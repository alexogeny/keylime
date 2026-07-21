import { describe, expect, test } from "bun:test";

const modulePath = "../../extensions/shared/trajectory-reducer";
async function reducerApi(): Promise<any> {
  return import(modulePath);
}

const trajectory = () => [
  { id: "u1", role: "user", kind: "constraint", text: "Do not change public APIs.", ageTurns: 8, protected: true },
  { id: "a1", role: "assistant", kind: "tool_call", toolCallId: "call-old", toolName: "inspect", text: "inspect old file" , ageTurns: 7 },
  { id: "t1", role: "tool", kind: "tool_result", toolCallId: "call-old", text: "x".repeat(8_000), ageTurns: 7, recoverableObjectId: "ctx-old" },
  { id: "a2", role: "assistant", kind: "decision", text: "Use the shared runtime as the single mutation owner.", ageTurns: 5, protected: true },
  { id: "a3", role: "assistant", kind: "tool_call", toolCallId: "call-write", toolName: "apply", text: "apply guarded replacement", ageTurns: 3 },
  { id: "t2", role: "tool", kind: "mutation_result", toolCallId: "call-write", text: "Changed extensions/context-runtime.ts", ageTurns: 3, protected: true },
  { id: "a4", role: "assistant", kind: "tool_call", toolCallId: "call-fail", toolName: "check", text: "run tests", ageTurns: 2 },
  { id: "t3", role: "tool", kind: "failure", toolCallId: "call-fail", text: "FAIL expected activeContext.tokens=12000 received=90000", ageTurns: 2, protected: true },
  { id: "u2", role: "user", kind: "message", text: "Continue", ageTurns: 0 },
];

describe("RED: trajectory reduction removes waste without deleting task state", () => {
  test("replaces stale recoverable observations with durable object references", async () => {
    const { planTrajectoryReduction } = await reducerApi();
    const result = planTrajectoryReduction(trajectory(), { hotTurns: 2, warmTurns: 5 });
    const oldResult = result.messages.find((message: any) => message.toolCallId === "call-old" && message.role === "tool");

    expect(oldResult.text.length).toBeLessThan(500);
    expect(oldResult.text).toContain("ctx-old");
    expect(result.report.recoverableCharsRemoved).toBeGreaterThan(7_000);
  });

  test("preserves exact user constraints, decisions, mutations, and unresolved failures", async () => {
    const { planTrajectoryReduction } = await reducerApi();
    const result = planTrajectoryReduction(trajectory(), { hotTurns: 2, warmTurns: 5 });
    const text = result.messages.map((message: any) => message.text).join("\n");

    expect(text).toContain("Do not change public APIs.");
    expect(text).toContain("single mutation owner");
    expect(text).toContain("Changed extensions/context-runtime.ts");
    expect(text).toContain("expected activeContext.tokens=12000 received=90000");
  });

  test("never creates orphaned tool calls or tool results", async () => {
    const { planTrajectoryReduction, validateToolPairing } = await reducerApi();
    const result = planTrajectoryReduction(trajectory(), { hotTurns: 2, warmTurns: 5 });

    expect(validateToolPairing(result.messages)).toEqual({ valid: true, orphanedCallIds: [] });
  });

  test("retains compact failure evidence after a later successful retry", async () => {
    const { planTrajectoryReduction } = await reducerApi();
    const input = trajectory().concat([
      { id: "a5", role: "assistant", kind: "tool_call", toolCallId: "call-pass", toolName: "check", text: "rerun tests", ageTurns: 1 },
      { id: "t4", role: "tool", kind: "verification", toolCallId: "call-pass", text: "848 pass, 0 fail", ageTurns: 1, protected: true },
    ]);
    const result = planTrajectoryReduction(input, { hotTurns: 2, warmTurns: 5 });
    const text = result.messages.map((message: any) => message.text).join("\n");

    expect(text).toContain("848 pass, 0 fail");
    expect(text).toContain("activeContext.tokens");
    expect(result.report.failuresFolded).toBe(1);
  });

  test("produces deterministic plans and auditable per-item reasons", async () => {
    const { planTrajectoryReduction } = await reducerApi();
    const first = planTrajectoryReduction(trajectory(), { hotTurns: 2, warmTurns: 5 });
    const second = planTrajectoryReduction(trajectory(), { hotTurns: 2, warmTurns: 5 });

    expect(first).toEqual(second);
    expect(first.actions.every((action: any) => action.id && action.action && action.reason)).toBe(true);
  });
});
