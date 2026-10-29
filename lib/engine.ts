// The plugin's state and decisions: which accounts each machine has, their usage, thread pins,
// limit-failure blocks, and what each turn's environment should be.
import type {
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
  PluginBbSdk,
  PluginKvStorage,
  PluginLogger,
  PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  isClaudeBridgeModel,
  matchesModelPattern,
  modelFamily,
  planLabel,
  planWeight,
  type AccountSpec,
} from "./accounts";
import type { InspectedAccount, InspectResult, UsageRead } from "./contract";
import { parseClaudeLimit, type ClaudeLimitFailure } from "./failure";
import { pickAccount, type Candidate, type Limits, type Pick } from "./policy";
import { resetsAtMs, type UsageWindow } from "./usage";

export interface EngineSettings {
  accounts: AccountSpec[];
  mode: "route" | "observe";
  newLimits: Limits;
  moveLimits: Limits;
  pollMs: number;
  smallAccountModels: string[];
}

export interface HostDirectoryClient {
  inspect(hostId: string, directories: string[], signal?: AbortSignal): Promise<InspectResult>;
  readUsage(hostId: string, directory: string, signal?: AbortSignal): Promise<UsageRead>;
}

export interface EngineOptions {
  kv: PluginKvStorage;
  /** bb.sdk is bind-gated, so it is read when needed. */
  sdk: () => PluginBbSdk;
  host: HostDirectoryClient;
  settings: () => Promise<EngineSettings>;
  log: PluginLogger;
  now?: () => number;
  random?: () => number;
}

export interface Pin {
  account: string;
  manual: boolean;
  hostId: string;
  model: string;
  at: number;
}

export interface Decision {
  at: number;
  account: string | null;
  previous: string | null;
  detail: string;
  retryAt: number | null;
}

export interface AccountUsage {
  status: "ok" | "expired" | "signed-out" | "error";
  checkedAt: number;
  observedAt: number | null;
  windows: UsageWindow[] | null;
  message: string | null;
  hostId: string | null;
}

export interface Block {
  until: number | null;
  families: Record<string, number>;
  /** When the last limit failure set the block; missing on blocks stored before it was recorded. */
  at?: number;
}

/** A retry this plugin queued through bb, kept so it can be dropped if the thread moves on first. */
export interface PendingRetry {
  queuedMessageId: string;
  turnRequestId: string;
  sendAt: number;
}

export interface HostInventory extends InspectResult {
  hostId: string;
  checkedAt: number;
}

export interface MachineStatus {
  hostId: string;
  hostName: string;
  signedIn: boolean;
  path: string | null;
  refreshTokenExpiresAt: number | null;
  error: string | null;
}

export interface AccountStatus {
  name: string;
  directory: string;
  email: string | null;
  accountUuid: string | null;
  organizationUuid: string | null;
  plan: string | null;
  weight: number | null;
  machines: MachineStatus[];
  usage: AccountUsage | null;
  blockedUntil: number | null;
  blockedFamilies: Record<string, number>;
  pinnedThreads: number;
}

export interface EngineStatus {
  mode: EngineSettings["mode"];
  newLimits: Limits;
  moveLimits: Limits;
  smallAccountModels: string[];
  accounts: AccountStatus[];
  warnings: string[];
}

export interface Explanation {
  threadId: string;
  pin: Pin | null;
  decision: Decision | null;
  /** What the rule would pick on the thread's next turn. */
  next: Pick | null;
}

const MAX_RETRY_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 6 * 60 * 60_000;
const BLOCK_FALLBACK_MS = 60 * 60_000;
/** How long after a limit failure a usage reading can lift its block; earlier readings may not reflect the failure yet. */
const BLOCK_RECHECK_MS = 15 * 60_000;
const REFRESH_DEBOUNCE_MS = 60_000;
const INSPECT_DEBOUNCE_MS = 30_000;
const LOGIN_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;
/** How long a dispatch's model answers for the environment bb prepares right after it. */
const DISPATCH_MODEL_TTL_MS = 2 * 60_000;

const requestEventSchema = z.object({
  requestId: z.string().optional(),
  execution: z.object({ model: z.string().optional() }).optional(),
});
const providerErrorSchema = z.object({
  message: z.string().optional(),
  detail: z.string().optional(),
});

const key = {
  pin: (threadId: string) => `pin:${threadId}`,
  decision: (threadId: string) => `decision:${threadId}`,
  usage: (account: string) => `usage:${account}`,
  block: (account: string) => `block:${account}`,
  inventory: (hostId: string) => `inventory:${hostId}`,
  retry: (threadId: string) => `retry:${threadId}`,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Provider Retry handles failures bb classified as rate limits; this plugin handles the rest. */
function isStructuredRateLimit(event: PluginTurnFailedEvent): boolean {
  return event.errorInfo?.category === "rate-limit" || event.errorInfo?.httpStatusCode === 429;
}

export class Engine {
  private readonly kv: PluginKvStorage;
  private readonly sdk: () => PluginBbSdk;
  private readonly host: HostDirectoryClient;
  private readonly settings: () => Promise<EngineSettings>;
  private readonly log: PluginLogger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly inventories = new Map<string, HostInventory>();
  private readonly usage = new Map<string, AccountUsage>();
  private readonly blocks = new Map<string, Block>();
  private readonly inspecting = new Map<string, Promise<void>>();
  private readonly lastInspect = new Map<string, number>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly dispatches = new Map<string, { model: string | null; joinsTurn: boolean; at: number }>();

  constructor(options: EngineOptions) {
    this.kv = options.kv;
    this.sdk = options.sdk;
    this.host = options.host;
    this.settings = options.settings;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Restores the last known inventory, usage, and blocks so a restart routes like before. */
  async load(): Promise<void> {
    for (const name of await this.kv.list("inventory:")) {
      const value = await this.kv.get<HostInventory>(name);
      if (value) this.inventories.set(value.hostId, value);
    }
    for (const name of await this.kv.list("usage:")) {
      const value = await this.kv.get<AccountUsage>(name);
      if (value) this.usage.set(name.slice("usage:".length), value);
    }
    for (const name of await this.kv.list("block:")) {
      const value = await this.kv.get<Block>(name);
      if (value) this.blocks.set(name.slice("block:".length), value);
    }
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    const settings = await this.settings();
    let hosts: Array<{ id: string; status: string }> = [];
    try {
      hosts = await this.sdk().hosts.list();
    } catch (error) {
      this.log.warn(`Could not list machines: ${errorText(error)}`);
    }
    await Promise.all(
      hosts
        .filter((host) => host.status !== "disconnected")
        .map((host) => this.inspectHost(host.id, settings, signal)),
    );
    await Promise.all(settings.accounts.map((spec) => this.refreshUsage(spec, signal)));
  }

  private async inspectHost(hostId: string, settings: EngineSettings, signal?: AbortSignal): Promise<void> {
    const running = this.inspecting.get(hostId);
    if (running) return running;
    const work = (async () => {
      try {
        const result = await this.host.inspect(
          hostId,
          settings.accounts.map((spec) => spec.directory),
          signal,
        );
        const inventory: HostInventory = { ...result, hostId, checkedAt: this.now() };
        this.inventories.set(hostId, inventory);
        await this.kv.set(key.inventory(hostId), inventory);
      } catch (error) {
        this.log.warn(`Could not inspect Claude config directories on ${hostId}: ${errorText(error)}`);
      } finally {
        this.lastInspect.set(hostId, this.now());
        this.inspecting.delete(hostId);
      }
    })();
    this.inspecting.set(hostId, work);
    return work;
  }

  private inspectSoon(hostId: string): void {
    if (this.now() - (this.lastInspect.get(hostId) ?? 0) < INSPECT_DEBOUNCE_MS) return;
    this.lastInspect.set(hostId, this.now());
    void this.settings().then((settings) => this.inspectHost(hostId, settings));
  }

  /** Reads usage on the server machine when the account is signed in there, else on any machine that has it. */
  private async readHostFor(spec: AccountSpec): Promise<string | null> {
    let primary: string | null = null;
    try {
      primary = (await this.sdk().system.config()).primaryHostId;
    } catch {
      primary = null;
    }
    const signedIn = (hostId: string) =>
      this.inventories.get(hostId)?.accounts.some((account) => account.directory === spec.directory && account.signedIn) ??
      false;
    if (primary !== null && signedIn(primary)) return primary;
    for (const hostId of this.inventories.keys()) if (signedIn(hostId)) return hostId;
    return null;
  }

  async refreshUsage(spec: AccountSpec, signal?: AbortSignal): Promise<void> {
    const running = this.reading.get(spec.name);
    if (running) return running;
    const work = (async () => {
      const hostId = await this.readHostFor(spec);
      const previous = this.usage.get(spec.name);
      let next: AccountUsage;
      if (hostId === null) {
        next = {
          status: "signed-out",
          checkedAt: this.now(),
          observedAt: previous?.observedAt ?? null,
          windows: previous?.windows ?? null,
          message: `No machine has a Claude Code login in ${spec.directory}.`,
          hostId: null,
        };
      } else {
        let read: UsageRead;
        try {
          read = await this.host.readUsage(hostId, spec.directory, signal);
        } catch (error) {
          read = { status: "error", message: errorText(error) };
        }
        next =
          read.status === "ok"
            ? { status: "ok", checkedAt: this.now(), observedAt: read.observedAt, windows: read.windows, message: null, hostId }
            : {
                status: read.status,
                checkedAt: this.now(),
                observedAt: previous?.observedAt ?? null,
                windows: previous?.windows ?? null,
                message: read.message,
                hostId,
              };
      }
      this.usage.set(spec.name, next);
      await this.kv.set(key.usage(spec.name), next);
      await this.liftBlock(spec.name, next);
    })().finally(() => this.reading.delete(spec.name));
    this.reading.set(spec.name, work);
    return work;
  }

  private async refreshUsageSoon(account: string): Promise<void> {
    const settings = await this.settings();
    const spec = settings.accounts.find((candidate) => candidate.name === account);
    if (!spec) return;
    if (this.now() - (this.usage.get(account)?.checkedAt ?? 0) < REFRESH_DEBOUNCE_MS) return;
    await this.refreshUsage(spec);
  }

  private inventoryAccount(hostId: string, spec: AccountSpec): InspectedAccount | undefined {
    return this.inventories.get(hostId)?.accounts.find((account) => account.directory === spec.directory);
  }

  /** Plan and identity come from whichever machine reported them; the plan is the same everywhere. */
  private identity(spec: AccountSpec): InspectedAccount | undefined {
    let fallback: InspectedAccount | undefined;
    for (const inventory of this.inventories.values()) {
      const account = inventory.accounts.find((candidate) => candidate.directory === spec.directory);
      if (!account) continue;
      if (account.signedIn && account.rateLimitTier !== null) return account;
      fallback ??= account;
    }
    return fallback;
  }

  private candidates(settings: EngineSettings, hostId: string): Candidate[] {
    const now = this.now();
    return settings.accounts.map((spec) => {
      const inspected = this.inventoryAccount(hostId, spec);
      const identity = this.identity(spec);
      const block = this.blocks.get(spec.name);
      const loginLive =
        inspected?.refreshTokenExpiresAt === null ||
        inspected?.refreshTokenExpiresAt === undefined ||
        inspected.refreshTokenExpiresAt > now;
      return {
        name: spec.name,
        order: spec.order,
        weight: planWeight(identity?.rateLimitTier ?? null, identity?.subscriptionType ?? null),
        available: Boolean(inspected?.exists && inspected.signedIn && loginLive),
        windows: this.usage.get(spec.name)?.windows ?? null,
        blockedUntil: block?.until ?? null,
        blockedFamilies: block?.families ?? {},
      };
    });
  }

  private pick(settings: EngineSettings, hostId: string, model: string, pin: Pin | null): Pick {
    return pickAccount({
      candidates: this.candidates(settings, hostId),
      pin: pin?.account ?? null,
      manualPin: pin?.manual ?? false,
      family: modelFamily(model),
      preferSmall: settings.smallAccountModels.some((pattern) => matchesModelPattern(model, pattern)),
      newLimits: settings.newLimits,
      moveLimits: settings.moveLimits,
      now: this.now(),
    });
  }

  private async recordDecision(threadId: string, decision: Decision): Promise<void> {
    await this.kv.set(key.decision(threadId), decision);
  }

  /** The machine's default `~/.claude` account, which a thread without a pin has been running on. */
  private defaultPin(hostId: string, settings: EngineSettings): Pin | null {
    const spec = settings.accounts.find((candidate) => this.inventoryAccount(hostId, candidate)?.isDefault);
    return spec ? { account: spec.name, manual: false, hostId, model: "", at: this.now() } : null;
  }

  /**
   * A thread with earlier turns ran on the default login before this plugin pinned it, so it starts
   * pinned there and keeps its prompt cache. A fork starts where its source thread is.
   */
  private async implicitPin(threadId: string, hostId: string, settings: EngineSettings, hasEarlierTurn: boolean) {
    if (hasEarlierTurn) return this.defaultPin(hostId, settings);
    try {
      const thread = await this.sdk().threads.get({ threadId });
      if (!thread.sourceThreadId) return null;
      const source = await this.kv.get<Pin>(key.pin(thread.sourceThreadId));
      return source ? { ...source, manual: false, hostId } : this.defaultPin(hostId, settings);
    } catch {
      return null;
    }
  }

  /** Picks the thread's account and stores the pin when it changes. */
  private async decide(
    threadId: string,
    hostId: string,
    model: string,
    settings: EngineSettings,
    hasEarlierTurn: () => Promise<boolean>,
  ): Promise<Pick> {
    const stored = (await this.kv.get<Pin>(key.pin(threadId))) ?? null;
    const pin = stored ?? (await this.implicitPin(threadId, hostId, settings, await hasEarlierTurn()));
    const pick = this.pick(settings, hostId, model, pin);
    if (pick.account === null) return pick;
    const changed = pin === null || pin.account !== pick.account;
    if (stored === null || changed || stored.hostId !== hostId || stored.model !== model) {
      await this.kv.set(key.pin(threadId), {
        account: pick.account,
        manual: !changed && (pin?.manual ?? false),
        hostId,
        model,
        at: changed || stored === null ? this.now() : stored.at,
      } satisfies Pin);
    }
    if (changed) {
      await this.recordDecision(threadId, {
        at: this.now(),
        account: pick.account,
        previous: pin?.account ?? null,
        detail: pick.detail,
        retryAt: null,
      });
      if (pin !== null) this.log.info(`Thread ${threadId}: ${pick.detail}`);
    }
    return pick;
  }

  /**
   * The last turn request bb wrote. While bb prepares a turn this is still the previous turn's
   * request: bb resolves the provider environment first and writes the new request afterwards.
   */
  private async latestRequest(
    threadId: string,
  ): Promise<{ seq: number; requestId: string | null; model: string | null } | null> {
    const rows = await this.sdk().threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
    });
    const row = rows[0];
    if (!row) return null;
    const data = requestEventSchema.safeParse(row.data);
    return {
      seq: row.seq,
      requestId: data.success ? (data.data.requestId ?? null) : null,
      model: data.success ? (data.data.execution?.model ?? null) : null,
    };
  }

  /** Whether a turn finished before the one bb is preparing, which has not finished yet. */
  private async hasEarlierTurn(threadId: string): Promise<boolean> {
    const rows = await this.sdk().threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    return rows.length > 0;
  }

  /**
   * From the `message.dispatch` hook, which bb runs before it prepares a turn: the model that turn
   * runs on, and whether the message starts a turn or joins a running one. bb writes the turn's
   * request event only after it resolves the provider environment, so this is the only current
   * answer while the environment is resolved. Never throws.
   */
  noteDispatch(threadId: string, model: string | null, attempt: "start-turn" | "join-turn"): void {
    const now = this.now();
    for (const [id, note] of this.dispatches) {
      if (now - note.at > DISPATCH_MODEL_TTL_MS) this.dispatches.delete(id);
    }
    this.dispatches.set(threadId, { model, joinsTurn: attempt === "join-turn", at: now });
  }

  private freshDispatch(threadId: string) {
    const note = this.dispatches.get(threadId);
    return note !== undefined && this.now() - note.at <= DISPATCH_MODEL_TTL_MS ? note : null;
  }

  /** The model of the turn bb is preparing: the dispatch hook's note when fresh, else the last request bb wrote. */
  private async turnModel(threadId: string): Promise<string | null> {
    const note = this.freshDispatch(threadId);
    if (note !== null) return note.model;
    return (await this.latestRequest(threadId))?.model ?? null;
  }

  private envFor(spec: AccountSpec, inspected: InspectedAccount | undefined): ExperimentalPluginProviderEnvEntry[] {
    if (!inspected || inspected.isDefault) return [];
    return [
      {
        name: "CLAUDE_CONFIG_DIR",
        value: inspected.path,
        reason: `Claude Accounts: this turn uses account ${spec.name}`,
      },
      {
        name: "BB_CLAUDE_ACCOUNT",
        value: spec.name,
        reason: "Claude Accounts: the account this turn uses",
      },
    ];
  }

  /** The `pi` provider's environment for one command. Never throws; on any doubt it leaves the default login in place. */
  async resolveEnv(context: ExperimentalPluginProviderEnvContext): Promise<ExperimentalPluginProviderEnvEntry[]> {
    if (!context.threadId) return [];
    try {
      const threadId = context.threadId;
      const model = await this.turnModel(threadId);
      if (model === null || !isClaudeBridgeModel(model)) return [];
      if (!this.inventories.has(context.hostId)) {
        this.inspectSoon(context.hostId);
        return [];
      }
      const settings = await this.settings();
      // A message that joins a running turn, such as a steer or a delivered tool result, reaches the
      // Claude Code process that turn started, which keeps its login. Picking again would move the pin
      // off the account the turn runs on, and the turn's limit failure would block the wrong account.
      const account = this.freshDispatch(threadId)?.joinsTurn
        ? ((await this.kv.get<Pin>(key.pin(threadId)))?.account ?? null)
        : (await this.decide(threadId, context.hostId, model, settings, () => this.hasEarlierTurn(threadId))).account;
      if (settings.mode !== "route" || account === null) return [];
      const spec = settings.accounts.find((candidate) => candidate.name === account);
      return spec ? this.envFor(spec, this.inventoryAccount(context.hostId, spec)) : [];
    } catch (error) {
      this.log.warn(`Leaving thread ${context.threadId} on its default login: ${errorText(error)}`);
      return [];
    }
  }

  private async limitFailure(event: PluginTurnFailedEvent): Promise<ClaudeLimitFailure | null> {
    const request = await this.latestRequest(event.threadId);
    if (request === null || (request.requestId !== null && request.requestId !== event.requestId)) return null;
    const rows = await this.sdk().threads.events.list({
      threadId: event.threadId,
      types: ["provider/error"],
      order: "desc",
      limit: "5",
    });
    for (const row of rows) {
      if (row.seq < request.seq) continue;
      const data = providerErrorSchema.safeParse(row.data);
      if (!data.success) continue;
      const failure = parseClaudeLimit(`${data.data.detail ?? ""} ${data.data.message ?? ""}`);
      if (failure) return failure;
    }
    return null;
  }

  /** When the window behind a limit failure resets, from the account's last usage reading. */
  private resetFor(account: string, failure: ClaudeLimitFailure): number | null {
    const windows = this.usage.get(account)?.windows ?? [];
    const match = windows.find((window) =>
      failure.scope === "session"
        ? window.kind === "session"
        : failure.scope === "family"
          ? window.kind === "weekly" && window.model === failure.family
          : failure.scope === "weekly"
            ? window.kind === "weekly" && window.model === null
            : false,
    );
    const reset = match ? resetsAtMs(match) : null;
    return reset !== null && reset > this.now() ? reset : null;
  }

  private async block(account: string, failure: ClaudeLimitFailure): Promise<number> {
    const until = this.resetFor(account, failure) ?? this.now() + BLOCK_FALLBACK_MS;
    const current = this.blocks.get(account) ?? { until: null, families: {} };
    const next: Block =
      failure.scope === "family" && failure.family !== null
        ? { ...current, families: { ...current.families, [failure.family]: until }, at: this.now() }
        : { ...current, until: Math.max(current.until ?? 0, until), at: this.now() };
    this.blocks.set(account, next);
    await this.kv.set(key.block(account), next);
    return until;
  }

  /**
   * Lifts a limit-failure block once a usage reading taken well after the failure covers the blocked
   * window. Anthropic sometimes rejects an account briefly while its windows have room; the windows
   * still hold the account back when it is really full, so the block need not last until the reset.
   */
  private async liftBlock(account: string, usage: AccountUsage): Promise<void> {
    const block = this.blocks.get(account);
    const windows = usage.windows;
    if (!block || usage.status !== "ok" || usage.observedAt === null || windows === null) return;
    if (usage.observedAt < (block.at ?? 0) + BLOCK_RECHECK_MS) return;
    const covers = (kind: "session" | "weekly", model: string | null) =>
      windows.some((window) => window.kind === kind && window.model === model);
    const until = block.until !== null && covers("session", null) && covers("weekly", null) ? null : block.until;
    const families = Object.fromEntries(Object.entries(block.families).filter(([family]) => !covers("weekly", family)));
    const lifted = [
      ...(until !== block.until ? ["all models"] : []),
      ...Object.keys(block.families).filter((family) => !(family in families)),
    ];
    if (lifted.length === 0) return;
    if (until === null && Object.keys(families).length === 0) {
      this.blocks.delete(account);
      await this.kv.delete(key.block(account));
    } else {
      const next: Block = { ...block, until, families };
      this.blocks.set(account, next);
      await this.kv.set(key.block(account), next);
    }
    this.log.info(`Account ${account}: lifted its limit-failure block (${lifted.join(", ")}); a later usage reading decides from here.`);
  }

  async onTurnFailed(event: PluginTurnFailedEvent): Promise<void> {
    const pin = (await this.kv.get<Pin>(key.pin(event.threadId))) ?? null;
    if (pin === null) return;
    const failure = await this.limitFailure(event);
    if (failure === null) return;
    const until = await this.block(pin.account, failure);
    void this.refreshUsageSoon(pin.account).catch(() => {});
    const what = failure.family ? `its ${failure.family} limit` : failure.scope === "session" ? "its session limit" : "a usage limit";
    const record = (detail: string, retryAt: number | null = null, account: string | null = pin.account) =>
      this.recordDecision(event.threadId, { at: this.now(), account, previous: pin.account, detail, retryAt });
    if (pin.manual) {
      await record(`Account ${pin.account} hit ${what}; the thread is pinned there by hand, so it stays.`);
      return;
    }
    const settings = await this.settings();
    const pick = await this.decide(event.threadId, pin.hostId, pin.model, settings, async () => true);
    const moved = pick.account !== null && pick.account !== pin.account;
    if (settings.mode !== "route") {
      await record(`Observe mode: account ${pin.account} hit ${what}; routing would ${moved ? `move to ${pick.account}` : "wait"}.`, null, pick.account);
      return;
    }
    if (isStructuredRateLimit(event)) {
      await record(`Account ${pin.account} hit ${what}; Provider Retry schedules the retry.`, null, pick.account);
      return;
    }
    if (event.attemptNumber >= MAX_RETRY_ATTEMPTS) {
      await record(`Account ${pin.account} hit ${what} after ${event.attemptNumber} attempts; not retrying again.`, null, pick.account);
      return;
    }
    const now = this.now();
    let sendAt: number | null = null;
    let reason: string;
    if (moved && pick.ready) {
      sendAt = now + 15_000 + Math.round(this.random() * 30_000);
      reason = `Claude Accounts: ${pin.account} hit ${what}; retrying on ${pick.account}`;
    } else {
      const readyAt = pick.readyAt ?? until;
      if (readyAt - now <= MAX_RETRY_WAIT_MS) sendAt = Math.max(readyAt, now) + 30_000 + Math.round(this.random() * 60_000);
      reason = `Claude Accounts: every account is out of quota; retrying when ${pick.readyAccount ?? pick.account ?? pin.account} frees up`;
    }
    if (sendAt === null) {
      await record(`Account ${pin.account} hit ${what}; no account frees up within 6 hours, so no retry was queued.`, null, pick.account);
      return;
    }
    try {
      const queued = await this.sdk().threads.retry({ threadId: event.threadId, turnRequestId: event.requestId, sendAt, reason });
      if (queued.delivery === "queued") {
        await this.kv.set(key.retry(event.threadId), {
          queuedMessageId: queued.queuedMessageId,
          turnRequestId: event.requestId,
          sendAt,
        } satisfies PendingRetry);
      }
      await record(reason.replace(/^Claude Accounts: /u, ""), sendAt, pick.account);
      this.log.info(`Thread ${event.threadId}: ${reason} at ${new Date(sendAt).toISOString()}`);
    } catch (error) {
      await record(`Account ${pin.account} hit ${what}; queuing a retry failed: ${errorText(error)}`, null, pick.account);
    }
  }

  async onThreadIdle(threadId: string): Promise<void> {
    const pin = await this.kv.get<Pin>(key.pin(threadId));
    if (pin) await this.refreshUsageSoon(pin.account);
  }

  /**
   * A turn started. Unless it is this plugin's queued retry, the thread moved on without the retry,
   * which would now re-run finished work, so the queued row is deleted.
   */
  async onThreadActive(threadId: string): Promise<void> {
    const pending = await this.kv.get<PendingRetry>(key.retry(threadId));
    if (pending === undefined) return;
    await this.kv.delete(key.retry(threadId));
    try {
      const rows = await this.sdk().threads.queuedMessages.list({ threadId });
      const row = rows.find((candidate) => candidate.id === pending.queuedMessageId);
      // Gone or claimed: the turn that started is the retry itself.
      if (row === undefined || row.state === "claimed") return;
      await this.sdk().threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
    } catch (error) {
      this.log.warn(`Thread ${threadId}: could not drop the queued retry after the thread moved on: ${errorText(error)}`);
      return;
    }
    await this.recordRetryEnd(threadId, "Dropped the queued retry: the thread started another turn first.");
  }

  /** The queued retry was deleted by hand. */
  async onQueuedMessageCancelled(threadId: string, queuedMessageId: string): Promise<void> {
    const pending = await this.kv.get<PendingRetry>(key.retry(threadId));
    if (pending?.queuedMessageId !== queuedMessageId) return;
    await this.kv.delete(key.retry(threadId));
    await this.recordRetryEnd(threadId, "The queued retry was cancelled by hand.");
  }

  private async recordRetryEnd(threadId: string, detail: string): Promise<void> {
    const account = (await this.kv.get<Pin>(key.pin(threadId)))?.account ?? null;
    await this.recordDecision(threadId, { at: this.now(), account, previous: account, detail, retryAt: null });
    this.log.info(`Thread ${threadId}: ${detail}`);
  }

  async forgetThread(threadId: string): Promise<void> {
    await this.kv.delete(key.pin(threadId));
    await this.kv.delete(key.decision(threadId));
    await this.kv.delete(key.retry(threadId));
  }

  async setManualPin(threadId: string, account: string): Promise<Pin> {
    const settings = await this.settings();
    if (!settings.accounts.some((spec) => spec.name === account)) {
      throw new Error(`No account is named ${account}. Configured: ${settings.accounts.map((spec) => spec.name).join(", ")}.`);
    }
    const current = await this.kv.get<Pin>(key.pin(threadId));
    const request = await this.latestRequest(threadId);
    const pin: Pin = {
      account,
      manual: true,
      hostId: current?.hostId ?? "",
      model: request?.model ?? current?.model ?? "",
      at: this.now(),
    };
    await this.kv.set(key.pin(threadId), pin);
    await this.recordDecision(threadId, {
      at: this.now(),
      account,
      previous: current?.account ?? null,
      detail: `Pinned to ${account} by hand.`,
      retryAt: null,
    });
    return pin;
  }

  async unpin(threadId: string): Promise<boolean> {
    const current = await this.kv.get<Pin>(key.pin(threadId));
    if (current === undefined) return false;
    await this.kv.delete(key.pin(threadId));
    await this.recordDecision(threadId, {
      at: this.now(),
      account: null,
      previous: current.account,
      detail: `Unpinned from ${current.account} by hand; the thread's next turn picks its account by the rules.`,
      retryAt: null,
    });
    return true;
  }

  async explain(threadId: string): Promise<Explanation> {
    const pin = (await this.kv.get<Pin>(key.pin(threadId))) ?? null;
    const decision = (await this.kv.get<Decision>(key.decision(threadId))) ?? null;
    const settings = await this.settings();
    const next = pin && pin.hostId !== "" ? this.pick(settings, pin.hostId, pin.model, pin) : null;
    return { threadId, pin, decision, next };
  }

  /** For Provider Retry: whether a failed pinned thread can run again now. */
  async availability(threadId: string) {
    const pin = await this.kv.get<Pin>(key.pin(threadId));
    if (!pin || pin.hostId === "") return { kind: "not-routed" } as const;
    const pick = this.pick(await this.settings(), pin.hostId, pin.model, pin);
    if (pick.account !== null && pick.ready) return { kind: "ready" } as const;
    if (pick.readyAt !== null) return { kind: "blocked", retryAt: pick.readyAt } as const;
    return { kind: "unavailable", reason: "reset-unknown" } as const;
  }

  async status(): Promise<EngineStatus> {
    const settings = await this.settings();
    const now = this.now();
    let hosts: Array<{ id: string; name: string }> = [];
    try {
      hosts = await this.sdk().hosts.list();
    } catch {
      hosts = [...this.inventories.keys()].map((id) => ({ id, name: id }));
    }
    const hostName = new Map(hosts.map((host) => [host.id, host.name]));
    const pinCounts = new Map<string, number>();
    for (const name of await this.kv.list("pin:")) {
      const pin = await this.kv.get<Pin>(name);
      if (pin) pinCounts.set(pin.account, (pinCounts.get(pin.account) ?? 0) + 1);
    }
    const warnings: string[] = [];
    const accounts = settings.accounts.map((spec): AccountStatus => {
      const identity = this.identity(spec);
      const machines: MachineStatus[] = [...this.inventories.values()].map((inventory) => {
        const account = inventory.accounts.find((candidate) => candidate.directory === spec.directory);
        return {
          hostId: inventory.hostId,
          hostName: hostName.get(inventory.hostId) ?? inventory.hostId,
          signedIn: account?.signedIn ?? false,
          path: account?.path ?? null,
          refreshTokenExpiresAt: account?.refreshTokenExpiresAt ?? null,
          error: account?.error ?? null,
        };
      });
      for (const machine of machines) {
        if (machine.refreshTokenExpiresAt !== null && machine.refreshTokenExpiresAt - now < LOGIN_EXPIRY_WARNING_MS) {
          warnings.push(
            `${spec.name}'s login on ${machine.hostName} expires ${new Date(machine.refreshTokenExpiresAt).toISOString()}; sign in again with CLAUDE_CONFIG_DIR=${spec.directory} claude.`,
          );
        }
      }
      const uuids = new Set(
        [...this.inventories.values()]
          .map((inventory) => inventory.accounts.find((candidate) => candidate.directory === spec.directory)?.accountUuid)
          .filter((uuid): uuid is string => typeof uuid === "string"),
      );
      if (uuids.size > 1) warnings.push(`${spec.directory} is signed in to different Claude accounts on different machines.`);
      const block = this.blocks.get(spec.name);
      return {
        name: spec.name,
        directory: spec.directory,
        email: identity?.email ?? null,
        accountUuid: identity?.accountUuid ?? null,
        organizationUuid: identity?.organizationUuid ?? null,
        plan: planLabel(identity?.rateLimitTier ?? null, identity?.subscriptionType ?? null),
        weight: planWeight(identity?.rateLimitTier ?? null, identity?.subscriptionType ?? null),
        machines,
        usage: this.usage.get(spec.name) ?? null,
        blockedUntil: block?.until !== null && block?.until !== undefined && block.until > now ? block.until : null,
        blockedFamilies: Object.fromEntries(Object.entries(block?.families ?? {}).filter(([, until]) => until > now)),
        pinnedThreads: pinCounts.get(spec.name) ?? 0,
      };
    });
    const organizations = new Map<string, string[]>();
    for (const account of accounts) {
      if (account.organizationUuid === null) continue;
      organizations.set(account.organizationUuid, [...(organizations.get(account.organizationUuid) ?? []), account.name]);
    }
    for (const names of organizations.values()) {
      if (names.length > 1) warnings.push(`${names.join(" and ")} belong to one organization, so they share one quota.`);
    }
    return {
      mode: settings.mode,
      newLimits: settings.newLimits,
      moveLimits: settings.moveLimits,
      smallAccountModels: settings.smallAccountModels,
      accounts,
      warnings,
    };
  }

  /** For the provider-usage.v1 source: one entry per configured account. */
  async usageResources() {
    const settings = await this.settings();
    return settings.accounts.map((spec) => {
      const identity = this.identity(spec);
      return {
        spec,
        accountKey: identity?.accountUuid ? `anthropic:account:${identity.accountUuid}` : null,
        email: identity?.email ?? null,
        plan: planLabel(identity?.rateLimitTier ?? null, identity?.subscriptionType ?? null),
        subscriptionType: identity?.subscriptionType ?? null,
        multiplier: Number(/max_(\d+)x/u.exec(identity?.rateLimitTier ?? "")?.[1]) || null,
        usage: this.usage.get(spec.name) ?? null,
      };
    });
  }
}
