import { describe, expect, test } from "bun:test";
import { reduceToolResultText } from "../../extensions/shared/tool-result-reducers";

const economicsPath = "../../extensions/shared/tool-result-economics";
async function economicsApi(): Promise<any> { return import(economicsPath); }

describe("RED: deterministic token-reduction research theses", () => {
  test("TE-095 estimates code and punctuation pressure in token units rather than characters alone", async () => {
    const { estimateDeterministicTokens } = await economicsApi();
    const prose = "alpha beta gamma delta";
    const syntax = "{}[]();=>?.";

    expect(prose.length).toBeGreaterThan(syntax.length);
    expect(estimateDeterministicTokens(syntax)).toBeGreaterThan(estimateDeterministicTokens(prose));
  });

  test("TE-096 compacts only when a recoverable reduction clears the configured token floor", async () => {
    const { planRecoverableToolResultReduction } = await economicsApi();
    const compact = planRecoverableToolResultReduction({
      originalText: "token ".repeat(1_000),
      reducedText: "token ".repeat(100),
      recoverableObjectId: "ctx-123",
      expectedFutureUses: 2,
      minimumActiveTokensSaved: 500,
    });
    const irreversible = planRecoverableToolResultReduction({
      originalText: "token ".repeat(1_000),
      reducedText: "token ".repeat(100),
      expectedFutureUses: 2,
      minimumActiveTokensSaved: 500,
    });

    expect(compact).toMatchObject({ decision: "compact", auxiliaryModelCalls: 0, recoverable: true });
    expect(compact.activeTokensSaved).toBeGreaterThanOrEqual(500);
    expect(irreversible).toMatchObject({ decision: "retain", recoverable: false });
  });

  test("TE-097 reports cache-adjusted savings separately from active-context savings", async () => {
    const { planRecoverableToolResultReduction } = await economicsApi();
    const result = planRecoverableToolResultReduction({
      originalText: "record ".repeat(1_000),
      reducedText: "record ".repeat(100),
      recoverableObjectId: "ctx-cache",
      expectedFutureUses: 4,
      cacheReadFraction: 0.75,
      minimumActiveTokensSaved: 100,
    });

    expect(result.activeTokensSaved).toBeGreaterThan(result.uncachedTokensSaved);
    expect(result.uncachedTokensSaved).toBe(Math.round(result.activeTokensSaved * 0.25));
  });

  test("TE-098 deterministically keeps distant task-relevant lines with exact recovery locators", () => {
    const text = [
      "request completed",
      ...Array.from({ length: 30 }, (_, index) => `unrelated telemetry row ${index}`),
      "auth timeout is configured in retryPolicy at src/auth/client.ts:84",
      ...Array.from({ length: 20 }, (_, index) => `unrelated footer row ${index}`),
    ].join("\n");

    const reduced = reduceToolResultText("fetch_url", text, {
      maxChars: 260,
      query: "find the auth timeout retryPolicy configuration",
    });

    expect(reduced.activeText).toContain("src/auth/client.ts:84");
    expect(reduced.activeText).not.toContain("unrelated telemetry row 20");
    expect(reduced.summary).toContain("task-conditioned");
    expect(Object.keys(reduced.sections)).toContain("task_match_1");
  });
});
