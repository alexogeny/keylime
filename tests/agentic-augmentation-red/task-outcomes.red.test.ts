import { describe, expect, test } from "bun:test";
import { productionModule } from "./helpers";

async function tracker(taskId = "task-1") {
  const api = await productionModule("task-outcome");
  return api.createTaskOutcomeTracker({
    taskId,
    repositoryFingerprint: "a".repeat(64),
    startedAt: 1_000,
  });
}

describe("RED AA-001..010: one outcome record per settled user task", () => {
  test("AA-001 opens one task and settles it exactly once", async () => {
    const active = await tracker();
    const first = active.settle({ settledAt: 2_000 });
    expect(first.taskId).toBe("task-1");
    expect(() => active.settle({ settledAt: 3_000 })).toThrow(/settled|closed|complete/i);
  });

  test("AA-002 aggregates usage across every model turn", async () => {
    const active = await tracker();
    active.recordUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, costUsd: 0.01 });
    active.recordUsage({ inputTokens: 80, outputTokens: 10, cacheReadTokens: 20, costUsd: 0.02 });
    const result = active.settle({ settledAt: 2_000 });
    expect(result.usage).toMatchObject({ modelCalls: 2, inputTokens: 180, outputTokens: 30, cacheReadTokens: 60, costUsd: 0.03 });
  });

  test("AA-003 classifies a successful mutation with passing checks as verified", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "apply_code_replacements", isError: false, changedPaths: ["src/a.ts"] });
    active.recordToolResult({ toolName: "run_checks", isError: false, verification: [{ command: "bun test", passed: true }] });
    expect(active.settle({ settledAt: 2_000 }).outcome).toBe("verified");
  });

  test("AA-004 classifies a successful mutation without checks as unverified", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "create_file", isError: false, changedPaths: ["src/a.ts"] });
    expect(active.settle({ settledAt: 2_000 }).outcome).toBe("unverified_mutation");
  });

  test("AA-005 classifies a final failing check as failed verification", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "apply_code_replacements", isError: false, changedPaths: ["src/a.ts"] });
    active.recordToolResult({ toolName: "run_checks", isError: true, verification: [{ command: "bun test", passed: false }] });
    expect(active.settle({ settledAt: 2_000 }).outcome).toBe("failed_verification");
  });

  test("AA-006 recognizes recovery when a failed check is followed by a passing check", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "apply_code_replacements", isError: false, changedPaths: ["src/a.ts"] });
    active.recordToolResult({ toolName: "run_checks", isError: true, verification: [{ command: "bun test", passed: false }] });
    active.recordToolResult({ toolName: "run_checks", isError: false, verification: [{ command: "bun test", passed: true }] });
    const result = active.settle({ settledAt: 2_000 });
    expect(result.outcome).toBe("verified");
    expect(result.recoveredFailures).toBe(1);
  });

  test("AA-007 treats a successful read-only task as complete rather than no-tool failure", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "inspect_lines", isError: false, evidenceObjectIds: ["object-1"] });
    expect(active.settle({ settledAt: 2_000 }).outcome).toBe("read_only_complete");
  });

  test("AA-008 records a policy-blocked task distinctly", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "apply_code_replacements", blocked: true, isError: true });
    expect(active.settle({ settledAt: 2_000 }).outcome).toBe("blocked");
  });

  test("AA-009 keeps changed paths and verification commands bounded and relative", async () => {
    const active = await tracker();
    active.recordToolResult({ toolName: "create_file", isError: false, changedPaths: ["src/a.ts", "/tmp/outside.ts", "../escape.ts"] });
    active.recordToolResult({ toolName: "run_checks", isError: false, verification: Array.from({ length: 200 }, (_, i) => ({ command: `check-${i}`, passed: true })) });
    const result = active.settle({ settledAt: 2_000 });
    expect(result.changedPaths).toEqual(["src/a.ts"]);
    expect(result.verification.length).toBeLessThanOrEqual(100);
  });

  test("AA-010 produces an aggregate-only persistence record", async () => {
    const active = await tracker();
    active.recordToolCall({ toolName: "inspect_lines", input: { path: "/secret/repo/src/a.ts", prompt: "private prompt" } });
    active.recordAssistantMessage({ text: "private response containing source" });
    const serialized = JSON.stringify(active.settle({ settledAt: 2_000 }));
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private response");
    expect(serialized).not.toContain("/secret/repo");
  });
});
