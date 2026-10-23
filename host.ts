// bb-plugin-claude-accounts — host entry. Runs on each machine and reads its Claude Code config directories.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { inspectDirectory, readUsage, type ClaudeHomeDeps } from "./lib/claude-home";
import { hostContract } from "./lib/contract";

const run = promisify(execFile);
/** `security` exits 44 when the Keychain item is missing. */
const KEYCHAIN_ITEM_MISSING = 44;

let cliVersion: Promise<string | null> | null = null;

const deps: ClaudeHomeDeps = {
  home: homedir(),
  platform: process.platform,
  readFile: (path, signal) => readFile(path, { encoding: "utf8", signal }),
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async keychain(service, withSecret, signal) {
    try {
      const { stdout } = await run(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, ...(withSecret ? ["-w"] : [])],
        { signal, timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      return withSecret ? stdout.trim() : "";
    } catch (error) {
      if ((error as { code?: unknown }).code === KEYCHAIN_ITEM_MISSING) return null;
      throw error;
    }
  },
  fetch: (input, init) => fetch(input, init),
  cliVersion() {
    cliVersion ??= run("claude", ["--version"], { timeout: 5_000 })
      .then(({ stdout }) => /\d+\.\d+\.\d+/u.exec(stdout)?.[0] ?? null)
      .catch(() => null);
    return cliVersion;
  },
  now: Date.now,
};

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspect: async ({ directories }, context) => ({
      home: deps.home,
      platform: deps.platform,
      accounts: await Promise.all(directories.map((directory) => inspectDirectory(directory, deps, context.signal))),
    }),
    readUsage: ({ directory }, context) => readUsage(directory, deps, context.signal),
  },
});
