import { maxResponse, proResponse } from "./fixtures";
import { currentPercent, parseUsageResponse } from "./usage";

describe("parseUsageResponse", () => {
  it("reads session, weekly, and model-scoped limits", () => {
    expect(parseUsageResponse(maxResponse)).toEqual([
      { id: "session", kind: "session", label: "Session", model: null, usedPercent: 47, resetsAt: "2026-10-23T17:19:59.572251+00:00" },
      { id: "weekly", kind: "weekly", label: "Weekly", model: null, usedPercent: 17, resetsAt: "2026-10-27T04:59:59.572270+00:00" },
      { id: "weekly:fable", kind: "weekly", label: "Weekly · Fable", model: "fable", usedPercent: 1, resetsAt: "2026-10-27T04:59:59.572407+00:00" },
    ]);
  });

  it("keeps a session window that has not started", () => {
    expect(parseUsageResponse(proResponse)[0]).toEqual({
      id: "session",
      kind: "session",
      label: "Session",
      model: null,
      usedPercent: 0,
      resetsAt: null,
    });
  });

  it("falls back to the older fields without limits[]", () => {
    const { limits: _ignored, ...legacy } = maxResponse;
    expect(parseUsageResponse(legacy).map((window) => [window.id, window.usedPercent])).toEqual([
      ["session", 47],
      ["weekly", 17],
    ]);
  });

  it("keeps unknown limits as other and ignores junk", () => {
    expect(parseUsageResponse({ limits: [{ kind: "monthly_spend", percent: 3 }, { kind: "session" }, 7] })).toEqual([
      { id: "monthly_spend", kind: "other", label: "monthly_spend", model: null, usedPercent: 3, resetsAt: null },
    ]);
    expect(parseUsageResponse(null)).toEqual([]);
  });
});

describe("currentPercent", () => {
  it("treats a window whose reset has passed as empty", () => {
    const window = parseUsageResponse(maxResponse)[0]!;
    expect(currentPercent(window, Date.parse("2026-10-23T12:00:00Z"))).toBe(47);
    expect(currentPercent(window, Date.parse("2026-10-23T18:00:00Z"))).toBe(0);
  });
});
