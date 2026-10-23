// Parses Anthropic's subscription usage response (GET /api/oauth/usage).
import { z } from "zod";

export const usageWindowSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["session", "weekly", "other"]),
    label: z.string().min(1),
    /** Model family a scoped weekly window applies to, lowercased ("fable"); null for all models. */
    model: z.string().nullable(),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
  })
  .strict();
export type UsageWindow = z.infer<typeof usageWindowSchema>;

const limitSchema = z.object({
  kind: z.string(),
  percent: z.number().nullable().optional(),
  resets_at: z.string().nullable().optional(),
  scope: z
    .object({
      model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const legacyWindowSchema = z.object({
  utilization: z.number().nullable().optional(),
  resets_at: z.string().nullable().optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromLimit(raw: unknown): UsageWindow | null {
  const parsed = limitSchema.safeParse(raw);
  if (!parsed.success || typeof parsed.data.percent !== "number") return null;
  const { kind, percent } = parsed.data;
  const resetsAt = parsed.data.resets_at ?? null;
  if (kind === "session") {
    return { id: "session", kind: "session", label: "Session", model: null, usedPercent: percent, resetsAt };
  }
  if (kind === "weekly_all") {
    return { id: "weekly", kind: "weekly", label: "Weekly", model: null, usedPercent: percent, resetsAt };
  }
  const displayName = parsed.data.scope?.model?.display_name?.trim();
  if (kind === "weekly_scoped" && displayName) {
    const model = displayName.toLowerCase();
    return {
      id: `weekly:${model}`,
      kind: "weekly",
      label: `Weekly · ${displayName}`,
      model,
      usedPercent: percent,
      resetsAt,
    };
  }
  return { id: kind, kind: "other", label: kind, model: null, usedPercent: percent, resetsAt };
}

const LEGACY_FIELDS: ReadonlyArray<[field: string, window: Omit<UsageWindow, "usedPercent" | "resetsAt">]> = [
  ["five_hour", { id: "session", kind: "session", label: "Session", model: null }],
  ["seven_day", { id: "weekly", kind: "weekly", label: "Weekly", model: null }],
  ["seven_day_opus", { id: "weekly:opus", kind: "weekly", label: "Weekly · Opus", model: "opus" }],
  ["seven_day_sonnet", { id: "weekly:sonnet", kind: "weekly", label: "Weekly · Sonnet", model: "sonnet" }],
];

/** Reads `limits[]` when present, else the older `five_hour`/`seven_day` fields. Unknown entries are kept as `other`. */
export function parseUsageResponse(body: unknown): UsageWindow[] {
  const record = isRecord(body) ? body : {};
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  const add = (window: UsageWindow | null) => {
    if (window === null || seen.has(window.id)) return;
    seen.add(window.id);
    windows.push(window);
  };
  if (Array.isArray(record.limits)) {
    for (const raw of record.limits) add(fromLimit(raw));
    return windows;
  }
  for (const [field, shape] of LEGACY_FIELDS) {
    const parsed = legacyWindowSchema.safeParse(record[field]);
    if (!parsed.success || typeof parsed.data.utilization !== "number") continue;
    add({ ...shape, usedPercent: parsed.data.utilization, resetsAt: parsed.data.resets_at ?? null });
  }
  return windows;
}

export function resetsAtMs(window: UsageWindow): number | null {
  if (window.resetsAt === null) return null;
  const ms = Date.parse(window.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

/** A window whose reset has passed counts as empty, even if the last reading was full. */
export function currentPercent(window: UsageWindow, now: number): number {
  const reset = resetsAtMs(window);
  return reset !== null && reset <= now ? 0 : window.usedPercent;
}
