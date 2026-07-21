import { describe, expect, test } from "bun:test";

const handoffPath = "../../extensions/shared/session-handoff";
const compactionPath = "../../extensions/structured-compaction";
async function handoffApi(): Promise<any> { return import(handoffPath); }
async function compactionApi(): Promise<any> { return import(compactionPath); }

describe("RED: economic compaction and executable cross-session handoff", () => {
  test("TE-050 compacts when projected next-turn cost is high before the pressure threshold", async () => {
    const { decideEconomicCompaction } = await handoffApi();
    expect(decideEconomicCompaction({ activeContextPercent: 60, projectedNextTurnCostUsd: 0.8, checkpointQuality: 0.95, boundary: "none" })).toMatchObject({ compact: true, reason: "projected-cost" });
  });

  test("TE-051 refuses semantic-boundary compaction when checkpoint quality is insufficient", async () => {
    const { decideEconomicCompaction } = await handoffApi();
    expect(decideEconomicCompaction({ activeContextPercent: 45, projectedNextTurnCostUsd: 0.1, checkpointQuality: 0.4, boundary: "implementation-complete" })).toMatchObject({ compact: false, reason: "checkpoint-incomplete" });
  });

  test("TE-052 creates an explicit handoff command plan with a durable checkpoint entry", async () => {
    const { buildHandoffCommandPlan } = await handoffApi();
    const plan = buildHandoffCommandPlan({ goal: "continue work", pendingActions: ["wire runtime"], sessionId: "s1" });
    expect(plan.entries).toEqual(expect.arrayContaining([expect.objectContaining({ customType: "token-efficiency-handoff" })]));
    expect(plan.bootstrap).toContain("wire runtime");
    expect(plan.openNewSession).toBe(true);
  });

  test("TE-053 injects a handoff bootstrap exactly once in the destination session", async () => {
    const { planSessionBootstrapInjection } = await handoffApi();
    const first = planSessionBootstrapInjection({ destinationSessionId: "s2", consumedCheckpointIds: [], checkpoint: { id: "h1", goal: "continue" } });
    const repeated = planSessionBootstrapInjection({ destinationSessionId: "s2", consumedCheckpointIds: ["h1"], checkpoint: { id: "h1", goal: "continue" } });
    expect(first).toMatchObject({ inject: true, markConsumed: "h1" });
    expect(repeated).toMatchObject({ inject: false, reason: "already-consumed" });
  });

  test("TE-054 validates sidecar compression before accepting it", async () => {
    const { validateSidecarCompression } = await handoffApi();
    const result = validateSidecarCompression({
      sourceIds: ["constraint-1", "mutation-1", "failure-1"],
      compressed: { retainedSourceIds: ["constraint-1", "mutation-1"], text: "summary" },
    });
    expect(result).toMatchObject({ valid: false, missingSourceIds: ["failure-1"], useFallback: true });
  });

  test("TE-055 preserves the main model while sidecar compression executes and falls back", async () => {
    const { completeSidecarCompression } = await handoffApi();
    const result = await completeSidecarCompression({
      mainModel: "anthropic/opus", sidecarModel: "anthropic/haiku", sourceIds: ["constraint-1"],
      sidecarResult: { retainedSourceIds: [], text: "invalid" }, deterministicFallback: { retainedSourceIds: ["constraint-1"], text: "safe" },
    });
    expect(result).toMatchObject({ mainModelBefore: "anthropic/opus", mainModelAfter: "anthropic/opus", source: "deterministic-fallback", text: "safe" });
  });

  test("TE-056 merges handoff state into structured compaction without merging typed fact classes", async () => {
    const { mergeHandoffIntoCompaction } = await compactionApi();
    const merged = mergeHandoffIntoCompaction({ repositoryFacts: [{ id: "r1" }], externalFacts: [{ id: "e1" }], userIntent: ["u1"], suggestions: ["s1"] });
    expect(merged.repositoryFacts).toEqual([{ id: "r1" }]);
    expect(merged.externalFacts).toEqual([{ id: "e1" }]);
    expect(merged.userIntent).not.toEqual(merged.suggestions);
  });

  test("TE-057 fails closed when compaction continuation loses protected state", async () => {
    const { validateCompactionContinuation } = await compactionApi();
    const result = validateCompactionContinuation({ before: { protectedIds: ["c1", "m1", "f1"] }, after: { retainedIds: ["c1", "m1"] } });
    expect(result).toMatchObject({ valid: false, missingProtectedIds: ["f1"], allowContinuation: false });
  });
});
