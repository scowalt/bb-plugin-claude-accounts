import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";

/**
 * `auth status` in 2.1.314 can skip startup renewal (tengu_quizzical_giraffe).
 * A one-turn Haiku print request reliably takes the session renewal path. It uses
 * a small amount of quota; only Claude Code handles rotating/writing credentials.
 */
export async function renewClaudeLogin(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), "bb-claude-renew-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: path };
    // The default login uses the unsuffixed Keychain item; an explicit config dir can select a different one.
    if (normalize(path) === join(homedir(), ".claude")) delete env.CLAUDE_CONFIG_DIR;
    // The directory's stored login must win over inherited auth/provider overrides.
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_AGENT_SDK_CLIENT_APP") {
        delete env[key];
      }
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("claude", [
        "-p", "Reply OK.",
        "--model", "haiku",
        "--max-turns", "1",
        "--tools", "",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt", "Reply OK.",
      ], { cwd, env, signal, timeout: 60_000, stdio: "ignore" });
      child.once("error", () => reject(new Error("Claude Code login renewal could not run.")));
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Claude Code login renewal did not complete."));
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
