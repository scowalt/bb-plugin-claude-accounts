// Text output for `bb claude-accounts`.
import type { EngineStatus, Explanation } from "./engine";
import { currentPercent, resetsAtMs, type UsageWindow } from "./usage";

export function formatDuration(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function when(at: number, now: number): string {
  return at >= now ? `in ${formatDuration(at - now)}` : `${formatDuration(now - at)} ago`;
}

export function formatWindows(windows: readonly UsageWindow[], now: number): string {
  return windows
    .filter((window) => window.kind !== "other")
    .map((window) => {
      const reset = resetsAtMs(window);
      const percent = Math.round(currentPercent(window, now));
      return reset === null ? `${window.label} ${percent}%` : `${window.label} ${percent}% (resets ${when(reset, now)})`;
    })
    .join(" · ");
}

export function formatStatus(status: EngineStatus, now: number): string {
  const lines = [
    `Mode: ${status.mode} · new threads need session < ${status.newLimits.session}% and weekly < ${status.newLimits.weekly}% · a thread moves at session ${status.moveLimits.session}% or weekly ${status.moveLimits.weekly}%`,
  ];
  if (status.smallAccountModels.length > 0) {
    lines.push(`Smallest account first for: ${status.smallAccountModels.join(", ")}`);
  }
  for (const account of status.accounts) {
    lines.push("");
    const plan = account.plan ?? "plan unknown";
    lines.push(`${account.name}  ${account.directory}  ${account.email ?? "email unknown"}  ${plan}  · ${account.pinnedThreads} thread(s) pinned${account.recentPlacements > 0 ? `, ${account.recentPlacements} placed in the last poll interval` : ""}${account.discovered ? "  · discovered" : ""}`);
    const machines = account.machines
      .map((machine) => `${machine.hostName} ${machine.signedIn ? "signed in" : "not signed in"}${machine.error ? ` (${machine.error})` : ""}`)
      .join(", ");
    lines.push(`  Machines: ${machines || "not inspected yet"}`);
    const usage = account.usage;
    if (usage === null) {
      lines.push("  Usage: not read yet");
    } else {
      const windows = usage.windows ? formatWindows(usage.windows, now) : "";
      const observed = usage.observedAt === null ? "never read" : `read ${when(usage.observedAt, now)}`;
      lines.push(`  Usage: ${windows || "no windows"} · ${observed}${usage.status === "ok" ? "" : ` · ${usage.status}: ${usage.message ?? ""}`}`);
    }
    const blocks = [
      ...(account.blockedUntil !== null ? [`all models until ${when(account.blockedUntil, now)}`] : []),
      ...Object.entries(account.blockedFamilies).map(([family, until]) => `${family} until ${when(until, now)}`),
    ];
    if (blocks.length > 0) lines.push(`  Blocked after a limit failure: ${blocks.join(", ")}`);
  }
  if (status.warnings.length > 0) {
    lines.push("", "Warnings:", ...status.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}

const SOURCE_ORDER: Array<"setting" | "discovered"> = ["setting", "discovered"];

/** `bb claude-accounts accounts`: every account in use and where it came from. */
export function formatAccounts(status: EngineStatus): string {
  const lines: string[] = [];
  for (const source of SOURCE_ORDER) {
    const accounts = status.accounts.filter((account) => account.discovered === (source === "discovered"));
    if (accounts.length === 0) continue;
    lines.push(source === "setting" ? "Named in the accounts setting:" : "Found on a machine, not named in the setting:");
    for (const account of accounts) {
      lines.push(`  ${account.name}  ${account.directory}  ${account.email ?? "email unknown"}  ${account.plan ?? "plan unknown"}`);
    }
    lines.push("");
  }
  lines.push(
    "A signed-in ~/.claude-* directory joins the rotation on its own. Name one in the accounts setting to control its letter or keep it on a machine without it.",
  );
  return lines.join("\n");
}

export function formatExplanation(explanation: Explanation, now: number): string {
  const { pin, decision, next } = explanation;
  const lines = [
    pin === null
      ? `Thread ${explanation.threadId} has no pin; its next Claude turn picks an account.`
      : `Thread ${explanation.threadId} is pinned to ${pin.account}${pin.manual ? " (by hand)" : ""} since ${when(pin.at, now)}, model ${pin.model || "unknown"}.`,
  ];
  if (decision !== null) {
    lines.push(`Last decision ${when(decision.at, now)}: ${decision.detail}`);
    if (decision.retryAt !== null) {
      lines.push(
        decision.retryAt > now
          ? `A retry runs ${when(decision.retryAt, now)}.`
          : `A retry was queued to run ${when(decision.retryAt, now)}.`,
      );
    }
  }
  if (next !== null) {
    lines.push(`Next turn: ${next.account ?? "default login"} — ${next.detail}`);
    if (!next.ready && next.readyAt !== null) lines.push(`First account frees up ${when(next.readyAt, now)}.`);
  }
  return lines.join("\n");
}
