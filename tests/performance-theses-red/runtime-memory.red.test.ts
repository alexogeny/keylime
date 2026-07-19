import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import { createContextRuntimeCoordinator } from "../../extensions/context-runtime";

describe("RED: runtime state has explicit entry and character ceilings", () => {
  test("fails closed before a single durable control exceeds the character budget", () => {
    const runtime = createContextRuntimeCoordinator({ maxControlEntries: 100, maxControlChars: 1_000 } as any);

    expect(() => runtime.recordTrajectory([{
      id: "oversized-policy",
      subtask: "active",
      type: "constraint",
      text: "x".repeat(2_000),
    }])).toThrow(/control.*character/i);
    expect((runtime.snapshot() as any).memoryStats.controlChars).toBe(0);
  });

  test("reports retained characters and entries for every long-lived runtime region", () => {
    const runtime = createContextRuntimeCoordinator({
      maxObservationEntries: 20,
      maxObservationChars: 2_000,
      maxTrajectoryEvents: 20,
      maxControlEntries: 20,
      maxControlChars: 2_000,
      maxExperiences: 20,
    } as any);
    runtime.recordToolResult({ toolCallId: "result", toolName: "test", text: "r".repeat(500), isError: false });
    runtime.recordTrajectory([{ id: "policy", subtask: "active", type: "constraint", text: "p".repeat(400) }]);

    const stats = (runtime.snapshot() as any).memoryStats;
    expect(stats).toEqual(expect.objectContaining({
      observationEntries: 1,
      observationChars: 500,
      trajectoryEvents: 1,
      controlEntries: 1,
      controlChars: 400,
      experienceEntries: 0,
    }));
    expect(stats.observationChars).toBeLessThanOrEqual(2_000);
    expect(stats.controlChars).toBeLessThanOrEqual(2_000);
  });

  test("high-volume observation ingestion stays bounded in memory and wallclock", () => {
    const runtime = createContextRuntimeCoordinator({ maxObservationEntries: 200, maxObservationChars: 20_000 } as any);
    const started = performance.now();
    for (let index = 0; index < 10_000; index++) {
      runtime.recordToolResult({
        toolCallId: `result-${index}`,
        toolName: "code_search",
        text: `result ${index} ${"x".repeat(100)}`,
        isError: false,
      });
    }
    const elapsedMs = performance.now() - started;
    const stats = (runtime.snapshot() as any).memoryStats;

    expect(stats.observationEntries).toBeLessThanOrEqual(200);
    expect(stats.observationChars).toBeLessThanOrEqual(20_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("durable control entry overflow is rejected without partially mutating state", () => {
    const runtime = createContextRuntimeCoordinator({ maxControlEntries: 10, maxControlChars: 10_000 } as any);
    runtime.recordTrajectory(Array.from({ length: 10 }, (_, index) => ({
      id: `constraint-${index}`,
      subtask: "active",
      type: "constraint" as const,
      text: `constraint ${index}`,
    })));

    expect(() => runtime.recordTrajectory([{
      id: "constraint-overflow",
      subtask: "active",
      type: "constraint",
      text: "must not be retained",
    }])).toThrow(/control-state limit/i);
    const stats = (runtime.snapshot() as any).memoryStats;
    expect(stats.controlEntries).toBe(10);
    expect(stats.controlChars).toBeLessThan(10_000);
  });
});
