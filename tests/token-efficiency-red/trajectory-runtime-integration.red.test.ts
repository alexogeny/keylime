import { describe, expect, test } from "bun:test";

const runtimePath = "../../extensions/context-runtime";
async function runtimeApi(): Promise<any> { return import(runtimePath); }

const base: any[] = [
  { id: "constraint", role: "user", kind: "constraint", text: "Never change the public API", ageTurns: 12, protected: true },
  { id: "call", role: "assistant", kind: "tool_call", toolCallId: "c1", text: "inspect", ageTurns: 10 },
  { id: "result", role: "tool", kind: "tool_result", toolCallId: "c1", text: "large output ".repeat(700), ageTurns: 10, recoverableObjectId: "ctx-1" },
];

async function transform(items: any[], options: Record<string, unknown> = {}) {
  const { transformTrajectoryForContext } = await runtimeApi();
  return transformTrajectoryForContext(items, { currentTurn: 12, hotTurns: 2, warmTurns: 6, ...options });
}

describe("RED: context-runtime is the single trajectory-reduction owner", () => {
  test("TE-040 reports context-runtime as the only mutation owner", async () => {
    const result = await transform(base);
    expect(result.owner).toBe("context-runtime");
    expect(result.mutationPasses).toBe(1);
  });

  test("TE-041 implements protected, hot, warm, recoverable, superseded, and failure states", async () => {
    const result = await transform([
      ...base,
      { id: "hot", role: "tool", kind: "tool_result", text: "recent", ageTurns: 1 },
      { id: "warm", role: "tool", kind: "tool_result", text: "useful", ageTurns: 4 },
      { id: "superseded", role: "tool", kind: "tool_result", text: "old state", ageTurns: 9, supersededBy: "warm" },
      { id: "failure", role: "tool", kind: "failure", text: "permission denied", ageTurns: 8, protected: true },
    ]);
    expect(result.states).toMatchObject({ constraint: "protected", hot: "hot", warm: "warm", result: "recoverable", superseded: "superseded", failure: "failure" });
  });

  test("TE-042 preserves exact protected controls through the actual context transform", async () => {
    const result = await transform(base);
    expect(result.messages.map((message: any) => message.text).join("\n")).toContain("Never change the public API");
    expect(result.audit.protectedChanged).toEqual([]);
  });

  test("TE-043 replaces recoverable observations with resolvable context-object references", async () => {
    const result = await transform(base);
    const recovered = result.messages.find((message: any) => message.id === "result");
    expect(recovered.text).toContain("ctx-1");
    expect(recovered.text.length).toBeLessThan(500);
    expect(result.audit.recoverableIds).toContain("ctx-1");
  });

  test("TE-044 preserves valid tool-call and tool-result pairs after runtime reduction", async () => {
    const result = await transform(base);
    expect(result.audit.toolPairing).toEqual({ valid: true, orphanedCallIds: [] });
  });

  test("TE-045 replays a coding trajectory without losing changed files or checks", async () => {
    const result = await transform(base.concat([
      { id: "mutation", role: "tool", kind: "mutation_result", text: "Changed extensions/a.ts", ageTurns: 5, protected: true },
      { id: "check", role: "tool", kind: "verification", text: "120 pass, 0 fail", ageTurns: 4, protected: true },
    ]));
    const text = result.messages.map((message: any) => message.text).join("\n");
    expect(text).toContain("Changed extensions/a.ts");
    expect(text).toContain("120 pass, 0 fail");
  });

  test("TE-046 replays research with external facts separated from repository facts", async () => {
    const result = await transform(base.concat([
      { id: "external", role: "assistant", kind: "external_fact", text: "Provider caching has a TTL", source: "official-doc", ageTurns: 7, protected: true },
      { id: "repo", role: "assistant", kind: "repository_fact", text: "usage tracker stores cacheRead", source: "extensions/usage-tracker.ts", ageTurns: 7, protected: true },
    ]));
    expect(result.typedFacts.external[0].source).toBe("official-doc");
    expect(result.typedFacts.repository[0].source).toContain("usage-tracker.ts");
  });

  test("TE-047 replays debugging while retaining bounded failed-attempt evidence", async () => {
    const result = await transform(base.concat([
      { id: "failure", role: "tool", kind: "failure", text: "expected 12k received 90k", ageTurns: 5, protected: true },
      { id: "success", role: "tool", kind: "verification", text: "all pass", ageTurns: 1, protected: true },
    ]));
    expect(result.audit.failuresFolded).toBe(1);
    expect(result.messages.map((message: any) => message.text).join("\n")).toContain("expected 12k received 90k");
  });

  test("TE-048 replays failed mutations without hiding partial-write or rollback state", async () => {
    const result = await transform(base.concat([
      { id: "partial", role: "tool", kind: "mutation_failure", text: "1 of 3 replacements applied; rollback required", ageTurns: 5, protected: true },
    ]));
    expect(result.audit.protectedKinds).toContain("mutation_failure");
    expect(result.messages.map((message: any) => message.text).join("\n")).toContain("rollback required");
  });
});
