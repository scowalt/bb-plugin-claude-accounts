import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const BEELINK = "host_beelink";
const MACBOOK = "host_macbook";
const OPUS = "claude-bridge/claude-opus-5-5";
const CODEX = "openai-codex/gpt-6-astra";

interface FakeThread {
  /** The model its turns run on unless a turn names another. */
  model: string;
  /** Turn requests bb has written, oldest first. */
  requests: Array<{ requestId: string; model: string }>;
  /** Turns that have finished. */
  completedTurns: number;
  errors: string[];
  sourceThreadId: string | null;
}

interface Usage {
  session: number;
  weekly: number;
  fable?: number;
}

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function windows(usage: Usage) {
  return [
    { id: "session", kind: "session", label: "Session", model: null, usedPercent: usage.session, resetsAt: inHours(3) },
    { id: "weekly", kind: "weekly", label: "Weekly", model: null, usedPercent: usage.weekly, resetsAt: inHours(80) },
    ...(usage.fable === undefined
      ? []
      : [{ id: "weekly:fable", kind: "weekly", label: "Weekly · Fable", model: "fable", usedPercent: usage.fable, resetsAt: inHours(80) }]),
  ];
}

function inspected(directory: string, hostId: string) {
  const home = hostId === MACBOOK ? "/Users/u" : "/home/u";
  const isDefault = directory === "~/.claude";
  const path = `${home}/${directory.slice(2)}`;
  const signedIn = isDefault || hostId === BEELINK;
  return {
    directory,
    path,
    isDefault,
    exists: signedIn,
    signedIn,
    accountUuid: isDefault ? "uuid-a" : "uuid-b",
    organizationUuid: isDefault ? "org-a" : "org-b",
    email: isDefault ? "a@example.com" : "b@example.com",
    subscriptionType: isDefault ? "max" : "pro",
    rateLimitTier: isDefault ? "default_claude_max_20x" : "default_claude_ai",
    refreshTokenExpiresAt: Date.now() + 20 * 86_400_000,
    error: null,
  };
}

async function setup(options: { settings?: Record<string, unknown> } = {}) {
  const threads = new Map<string, FakeThread>();
  const usage = new Map<string, Usage>([
    ["~/.claude", { session: 40, weekly: 17, fable: 1 }],
    ["~/.claude-b", { session: 2, weekly: 0 }],
  ]);
  const retries: Array<{ threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }> = [];
  /** Rows in bb's message queue, per thread. */
  const queued = new Map<string, ReturnType<typeof makeQueueEntry>[]>();
  const deletedRows: string[] = [];
  const row = (seq: number, type: string, data: unknown, threadId: string) => ({
    id: `evt_${seq}`,
    scope: { kind: "thread" },
    threadId,
    seq,
    createdAt: Date.now(),
    type,
    data,
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "claude-accounts",
    settings: { accounts: "A=~/.claude, B=~/.claude-b", ...options.settings },
    sdk: {
      threads: {
        events: {
          list: async (args: { threadId: string; types?: readonly string[]; limit?: string }) => {
            const thread = threads.get(args.threadId);
            if (!thread) return [];
            const limit = Number(args.limit ?? 1_000);
            if (args.types?.[0] === "client/turn/requested") {
              return thread.requests
                .map((request, index) => row(100 + index, "client/turn/requested", { requestId: request.requestId, execution: { model: request.model } }, args.threadId))
                .reverse()
                .slice(0, limit);
            }
            if (args.types?.[0] === "turn/completed") {
              return Array.from({ length: Math.min(thread.completedTurns, limit) }, (_, index) =>
                row(500 + index, "turn/completed", { providerThreadId: "pi_1", status: "completed" }, args.threadId),
              );
            }
            if (args.types?.[0] === "provider/error") {
              return thread.errors.map((detail, index) =>
                row(1_000 + index, "provider/error", { providerThreadId: "pi_1", message: "Provider error", detail }, args.threadId),
              );
            }
            return [];
          },
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, sourceThreadId: threads.get(threadId)?.sourceThreadId ?? null }),
        retry: async (args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }) => {
          retries.push(args);
          const id = `qm_${retries.length}`;
          queued.set(args.threadId, [
            ...(queued.get(args.threadId) ?? []),
            makeQueueEntry({ id, threadId: args.threadId, state: "scheduled", sendAt: args.sendAt ?? null }),
          ]);
          return {
            ok: true,
            delivery: "queued",
            attempt: 2,
            queuedMessageId: id,
            sendAt: args.sendAt ?? null,
            turnRequestId: args.turnRequestId ?? "",
            waitingOn: { kind: "time" },
          };
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => queued.get(threadId) ?? [],
          delete: async ({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) => {
            deletedRows.push(queuedMessageId);
            queued.set(threadId, (queued.get(threadId) ?? []).filter((entry) => entry.id !== queuedMessageId));
            return { ok: true };
          },
        },
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: BEELINK, name: "beelink", status: "connected" }),
          makeHostResponse({ id: MACBOOK, name: "macbook", status: "connected" }),
        ],
      },
      system: { config: async () => ({ primaryHostId: BEELINK }) as never },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (method === "inspect") {
        const { directories } = input as { directories: string[] };
        return {
          home: hostId === MACBOOK ? "/Users/u" : "/home/u",
          platform: hostId === MACBOOK ? "darwin" : "linux",
          accounts: directories.map((directory) => inspected(directory, hostId)),
        };
      }
      const { directory } = input as { directory: string };
      const current = usage.get(directory);
      return current
        ? { status: "ok", observedAt: Date.now(), windows: windows(current) }
        : { status: "signed-out", message: "No login." };
    },
  });
  await plugin(bb);
  const refresh = () => harness.behavior.runCli(["refresh", "--json"]);
  await refresh();
  /** bb resolving the environment on its own, with no dispatch just before (a runtime restart). */
  const env = (threadId: string | null, hostId = BEELINK) =>
    harness.behavior.resolveProviderEnv("pi", { threadId: threadId as string, projectId: "proj_1", hostId });
  const dispatchHook = () => {
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    if (!hook) throw new Error("No message.dispatch hook registered.");
    return hook;
  };
  /**
   * A turn, in bb's order: the dispatch hook runs, bb resolves the environment, and only then writes
   * the turn's request event. Returns the environment the turn ran with; the turn then finishes.
   */
  const turn = async (threadId: string, model?: string, hostId = BEELINK) => {
    const fake = threads.get(threadId)!;
    const turnModel = model ?? fake.requests.at(-1)?.model ?? fake.model;
    expect(await dispatchHook()(makeMessageDispatchHookContext({ thread: { id: threadId }, requestedExecution: { model: turnModel } }))).toEqual({
      action: "proceed",
    });
    const resolved = await env(threadId, hostId);
    fake.requests.push({ requestId: `req_${threadId}_${fake.requests.length + 1}`, model: turnModel });
    fake.completedTurns += 1;
    return resolved;
  };
  /** A message joining the thread's running turn, such as a steer or a delivered tool result. */
  const join = async (threadId: string) => {
    const fake = threads.get(threadId)!;
    const model = fake.requests.at(-1)?.model ?? fake.model;
    await dispatchHook()(
      makeMessageDispatchHookContext({ thread: { id: threadId }, requestedExecution: { model }, attempt: "join-turn" }),
    );
    const resolved = await env(threadId);
    fake.requests.push({ requestId: `req_${threadId}_${fake.requests.length + 1}`, model });
    return resolved;
  };
  const lastRequestId = (threadId: string) => threads.get(threadId)!.requests.at(-1)!.requestId;
  /** A thread with `turns` finished turns on `model`, from before this test looked at it. */
  const thread = (threadId: string, model = OPUS, options: { turns?: number; sourceThreadId?: string } = {}) => {
    const turns = options.turns ?? 0;
    threads.set(threadId, {
      model,
      requests: Array.from({ length: turns }, (_, index) => ({ requestId: `req_${threadId}_${index + 1}`, model })),
      completedTurns: turns,
      errors: [],
      sourceThreadId: options.sourceThreadId ?? null,
    });
    return threads.get(threadId)!;
  };
  return { harness, threads, usage, retries, queued, deletedRows, refresh, env, turn, join, thread, lastRequestId, dispatchHook };
}

const B_ENV = [
  { name: "CLAUDE_CONFIG_DIR", value: "/home/u/.claude-b", reason: "Claude Accounts: this turn uses account B" },
  { name: "BB_CLAUDE_ACCOUNT", value: "B", reason: "Claude Accounts: the account this turn uses" },
];

describe("claude-accounts", () => {
  it("leaves Claude threads on the default login while it has headroom", async () => {
    const { turn, thread } = await setup();
    thread("thr_a");
    expect(await turn("thr_a")).toEqual([]);
  });

  it("sends a new thread's first turn to B once A is past the new-thread limits, and keeps pinned threads on A", async () => {
    const { turn, thread, usage, refresh } = await setup();
    thread("thr_a");
    await turn("thr_a");
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_new");
    expect(await turn("thr_new")).toEqual(B_ENV);
    expect(await turn("thr_a")).toEqual([]);
  });

  it("keeps threads that ran before the plugin on the default login until the move limits", async () => {
    const { turn, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_old", OPUS, { turns: 5 });
    thread("thr_fresh");
    expect(await turn("thr_old")).toEqual([]);
    expect(await turn("thr_fresh")).toEqual(B_ENV);
    usage.set("~/.claude", { session: 98, weekly: 17 });
    await refresh();
    expect(await turn("thr_old")).toEqual(B_ENV);
  });

  it("starts a fork on its source thread's account", async () => {
    const { turn, thread, usage, refresh } = await setup();
    thread("thr_source", OPUS, { turns: 3 });
    await turn("thr_source");
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_fork", OPUS, { sourceThreadId: "thr_source" });
    expect(await turn("thr_fork")).toEqual([]);
  });

  it("moves a pinned thread off A at the move limits, and back once it has headroom again", async () => {
    const { turn, thread, usage, refresh } = await setup();
    thread("thr_a");
    await turn("thr_a");
    usage.set("~/.claude", { session: 98, weekly: 17 });
    await refresh();
    expect(await turn("thr_a")).toEqual(B_ENV);
    usage.set("~/.claude-b", { session: 99, weekly: 3 });
    usage.set("~/.claude", { session: 5, weekly: 18 });
    await refresh();
    expect(await turn("thr_a")).toEqual([]);
  });

  it("moves only threads on a model whose weekly allowance is spent", async () => {
    const { turn, thread, usage, refresh } = await setup();
    thread("thr_fable", "claude-bridge/claude-fable-5-1");
    thread("thr_sonnet", "claude-bridge/claude-sonnet-5-5");
    usage.set("~/.claude", { session: 40, weekly: 30, fable: 100 });
    await refresh();
    expect(await turn("thr_fable", "claude-bridge/claude-fable-5-1")).toEqual(B_ENV);
    expect(await turn("thr_sonnet", "claude-bridge/claude-sonnet-5-5")).toEqual([]);
  });

  it("routes a turn by the model it is about to run on, not the thread's previous model", async () => {
    const { turn, thread, usage, refresh, harness } = await setup();
    thread("thr_a");
    await turn("thr_a", "claude-bridge/claude-sonnet-5-5");
    usage.set("~/.claude", { session: 40, weekly: 30, fable: 100 });
    await refresh();
    expect(await turn("thr_a", "claude-bridge/claude-fable-5-1")).toEqual(B_ENV);
    expect((await harness.behavior.runCli(["explain", "thr_a", "--json"])).stdout).toContain('"model":"claude-bridge/claude-fable-5-1"');
  });

  it("routes the first Claude turn after a turn on another provider's model", async () => {
    const { turn, thread, usage, refresh, harness } = await setup();
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_a");
    expect(await turn("thr_a")).toEqual(B_ENV);
    expect(await turn("thr_a", CODEX)).toEqual([]);
    expect(await turn("thr_a", OPUS)).toEqual(B_ENV);
    usage.set("~/.claude-b", { session: 99, weekly: 3 });
    usage.set("~/.claude", { session: 5, weekly: 18 });
    await refresh();
    await turn("thr_a", CODEX);
    expect(await turn("thr_a", OPUS)).toEqual([]);
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("is pinned to A since");
  });

  it("falls back to the thread's last request when bb resolves the environment without a dispatch", async () => {
    const { env, thread, harness } = await setup();
    thread("thr_a", OPUS, { turns: 2 });
    await harness.behavior.runCli(["pin", "thr_a", "B"]);
    expect(await env("thr_a")).toEqual(B_ENV);
    thread("thr_gpt", CODEX, { turns: 2 });
    expect(await env("thr_gpt")).toEqual([]);
  });

  it("lets every message through its dispatch hook, whatever the context", async () => {
    const { dispatchHook } = await setup();
    expect(await dispatchHook()(makeMessageDispatchHookContext({ requestedExecution: { model: null } }))).toEqual({ action: "proceed" });
    expect(await dispatchHook()(makeMessageDispatchHookContext({ attempt: "join-turn" }))).toEqual({ action: "proceed" });
  });

  it("leaves other models, catalog listings, and unknown threads alone", async () => {
    const { env, turn, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 99, weekly: 17 });
    await refresh();
    thread("thr_gpt", "openai-codex/gpt-6.1-sol");
    expect(await turn("thr_gpt")).toEqual([]);
    expect(await env(null)).toEqual([]);
    expect(await env("thr_missing")).toEqual([]);
  });

  it("keeps MacBook threads on A because B is not signed in there", async () => {
    const { turn, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 99, weekly: 17 });
    await refresh();
    thread("thr_mac");
    expect(await turn("thr_mac", undefined, MACBOOK)).toEqual([]);
  });

  it("moves a thread and queues a retry after a Claude limit failure", async () => {
    const { harness, turn, thread, retries, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour) — resets 5:20:00 PM: You've hit your session limit"];
    const before = Date.now();
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_a", requestId: lastRequestId("thr_a"), errorInfo: null, attemptNumber: 1 }),
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ threadId: "thr_a", turnRequestId: lastRequestId("thr_a") });
    expect(retries[0]!.sendAt! - before).toBeGreaterThanOrEqual(15_000);
    expect(retries[0]!.sendAt! - before).toBeLessThan(46_000);
    expect(retries[0]!.reason).toContain("retrying on B");
    const explained = await harness.behavior.runCli(["explain", "thr_a"]);
    expect(explained.stdout).toContain("pinned to B");
    expect(explained.stdout).toContain("A retry runs in");
    expect(await turn("thr_a")).toEqual(B_ENV);
  });

  it("keeps a running turn on its account when a message joins it, so the turn's limit failure moves it", async () => {
    const { harness, turn, join, thread, usage, refresh, retries, lastRequestId } = await setup();
    const one = thread("thr_one");
    const two = thread("thr_two");
    // Both turns start on A and are still running when A crosses the move limit.
    expect(await turn("thr_one")).toEqual([]);
    expect(await turn("thr_two")).toEqual([]);
    usage.set("~/.claude", { session: 98, weekly: 17 });
    await refresh();
    const joined = await join("thr_one");
    // A runs out under both turns.
    const limit = "Claude quota exceeded — rate limit (five_hour) — resets 7:00:00 PM: You've hit your session limit";
    one.errors = [limit];
    two.errors = [limit];
    const before = Date.now();
    for (const threadId of ["thr_one", "thr_two"]) {
      await harness.behavior.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({ threadId, requestId: lastRequestId(threadId), errorInfo: null, attemptNumber: 1 }),
      );
    }
    const status = JSON.parse((await harness.behavior.runCli(["status", "--json"])).stdout) as {
      accounts: Array<{ name: string; blockedUntil: number | null }>;
    };
    expect(status.accounts.map((account) => [account.name, account.blockedUntil !== null])).toEqual([
      ["A", true],
      ["B", false],
    ]);
    expect(retries.map((retry) => [retry.threadId, retry.reason])).toEqual([
      ["thr_one", "Claude Accounts: A hit its session limit; retrying on B"],
      ["thr_two", "Claude Accounts: A hit its session limit; retrying on B"],
    ]);
    for (const retry of retries) expect(retry.sendAt! - before).toBeLessThan(46_000);
    expect(joined).toEqual([]);
  });

  it("names the account that frees up first when every account is out of quota", async () => {
    const { harness, turn, thread, usage, refresh, retries, lastRequestId } = await setup();
    usage.set("~/.claude", { session: 99, weekly: 17 });
    await refresh();
    const fake = thread("thr_b");
    expect(await turn("thr_b")).toEqual(B_ENV);
    fake.errors = ["Claude quota exceeded — rate limit (five_hour) — resets 8:10:00 PM: You've hit your session limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_b", requestId: lastRequestId("thr_b"), errorInfo: null, attemptNumber: 1 }),
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]!.reason).toBe("Claude Accounts: every account is out of quota; retrying when A frees up");
  });

  it("drops its queued retry when the thread starts another turn first", async () => {
    const { harness, turn, thread, retries, queued, deletedRows, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour): You've hit your session limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_a", requestId: lastRequestId("thr_a"), errorInfo: null, attemptNumber: 1 }),
    );
    expect(retries).toHaveLength(1);
    fake.errors = [];
    await turn("thr_a", CODEX);
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect(deletedRows).toEqual(["qm_1"]);
    expect(queued.get("thr_a")).toEqual([]);
    const explained = (await harness.behavior.runCli(["explain", "thr_a"])).stdout;
    expect(explained).toContain("Dropped the queued retry: the thread started another turn first.");
    expect(explained).not.toContain("A retry runs in");
  });

  it("lifts a limit-failure block once a usage reading well after the failure shows room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { harness, turn, thread, usage, refresh, lastRequestId } = await setup();
      usage.set("~/.claude", { session: 99, weekly: 17 });
      await refresh();
      const fake = thread("thr_b");
      expect(await turn("thr_b")).toEqual(B_ENV);
      fake.errors = ["Claude quota exceeded — rate limit (five_hour) — resets 8:10:00 PM: You've hit your session limit"];
      await harness.behavior.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({ threadId: "thr_b", requestId: lastRequestId("thr_b"), errorInfo: null, attemptNumber: 1 }),
      );
      const blocked = async () => (await harness.behavior.runCli([])).stdout.includes("Blocked after a limit failure");
      await refresh();
      expect(await blocked()).toBe(true);
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await refresh();
      expect(await blocked()).toBe(false);
      thread("thr_new");
      expect(await turn("thr_new")).toEqual(B_ENV);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still keeps an account out when the reading that lifts its block shows the window full", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { harness, turn, thread, usage, refresh, lastRequestId } = await setup();
      usage.set("~/.claude", { session: 99, weekly: 17 });
      await refresh();
      const fake = thread("thr_b");
      expect(await turn("thr_b")).toEqual(B_ENV);
      fake.errors = ["Claude quota exceeded — rate limit (five_hour) — resets 8:10:00 PM: You've hit your session limit"];
      await harness.behavior.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({ threadId: "thr_b", requestId: lastRequestId("thr_b"), errorInfo: null, attemptNumber: 1 }),
      );
      usage.set("~/.claude-b", { session: 100, weekly: 3 });
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await refresh();
      thread("thr_new");
      expect(await turn("thr_new")).not.toEqual(B_ENV);
      expect((await harness.behavior.runCli(["explain", "thr_new"])).stdout).toContain("No account has headroom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves its retry alone when the turn that starts is the retry itself", async () => {
    const { harness, turn, thread, queued, deletedRows, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour): You've hit your session limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_a", requestId: lastRequestId("thr_a"), errorInfo: null, attemptNumber: 1 }),
    );
    queued.set("thr_a", []);
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_a" }) });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect(deletedRows).toEqual([]);
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("retrying on B");
  });

  it("records a queued retry cancelled by hand and stops watching it", async () => {
    const { harness, turn, thread, deletedRows, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour): You've hit your session limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_a", requestId: lastRequestId("thr_a"), errorInfo: null, attemptNumber: 1 }),
    );
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_other", threadId: "thr_a" }) });
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("retrying on B");
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_1", threadId: "thr_a" }) });
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("The queued retry was cancelled by hand.");
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect(deletedRows).toEqual([]);
  });

  it("leaves the retry to Provider Retry when bb classified the rate limit", async () => {
    const { harness, turn, thread, retries, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour): limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "thr_a",
        requestId: lastRequestId("thr_a"),
        errorInfo: { category: "rate-limit", httpStatusCode: 429 } as never,
      }),
    );
    expect(retries).toHaveLength(0);
    expect(await harness.behavior.callRpc("provider-retry.v1.availability", { threadId: "thr_a", requestId: lastRequestId("thr_a") })).toEqual({
      kind: "ready",
    });
    expect(await turn("thr_a")).toEqual(B_ENV);
  });

  it("ignores failures that are not Claude limits", async () => {
    const { harness, turn, thread, retries, lastRequestId } = await setup();
    const fake = thread("thr_a");
    await turn("thr_a");
    fake.errors = ["WebSocket closed 1000"];
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_a", requestId: lastRequestId("thr_a") }));
    expect(retries).toHaveLength(0);
    expect(await turn("thr_a")).toEqual([]);
  });

  it("decides but changes nothing in observe mode", async () => {
    const { harness, turn, thread, usage, refresh } = await setup({ settings: { mode: "observe" } });
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_new");
    expect(await turn("thr_new")).toEqual([]);
    expect((await harness.behavior.runCli(["explain", "thr_new"])).stdout).toContain("pinned to B");
  });

  it("honors a hand-made pin and forgets pins of deleted threads", async () => {
    const { harness, turn, thread } = await setup();
    thread("thr_a");
    expect((await harness.behavior.runCli(["pin", "thr_a", "B"])).exitCode).toBe(0);
    expect(await turn("thr_a")).toEqual(B_ENV);
    expect(await turn("thr_a")).toEqual(B_ENV);
    expect((await harness.behavior.runCli(["pin", "thr_a", "Z"])).exitCode).not.toBe(0);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("has no pin");
  });

  it("returns an unpinned thread to the rules and records why", async () => {
    const { harness, turn, thread } = await setup();
    thread("thr_a");
    await harness.behavior.runCli(["pin", "thr_a", "B"]);
    expect(await turn("thr_a")).toEqual(B_ENV);
    expect((await harness.behavior.runCli(["unpin", "thr_a"])).stdout).toContain("Unpinned thr_a.");
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("Unpinned from B by hand");
    expect(await turn("thr_a")).toEqual([]);
    const explained = (await harness.behavior.runCli(["explain", "thr_a"])).stdout;
    expect(explained).toContain("is pinned to A since");
    expect(explained).toContain("Unpinned from B by hand");
  });

  it("publishes every account through provider-usage.v1", async () => {
    const { harness } = await setup();
    expect(await harness.behavior.callRpc("provider-usage.v1.listResources", {})).toEqual({
      label: "Claude Accounts",
      resources: [
        { id: "A", accountKey: "anthropic:account:uuid-a", providerId: "claude-code", label: "a@example.com", scope: { kind: "shared" } },
        { id: "B", accountKey: "anthropic:account:uuid-b", providerId: "claude-code", label: "b@example.com", scope: { kind: "shared" } },
      ],
    });
    const measurement = (await harness.behavior.callRpc("provider-usage.v1.getResource", { resourceId: "A", refresh: false })) as {
      usage: { status: string; planLabel: string; windows: Array<{ kind: string; label: string; usedPercent: number }> };
    };
    expect(measurement.usage.status).toBe("ok");
    expect(measurement.usage.planLabel).toBe("Max (20x)");
    expect(measurement.usage.windows.map((window) => [window.kind, window.label, window.usedPercent])).toEqual([
      ["five-hour", "Current session", 40],
      ["weekly", "Weekly limit", 17],
      ["weekly", "Weekly · Fable", 1],
    ]);
  });

  it("prints a status with machines, usage, and pinned counts", async () => {
    const { harness, turn, thread } = await setup();
    thread("thr_a");
    await turn("thr_a");
    const { stdout, exitCode } = await harness.behavior.runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("A  ~/.claude  a@example.com  Max (20x)  · 1 thread(s) pinned");
    expect(stdout).toContain("B  ~/.claude-b  b@example.com  Pro  · 0 thread(s) pinned");
    expect(stdout).toContain("macbook not signed in");
    expect(stdout).toContain("Session 40%");
  });
});
