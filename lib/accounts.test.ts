import {
  isClaudeBridgeModel,
  matchesModelPattern,
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
