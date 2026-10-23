// Usage responses trimmed from real accounts on 2026-10-23 (identities removed).

/** Trimmed from a real Max 20x response on 2026-10-23. */
export const maxResponse = {
  five_hour: { utilization: 47.0, resets_at: "2026-10-23T17:19:59.572251+00:00" },
  seven_day: { utilization: 17.0, resets_at: "2026-10-27T04:59:59.572270+00:00" },
  seven_day_opus: null,
  extra_usage: { utilization: null, resets_at: null },
  limits: [
    { group: "session", is_active: true, kind: "session", percent: 47, resets_at: "2026-10-23T17:19:59.572251+00:00", scope: null, severity: "normal" },
    { group: "weekly", is_active: false, kind: "weekly_all", percent: 17, resets_at: "2026-10-27T04:59:59.572270+00:00", scope: null, severity: "normal" },
    {
      group: "weekly",
      is_active: false,
      kind: "weekly_scoped",
      percent: 1,
      resets_at: "2026-10-27T04:59:59.572407+00:00",
      scope: { model: { display_name: "Fable", id: null }, surface: null },
      severity: "normal",
    },
  ],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
};

/** Trimmed from a real Pro response on 2026-10-23, before the first request. */
export const proResponse = {
  five_hour: { utilization: 0.0, resets_at: null },
  seven_day: { utilization: 0.0, resets_at: "2026-10-30T09:59:59.959538+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 0, resets_at: null, scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 0, resets_at: "2026-10-30T09:59:59.926331+00:00", scope: null, is_active: false },
  ],
};
