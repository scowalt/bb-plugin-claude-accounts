// Which account a thread should use. Pure, so every rule is testable without bb.
import { currentPercent, resetsAtMs, type UsageWindow } from "./usage";

export interface Limits {
  session: number;
  weekly: number;
}

export interface Candidate {
  name: string;
  order: number;
  /** Plan size: Max 20x is 20, Max 5x is 5, Pro is 1; null when unknown. */
  weight: number | null;
  /** Signed in on the thread's machine. */
  available: boolean;
  /** Null until the account's usage has been read once. */
  windows: readonly UsageWindow[] | null;
  /** A limit failure blocks every model until this time. */
  blockedUntil: number | null;
  /** A limit failure on one model family blocks that family until this time. */
  blockedFamilies: Readonly<Record<string, number>>;
}

export interface PickInput {
  candidates: readonly Candidate[];
  pin: string | null;
  manualPin: boolean;
  family: string | null;
  preferSmall: boolean;
  newLimits: Limits;
  moveLimits: Limits;
  now: number;
}

export type PickReason = "pinned" | "manual" | "new" | "moved" | "waiting" | "none";

export interface Pick {
  account: string | null;
  reason: PickReason;
  /** One sentence for `explain`. */
  detail: string;
  /** The account has headroom under the limits that applied. */
  ready: boolean;
  /** When the first account frees up, if none has headroom now; null when unknown. */
  readyAt: number | null;
}

interface Blocker {
  label: string;
  until: number | null;
}

function blockers(candidate: Candidate, family: string | null, limits: Limits, now: number): Blocker[] {
  const found: Blocker[] = [];
  if (candidate.blockedUntil !== null && candidate.blockedUntil > now) {
    found.push({ label: "a recent limit failure", until: candidate.blockedUntil });
  }
  const familyBlock = family === null ? undefined : candidate.blockedFamilies[family];
  if (familyBlock !== undefined && familyBlock > now) {
    found.push({ label: `a recent ${family} limit failure`, until: familyBlock });
  }
  for (const window of candidate.windows ?? []) {
    const applies =
      window.kind === "session" || (window.kind === "weekly" && (window.model === null || window.model === family));
    if (!applies) continue;
    const limit = window.kind === "session" ? limits.session : limits.weekly;
    if (currentPercent(window, now) >= limit) {
      found.push({ label: `${window.label} at ${Math.round(window.usedPercent)}%`, until: resetsAtMs(window) });
    }
  }
  return found;
}

/** When the account is usable under `limits`: `now` if already, null if a blocker has no known end. */
function usableAt(candidate: Candidate, family: string | null, limits: Limits, now: number): number | null {
  let at = now;
  for (const blocker of blockers(candidate, family, limits, now)) {
    if (blocker.until === null) return null;
    at = Math.max(at, blocker.until);
  }
  return at;
}

function weekly(candidate: Candidate): UsageWindow | undefined {
  return candidate.windows?.find((window) => window.kind === "weekly" && window.model === null);
}

function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Larger plans first (smaller first with `preferSmall`), then measured before unmeasured, soonest weekly reset, least weekly use, setting order. */
function compare(a: Candidate, b: Candidate, preferSmall: boolean, now: number): number {
  if (a.weight !== b.weight) {
    if (a.weight === null) return 1;
    if (b.weight === null) return -1;
    return preferSmall ? a.weight - b.weight : b.weight - a.weight;
  }
  const measured = Number(a.windows === null) - Number(b.windows === null);
  if (measured !== 0) return measured;
  const weeklyA = weekly(a);
  const weeklyB = weekly(b);
  const reset = compareNullable(weeklyA ? resetsAtMs(weeklyA) : null, weeklyB ? resetsAtMs(weeklyB) : null);
  if (reset !== 0) return reset;
  const used = compareNullable(
    weeklyA ? currentPercent(weeklyA, now) : null,
    weeklyB ? currentPercent(weeklyB, now) : null,
  );
  if (used !== 0) return used;
  return a.order - b.order;
}

function describe(found: readonly Blocker[]): string {
  return found.map((blocker) => blocker.label).join(", ");
}

export function pickAccount(input: PickInput): Pick {
  const { candidates, family, now, preferSmall } = input;
  const pinned = input.pin === null ? undefined : candidates.find((candidate) => candidate.name === input.pin);
  const pinUsable = pinned !== undefined && pinned.available;

  if (pinUsable && input.manualPin) {
    const ready = blockers(pinned, family, input.moveLimits, now).length === 0;
    return {
      account: pinned.name,
      reason: "manual",
      detail: `Pinned to ${pinned.name} by hand.`,
      ready,
      readyAt: ready ? null : usableAt(pinned, family, input.moveLimits, now),
    };
  }
  const pinBlockers = pinUsable ? blockers(pinned, family, input.moveLimits, now) : [];
  if (pinUsable && pinBlockers.length === 0) {
    return {
      account: pinned.name,
      reason: "pinned",
      detail: `Stays on ${pinned.name}, which is under the move limits.`,
      ready: true,
      readyAt: null,
    };
  }

  const under = (limits: Limits) =>
    candidates
      .filter((candidate) => candidate.available && blockers(candidate, family, limits, now).length === 0)
      .sort((a, b) => compare(a, b, preferSmall, now));
  const roomy = under(input.newLimits);
  const best = roomy[0] ?? under(input.moveLimits)[0];
  if (best !== undefined) {
    const tight = roomy.length === 0 ? " (every account is past the new-thread limits; this one is still under the move limits)" : "";
    if (input.pin === null) {
      return {
        account: best.name,
        reason: "new",
        detail: `Starts on ${best.name}, the ${preferSmall ? "smallest" : "largest"} plan with headroom${tight}.`,
        ready: true,
        readyAt: null,
      };
    }
    const why =
      pinned === undefined
        ? `${input.pin} is no longer configured`
        : !pinned.available
          ? `${pinned.name} is not signed in on this machine`
          : describe(pinBlockers);
    return {
      account: best.name,
      reason: "moved",
      detail: `Moves from ${input.pin} (${why}) to ${best.name}${tight}.`,
      ready: true,
      readyAt: null,
    };
  }

  const available = candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return {
      account: null,
      reason: "none",
      detail: "No configured account is signed in on this machine.",
      ready: false,
      readyAt: null,
    };
  }
  const times = new Map(available.map((candidate) => [candidate.name, usableAt(candidate, family, input.newLimits, now)]));
  const soonest = [...times.values()].reduce<number | null>(
    (earliest, at) => (at !== null && (earliest === null || at < earliest) ? at : earliest),
    null,
  );
  if (pinUsable) {
    return {
      account: pinned.name,
      reason: "waiting",
      detail: `No account has headroom (${pinned.name}: ${describe(pinBlockers)}); stays on ${pinned.name}.`,
      ready: false,
      readyAt: soonest,
    };
  }
  const first = [...available].sort(
    (a, b) => compareNullable(times.get(a.name) ?? null, times.get(b.name) ?? null) || compare(a, b, preferSmall, now),
  )[0]!;
  return {
    account: first.name,
    reason: "waiting",
    detail: `No account has headroom; starts on ${first.name}, which frees up first.`,
    ready: false,
    readyAt: soonest,
  };
}
