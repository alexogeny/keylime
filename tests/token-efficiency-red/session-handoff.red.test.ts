import { describe, expect, test } from "bun:test";

const modulePath = "../../extensions/shared/session-handoff";
async function handoffApi(): Promise<any> {
  return import(modulePath);
}

describe("RED: compaction and cross-session handoff preserve state instead of replaying transcripts", () => {
  test("triggers from active-context pressure and semantic boundaries, never cumulative branch totals alone", async () => {
    const { decideCompaction } = await handoffApi();

    expect(decideCompaction({ activeContextPercent: 82, branchInputTotal: 40_000, boundary: "none" }).compact).toBe(true);
    expect(decideCompaction({ activeContextPercent: 25, branchInputTotal: 900_000, boundary: "none" }).compact).toBe(false);
    expect(decideCompaction({ activeContextPercent: 45, branchInputTotal: 90_000, boundary: "implementation-complete" }).compact).toBe(true);
  });

  test("keeps repository facts, external research, user intent, and suggestions typed separately", async () => {
    const { buildHandoffCheckpoint } = await handoffApi();
    const checkpoint = buildHandoffCheckpoint({
      goal: "Reduce successful-task token spend",
      repositoryFacts: [{ text: "signal-footer sums branch usage.input", source: "extensions/signal-footer.ts:101-114" }],
      externalFacts: [{ text: "Trajectory reduction lowered input tokens in AgentDiet", source: "arxiv:2509.23586", observedAt: "2026-07-21" }],
      userIntent: ["Prefer deterministic reductions before auxiliary model calls"],
      suggestions: ["Profile provider payload prefixes"],
      activeFiles: ["extensions/context-runtime.ts"],
      unresolvedFailures: ["Footer conflates cumulative and current values"],
    });

    expect(checkpoint.repositoryFacts[0].source).toContain("signal-footer.ts");
    expect(checkpoint.externalFacts[0].source).toContain("arxiv");
    expect(checkpoint.userIntent).not.toEqual(checkpoint.suggestions);
  });

  test("creates a bounded bootstrap without embedding the prior transcript", async () => {
    const { buildSessionBootstrap } = await handoffApi();
    const transcript = Array.from({ length: 100 }, (_, index) => `turn ${index}: ${"verbose ".repeat(100)}`);
    const bootstrap = buildSessionBootstrap({
      checkpoint: {
        goal: "Continue token-efficiency work",
        constraints: ["Preserve task success"],
        activeFiles: ["extensions/context-runtime.ts"],
        pendingActions: ["Implement prefix profiler"],
      },
      transcript,
      maxChars: 2_000,
    });

    expect(bootstrap.length).toBeLessThanOrEqual(2_000);
    expect(bootstrap).toContain("Implement prefix profiler");
    expect(bootstrap).not.toContain("turn 99");
  });

  test("plans cheaper sidecar compression without switching the main coding model", async () => {
    const { planCompressionRoute } = await handoffApi();
    const route = planCompressionRoute({
      mainModel: "anthropic/claude-opus",
      availableModels: ["anthropic/claude-opus", "anthropic/claude-haiku"],
      task: "compress-recoverable-observations",
      protectedStatePresent: true,
    });

    expect(route.mainModel).toBe("anthropic/claude-opus");
    expect(route.sidecarModel).toBe("anthropic/claude-haiku");
    expect(route.validation.required).toBe(true);
  });

  test("rejects checkpoints that omit active constraints, mutations, failures, or next actions", async () => {
    const { validateHandoffCheckpoint } = await handoffApi();
    const result = validateHandoffCheckpoint({
      goal: "Reduce spend",
      constraints: [],
      changes: [],
      unresolvedFailures: [],
      pendingActions: [],
    }, {
      expectedConstraintIds: ["constraint-1"],
      expectedMutationIds: ["mutation-1"],
      expectedFailureIds: ["failure-1"],
    });

    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(["constraint-1", "mutation-1", "failure-1", "pendingActions"]));
  });
});
