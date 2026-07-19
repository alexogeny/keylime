import { describe, expect, test } from "bun:test";
import { productionModule, shaPattern } from "./helpers";

function sample(strategy: string, index: number, overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: `fixture-${index}`,
    strategy,
    inputTokens: strategy === "raw" ? 1_000 : 400,
    outputTokens: 100,
    latencyMs: strategy === "raw" ? 1_000 : 600,
    fallbackUsed: false,
    resolutionPassed: true,
    safetyPassed: true,
    activeControlIdsBefore: ["constraint-1", "plan-1"],
    activeControlIdsAfter: ["constraint-1", "plan-1"],
    prohibitedBackendActions: 0,
    relinkingDetected: false,
    evaluatorId: "independent-evaluator",
    optimizerId: strategy,
    ...overrides,
  };
}

describe("RED: runtime quality canaries and promotion gates", () => {
  test("requires paired raw baseline and candidate runs for every fixture", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    expect(() => evaluateRuntimeCanary([sample("candidate", 1)])).toThrow(/baseline|paired/i);
    expect(() => evaluateRuntimeCanary([sample("raw", 1), sample("candidate", 2)])).toThrow(/paired|fixture/i);
  });

  test("reports strategy-level confidence intervals across repeated runs", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    const runs = Array.from({ length: 20 }, (_, index) => [sample("raw", index), sample("candidate", index, { resolutionPassed: index !== 0 })]).flat();
    const report = evaluateRuntimeCanary(runs, { minResolutionRate: .9, confidenceLevel: .95 });
    expect(report.strategies.candidate.resolutionRate).toBe(.95);
    expect(typeof report.strategies.candidate.confidenceInterval95.lower).toBe("number");
    expect(report.strategies.candidate.runs).toBe(20);
  });

  test("uses zero-tolerance gates for safety, relinking, and control loss", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    const report = evaluateRuntimeCanary([
      sample("raw", 1),
      sample("candidate", 1, { safetyPassed: false, relinkingDetected: true, prohibitedBackendActions: 1, activeControlIdsAfter: ["constraint-1"] }),
    ]);
    expect(report.promotable).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining(["safety_failed", "relinking_detected", "prohibited_backend_action", "active_control_loss"]));
  });

  test("gates p95 latency, fallback rate, and tokens per success", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    const runs = Array.from({ length: 20 }, (_, index) => [
      sample("raw", index),
      sample("candidate", index, { latencyMs: index === 19 ? 90_000 : 20_000, fallbackUsed: index > 17, inputTokens: 2_000 }),
    ]).flat();
    const report = evaluateRuntimeCanary(runs, { maxP95LatencyMs: 10_000, maxFallbackRate: .01, maxTokensPerSuccess: 1_000 });
    expect(report.reasons).toEqual(expect.arrayContaining(["latency_p95_exceeded", "fallback_rate_exceeded", "tokens_per_success_exceeded"]));
  });

  test("requires evaluator independence", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    const report = evaluateRuntimeCanary([
      sample("raw", 1),
      sample("candidate", 1, { optimizerId: "agent-a", evaluatorId: "agent-a" }),
    ]);
    expect(report.promotable).toBe(false);
    expect(report.reasons).toContain("evaluator_not_independent");
  });

  test("stores structural fixture fingerprints rather than prompts or source", async () => {
    const { createCanaryFixture } = await productionModule("runtime-canaries");
    const fixture = createCanaryFixture({
      id: "compaction-invalid-json",
      eventTypes: ["model_response", "parse_failure", "fallback"],
      requiredControlIds: ["constraint-1"],
      prompt: "PRIVATE PROMPT",
      sourceCode: "PRIVATE SOURCE",
      repositoryPath: "/private/repo",
    });
    expect(fixture.fingerprint).toMatch(shaPattern());
    expect(JSON.stringify(fixture)).not.toContain("PRIVATE");
    expect(JSON.stringify(fixture)).not.toContain("/private/repo");
  });

  test("promotes atomically and rolls back when post-promotion checks fail", async () => {
    const { createCanaryRegistry } = await productionModule("runtime-canaries");
    const registry = createCanaryRegistry({ maxVersions: 10 });
    registry.install("baseline", { enabled: true });
    const promotion = registry.promote("candidate", { promotable: true, fingerprint: "candidate-hash" });
    expect(promotion.previousVersion).toBe("baseline");
    expect(registry.activeVersion()).toBe("candidate");
    registry.recordPostPromotionFailure("candidate", { reason: "safety regression" });
    expect(registry.activeVersion()).toBe("baseline");
    expect(registry.history().at(-1).action).toBe("rollback");
  });

  test("accounts for temperature-zero noise with repeated trials", async () => {
    const { evaluateRuntimeCanary } = await productionModule("runtime-canaries");
    const runs = Array.from({ length: 10 }, (_, index) => [sample("raw", index), sample("candidate", index, { resolutionPassed: index !== 0 })]).flat();
    const report = evaluateRuntimeCanary(runs, { minResolutionRate: .9, confidenceLevel: .95 });
    expect(report.promotable).toBe(false);
    expect(report.reasons).toContain("resolution_confidence_below_floor");
  });

  test("bounds fixture, result, and version history", async () => {
    const { createCanaryRegistry } = await productionModule("runtime-canaries");
    const registry = createCanaryRegistry({ maxFixtures: 100, maxResults: 1_000, maxVersions: 10 });
    for (let index = 0; index < 1_000; index++) registry.addFixture({ id: `fixture-${index}`, fingerprint: `hash-${index}` });
    for (let index = 0; index < 5_000; index++) registry.recordResult({ fixtureId: `fixture-${index}`, passed: true });
    for (let index = 0; index < 50; index++) registry.install(`version-${index}`, {});
    expect(registry.memoryStats()).toEqual({ fixtures: 100, results: 1_000, versions: 10 });
  });
});
