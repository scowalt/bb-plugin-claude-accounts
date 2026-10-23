// Account settings and plan facts. Pure: no file system, no network.

/** The directory Claude Code uses when CLAUDE_CONFIG_DIR is unset. */
export const DEFAULT_DIRECTORY = "~/.claude";
export const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export interface AccountSpec {
  name: string;
  /** As configured: `~/…` resolves against each machine's home directory. */
  directory: string;
  /** Position in the setting; the last tie-break. */
  order: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const MAX_ACCOUNTS = 8;

export function normalizeDirectory(directory: string): string {
  const trimmed = directory.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/u, "") : trimmed;
}

/** Parses `A=~/.claude, B=~/.claude-b`. Throws an Error whose message suits a settings field. */
export function parseAccounts(value: string): AccountSpec[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new Error("List at least one account, for example A=~/.claude.");
  if (entries.length > MAX_ACCOUNTS) throw new Error(`List at most ${MAX_ACCOUNTS} accounts.`);
  const names = new Set<string>();
  const directories = new Set<string>();
  return entries.map((entry, order) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`"${entry}" must look like Name=~/.claude-b.`);
    const name = entry.slice(0, separator).trim();
    const directory = normalizeDirectory(entry.slice(separator + 1));
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`"${name}" is not a valid account name: use up to 32 letters, digits, - or _.`);
    }
    if (!(directory === "~" || directory.startsWith("~/") || directory.startsWith("/"))) {
      throw new Error(`${name}: the directory must start with ~/ or /.`);
    }
    if (names.has(name.toLowerCase())) throw new Error(`The account name ${name} appears twice.`);
    if (directories.has(directory)) throw new Error(`The directory ${directory} appears twice.`);
    names.add(name.toLowerCase());
    directories.add(directory);
    return { name, directory, order };
  });
}

/** Max 20x → 20, Max 5x → 5, Pro → 1, from the login's rate-limit tier. Null when unknown. */
export function planWeight(rateLimitTier: string | null, subscriptionType: string | null): number | null {
  const max = /max_(\d+)x/u.exec(rateLimitTier ?? "");
  if (max) return Number(max[1]);
  if (subscriptionType === "pro" || rateLimitTier === "default_claude_ai") return 1;
  return null;
}

export function planLabel(rateLimitTier: string | null, subscriptionType: string | null): string | null {
  const max = /max_(\d+)x/u.exec(rateLimitTier ?? "");
  if (max) return `Max (${max[1]}x)`;
  if (!subscriptionType) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

export function isClaudeBridgeModel(model: string): boolean {
  return model.startsWith("claude-bridge/");
}

export function modelFamily(model: string): ModelFamily | null {
  const id = model.toLowerCase();
  return MODEL_FAMILIES.find((family) => id.includes(family)) ?? null;
}

export function parseModelPatterns(value: string): string[] {
  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}

/** `*` matches any run of characters; everything else is literal. */
export function matchesModelPattern(model: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(model);
}
