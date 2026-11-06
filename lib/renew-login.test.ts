import { ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renewClaudeLogin } from "./renew-login";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

beforeEach(() => { vi.mocked(spawn).mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("renewClaudeLogin", () => {
  it("runs one isolated, bounded print request on the selected login, with output discarded", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-api-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://invalid.example");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-override");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("CLAUDECODE", "1");
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);
    const signal = new AbortController().signal;
    const pending = renewClaudeLogin("/home/u/.claude-c", signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p", "Reply OK.", "--model", "haiku", "--max-turns", "1", "--tools", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
      "--disable-slash-commands", "--no-session-persistence", "--system-prompt", "Reply OK.",
    ]);
    expect(options).toMatchObject({ signal, timeout: 60_000, stdio: "ignore", env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-c" } });
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE"]) {
      expect(options?.env).not.toHaveProperty(key);
    }
    expect(options?.cwd).not.toBe(process.cwd());
    expect((await stat(String(options?.cwd))).isDirectory()).toBe(true);
    child.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
    await expect(stat(String(options?.cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves CLAUDE_CONFIG_DIR unset for the default login, including with an inherited override", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/home/u/.claude-c");
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);
    const pending = renewClaudeLogin(join(homedir(), ".claude"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(vi.mocked(spawn).mock.calls[0]![2]?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    child.emit("exit", 0);
    await pending;
  });

  it.each(["exit", "error"])("hides subprocess diagnostics and cleans up on %s", async (event) => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);
    const pending = renewClaudeLogin("/home/u/.claude-c");
    const rejected = expect(pending).rejects.toThrow(/^Claude Code login renewal/);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const options = vi.mocked(spawn).mock.calls[0]![2];
    if (event === "error") child.emit("error", new Error("private diagnostics"));
    else child.emit("exit", 1);
    await rejected;
    await expect(stat(String(options?.cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never launches a process for an already aborted read", async () => {
    await expect(renewClaudeLogin("/home/u/.claude-c", AbortSignal.abort())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
