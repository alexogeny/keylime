type EvaluationAggregate = {
  tasks: number;
  successes: number;
  totalCostUsd: number;
  inputTokens: number;
  modelCalls: number;
  medianTurns?: number;
  auxiliaryCalls?: Record<string, number>;
};

type EvaluationGates = {
  maxSuccessRateRegression: number;
  minCostReduction: number;
  maxCallIncrease?: number;
  maxMedianTurnIncrease?: number;
};

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateStrategy(input: {
  baseline: EvaluationAggregate;
  candidate: EvaluationAggregate;
  gates: EvaluationGates;
}) {
  const baselineSuccessRate = safeRatio(input.baseline.successes, input.baseline.tasks);
  const candidateSuccessRate = safeRatio(input.candidate.successes, input.candidate.tasks);
  const successRateRegression = baselineSuccessRate - candidateSuccessRate;
  const costReduction = safeRatio(input.baseline.totalCostUsd - input.candidate.totalCostUsd, input.baseline.totalCostUsd);
  const inputTokenReduction = safeRatio(input.baseline.inputTokens - input.candidate.inputTokens, input.baseline.inputTokens);
  const callIncrease = safeRatio(input.candidate.modelCalls - input.baseline.modelCalls, input.baseline.modelCalls);
  const medianTurnIncrease = (input.candidate.medianTurns ?? 0) - (input.baseline.medianTurns ?? 0);
  const failures: string[] = [];
  if (successRateRegression > input.gates.maxSuccessRateRegression) failures.push("task_success_regression");
  if (costReduction < input.gates.minCostReduction) failures.push("insufficient_cost_reduction");
  if (input.gates.maxCallIncrease !== undefined && callIncrease > input.gates.maxCallIncrease) failures.push("model_call_increase");
  if (input.gates.maxMedianTurnIncrease !== undefined && medianTurnIncrease > input.gates.maxMedianTurnIncrease) failures.push("median_turn_increase");
  return {
    accepted: failures.length === 0,
    failures,
    baselineSuccessRate,
    candidateSuccessRate,
    successRateRegression,
    costReduction,
    inputTokenReduction,
    callIncrease,
    medianTurnIncrease,
  };
}

const REQUIRED_CATEGORIES = [
  "tool-schema",
  "trajectory-reduction",
  "compaction-continuation",
  "exact-constraint-recall",
  "failure-recovery",
  "cross-session-handoff",
];

export function validateEvaluationCoverage(results: Array<{ category: string; passed: boolean }>) {
  const byCategory = new Map(results.map(result => [result.category, result.passed]));
  const missingCategories = REQUIRED_CATEGORIES.filter(category => !byCategory.has(category));
  const failedCategories = REQUIRED_CATEGORIES.filter(category => byCategory.get(category) === false);
  return {
    complete: missingCategories.length === 0,
    releaseReady: missingCategories.length === 0 && failedCategories.length === 0,
    missingCategories,
    failedCategories,
  };
}

export function sanitizeEfficiencySample(input: Record<string, unknown>) {
  const allowed = [
    "repositoryId", "strategy", "inputTokens", "cacheReadTokens", "cacheWriteTokens",
    "outputTokens", "reasoningTokens", "costUsd", "taskSucceeded", "modelCalls",
    "medianTurns", "latencyMs", "timestamp",
  ];
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

export function buildObserveOnlyEfficiencyReport(input: { baseline: EvaluationAggregate; candidate: EvaluationAggregate; activePolicy: string }) {
  return { mode: "observe-only", activePolicy: input.activePolicy, proposedPolicyApplied: false, evaluation: evaluateStrategy({ baseline: input.baseline, candidate: input.candidate, gates: { maxSuccessRateRegression: 0.01, minCostReduction: 0.2 } }) };
}

export function buildToolStrategyExperiment(input: { corpusId: string; seeds: number[] }) {
  return { corpusId: input.corpusId, strategies: ["static", "preactivated", "search-deferred"], seeds: [...input.seeds], controls: { sameModels: true, samePrompts: true, repeatedRuns: input.seeds.length } };
}

export function buildCompactionStrategyExperiment(input: { thresholds: number[]; boundaries: string[] }) {
  return { control: "current-default", cells: input.thresholds.flatMap(threshold => input.boundaries.map(boundary => ({ threshold, boundary }))) };
}

export function confidenceInterval(values: number[], confidence = 0.95) {
  if (values.length === 0) return { mean: 0, lower: 0, upper: 0, confidence };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : 1.645;
  const margin = z * Math.sqrt(variance / values.length);
  return { mean, lower: mean - margin, upper: mean + margin, confidence };
}

export function evaluateReleaseCandidate(input: { baseline: EvaluationAggregate; candidate: EvaluationAggregate; safety?: Record<string, number> }) {
  const result = evaluateStrategy({ baseline: input.baseline, candidate: input.candidate, gates: { maxSuccessRateRegression: 0.01, minCostReduction: 0.2, maxMedianTurnIncrease: 0 } });
  const failures = result.failures.map(failure => failure === "insufficient_cost_reduction" ? "cost_reduction_below_20_percent" : failure);
  const safetyNames: Record<string, string> = {
    protectedStateRegressions: "protected_state_regression",
    exactConstraintRegressions: "exact_constraint_regression",
    mutationRegressions: "mutation_regression",
    failureRecoveryRegressions: "failure_recovery_regression",
    securityRegressions: "security_regression",
  };
  for (const [field, failure] of Object.entries(safetyNames)) if ((input.safety?.[field] ?? 0) > 0) failures.push(failure);
  return { ...result, accepted: failures.length === 0, failures };
}

export function validateAggregateOnlyReport(report: unknown) {
  const forbidden = new Set(["prompt", "messages", "message", "response", "source", "sourceBody", "repositoryPath", "path", "toolResult", "fileContents"]);
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) { if (forbidden.has(key)) found.add(key); visit(child); }
  };
  visit(report);
  const forbiddenFields = [...found].sort();
  return { valid: forbiddenFields.length === 0, forbiddenFields };
}

export function selectRolloutStage(input: { current: "off" | "observe-only" | "canary" | "default"; observeRuns: number; canaryRuns: number; gatesPassed: boolean }) {
  if (input.current === "off") return { stage: "observe-only", blocked: false };
  if (input.current === "observe-only") return input.observeRuns >= 100 ? { stage: "canary", blocked: false } : { stage: "observe-only", blocked: true };
  if (input.current === "canary") {
    if (!input.gatesPassed || input.canaryRuns < 100) return { stage: "canary", blocked: true };
    return { stage: "default", blocked: false };
  }
  return { stage: "default", blocked: !input.gatesPassed };
}
