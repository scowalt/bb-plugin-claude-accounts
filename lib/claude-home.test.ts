import { inspectDirectory, keychainService, readUsage, resolveDirectory, type ClaudeHomeDeps } from "./claude-home";
import { maxResponse } from "./fixtures";

const NOW = Date.parse("2026-10-23T14:00:00Z");
const HOME = "/home/u";

function credentials(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "token-a",
      refreshToken: "refresh-a",
      expiresAt: NOW + 6 * 3_600_000,
      refreshTokenExpiresAt: NOW + 20 * 86_400_000,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      ...overrides,
    },
  });
}

function identity(email: string, accountUuid: string, tier = "default_claude_max_20x", type = "claude_max") {
  return JSON.stringify({
    oauthAccount: {
      emailAddress: email,
      accountUuid,
      organizationUuid: `org-${accountUuid}`,
      organizationRateLimitTier: tier,
      organizationType: type,
    },
  });
}

function fakeMachine(files: Record<string, string>, overrides: Partial<ClaudeHomeDeps> = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const deps: ClaudeHomeDeps = {
    home: HOME,
    platform: "linux",
    async readFile(path) {
      if (path in files) return files[path]!;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    async exists(path) {
      return Object.keys(files).some((file) => file === path || file.startsWith(`${path}/`));
    },
    async keychain() {
      return null;
    },
    async fetch(url, init) {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(maxResponse), { status: 200, headers: { "content-type": "application/json" } });
    },
    async cliVersion() {
      return "2.1.309";
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, requests };
}

const machine = {
  [`${HOME}/.claude.json`]: identity("a@example.com", "uuid-a"),
  [`${HOME}/.claude/.credentials.json`]: credentials(),
  [`${HOME}/.claude-b/.claude.json`]: identity("b@example.com", "uuid-b", "default_claude_ai", "claude_pro"),
  [`${HOME}/.claude-b/.credentials.json`]: credentials({
    accessToken: "token-b",
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  }),
};

describe("resolveDirectory", () => {
  it("resolves ~ against the machine's home", () => {
    expect(resolveDirectory("~/.claude-b", HOME)).toBe("/home/u/.claude-b");
    expect(resolveDirectory("/opt/x/", HOME)).toBe("/opt/x");
  });
});

describe("inspectDirectory", () => {
  it("reads the default login's identity from ~/.claude.json", async () => {
    const { deps } = fakeMachine(machine);
    expect(await inspectDirectory("~/.claude", deps)).toEqual({
      directory: "~/.claude",
      path: "/home/u/.claude",
      isDefault: true,
      exists: true,
      signedIn: true,
      accountUuid: "uuid-a",
      organizationUuid: "org-uuid-a",
      email: "a@example.com",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      refreshTokenExpiresAt: NOW + 20 * 86_400_000,
      error: null,
    });
  });

  it("reads another directory's identity from inside it", async () => {
    const { deps } = fakeMachine(machine);
    expect(await inspectDirectory("~/.claude-b", deps)).toMatchObject({
      isDefault: false,
      signedIn: true,
      accountUuid: "uuid-b",
      email: "b@example.com",
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    });
  });

  it("reports a missing or signed-out directory", async () => {
    const { deps } = fakeMachine({ ...machine, [`${HOME}/.claude-c/.claude.json`]: "{}" });
    expect(await inspectDirectory("~/.claude-z", deps)).toMatchObject({ exists: false, signedIn: false });
    expect(await inspectDirectory("~/.claude-c", deps)).toMatchObject({ exists: true, signedIn: false, error: null });
  });

  it("uses the Keychain item tied to the directory on macOS without reading its secret", async () => {
    const asked: Array<[string, boolean]> = [];
    const { deps } = fakeMachine(
      { "/Users/u/.claude-b/.claude.json": identity("b@example.com", "uuid-b", "default_claude_ai", "claude_pro") },
      {
        home: "/Users/u",
        platform: "darwin",
        async keychain(service, withSecret) {
          asked.push([service, withSecret]);
          return service === keychainService("/Users/u/.claude-b", false) ? "" : null;
        },
      },
    );
    expect(await inspectDirectory("~/.claude-b", deps)).toMatchObject({
      signedIn: true,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    });
    expect(asked).toEqual([[keychainService("/Users/u/.claude-b", false), false]]);
    expect(keychainService("/Users/u/.claude", true)).toBe("Claude Code-credentials");
    expect(keychainService("/Users/u/.claude-b", false)).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/u);
  });
});

describe("readUsage", () => {
  it("reads usage with the directory's own token", async () => {
    const { deps, requests } = fakeMachine(machine);
    const result = await readUsage("~/.claude-b", deps);
    expect(result).toMatchObject({ status: "ok", observedAt: NOW });
    expect(result.status === "ok" ? result.windows.map((window) => window.id) : []).toEqual(["session", "weekly", "weekly:fable"]);
    expect(requests).toHaveLength(1);
    const headers = requests[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-b");
    expect(headers["User-Agent"]).toBe("claude-cli/2.1.309 (external, cli) bb-claude-accounts");
  });

  it("does not send an expired token", async () => {
    const { deps, requests } = fakeMachine({
      ...machine,
      [`${HOME}/.claude-b/.credentials.json`]: credentials({ expiresAt: NOW - 1 }),
    });
    expect(await readUsage("~/.claude-b", deps)).toMatchObject({ status: "expired" });
    expect(requests).toHaveLength(0);
  });

  it("reports rejected tokens and missing logins", async () => {
    const { deps } = fakeMachine(machine, { fetch: async () => new Response("no", { status: 401 }) });
    expect(await readUsage("~/.claude", deps)).toMatchObject({ status: "expired" });
    expect(await readUsage("~/.claude-z", deps)).toMatchObject({ status: "signed-out" });
  });
});
