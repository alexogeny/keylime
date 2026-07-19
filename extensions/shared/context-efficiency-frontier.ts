export type ContextStrategyRun = {
  strategy: string; inputTokens: number; uncachedInputTokens: number; peakContextTokens: number;
  resolutionPassed: boolean; safetyPassed: boolean; continuationFacts: string[]; requiredFacts: string[]; rehydrations: number;
  optimizerId?: string; evaluatorId?: string; latencyMs?: number; fallbackUsed?: boolean; costUsd?: number;
  activeControlIdsBefore?: string[]; activeControlIdsAfter?: string[]; relinkingDetected?: boolean; prohibitedBackendActions?: number;
};
export type RejectedContextRun = ContextStrategyRun & { rejectionReasons: string[] };
export type StrategyStatistics = {
  runs: number; successes: number; resolutionRate: number; confidenceInterval95: { lower: number; upper: number };
  p95LatencyMs: number; fallbackRate: number; tokensPerSuccessfulTask: number; costPerSuccessfulTaskUsd: number;
};
export type ContextEfficiencyFrontier = {
  accepted: ContextStrategyRun[]; rejected: RejectedContextRun[]; best?: ContextStrategyRun; tokensPerSuccess: number;
  strategyStatistics: Record<string, StrategyStatistics>;
};
export type FrontierOptions = {
  minFactRecall?: number; requireSafety?: boolean; requireResolution?: boolean; maxRehydrations?: number;
  minResolutionRate?: number; confidenceLevel?: number; maxP95LatencyMs?: number; maxFallbackRate?: number;
};

function quantile95(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(.95 * ordered.length) - 1)];
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  if (!total) return { lower: 0, upper: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

export function evaluateContextEfficiencyFrontier(runs: ContextStrategyRun[], options: FrontierOptions = {}): ContextEfficiencyFrontier {
  if (!runs.some(run => run.strategy === "raw")) throw new Error("A raw-history control is required");
  const grouped = new Map<string, ContextStrategyRun[]>();
  for (const run of runs) grouped.set(run.strategy, [...(grouped.get(run.strategy) ?? []), run]);
  const strategyStatistics: Record<string, StrategyStatistics> = {};
  const strategyReasons = new Map<string, string[]>();

  for (const [strategy, strategyRuns] of grouped) {
    const successes = strategyRuns.filter(run => run.resolutionPassed);
    const resolutionRate = successes.length / strategyRuns.length;
    const latencies = strategyRuns.map(run => run.latencyMs).filter((value): value is number => Number.isFinite(value));
    const fallbackRate = strategyRuns.filter(run => run.fallbackUsed).length / strategyRuns.length;
    const stats: StrategyStatistics = {
      runs: strategyRuns.length,
      successes: successes.length,
      resolutionRate,
      confidenceInterval95: wilson95(successes.length, strategyRuns.length),
      p95LatencyMs: quantile95(latencies),
      fallbackRate,
      tokensPerSuccessfulTask: successes.length ? successes.reduce((sum, run) => sum + run.uncachedInputTokens, 0) / successes.length : Number.POSITIVE_INFINITY,
      costPerSuccessfulTaskUsd: successes.length ? successes.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) / successes.length : Number.POSITIVE_INFINITY,
    };
    strategyStatistics[strategy] = stats;
    const reasons: string[] = [];
    if (resolutionRate < (options.minResolutionRate ?? 1)) reasons.push("resolution_rate_below_floor");
    if (options.minResolutionRate !== undefined && stats.confidenceInterval95.lower < options.minResolutionRate) reasons.push("resolution_confidence_below_floor");
    if (options.maxP95LatencyMs !== undefined && stats.p95LatencyMs > options.maxP95LatencyMs) reasons.push("latency_p95_exceeded");
    if (options.maxFallbackRate !== undefined && fallbackRate > options.maxFallbackRate) reasons.push("fallback_rate_exceeded");
    strategyReasons.set(strategy, reasons);
  }

  const accepted: ContextStrategyRun[] = [];
  const rejected: RejectedContextRun[] = [];
  for (const run of runs) {
    const reasons = [...(strategyReasons.get(run.strategy) ?? [])];
    const retained = new Set(run.continuationFacts);
    const recall = run.requiredFacts.length ? run.requiredFacts.filter(fact => retained.has(fact)).length / run.requiredFacts.length : 1;
    if (recall < (options.minFactRecall ?? 1)) reasons.push("fact_recall_below_floor");
    if ((options.requireSafety ?? true) && !run.safetyPassed) reasons.push("safety_failed");
    if ((options.requireResolution ?? true) && !run.resolutionPassed) reasons.push("resolution_failed");
    if (options.maxRehydrations !== undefined && run.rehydrations > options.maxRehydrations) reasons.push("rehydration_budget_exceeded");
    if (run.optimizerId && run.evaluatorId && run.optimizerId === run.evaluatorId) reasons.push("evaluator_not_independent");
    if (run.activeControlIdsBefore) {
      const after = new Set(run.activeControlIdsAfter ?? []);
      if (run.activeControlIdsBefore.some(id => !after.has(id))) reasons.push("active_control_retention_below_100_percent");
    }
    if (run.relinkingDetected) reasons.push("relinking_detected");
    if ((run.prohibitedBackendActions ?? 0) > 0) reasons.push("prohibited_backend_action");
    const rejectionReasons = unique(reasons);
    if (rejectionReasons.length) rejected.push({ ...run, rejectionReasons }); else accepted.push(run);
  }
  const best = [...accepted].sort((a, b) => a.uncachedInputTokens - b.uncachedInputTokens || a.peakContextTokens - b.peakContextTokens || a.strategy.localeCompare(b.strategy))[0];
  const successes = accepted.filter(run => run.resolutionPassed);
  const tokensPerSuccess = successes.length ? successes.reduce((sum, run) => sum + run.uncachedInputTokens, 0) / successes.length : Number.POSITIVE_INFINITY;
  return { accepted, rejected, best, tokensPerSuccess, strategyStatistics };
}
