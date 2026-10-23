// bb-plugin-claude-accounts — backend entry.
//
// Spreads Pi threads that run Claude through claude-bridge across several Claude subscriptions.
// Each account is a Claude Code config directory signed in with `CLAUDE_CONFIG_DIR=<dir> claude`.
// Every turn, the `pi` provider's environment gets CLAUDE_CONFIG_DIR for the thread's account;
// the machine's default `~/.claude` gets no variable at all. A Claude limit failure moves the
// thread to another account and queues a retry, which is dropped if the thread starts another
// turn first. Usage is read on each machine by the host entry and published through bb's
// provider-usage.v1 contract.
import { setTimeout as delay } from "node:timers/promises";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseAccounts, parseModelPatterns, type AccountSpec } from "./lib/accounts";
import { hostContract } from "./lib/contract";
import { Engine, type EngineSettings, type HostDirectoryClient } from "./lib/engine";
import { formatExplanation, formatStatus } from "./lib/format";
import { retryAvailabilityContract, retryAvailabilityMethod } from "./lib/retry-contract";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./lib/usage-source-contract";
import type { UsageWindow } from "./lib/usage";

export const DEFAULT_ACCOUNTS = "A=~/.claude";

const accountsSchema = z.string().superRefine((value, context) => {
  try {
    parseAccounts(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
  }
});
const percentSchema = z.number().int().min(1).max(100);

function usageWindow(window: UsageWindow) {
  return {
    kind: window.kind === "session" ? ("five-hour" as const) : window.kind === "weekly" ? ("weekly" as const) : ("custom" as const),
    id: window.id,
    label: window.kind === "session" ? "Current session" : window.kind === "weekly" && window.model === null ? "Weekly limit" : window.label,
    usedPercent: Math.max(0, window.usedPercent),
    resetsAt: window.resetsAt,
    model: window.model,
    cost: null,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    accounts: {
      type: "string",
      label: "Accounts",
      description:
        "Name=directory pairs separated by commas, for example A=~/.claude, B=~/.claude-b. ~ is each machine's home directory. Sign each extra directory in with CLAUDE_CONFIG_DIR=<directory> claude, then /login.",
      experimental_schema: accountsSchema,
      default: DEFAULT_ACCOUNTS,
    },
    mode: {
      type: "select",
      label: "Mode",
      options: ["route", "observe"],
      experimental_optionLabels: {
        route: "Route threads",
        observe: "Observe only: decide and record, change nothing",
      },
      default: "route",
    },
    newThreadSessionPercent: {
      type: "number",
      label: "New threads: session limit (%)",
      description: "A thread starts on, or moves to, an account only while its five-hour session use is below this.",
      experimental_schema: percentSchema,
      default: 85,
    },
    newThreadWeeklyPercent: {
      type: "number",
      label: "New threads: weekly limit (%)",
      description: "A thread starts on, or moves to, an account only while its weekly use is below this.",
      experimental_schema: percentSchema,
      default: 90,
    },
    moveSessionPercent: {
      type: "number",
      label: "Move threads at session use (%)",
      description: "A thread leaves its account at its next turn once the account's session use reaches this.",
      experimental_schema: percentSchema,
      default: 97,
    },
    moveWeeklyPercent: {
      type: "number",
      label: "Move threads at weekly use (%)",
      description: "A thread leaves its account at its next turn once the account's weekly use reaches this.",
      experimental_schema: percentSchema,
      default: 97,
    },
    pollMinutes: {
      type: "number",
      label: "Read usage every (minutes)",
      experimental_schema: z.number().int().min(1).max(60),
      default: 5,
    },
    smallAccountModels: {
      type: "string",
      label: "Models that prefer the smallest account",
      description: "Comma-separated model patterns; * matches anything. Example: claude-bridge/claude-haiku-*",
      default: "",
    },
  });

  async function engineSettings(): Promise<EngineSettings> {
    const values = await settings.get();
    let accounts: AccountSpec[];
    try {
      accounts = parseAccounts(String(values.accounts));
    } catch (error) {
      bb.log.warn(`Ignoring the accounts setting: ${error instanceof Error ? error.message : String(error)}`);
      accounts = parseAccounts(DEFAULT_ACCOUNTS);
    }
    return {
      accounts,
      mode: values.mode === "observe" ? "observe" : "route",
      newLimits: { session: values.newThreadSessionPercent, weekly: values.newThreadWeeklyPercent },
      moveLimits: { session: values.moveSessionPercent, weekly: values.moveWeeklyPercent },
      pollMs: values.pollMinutes * 60_000,
      smallAccountModels: parseModelPatterns(values.smallAccountModels),
    };
  }

  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const host: HostDirectoryClient = {
    inspect: (hostId, directories, signal) => hostClient.call("inspect", { directories }, { hostId, signal }),
    readUsage: (hostId, directory, signal) => hostClient.call("readUsage", { directory }, { hostId, signal }),
  };
  const engine = new Engine({
    kv: bb.storage.kv,
    sdk: () => bb.sdk,
    host,
    settings: engineSettings,
    log: bb.log,
  });
  await engine.load();

  bb.providers.experimental_contributeEnv("pi", (context) => engine.resolveEnv(context));
  // bb resolves the environment before it writes the turn's request event, so this hook is where the
  // turn's model is known in time. It only listens: every message proceeds, whatever happens here.
  bb.experimental_hooks.on("message.dispatch", (context) => {
    try {
      engine.noteDispatch(context.thread.id, context.requestedExecution.model);
    } catch {
      // Routing falls back to the thread's last request.
    }
    return { action: "proceed" };
  });
  bb.events.on("turn.failed", (event) => engine.onTurnFailed(event));
  bb.events.on("thread.active", ({ thread }) => engine.onThreadActive(thread.id));
  bb.events.on("message.cancelled", ({ entry }) => engine.onQueuedMessageCancelled(entry.threadId, entry.id));
  bb.events.on("thread.idle", ({ thread }) => engine.onThreadIdle(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => engine.forgetThread(thread.id));
  settings.onChange(() => {
    void engine.refreshAll().catch((error) => bb.log.warn(`Refresh after a settings change failed: ${String(error)}`));
  });

  bb.background.service("usage", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await engine.refreshAll(signal);
        } catch (error) {
          bb.log.warn(`Reading Claude usage failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const { pollMs } = await engineSettings();
        await delay(pollMs, undefined, { signal }).catch(() => {});
      }
    },
  });

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const resources = await engine.usageResources();
        return {
          label: "Claude Accounts",
          resources: resources.map((resource) => ({
            id: resource.spec.name,
            accountKey: resource.accountKey,
            providerId: "claude-code",
            label: resource.email ?? `Claude account ${resource.spec.name}`,
            scope: { kind: "shared" as const },
          })),
        };
      },
      async [usageFetchMethod]({ resourceId, refresh }): Promise<UsageMeasurement> {
        const spec = (await engineSettings()).accounts.find((candidate) => candidate.name === resourceId);
        if (!spec) throw new Error("Usage resource no longer exists.");
        if (refresh) await engine.refreshUsage(spec);
        const resource = (await engine.usageResources()).find((candidate) => candidate.spec.name === resourceId);
        if (!resource) throw new Error("Usage resource no longer exists.");
        const accountFields = {
          plan: resource.subscriptionType ? { id: resource.subscriptionType, multiplier: resource.multiplier } : null,
          accountEmail: resource.email,
          planLabel: resource.plan,
        };
        const usage = resource.usage;
        if (usage?.windows) {
          return {
            accountKey: resource.accountKey,
            observedAt: usage.observedAt,
            usage: { status: "ok", ...accountFields, windows: usage.windows.map(usageWindow) },
          };
        }
        const failure =
          usage?.status === "signed-out"
            ? ({ status: "unauthenticated", ...accountFields } as const)
            : usage?.status === "expired"
              ? ({ status: "expired", ...accountFields } as const)
              : ({ status: "error", ...accountFields, message: usage?.message ?? "Usage has not been read yet." } as const);
        return { accountKey: resource.accountKey, observedAt: null, usage: failure };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Usage windows for the Claude accounts that Claude Accounts spreads Pi threads across.",
    },
  );

  bb.rpc.register(
    retryAvailabilityContract,
    { [retryAvailabilityMethod]: ({ threadId }) => engine.availability(threadId) },
    {
      experimental_discoverable: true,
      experimental_description: "Claude Accounts availability for failed Pi threads it routes.",
    },
  );

  const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
  const statusCommand = () =>
    cliCommand({
      summary: "List accounts, their machines and usage, pinned thread counts, and warnings",
      options: { json },
      async run(input) {
        const status = await engine.status();
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(status) : formatStatus(status, Date.now()) };
      },
    });
  bb.cli.register(
    defineCli({
      name: "claude-accounts",
      summary: "Show and steer how Pi threads are spread across your Claude accounts",
      description:
        "Each Pi thread that runs Claude through claude-bridge is pinned to one account. New threads go to the largest plan with headroom; a thread moves at its next turn when its account crosses the move limits or hits a Claude limit.",
      root: statusCommand(),
      commands: {
        status: statusCommand(),
        explain: cliCommand({
          summary: "Explain which account a thread uses, why, and what its next turn would pick",
          positionals: [{ name: "thread", description: "Thread id; defaults to the current thread" }],
          options: { json },
          async run(input, context) {
            const threadId = input.positionals.thread ?? context.threadId;
            if (!threadId) {
              throw new PluginCliError("Name a thread.", { code: "missing_thread", hint: "bb claude-accounts explain <thread-id>" });
            }
            const explanation = await engine.explain(threadId);
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(explanation) : formatExplanation(explanation, Date.now()),
            };
          },
        }),
        pin: cliCommand({
          summary: "Pin a thread to one account until you unpin it; it takes effect on the thread's next turn",
          positionals: [
            { name: "thread", description: "Thread id", required: true },
            { name: "account", description: "Account name from the accounts setting", required: true },
          ],
          options: { json },
          async run(input) {
            try {
              const pin = await engine.setManualPin(input.positionals.thread, input.positionals.account);
              return {
                exitCode: 0,
                stdout: input.options.json ? JSON.stringify(pin) : `Pinned ${input.positionals.thread} to ${pin.account}; its next turn uses it.`,
              };
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "unknown_account" });
            }
          },
        }),
        unpin: cliCommand({
          summary: "Remove a thread's pin so its next turn picks an account by the rules",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          options: { json },
          async run(input) {
            const removed = await engine.unpin(input.positionals.thread);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ removed })
                : removed
                  ? `Unpinned ${input.positionals.thread}.`
                  : `${input.positionals.thread} had no pin.`,
            };
          },
        }),
        refresh: cliCommand({
          summary: "Re-check every machine's logins and read every account's usage now",
          options: { json },
          async run(input) {
            await engine.refreshAll();
            const status = await engine.status();
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(status) : formatStatus(status, Date.now()) };
          },
        }),
      },
    }),
  );
}
