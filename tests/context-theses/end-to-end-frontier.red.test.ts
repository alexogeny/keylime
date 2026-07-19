import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Run = { strategy: string; inputTokens: number; uncachedInputTokens: number; peakContextTokens: number; resolutionPassed: boolean; safetyPassed: boolean; continuationFacts: string[]; requiredFacts: string[]; rehydrations: number };
type Frontier = { accepted: Run[]; rejected: Array<Run & { rejectionReasons: string[] }>; best?: Run; tokensPerSuccess: number };

const baseline: Run = { strategy: "raw", inputTokens: 100_000, uncachedInputTokens: 90_000, peakContextTokens: 40_000, resolutionPassed: true, safetyPassed: true, continuationFacts: ["constraint", "failure", "next action"], requiredFacts: ["constraint", "failure", "next action"], rehydrations: 0 };
const optimized: Run = { ...baseline, strategy: "hybrid", inputTokens: 48_000, uncachedInputTokens: 30_000, peakContextTokens: 14_000, rehydrations: 2 };

async function evaluate(runs: Run[], options: Record<string, unknown> = {}): Promise<Frontier> {
  const api = await loadThesisModule("context-efficiency-frontier");
  const fn = thesisFunction<(runs: Run[], options: Record<string, unknown>) => Frontier>(api, "evaluateContextEfficiencyFrontier");
  return fn(runs, { minFactRecall: 1, requireSafety: true, requireResolution: true, ...options });
}

describe("RED thesis: end-to-end efficiency/effectiveness frontier", () => {
  test("accepts a strategy that preserves quality and halves input tokens", async () => {
    const result = await evaluate([baseline, optimized]);
    expect(result.accepted.map(run => run.strategy)).toContain("hybrid");
    expect(result.best?.strategy).toBe("hybrid");
  });

  test("rejects token savings that lose required continuation facts", async () => {
    const lossy = { ...optimized, strategy: "lossy", continuationFacts: ["next action"] };
    const result = await evaluate([baseline, lossy]);
    expect(result.rejected.find(run => run.strategy === "lossy")?.rejectionReasons).toContain("fact_recall_below_floor");
  });

  test("rejects token savings that violate safety", async () => {
    const unsafe = { ...optimized, strategy: "unsafe", safetyPassed: false };
    expect((await evaluate([baseline, unsafe])).rejected.find(run => run.strategy === "unsafe")?.rejectionReasons).toContain("safety_failed");
  });

  test("rejects token savings that reduce task resolution", async () => {
    const failed = { ...optimized, strategy: "failed", resolutionPassed: false };
    expect((await evaluate([baseline, failed])).rejected.find(run => run.strategy === "failed")?.rejectionReasons).toContain("resolution_failed");
  });

  test("optimizes uncached tokens rather than headline input tokens", async () => {
    const cachedButHuge = { ...baseline, strategy: "cached-huge", inputTokens: 120_000, uncachedInputTokens: 20_000 };
    const compactUncached = { ...optimized, strategy: "compact", inputTokens: 45_000, uncachedInputTokens: 25_000 };
    expect((await evaluate([cachedButHuge, compactUncached])).best?.strategy).toBe("cached-huge");
  });

  test("reports finite tokens per successful task", async () => {
    const result = await evaluate([baseline, optimized]);
    expect(Number.isFinite(result.tokensPerSuccess)).toBe(true);
    expect(result.tokensPerSuccess).toBeGreaterThan(0);
  });

  test("allows a bounded rehydration cost while rejecting thrashing", async () => {
    const thrashing = { ...optimized, strategy: "thrashing", inputTokens: 35_000, uncachedInputTokens: 25_000, rehydrations: 20 };
    const result = await evaluate([optimized, thrashing], { maxRehydrations: 4 });
    expect(result.accepted.map(run => run.strategy)).toContain("hybrid");
    expect(result.rejected.find(run => run.strategy === "thrashing")?.rejectionReasons).toContain("rehydration_budget_exceeded");
  });

  test("requires quality comparison against the raw-history control", async () => {
    await expect(evaluate([optimized])).rejects.toThrow("raw-history control");
  });
});
