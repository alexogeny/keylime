import { describe, expect, test } from "bun:test";

const modulePath = "../../extensions/shared/token-efficiency-evaluation";
async function evaluationApi(): Promise<any> {
  return import(modulePath);
}

describe("RED: token-efficiency changes ship only when successful-task economics improve", () => {
  test("rejects token savings that reduce task success", async () => {
    const { evaluateStrategy } = await evaluationApi();
    const result = evaluateStrategy({
      baseline: { tasks: 100, successes: 92, totalCostUsd: 20, inputTokens: 1_000_000, modelCalls: 500 },
      candidate: { tasks: 100, successes: 84, totalCostUsd: 12, inputTokens: 550_000, modelCalls: 470 },
      gates: { maxSuccessRateRegression: 0.01, minCostReduction: 0.15 },
    });

    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("task_success_regression");
  });

  test("counts extra discovery and compression calls when comparing strategies", async () => {
    const { evaluateStrategy } = await evaluationApi();
    const result = evaluateStrategy({
      baseline: { tasks: 20, successes: 19, totalCostUsd: 2, inputTokens: 100_000, modelCalls: 40 },
      candidate: {
        tasks: 20,
        successes: 19,
        totalCostUsd: 1.95,
        inputTokens: 60_000,
        modelCalls: 62,
        auxiliaryCalls: { toolSearch: 14, compression: 8 },
      },
      gates: { maxSuccessRateRegression: 0, minCostReduction: 0.10, maxCallIncrease: 0.25 },
    });

    expect(result.accepted).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(["insufficient_cost_reduction", "model_call_increase"]));
  });

  test("accepts a candidate only when cost falls and quality gates remain green", async () => {
    const { evaluateStrategy } = await evaluationApi();
    const result = evaluateStrategy({
      baseline: { tasks: 100, successes: 92, totalCostUsd: 20, inputTokens: 1_000_000, modelCalls: 500, medianTurns: 5 },
      candidate: { tasks: 100, successes: 93, totalCostUsd: 14, inputTokens: 620_000, modelCalls: 480, medianTurns: 5 },
      gates: { maxSuccessRateRegression: 0.01, minCostReduction: 0.20, maxCallIncrease: 0.10, maxMedianTurnIncrease: 0 },
    });

    expect(result.accepted).toBe(true);
    expect(result.costReduction).toBeCloseTo(0.30, 8);
    expect(result.inputTokenReduction).toBeCloseTo(0.38, 8);
  });

  test("requires category-specific replay coverage instead of one aggregate token score", async () => {
    const { validateEvaluationCoverage } = await evaluationApi();
    const coverage = validateEvaluationCoverage([
      { category: "tool-schema", passed: true },
      { category: "trajectory-reduction", passed: true },
      { category: "compaction-continuation", passed: true },
      { category: "exact-constraint-recall", passed: false },
      { category: "failure-recovery", passed: true },
      { category: "cross-session-handoff", passed: true },
    ]);

    expect(coverage.complete).toBe(true);
    expect(coverage.releaseReady).toBe(false);
    expect(coverage.failedCategories).toEqual(["exact-constraint-recall"]);
  });

  test("stores privacy-preserving aggregates without prompt or message bodies", async () => {
    const { sanitizeEfficiencySample } = await evaluationApi();
    const sample = sanitizeEfficiencySample({
      repositoryId: "repo-hash",
      strategy: "trajectory-reduction-v1",
      inputTokens: 12_000,
      cacheReadTokens: 8_000,
      outputTokens: 900,
      costUsd: 0.12,
      taskSucceeded: true,
      prompt: "private user request",
      messages: [{ role: "user", content: "secret" }],
      fileContents: "private source",
    });

    expect(sample).toMatchObject({ repositoryId: "repo-hash", strategy: "trajectory-reduction-v1", taskSucceeded: true });
    expect(JSON.stringify(sample)).not.toContain("private user request");
    expect(JSON.stringify(sample)).not.toContain("secret");
    expect(JSON.stringify(sample)).not.toContain("private source");
  });
});
