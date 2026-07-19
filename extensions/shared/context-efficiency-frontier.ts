export type ContextStrategyRun = { strategy: string; inputTokens: number; uncachedInputTokens: number; peakContextTokens: number; resolutionPassed: boolean; safetyPassed: boolean; continuationFacts: string[]; requiredFacts: string[]; rehydrations: number };
export type RejectedContextRun = ContextStrategyRun & { rejectionReasons: string[] };
export type ContextEfficiencyFrontier = { accepted: ContextStrategyRun[]; rejected: RejectedContextRun[]; best?: ContextStrategyRun; tokensPerSuccess: number };
export type FrontierOptions = { minFactRecall?: number; requireSafety?: boolean; requireResolution?: boolean; maxRehydrations?: number };

export function evaluateContextEfficiencyFrontier(runs: ContextStrategyRun[], options: FrontierOptions = {}): ContextEfficiencyFrontier {
  if (runs.length < 2 && !runs.some(run => run.strategy === "raw")) throw new Error("A raw-history control is required");
  const accepted: ContextStrategyRun[] = [];
  const rejected: RejectedContextRun[] = [];
  for (const run of runs) {
    const reasons: string[] = [];
    const retained = new Set(run.continuationFacts);
    const recall = run.requiredFacts.length ? run.requiredFacts.filter(fact => retained.has(fact)).length / run.requiredFacts.length : 1;
    if (recall < (options.minFactRecall ?? 1)) reasons.push("fact_recall_below_floor");
    if ((options.requireSafety ?? true) && !run.safetyPassed) reasons.push("safety_failed");
    if ((options.requireResolution ?? true) && !run.resolutionPassed) reasons.push("resolution_failed");
    if (options.maxRehydrations !== undefined && run.rehydrations > options.maxRehydrations) reasons.push("rehydration_budget_exceeded");
    if (reasons.length) rejected.push({ ...run, rejectionReasons: reasons }); else accepted.push(run);
  }
  const best = [...accepted].sort((a, b) => a.uncachedInputTokens - b.uncachedInputTokens || a.peakContextTokens - b.peakContextTokens || a.strategy.localeCompare(b.strategy))[0];
  const successes = accepted.filter(run => run.resolutionPassed);
  const tokensPerSuccess = successes.length ? successes.reduce((sum, run) => sum + run.uncachedInputTokens, 0) / successes.length : Number.POSITIVE_INFINITY;
  return { accepted, rejected, best, tokensPerSuccess };
}
