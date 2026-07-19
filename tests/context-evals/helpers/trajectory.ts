export type ContextEvalCategory =
  | "tool-selection"
  | "repository-retrieval"
  | "tool-results"
  | "compaction"
  | "stale-state"
  | "safety";

export type ContextEvalThresholds = {
  minReductionRate?: number;
  minFactRecall: number;
  maxUnrecoverableRemovedChars: number;
  maxTrajectoryChars: number;
  requireSafety?: boolean;
};

export type ContextEvalFixture = {
  id: string;
  category: ContextEvalCategory;
  before: string;
  after: string;
  recoverableRemovedChars: number;
  requiredFacts: string[];
  safetyInvariants: string[];
  thresholds: ContextEvalThresholds;
  retrieval?: { requiredRegionIds: string[]; returnedRegionIds: string[]; totalReturnedRegionIds: number };
  nextAction?: { expected: string; actual: string };
};

export function validateContextEvalFixture(fixture: ContextEvalFixture): void {
  if (!fixture.id || !fixture.category) throw new Error("Context fixture requires id and category");
  if (fixture.recoverableRemovedChars < 0 || !Number.isInteger(fixture.recoverableRemovedChars)) throw new Error("recoverableRemovedChars must be a non-negative integer");
  if (fixture.thresholds.minFactRecall < 0 || fixture.thresholds.minFactRecall > 1) throw new Error("minFactRecall must be between zero and one");
  if (fixture.thresholds.maxTrajectoryChars < 0) throw new Error("maxTrajectoryChars must be non-negative");
}
