// Host-side reads of Claude Code config directories. Runs on each machine; never refreshes or rewrites credentials.
import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { z } from "zod";
import type { InspectedAccount, UsageRead } from "./contract";
import { parseUsageResponse } from "./usage";

export interface ClaudeHomeDeps {
  home: string;
  platform: NodeJS.Platform;
  /** Rejects with code ENOENT when the file is missing. */
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** The Keychain item's secret (`withSecret`) or "" when it only exists; null when it is missing. */
  keychain(service: string, withSecret: boolean, signal?: AbortSignal): Promise<string | null>;
  fetch: typeof fetch;
  /** The installed Claude Code version, for a client-compatible user agent. */
  cliVersion(signal?: AbortSignal): Promise<string | null>;
  now(): number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 15_000;
/** Treat a token this close to expiry as expired; Claude Code renews it on next use. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullable().optional(),
    refreshTokenExpiresAt: z.number().nullable().optional(),
    subscriptionType: z.string().nullable().optional(),
    rateLimitTier: z.string().nullable().optional(),
  }),
});
type Credentials = z.infer<typeof credentialsSchema>["claudeAiOauth"];

const identitySchema = z.object({
  oauthAccount: z
    .object({
      accountUuid: z.string().nullable().optional(),
      organizationUuid: z.string().nullable().optional(),
      emailAddress: z.string().nullable().optional(),
      organizationType: z.string().nullable().optional(),
      organizationRateLimitTier: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export function resolveDirectory(directory: string, home: string): string {
  const resolved =
    directory === "~" ? home : directory.startsWith("~/") ? join(home, directory.slice(2)) : directory;
  const normalized = normalize(resolved);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

export function isDefaultPath(path: string, home: string): boolean {
  return normalize(path) === normalize(join(home, ".claude"));
}

/** Claude Code's Keychain item: the default login, or one suffixed by a hash of CLAUDE_CONFIG_DIR. */
export function keychainService(path: string, isDefault: boolean): string {
  if (isDefault) return DEFAULT_KEYCHAIN_SERVICE;
  const hash = createHash("sha256").update(path.normalize("NFC")).digest("hex").slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${hash}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Linux and other platforms keep `.credentials.json` in the directory; macOS keeps it in the Keychain. */
async function readCredentials(
  path: string,
  isDefault: boolean,
  deps: ClaudeHomeDeps,
  signal?: AbortSignal,
): Promise<Credentials | null> {
  let raw: string | null;
  if (deps.platform === "darwin") {
    raw = await deps.keychain(keychainService(path, isDefault), true, signal);
  } else {
    try {
      raw = await deps.readFile(join(path, ".credentials.json"), signal);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  if (raw === null) return null;
  const parsed = credentialsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data.claudeAiOauth : null;
}

async function hasLogin(path: string, isDefault: boolean, deps: ClaudeHomeDeps, signal?: AbortSignal) {
  if (deps.platform === "darwin") {
    return (await deps.keychain(keychainService(path, isDefault), false, signal)) !== null;
  }
  return (await readCredentials(path, isDefault, deps, signal)) !== null;
}

export async function inspectDirectory(
  directory: string,
  deps: ClaudeHomeDeps,
  signal?: AbortSignal,
): Promise<InspectedAccount> {
  const path = resolveDirectory(directory, deps.home);
  const isDefault = isDefaultPath(path, deps.home);
  const base: InspectedAccount = {
    directory,
    path,
    isDefault,
    exists: false,
    signedIn: false,
    accountUuid: null,
    organizationUuid: null,
    email: null,
    subscriptionType: null,
    rateLimitTier: null,
    refreshTokenExpiresAt: null,
    error: null,
  };
  try {
    if (!(await deps.exists(path))) return base;
    const account: InspectedAccount = { ...base, exists: true };
    const identityPath = isDefault ? join(deps.home, ".claude.json") : join(path, ".claude.json");
    try {
      const identity = identitySchema.parse(JSON.parse(await deps.readFile(identityPath, signal))).oauthAccount;
      account.accountUuid = identity?.accountUuid ?? null;
      account.organizationUuid = identity?.organizationUuid ?? null;
      account.email = identity?.emailAddress ?? null;
      account.rateLimitTier = identity?.organizationRateLimitTier ?? null;
      account.subscriptionType = identity?.organizationType?.replace(/^claude_/u, "") ?? null;
    } catch (error) {
      if (!isMissing(error)) account.error = `Could not read ${identityPath}: ${message(error)}`;
    }
    if (deps.platform === "darwin") {
      account.signedIn = await hasLogin(path, isDefault, deps, signal);
      return account;
    }
    const credentials = await readCredentials(path, isDefault, deps, signal);
    account.signedIn = credentials !== null;
    account.subscriptionType = credentials?.subscriptionType ?? account.subscriptionType;
    account.rateLimitTier = credentials?.rateLimitTier ?? account.rateLimitTier;
    account.refreshTokenExpiresAt = credentials?.refreshTokenExpiresAt ?? null;
    return account;
  } catch (error) {
    return { ...base, error: message(error) };
  }
}

export async function readUsage(directory: string, deps: ClaudeHomeDeps, signal?: AbortSignal): Promise<UsageRead> {
  const path = resolveDirectory(directory, deps.home);
  const isDefault = isDefaultPath(path, deps.home);
  let credentials: Credentials | null;
  try {
    credentials = await readCredentials(path, isDefault, deps, signal);
  } catch (error) {
    return { status: "error", message: `Could not read the login in ${path}: ${message(error)}` };
  }
  if (credentials === null) return { status: "signed-out", message: `No Claude Code login in ${path}.` };
  const now = deps.now();
  if (typeof credentials.expiresAt === "number" && credentials.expiresAt <= now + EXPIRY_MARGIN_MS) {
    return { status: "expired", message: "The access token has expired; Claude Code renews it the next time it uses this account." };
  }
  const version = (await deps.cliVersion(signal)) ?? "2.1.0";
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(USAGE_TIMEOUT_MS)])
    : AbortSignal.timeout(USAGE_TIMEOUT_MS);
  try {
    const response = await deps.fetch(USAGE_URL, {
      method: "GET",
      redirect: "error",
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
        "User-Agent": `claude-cli/${version} (external, cli) bb-claude-accounts`,
      },
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return { status: "expired", message: "Anthropic rejected the access token; Claude Code renews it on next use." };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: "error", message: `Anthropic returned HTTP ${response.status} for usage.` };
    }
    return { status: "ok", observedAt: deps.now(), windows: parseUsageResponse(await response.json()) };
  } catch (error) {
    return { status: "error", message: `Could not read usage: ${message(error)}` };
  }
}
