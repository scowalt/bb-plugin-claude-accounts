import {
  isClaudeBridgeModel,
  matchesModelPattern,
  mergeDiscoveredAccounts,
  modelFamily,
  parseAccounts,
  parseModelPatterns,
  planLabel,
  planWeight,
} from "./accounts";

describe("parseAccounts", () => {
  it("reads name=directory pairs in order", () => {
    expect(parseAccounts("A=~/.claude, B=~/.claude-b/")).toEqual([
      { name: "A", directory: "~/.claude", order: 0 },
      { name: "B", directory: "~/.claude-b", order: 1 },
    ]);
  });

  it("accepts absolute directories", () => {
    expect(parseAccounts("work=/opt/claude/work")).toEqual([{ name: "work", directory: "/opt/claude/work", order: 0 }]);
  });

  it.each([
    ["", "at least one account"],
    ["A", "must look like Name=~/.claude-b"],
    ["A=.claude", "must start with ~/ or /"],
    ["A=~/.claude, a=~/.claude-b", "appears twice"],
    ["A=~/.claude, B=~/.claude/", "appears twice"],
    ["bad name=~/.claude", "not a valid account name"],
  ])("rejects %j", (value, message) => {
    expect(() => parseAccounts(value)).toThrow(message);
  });
});

describe("plans", () => {
  it("weighs plans by their multiplier", () => {
    expect(planWeight("default_claude_max_20x", "max")).toBe(20);
    expect(planWeight("default_claude_max_5x", "max")).toBe(5);
    expect(planWeight("default_claude_ai", "pro")).toBe(1);
    expect(planWeight(null, "pro")).toBe(1);
    expect(planWeight(null, "team")).toBeNull();
  });

  it("labels plans the way Claude does", () => {
    expect(planLabel("default_claude_max_20x", "max")).toBe("Max (20x)");
    expect(planLabel("default_claude_ai", "pro")).toBe("Pro");
    expect(planLabel(null, null)).toBeNull();
  });
});

describe("models", () => {
  it("recognizes claude-bridge models and their family", () => {
    expect(isClaudeBridgeModel("claude-bridge/claude-opus-5-5")).toBe(true);
    expect(isClaudeBridgeModel("openai-codex/gpt-6.1-sol")).toBe(false);
    expect(modelFamily("claude-bridge/claude-fable-5-1")).toBe("fable");
    expect(modelFamily("claude-bridge/claude-haiku-5-5")).toBe("haiku");
    expect(modelFamily("kourier/deepseek-v4.1-flash")).toBeNull();
  });

  it("matches patterns with * wildcards and literal dots", () => {
    expect(parseModelPatterns(" claude-bridge/claude-haiku-*, ,x.y ")).toEqual(["claude-bridge/claude-haiku-*", "x.y"]);
    expect(matchesModelPattern("claude-bridge/claude-haiku-5-5", "claude-bridge/claude-haiku-*")).toBe(true);
    expect(matchesModelPattern("claude-bridge/claude-opus-5-5", "claude-bridge/claude-haiku-*")).toBe(false);
    expect(matchesModelPattern("xzy", "x.y")).toBe(false);
  });
});

describe("mergeDiscoveredAccounts", () => {
  const configured = parseAccounts("A=~/.claude, B=~/.claude-b");

  it("adds signed-in directories the setting does not name, after the configured ones", () => {
    expect(
      mergeDiscoveredAccounts(configured, [
        { directory: "~/.claude", isDefault: true, signedIn: true },
        { directory: "~/.claude-b", isDefault: false, signedIn: true },
        { directory: "~/.claude-c", isDefault: false, signedIn: true },
      ]),
    ).toEqual([
      { name: "A", directory: "~/.claude", order: 0 },
      { name: "B", directory: "~/.claude-b", order: 1 },
      { name: "C", directory: "~/.claude-c", order: 2 },
    ]);
  });

  it("skips directories without a login", () => {
    const merged = mergeDiscoveredAccounts(configured, [
      { directory: "~/.claude-c", isDefault: false, signedIn: false },
    ]);
    expect(merged.map((spec) => spec.name)).toEqual(["A", "B"]);
  });

  it("takes the default login when nothing names it", () => {
    const merged = mergeDiscoveredAccounts(parseAccounts("work=~/.claude-work"), [
      { directory: "~/.claude", isDefault: true, signedIn: true },
    ]);
    expect(merged.map((spec) => [spec.name, spec.directory])).toEqual([
      ["work", "~/.claude-work"],
      ["A", "~/.claude"],
    ]);
  });

  it("falls back to a numbered name when the suffix is unusable or taken", () => {
    const merged = mergeDiscoveredAccounts(parseAccounts("C=~/.claude-keep"), [
      { directory: "~/.claude-c", isDefault: false, signedIn: true },
      { directory: "~/.claude-a b", isDefault: false, signedIn: true },
    ]);
    expect(merged.map((spec) => spec.name)).toEqual(["C", "D1", "D2"]);
  });

  it("keeps a discovered directory once even when two machines report it", () => {
    const merged = mergeDiscoveredAccounts(configured, [
      { directory: "~/.claude-c", isDefault: false, signedIn: true },
      { directory: "~/.claude-c/", isDefault: false, signedIn: true },
    ]);
    expect(merged.map((spec) => spec.name)).toEqual(["A", "B", "C"]);
  });
});
