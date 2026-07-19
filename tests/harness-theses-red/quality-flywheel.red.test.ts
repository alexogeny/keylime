import { describe, expect, test } from "bun:test";
import {
  evaluateContextEfficiencyFrontier,
  type ContextStrategyRun,
} from "../../extensions/shared/context-efficiency-frontier";

function run(strategy: string, overrides: Partial<ContextStrategyRun> & Record<string, unknown> = {}): ContextStrategyRun {
  return {
    strategy,
    inputTokens: 1_000,
    uncachedInputTokens: 1_000,
    peakContextTokens: 1_000,
    resolutionPassed: true,
    safetyPassed: true,
    continuationFacts: ["constraint", "plan", "failure"],
    requiredFacts: ["constraint", "plan", "failure"],
    rehydrations: 0,
    ...overrides,
  } as ContextStrategyRun;
}

describe("RED: context optimization is quality-gated and statistically credible", () => {
  test("requires a raw-history control even when multiple optimized runs are supplied", () => {
    expect(() => evaluateContextEfficiencyFrontier([
      run("compressed-a"),
      run("compressed-b"),
    ])).toThrow();
  });

  test("evaluates reliability by strategy rather than cherry-picking a successful run", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw", { uncachedInputTokens: 10_000 }),
      run("compressed", { uncachedInputTokens: 300, resolutionPassed: true }),
      run("compressed", { uncachedInputTokens: 300, resolutionPassed: false }),
    ]);

    expect(report.accepted.map(item => item.strategy)).not.toContain("compressed");
  });

  test("rejects self-evaluation where the optimizer and evaluator are the same", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw", { optimizerId: "baseline", evaluatorId: "independent-evaluator" }),
      run("compressed", { optimizerId: "agent-a", evaluatorId: "agent-a", uncachedInputTokens: 300 }),
    ] as any);

    const rejected = report.rejected.find(item => item.strategy === "compressed");
    expect(rejected?.rejectionReasons).toContain("evaluator_not_independent");
  });

  test("reports repeated-run confidence intervals instead of a single deterministic score", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw"),
      ...Array.from({ length: 10 }, (_, index) => run("compressed", {
        resolutionPassed: index !== 0,
        uncachedInputTokens: 300,
      })),
    ]) as any;

    expect(report.strategyStatistics).toBeDefined();
    expect(report.strategyStatistics.compressed.resolutionRate).toBe(.9);
    expect(typeof report.strategyStatistics.compressed.confidenceInterval95.lower).toBe("number");
    expect(typeof report.strategyStatistics.compressed.confidenceInterval95.upper).toBe("number");
  });

  test("does not select a strategy whose confidence interval crosses the quality floor", () => {
    const report = evaluateContextEfficiencyFrontier([
      ...Array.from({ length: 10 }, () => run("raw", { uncachedInputTokens: 1_000 })),
      ...Array.from({ length: 10 }, (_, index) => run("compressed", {
        resolutionPassed: index < 9,
        uncachedInputTokens: 250,
      })),
    ], { minResolutionRate: .9, confidenceLevel: .95 } as any) as any;

    expect(report.best?.strategy).not.toBe("compressed");
  });

  test("enforces p95 latency and fallback-rate gates", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw", { latencyMs: 1_000, fallbackUsed: false }),
      run("compressed", { latencyMs: 90_000, fallbackUsed: true, uncachedInputTokens: 200 }),
    ] as any, { maxP95LatencyMs: 10_000, maxFallbackRate: .01 } as any);

    const rejected = report.rejected.find(item => item.strategy === "compressed");
    expect(rejected?.rejectionReasons).toEqual(expect.arrayContaining([
      "latency_p95_exceeded",
      "fallback_rate_exceeded",
    ]));
  });

  test("reports token and monetary cost per successful task, not token reduction alone", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw", { uncachedInputTokens: 1_000, costUsd: .10 }),
      run("compressed", { uncachedInputTokens: 300, costUsd: .04 }),
    ] as any) as any;

    expect(report.strategyStatistics.compressed.tokensPerSuccessfulTask).toBe(300);
    expect(report.strategyStatistics.compressed.costPerSuccessfulTaskUsd).toBe(.04);
  });

  test("reports semantic control retention separately from generic fact recall", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw"),
      run("compressed", {
        continuationFacts: ["ordinary fact"],
        requiredFacts: ["ordinary fact"],
        activeControlIdsBefore: ["constraint-1", "plan-1"],
        activeControlIdsAfter: ["constraint-1"],
        uncachedInputTokens: 200,
      }),
    ] as any) as any;

    const rejected = report.rejected.find((item: any) => item.strategy === "compressed");
    expect(rejected?.rejectionReasons).toContain("active_control_retention_below_100_percent");
  });

  test("tracks relinking and prohibited backend-action rates as zero-tolerance safety metrics", () => {
    const report = evaluateContextEfficiencyFrontier([
      run("raw"),
      run("compressed", {
        relinkingDetected: true,
        prohibitedBackendActions: 1,
        uncachedInputTokens: 200,
      }),
    ] as any) as any;

    const rejected = report.rejected.find((item: any) => item.strategy === "compressed");
    expect(rejected?.rejectionReasons).toEqual(expect.arrayContaining([
      "relinking_detected",
      "prohibited_backend_action",
    ]));
  });
});
