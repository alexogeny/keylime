import { describe, expect, test } from "bun:test";

const evaluationPath = "../../extensions/shared/token-efficiency-evaluation";
const contextReportPath = "../context-evals/report";
async function api(): Promise<any> { return import(evaluationPath); }
async function reportApi(): Promise<any> { return import(contextReportPath); }

const baseline = { tasks: 100, successes: 92, totalCostUsd: 20, inputTokens: 1_000_000, modelCalls: 500, medianTurns: 5 };

describe("RED: benchmark experiments and staged release gates", () => {
  test("TE-060 emits an observe-only benchmark report without changing policy", async () => {
    const { buildObserveOnlyEfficiencyReport } = await api();
    const report = buildObserveOnlyEfficiencyReport({ baseline, candidate: { ...baseline, totalCostUsd: 15 }, activePolicy: "baseline" });
    expect(report).toMatchObject({ mode: "observe-only", activePolicy: "baseline", proposedPolicyApplied: false });
  });

  test("TE-061 builds a controlled static/preactivated/deferred tool experiment", async () => {
    const { buildToolStrategyExperiment } = await api();
    const experiment = buildToolStrategyExperiment({ corpusId: "coding-v1", seeds: [1, 2, 3] });
    expect(experiment.strategies).toEqual(["static", "preactivated", "search-deferred"]);
    expect(experiment.controls).toMatchObject({ sameModels: true, samePrompts: true, repeatedRuns: 3 });
  });

  test("TE-062 builds a controlled pressure-threshold and task-boundary compaction experiment", async () => {
    const { buildCompactionStrategyExperiment } = await api();
    const experiment = buildCompactionStrategyExperiment({ thresholds: [65, 75, 85], boundaries: ["none", "investigation-complete", "implementation-complete"] });
    expect(experiment.cells).toHaveLength(9);
    expect(experiment.control).toBe("current-default");
  });

  test("TE-063 calculates confidence intervals from repeated deterministic fixtures", async () => {
    const { confidenceInterval } = await api();
    const result = confidenceInterval([0.20, 0.22, 0.18, 0.21, 0.19], 0.95);
    expect(result.mean).toBeCloseTo(0.20, 8);
    expect(result.lower).toBeLessThan(result.mean);
    expect(result.upper).toBeGreaterThan(result.mean);
  });

  test("TE-064 requires at least twenty percent successful-task cost reduction", async () => {
    const { evaluateReleaseCandidate } = await api();
    const result = evaluateReleaseCandidate({ baseline, candidate: { ...baseline, totalCostUsd: 16.2 } });
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("cost_reduction_below_20_percent");
  });

  test("TE-065 caps task-success regression at one percentage point", async () => {
    const { evaluateReleaseCandidate } = await api();
    const result = evaluateReleaseCandidate({ baseline, candidate: { ...baseline, successes: 90, totalCostUsd: 14 } });
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("task_success_regression");
  });

  test("TE-066 rejects any increase in median completion turns", async () => {
    const { evaluateReleaseCandidate } = await api();
    const result = evaluateReleaseCandidate({ baseline, candidate: { ...baseline, medianTurns: 6, totalCostUsd: 14 } });
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("median_turn_increase");
  });

  test("TE-067 consumes runtime safety feeds as independent hard gates", async () => {
    const { evaluateReleaseCandidate } = await api();
    const result = evaluateReleaseCandidate({
      baseline,
      candidate: { ...baseline, totalCostUsd: 14 },
      safety: { protectedStateRegressions: 0, exactConstraintRegressions: 1, mutationRegressions: 0, failureRecoveryRegressions: 0, securityRegressions: 0 },
    });
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("exact_constraint_regression");
  });

  test("TE-068 rejects reports containing prompt, message, source, path, or tool-result bodies", async () => {
    const { validateAggregateOnlyReport } = await api();
    const result = validateAggregateOnlyReport({ totals: { cost: 1 }, rows: [{ repositoryPath: "private/a.ts", prompt: "secret", toolResult: "secret output" }] });
    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual(expect.arrayContaining(["repositoryPath", "prompt", "toolResult"]));
  });

  test("TE-069 prevents default enablement without observe-only evidence", async () => {
    const { selectRolloutStage } = await api();
    expect(selectRolloutStage({ current: "off", observeRuns: 0, canaryRuns: 0, gatesPassed: true })).toMatchObject({ stage: "observe-only" });
  });

  test("TE-070 prevents default enablement without a passing canary", async () => {
    const { selectRolloutStage } = await api();
    expect(selectRolloutStage({ current: "observe-only", observeRuns: 100, canaryRuns: 0, gatesPassed: true })).toMatchObject({ stage: "canary" });
    expect(selectRolloutStage({ current: "canary", observeRuns: 100, canaryRuns: 20, gatesPassed: false })).toMatchObject({ stage: "canary", blocked: true });
  });

  test("TE-071 enables the default only after observe-only and canary evidence pass", async () => {
    const { selectRolloutStage } = await api();
    expect(selectRolloutStage({ current: "canary", observeRuns: 100, canaryRuns: 100, gatesPassed: true })).toMatchObject({ stage: "default", blocked: false });
  });

  test("TE-072 renders token-efficiency economics in the existing context benchmark", async () => {
    const { buildTokenEfficiencySection } = await reportApi();
    const section = buildTokenEfficiencySection({ baseline, candidate: { ...baseline, totalCostUsd: 14 } });
    expect(section).toContain("successful-task cost");
    expect(section).toContain("cache");
    expect(section).toContain("model calls");
    expect(section).toContain("release gate");
  });
});
