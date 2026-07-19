import { validateContextEvalFixture, type ContextEvalFixture } from "./trajectory";

export type ContextEvalMetrics = {
  beforeChars: number;
  afterChars: number;
  reductionRate: number;
  schemaChars: number;
  trajectoryChars: number;
  recoverableRemovedChars: number;
  unrecoverableRemovedChars: number;
  requiredFactsRetained: number;
  requiredFactsTotal: number;
  retrievalRecall?: number;
  retrievalPrecision?: number;
  nextActionMatch?: boolean;
  safetyInvariantPass: boolean;
};

export function evaluateTrajectory(fixture: ContextEvalFixture): ContextEvalMetrics {
  validateContextEvalFixture(fixture);
  const beforeChars = fixture.before.length;
  const afterChars = fixture.after.length;
  const removedChars = Math.max(0, beforeChars - afterChars);
  const recoverableRemovedChars = Math.min(removedChars, fixture.recoverableRemovedChars);
  const requiredFactsRetained = fixture.requiredFacts.filter(fact => fixture.after.includes(fact)).length;
  const required = new Set(fixture.retrieval?.requiredRegionIds ?? []);
  const returned = new Set(fixture.retrieval?.returnedRegionIds ?? []);
  const retrievedRequired = [...required].filter(id => returned.has(id)).length;
  return {
    beforeChars,
    afterChars,
    reductionRate: beforeChars > 0 ? (beforeChars - afterChars) / beforeChars : 0,
    schemaChars: 0,
    trajectoryChars: afterChars,
    recoverableRemovedChars,
    unrecoverableRemovedChars: Math.max(0, removedChars - recoverableRemovedChars),
    requiredFactsRetained,
    requiredFactsTotal: fixture.requiredFacts.length,
    retrievalRecall: fixture.retrieval ? (required.size > 0 ? retrievedRequired / required.size : 1) : undefined,
    retrievalPrecision: fixture.retrieval ? (fixture.retrieval.totalReturnedRegionIds > 0 ? retrievedRequired / fixture.retrieval.totalReturnedRegionIds : 0) : undefined,
    nextActionMatch: fixture.nextAction ? fixture.nextAction.actual === fixture.nextAction.expected : undefined,
    safetyInvariantPass: fixture.safetyInvariants.every(value => fixture.after.includes(value)),
  };
}
