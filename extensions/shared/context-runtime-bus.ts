import type { TrajectoryFold } from "./hierarchical-folding";
import type { RetrievalCredit } from "./retrieval-credit";
import type { CompactionStrategyDecision } from "./provider-compaction-policy";

export type ContextRuntimeTelemetrySnapshot = {
  turn: number;
  observations: number;
  maskedObservations: number;
  cacheFingerprint: string;
  retrieval: RetrievalCredit;
  retrievalBudget: { maxPackets: number; maxChars: number };
  lastFold?: TrajectoryFold;
  compaction?: CompactionStrategyDecision;
  controlState: {
    constraints: Array<{ sourceEventId: string; text: string }>;
    plans: Array<{ sourceEventId: string; text: string }>;
    unresolvedFailures: Array<{ sourceEventId: string; text: string }>;
  };
  memoryStats: {
    observationEntries: number; observationChars: number; trajectoryEvents: number; trajectoryChars: number;
    controlEntries: number; controlChars: number; experienceEntries: number;
  };
};

let latest: ContextRuntimeTelemetrySnapshot | undefined;

export function publishContextRuntimeTelemetry(snapshot: ContextRuntimeTelemetrySnapshot): void {
  latest = snapshot;
}

export function readContextRuntimeTelemetry(): ContextRuntimeTelemetrySnapshot | undefined {
  return latest;
}

export function resetContextRuntimeTelemetry(): void {
  latest = undefined;
}
