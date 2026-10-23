import { pickAccount, type Candidate, type PickInput } from "./policy";
import type { UsageWindow } from "./usage";

const NOW = Date.parse("2026-10-23T14:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function windows(session: number, weekly: number, extra: UsageWindow[] = []): UsageWindow[] {
  return [
    { id: "session", kind: "session", label: "Session", model: null, usedPercent: session, resetsAt: inHours(3) },
    { id: "weekly", kind: "weekly", label: "Weekly", model: null, usedPercent: weekly, resetsAt: inHours(87) },
    ...extra,
  ];
}

function account(overrides: Partial<Candidate> & Pick<Candidate, "name">): Candidate {
  return {
    order: 0,
    weight: 20,
    available: true,
    windows: windows(10, 10),
    blockedUntil: null,
    blockedFamilies: {},
    ...overrides,
  };
}

const A = (overrides: Partial<Candidate> = {}) => account({ name: "A", order: 0, weight: 20, ...overrides });
const B = (overrides: Partial<Candidate> = {}) =>
  account({
    name: "B",
    order: 1,
    weight: 1,
    windows: [
      { id: "session", kind: "session", label: "Session", model: null, usedPercent: 2, resetsAt: inHours(4) },
      { id: "weekly", kind: "weekly", label: "Weekly", model: null, usedPercent: 0, resetsAt: inHours(164) },
    ],
    ...overrides,
  });

function pick(input: Partial<PickInput> & Pick<PickInput, "candidates">) {
  return pickAccount({
    pin: null,
    manualPin: false,
    family: "opus",
    preferSmall: false,
    newLimits: { session: 85, weekly: 90 },
    moveLimits: { session: 97, weekly: 97 },
    now: NOW,
    ...input,
  });
}

describe("pickAccount", () => {
  it("starts a new thread on the largest plan with headroom", () => {
    expect(pick({ candidates: [B(), A()] })).toMatchObject({ account: "A", reason: "new", ready: true });
  });

  it("keeps a pinned thread on its account until the move limits", () => {
    expect(pick({ candidates: [A({ windows: windows(90, 17) }), B()], pin: "A" })).toMatchObject({
      account: "A",
      reason: "pinned",
    });
  });

  it("sends new threads to the next account once the first is past the new-thread limits", () => {
    expect(pick({ candidates: [A({ windows: windows(90, 17) }), B()] })).toMatchObject({ account: "B", reason: "new" });
  });

  it("moves a pinned thread when its account reaches the move limits", () => {
    const result = pick({ candidates: [A({ windows: windows(98, 17) }), B()], pin: "A" });
    expect(result).toMatchObject({ account: "B", reason: "moved", ready: true });
    expect(result.detail).toContain("Session at 98%");
  });

  it("uses an account still under the move limits when every account is past the new-thread limits", () => {
    const result = pick({ candidates: [A({ windows: windows(90, 17) }), B({ windows: windows(99, 0) })] });
    expect(result).toMatchObject({ account: "A", reason: "new", ready: true });
    expect(result.detail).toContain("still under the move limits");
    expect(
      pick({ candidates: [A({ windows: windows(90, 17) }), B({ windows: windows(99, 0) })], pin: "B" }),
    ).toMatchObject({ account: "A", reason: "moved", ready: true });
  });

  it("stays on the pin when no account has headroom, and says when one frees up", () => {
    const result = pick({
      candidates: [A({ windows: windows(98, 17) }), B({ windows: windows(99, 0) })],
      pin: "A",
    });
    expect(result).toMatchObject({
      account: "A",
      reason: "waiting",
      ready: false,
      readyAt: NOW + 3 * 3_600_000,
      readyAccount: "A",
    });
  });

  it("names the account that frees up first, even when the thread stays on another", () => {
    const result = pick({
      candidates: [
        A({ windows: windows(99, 17).map((window) => (window.kind === "session" ? { ...window, resetsAt: inHours(1) } : window)) }),
        B({ blockedUntil: NOW + 5 * 3_600_000 }),
      ],
      pin: "B",
    });
    expect(result).toMatchObject({ account: "B", reason: "waiting", readyAt: NOW + 3_600_000, readyAccount: "A" });
  });

  it("starts an unpinned thread on the account that frees up first when all are full", () => {
    const result = pick({
      candidates: [
        A({ windows: windows(98, 17) }),
        B({
          windows: [
            { id: "session", kind: "session", label: "Session", model: null, usedPercent: 99, resetsAt: inHours(1) },
          ],
        }),
      ],
    });
    expect(result).toMatchObject({ account: "B", reason: "waiting", readyAt: NOW + 3_600_000, readyAccount: "B" });
  });

  it("moves only threads of the model family whose weekly allowance is spent", () => {
    const fableSpent = windows(40, 30, [
      { id: "weekly:fable", kind: "weekly", label: "Weekly · Fable", model: "fable", usedPercent: 100, resetsAt: inHours(87) },
    ]);
    expect(pick({ candidates: [A({ windows: fableSpent }), B()], pin: "A", family: "fable" }).account).toBe("B");
    expect(pick({ candidates: [A({ windows: fableSpent }), B()], pin: "A", family: "sonnet" }).account).toBe("A");
  });

  it("never picks an account that is not signed in on the thread's machine", () => {
    expect(pick({ candidates: [A({ windows: windows(99, 17) }), B({ available: false })] })).toMatchObject({
      account: "A",
      reason: "waiting",
    });
    expect(pick({ candidates: [A({ available: false }), B({ available: false })] })).toMatchObject({
      account: null,
      reason: "none",
    });
  });

  it("counts a window whose reset has passed as empty", () => {
    const stale: UsageWindow[] = [
      { id: "session", kind: "session", label: "Session", model: null, usedPercent: 100, resetsAt: inHours(-1) },
    ];
    expect(pick({ candidates: [A({ windows: stale }), B()] }).account).toBe("A");
  });

  it("skips an account blocked by a recent limit failure", () => {
    expect(pick({ candidates: [A({ blockedUntil: NOW + 60_000 }), B()], pin: "A" }).account).toBe("B");
    expect(pick({ candidates: [A({ blockedFamilies: { opus: NOW + 60_000 } }), B()], pin: "A" }).account).toBe("B");
    expect(pick({ candidates: [A({ blockedFamilies: { opus: NOW + 60_000 } }), B()], pin: "A", family: "sonnet" }).account).toBe("A");
  });

  it("prefers the smallest plan for models that ask for it", () => {
    expect(pick({ candidates: [A(), B()], preferSmall: true })).toMatchObject({ account: "B", reason: "new" });
  });

  it("among equal plans, spends the weekly window that resets soonest", () => {
    const later = windows(10, 10);
    later[1] = { ...later[1]!, resetsAt: inHours(150) };
    expect(pick({ candidates: [A({ windows: later }), account({ name: "C", order: 2, weight: 20 })] }).account).toBe("C");
  });

  it("ranks an unmeasured account after a measured one of the same plan", () => {
    expect(pick({ candidates: [A({ windows: null }), account({ name: "C", order: 2 })] }).account).toBe("C");
  });

  it("still uses an unmeasured account when it is the only one with headroom", () => {
    expect(pick({ candidates: [A({ windows: windows(99, 17) }), B({ windows: null })] }).account).toBe("B");
  });

  it("keeps a hand-made pin even when the account is over its limits", () => {
    expect(pick({ candidates: [A(), B({ windows: windows(99, 50) })], pin: "B", manualPin: true })).toMatchObject({
      account: "B",
      reason: "manual",
      ready: false,
    });
  });

  it("moves a thread whose account was removed from the settings", () => {
    expect(pick({ candidates: [A()], pin: "Z" })).toMatchObject({ account: "A", reason: "moved" });
  });
});
