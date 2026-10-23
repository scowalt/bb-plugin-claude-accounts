import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const BEELINK = "host_beelink";
const MACBOOK = "host_macbook";

interface FakeThread {
  model: string;
  requestId: string;
  errors: string[];
  /** How many turns the thread has had, the current one included. */
  turns: number;
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
            if (args.types?.[0] === "client/turn/requested") {
              const count = Math.min(thread.turns, Number(args.limit ?? thread.turns));
              return Array.from({ length: count }, (_, index) =>
                row(10 - index, "client/turn/requested", {
                  requestId: index === 0 ? thread.requestId : `${thread.requestId}_earlier_${index}`,
                  execution: { model: thread.model },
                }, args.threadId),
              );
            }
            if (args.types?.[0] === "provider/error") {
              return thread.errors.map((detail, index) =>
                row(20 + index, "provider/error", { providerThreadId: "pi_1", message: "Provider error", detail }, args.threadId),
              );
            }
            return [];
          },
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, sourceThreadId: threads.get(threadId)?.sourceThreadId ?? null }),
        retry: async (args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }) => {
          retries.push(args);
          return {} as never;
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
  const env = (threadId: string | null, hostId = BEELINK) =>
    harness.behavior.resolveProviderEnv("pi", { threadId: threadId as string, projectId: "proj_1", hostId });
  const thread = (
    threadId: string,
    model = "claude-bridge/claude-opus-5-5",
    options: { turns?: number; sourceThreadId?: string } = {},
  ) => {
    threads.set(threadId, {
      model,
      requestId: `req_${threadId}`,
      errors: [],
      turns: options.turns ?? 1,
      sourceThreadId: options.sourceThreadId ?? null,
    });
    return threads.get(threadId)!;
  };
  return { harness, threads, usage, retries, refresh, env, thread };
}

const B_ENV = [
  { name: "CLAUDE_CONFIG_DIR", value: "/home/u/.claude-b", reason: "Claude Accounts: this turn uses account B" },
  { name: "BB_CLAUDE_ACCOUNT", value: "B", reason: "Claude Accounts: the account this turn uses" },
];

describe("claude-accounts", () => {
  it("leaves Claude threads on the default login while it has headroom", async () => {
    const { env, thread } = await setup();
    thread("thr_a");
    expect(await env("thr_a")).toEqual([]);
  });

  it("sends new threads to B once A is past the new-thread limits, and keeps pinned threads on A", async () => {
    const { env, thread, usage, refresh } = await setup();
    thread("thr_a");
    await env("thr_a");
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_new");
    expect(await env("thr_new")).toEqual(B_ENV);
    expect(await env("thr_a")).toEqual([]);
  });

  it("keeps threads that ran before the plugin on the default login until the move limits", async () => {
    const { env, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_old", "claude-bridge/claude-opus-5-5", { turns: 5 });
    thread("thr_fresh");
    expect(await env("thr_old")).toEqual([]);
    expect(await env("thr_fresh")).toEqual(B_ENV);
    usage.set("~/.claude", { session: 98, weekly: 17 });
    await refresh();
    expect(await env("thr_old")).toEqual(B_ENV);
  });

  it("starts a fork on its source thread's account", async () => {
    const { env, thread, usage, refresh } = await setup();
    thread("thr_source", "claude-bridge/claude-opus-5-5", { turns: 3 });
    await env("thr_source");
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_fork", "claude-bridge/claude-opus-5-5", { sourceThreadId: "thr_source" });
    expect(await env("thr_fork")).toEqual([]);
  });

  it("moves a pinned thread off A at the move limits, and back once it has headroom again", async () => {
    const { env, thread, usage, refresh } = await setup();
    thread("thr_a");
    await env("thr_a");
    usage.set("~/.claude", { session: 98, weekly: 17 });
    await refresh();
    expect(await env("thr_a")).toEqual(B_ENV);
    usage.set("~/.claude-b", { session: 99, weekly: 3 });
    usage.set("~/.claude", { session: 5, weekly: 18 });
    await refresh();
    expect(await env("thr_a")).toEqual([]);
  });

  it("moves only threads on a model whose weekly allowance is spent", async () => {
    const { env, thread, usage, refresh } = await setup();
    thread("thr_fable", "claude-bridge/claude-fable-5-1");
    thread("thr_sonnet", "claude-bridge/claude-sonnet-5-5");
    usage.set("~/.claude", { session: 40, weekly: 30, fable: 100 });
    await refresh();
    expect(await env("thr_fable")).toEqual(B_ENV);
    expect(await env("thr_sonnet")).toEqual([]);
  });

  it("leaves other models, catalog listings, and unknown threads alone", async () => {
    const { env, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 99, weekly: 17 });
    await refresh();
    thread("thr_gpt", "openai-codex/gpt-6.1-sol");
    expect(await env("thr_gpt")).toEqual([]);
    expect(await env(null)).toEqual([]);
    expect(await env("thr_missing")).toEqual([]);
  });

  it("keeps MacBook threads on A because B is not signed in there", async () => {
    const { env, thread, usage, refresh } = await setup();
    usage.set("~/.claude", { session: 99, weekly: 17 });
    await refresh();
    thread("thr_mac");
    expect(await env("thr_mac", MACBOOK)).toEqual([]);
  });

  it("moves a thread and queues a retry after a Claude limit failure", async () => {
    const { harness, env, thread, retries } = await setup();
    const fake = thread("thr_a");
    await env("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour) — resets 5:20:00 PM: You've hit your session limit"];
    const before = Date.now();
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_a", requestId: "req_thr_a", errorInfo: null, attemptNumber: 1 }),
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ threadId: "thr_a", turnRequestId: "req_thr_a" });
    expect(retries[0]!.sendAt! - before).toBeGreaterThanOrEqual(15_000);
    expect(retries[0]!.sendAt! - before).toBeLessThan(46_000);
    expect(retries[0]!.reason).toContain("retrying on B");
    expect(await env("thr_a")).toEqual(B_ENV);
    const explained = await harness.behavior.runCli(["explain", "thr_a"]);
    expect(explained.stdout).toContain("pinned to B");
    expect(explained.stdout).toContain("A retry runs in");
  });

  it("leaves the retry to Provider Retry when bb classified the rate limit", async () => {
    const { harness, env, thread, retries } = await setup();
    const fake = thread("thr_a");
    await env("thr_a");
    fake.errors = ["Claude quota exceeded — rate limit (five_hour): limit"];
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "thr_a",
        requestId: "req_thr_a",
        errorInfo: { category: "rate-limit", httpStatusCode: 429 } as never,
      }),
    );
    expect(retries).toHaveLength(0);
    expect(await env("thr_a")).toEqual(B_ENV);
    expect(await harness.behavior.callRpc("provider-retry.v1.availability", { threadId: "thr_a", requestId: "req_thr_a" })).toEqual({
      kind: "ready",
    });
  });

  it("ignores failures that are not Claude limits", async () => {
    const { harness, env, thread, retries } = await setup();
    const fake = thread("thr_a");
    await env("thr_a");
    fake.errors = ["WebSocket closed 1000"];
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_a", requestId: "req_thr_a" }));
    expect(retries).toHaveLength(0);
    expect(await env("thr_a")).toEqual([]);
  });

  it("decides but changes nothing in observe mode", async () => {
    const { harness, env, thread, usage, refresh } = await setup({ settings: { mode: "observe" } });
    usage.set("~/.claude", { session: 90, weekly: 17 });
    await refresh();
    thread("thr_new");
    expect(await env("thr_new")).toEqual([]);
    expect((await harness.behavior.runCli(["explain", "thr_new"])).stdout).toContain("pinned to B");
  });

  it("honors a hand-made pin and forgets pins of deleted threads", async () => {
    const { harness, env, thread } = await setup();
    thread("thr_a");
    expect((await harness.behavior.runCli(["pin", "thr_a", "B"])).exitCode).toBe(0);
    await env("thr_a");
    expect(await env("thr_a")).toEqual(B_ENV);
    expect((await harness.behavior.runCli(["pin", "thr_a", "Z"])).exitCode).not.toBe(0);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("has no pin");
  });

  it("returns an unpinned thread to the rules and records why", async () => {
    const { harness, env, thread } = await setup();
    const fake = thread("thr_a");
    await harness.behavior.runCli(["pin", "thr_a", "B"]);
    expect(await env("thr_a")).toEqual(B_ENV);
    expect((await harness.behavior.runCli(["unpin", "thr_a"])).stdout).toContain("Unpinned thr_a.");
    expect((await harness.behavior.runCli(["explain", "thr_a"])).stdout).toContain("Unpinned from B by hand");
    fake.turns = 3;
    expect(await env("thr_a")).toEqual([]);
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
    const { harness, env, thread } = await setup();
    thread("thr_a");
    await env("thr_a");
    const { stdout, exitCode } = await harness.behavior.runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("A  ~/.claude  a@example.com  Max (20x)  · 1 thread(s) pinned");
    expect(stdout).toContain("B  ~/.claude-b  b@example.com  Pro  · 0 thread(s) pinned");
    expect(stdout).toContain("macbook not signed in");
    expect(stdout).toContain("Session 40%");
  });
});
