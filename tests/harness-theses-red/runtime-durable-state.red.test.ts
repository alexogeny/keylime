import { describe, expect, test } from "bun:test";
import { createContextRuntimeCoordinator } from "../../extensions/context-runtime";
import { allocateContextBudget } from "../../extensions/shared/context-value-allocator";

describe("RED: runtime control state survives bounded histories", () => {
  test("an early active constraint cannot be evicted by later trajectory volume", () => {
    const runtime = createContextRuntimeCoordinator({ maxTrajectoryEvents: 10 });
    runtime.recordTrajectory([{
      id: "constraint-1",
      subtask: "active",
      type: "constraint",
      text: "Never mutate outside the repository.",
    }]);
    runtime.recordTrajectory(Array.from({ length: 10 }, (_, index) => ({
      id: `action-${index}`,
      subtask: "active",
      type: "action" as const,
      text: `Routine action ${index}`,
    })));

    const result = runtime.endTurn({ contextPercent: 90, boundary: "phase_changed" });
    expect(result.fold?.facts).toContain("Never mutate outside the repository.");
  });

  test("an early active plan remains durable after trajectory folding", () => {
    const runtime = createContextRuntimeCoordinator({ maxTrajectoryEvents: 10 });
    runtime.recordTrajectory([{
      id: "plan-1",
      subtask: "active",
      type: "decision",
      text: "Write the red tests before implementing the control plane.",
    }]);
    runtime.recordTrajectory(Array.from({ length: 10 }, (_, index) => ({
      id: `evidence-${index}`,
      subtask: "active",
      type: "evidence" as const,
      text: `Evidence ${index}`,
    })));

    const result = runtime.endTurn({ contextPercent: 90, boundary: "phase_changed" });
    expect(result.fold?.pending).toContain("Write the red tests before implementing the control plane.");
  });

  test("unresolved failures cannot be displaced from observations by successful noise", () => {
    const runtime = createContextRuntimeCoordinator({ maxObservationEntries: 3 });
    runtime.recordToolResult({
      toolCallId: "critical-failure",
      toolName: "run_checks",
      text: "Safety regression remains unresolved",
      isError: true,
    });
    for (let index = 0; index < 3; index++) {
      runtime.recordToolResult({
        toolCallId: `routine-${index}`,
        toolName: "code_search",
        text: `Routine successful observation ${index}`,
        isError: false,
      });
    }

    expect(runtime.retainedObservations().map(item => item.id)).toContain("critical-failure");
  });

  test("mandatory state that cannot fit its budget fails closed instead of disappearing", () => {
    expect(() => allocateContextBudget([{
      id: "active-policy",
      category: "control",
      chars: 200,
      relevance: 1,
      impact: 1,
      freshness: 1,
      confidence: 1,
      lossRisk: 1,
      recoverable: false,
      mandatory: true,
    }], { maxChars: 100 })).toThrow();
  });

  test("semantic duplicates do not consume budget that should preserve distinct evidence", () => {
    const allocation = allocateContextBudget([
      {
        id: "duplicate-a", contentHash: "same-content", category: "evidence", chars: 40,
        relevance: 1, impact: 1, freshness: 1, confidence: 1, lossRisk: 1, recoverable: false,
      },
      {
        id: "duplicate-b", contentHash: "same-content", category: "evidence", chars: 40,
        relevance: 1, impact: 1, freshness: 1, confidence: 1, lossRisk: 1, recoverable: false,
      },
      {
        id: "distinct-failure", contentHash: "distinct-content", category: "failure", chars: 40,
        relevance: .4, impact: .5, freshness: .4, confidence: .8, lossRisk: .5, recoverable: true,
      },
    ] as any, { maxChars: 80 });

    expect(allocation.selected.filter(item => (item as any).contentHash === "same-content")).toHaveLength(1);
    expect(allocation.selected.map(item => item.id)).toContain("distinct-failure");
  });

  test("the runtime snapshot exposes typed durable constraints, plans, and unresolved failures", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordTrajectory([
      { id: "c1", subtask: "active", type: "constraint", text: "Keep policy" },
      { id: "p1", subtask: "active", type: "decision", text: "Keep plan" },
      { id: "f1", subtask: "active", type: "failure", text: "Keep failure", resolved: false },
    ]);
    runtime.endTurn({ contextPercent: 90, boundary: "phase_changed" });

    const snapshot = runtime.snapshot() as any;
    expect(snapshot.controlState).toEqual({
      constraints: [expect.objectContaining({ sourceEventId: "c1", text: "Keep policy" })],
      plans: [expect.objectContaining({ sourceEventId: "p1", text: "Keep plan" })],
      unresolvedFailures: [expect.objectContaining({ sourceEventId: "f1", text: "Keep failure" })],
    });
  });

  test("control state remains available after a later fold replaces lastFold", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordTrajectory([{ id: "c1", subtask: "setup", type: "constraint", text: "Persistent constraint" }]);
    runtime.endTurn({ contextPercent: 90, boundary: "subtask_completed" });
    runtime.recordTrajectory([{ id: "e1", subtask: "implementation", type: "evidence", text: "Later evidence" }]);
    runtime.endTurn({ contextPercent: 90, boundary: "subtask_completed" });

    expect((runtime.snapshot() as any).controlState.constraints.map((item: any) => item.text)).toContain("Persistent constraint");
  });
});
