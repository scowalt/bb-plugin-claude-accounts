import { parseClaudeLimit } from "./failure";

describe("parseClaudeLimit", () => {
  it("reads pi-claude-bridge 0.9 session limits", () => {
    expect(
      parseClaudeLimit("Claude quota exceeded — rate limit (five_hour) — resets 1:10:00 PM: You've hit your session limit"),
    ).toEqual({ rateLimitType: "five_hour", scope: "session", family: null });
  });

  it("reads the older wording and the model family in the message", () => {
    expect(
      parseClaudeLimit(
        "Claude rate limit (seven_day_overage_included) — resets 1:00:00 AM: You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
      ),
    ).toEqual({ rateLimitType: "seven_day_overage_included", scope: "family", family: "fable" });
  });

  it("reads weekly and family-typed limits", () => {
    expect(parseClaudeLimit("Claude quota exceeded — rate limit (seven_day): weekly limit reached")?.scope).toBe("weekly");
    expect(parseClaudeLimit("Claude quota exceeded — rate limit (seven_day_opus): limit")).toEqual({
      rateLimitType: "seven_day_opus",
      scope: "family",
      family: "opus",
    });
    expect(parseClaudeLimit("Claude quota exceeded — rate limit: usage")?.scope).toBe("unknown");
  });

  it("ignores other errors and early warnings", () => {
    expect(parseClaudeLimit("WebSocket closed 1000")).toBeNull();
    expect(parseClaudeLimit("Claude rate limit warning: 80% used (five_hour)")).toBeNull();
  });
});
