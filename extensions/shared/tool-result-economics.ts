export type TokenEstimator = (text: string) => number;

export type ToolResultReductionPlan = {
  decision: "compact" | "retain";
  reason: string;
  recoverable: boolean;
  auxiliaryModelCalls: 0;
  originalTokens: number;
  reducedTokens: number;
  activeTokensSaved: number;
  uncachedTokensSaved: number;
};

/**
 * Provider-neutral, deterministic estimate for pre-request decisions.
 * Word-like runs approximate subword pieces; punctuation is counted separately.
 * Actual provider usage remains authoritative after a request.
 */
export function estimateDeterministicTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}_]+|[^\s]/gu)) {
    const value = match[0];
    tokens += /^[\p{L}\p{N}_]+$/u.test(value)
      ? Math.max(1, Math.ceil([...value].length / 4))
      : 1;
  }
  return tokens;
}

export function planRecoverableToolResultReduction(input: {
  originalText: string;
  reducedText: string;
  recoverableObjectId?: string;
  expectedFutureUses?: number;
  cacheReadFraction?: number;
  minimumActiveTokensSaved?: number;
  estimateTokens?: TokenEstimator;
}): ToolResultReductionPlan {
  const estimate = input.estimateTokens ?? estimateDeterministicTokens;
  const originalTokens = Math.max(0, Math.ceil(estimate(input.originalText)));
  const reducedTokens = Math.max(0, Math.ceil(estimate(input.reducedText)));
  const expectedFutureUses = Math.max(1, Math.floor(input.expectedFutureUses ?? 1));
  const cacheReadFraction = Math.min(1, Math.max(0, input.cacheReadFraction ?? 0));
  const minimumActiveTokensSaved = Math.max(0, Math.ceil(input.minimumActiveTokensSaved ?? 1));
  const activeTokensSaved = Math.max(0, originalTokens - reducedTokens) * expectedFutureUses;
  const uncachedTokensSaved = Math.round(activeTokensSaved * (1 - cacheReadFraction));
  const recoverable = Boolean(input.recoverableObjectId);
  const worthwhile = activeTokensSaved >= minimumActiveTokensSaved;

  return {
    decision: recoverable && worthwhile ? "compact" : "retain",
    reason: !recoverable
      ? "exact recovery reference required"
      : !worthwhile
        ? `projected active-context saving ${activeTokensSaved} tokens is below floor ${minimumActiveTokensSaved}`
        : `projected active-context saving ${activeTokensSaved} tokens with exact recovery`,
    recoverable,
    auxiliaryModelCalls: 0,
    originalTokens,
    reducedTokens,
    activeTokensSaved,
    uncachedTokensSaved,
  };
}
