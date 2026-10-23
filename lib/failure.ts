// Recognizes a Claude subscription limit in the error text claude-bridge reports.
import { MODEL_FAMILIES, type ModelFamily } from "./accounts";

export interface ClaudeLimitFailure {
  /** The rate-limit type Claude Code reported, such as five_hour or seven_day_overage_included. */
  rateLimitType: string | null;
  scope: "session" | "weekly" | "family" | "unknown";
  family: ModelFamily | null;
}

/** pi-claude-bridge 0.9 says "Claude quota exceeded — rate limit (x) — resets …"; older releases said "Claude rate limit (x) — resets …". */
const LIMIT_PATTERN = /Claude (?:quota exceeded\s*[—–-]+\s*)?rate limit(?! warning)(?:\s*\(([A-Za-z0-9_]+)\))?/u;
const FAMILY_PATTERN = /reached your (\w+) limit/iu;

function familyOf(word: string | undefined): ModelFamily | null {
  return MODEL_FAMILIES.find((family) => family === word?.toLowerCase()) ?? null;
}

export function parseClaudeLimit(text: string): ClaudeLimitFailure | null {
  const match = LIMIT_PATTERN.exec(text);
  if (!match) return null;
  const rateLimitType = match[1] ?? null;
  const family =
    familyOf(FAMILY_PATTERN.exec(text)?.[1]) ??
    MODEL_FAMILIES.find((candidate) => rateLimitType?.endsWith(`_${candidate}`)) ??
    null;
  const scope = family
    ? "family"
    : rateLimitType === "five_hour"
      ? "session"
      : rateLimitType?.startsWith("seven_day")
        ? "weekly"
        : "unknown";
  return { rateLimitType, scope, family };
}
