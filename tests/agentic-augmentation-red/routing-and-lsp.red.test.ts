import { describe, expect, test } from "bun:test";
import { createEcosystemAdapters } from "../../extensions/shared/ecosystem-adapters";
import { createHarnessGovernanceRuntime } from "../../extensions/shared/harness-governance-runtime";
import { fixtureRoot, productionModule, removeFixture, writeFixture } from "./helpers";

async function routingObserver() {
  const api = await productionModule("agent-routing-observer");
  return api.createAgentRoutingObserver({ mode: "observe-only", maxRecords: 100 });
}

describe("RED AA-046..049: model routing begins as outcome-linked observation", () => {
  test("AA-046 records the recommended profile and actual model without mutating either", async () => {
    const observer = await routingObserver();
    const actual = { provider: "anthropic", model: "sonnet", thinking: "low" };
    const record = observer.observe({ taskId: "task-1", taskKind: "cross_module_debugging", ambiguity: .9, risk: "high", contextPressure: .4, requiresCreativity: true, actual });
    expect(record.recommended.modelTier).toBe("capable");
    expect(record.actual).toEqual(actual);
    expect(record.applied).toBe(false);
    expect(actual).toEqual({ provider: "anthropic", model: "sonnet", thinking: "low" });
  });

  test("AA-047 routing observations are deterministic and explain their decision", async () => {
    const observer = await routingObserver();
    const input = { taskId: "task-1", taskKind: "structured_extraction", ambiguity: .1, risk: "low", contextPressure: .8, requiresCreativity: false, actual: { provider: "test", model: "m", thinking: "off" } };
    const first = observer.observe(input), second = observer.observe(input);
    expect(first.recommended).toEqual(second.recommended);
    expect(first.recommended.rationale.length).toBeGreaterThan(0);
  });

  test("AA-048 joins settled task outcome and successful-task cost to the observation", async () => {
    const observer = await routingObserver();
    observer.observe({ taskId: "task-1", taskKind: "cross_module_debugging", ambiguity: .8, risk: "medium", contextPressure: .3, requiresCreativity: true, actual: { provider: "test", model: "m", thinking: "low" } });
    const completed = observer.attachOutcome("task-1", { outcome: "verified", usage: { costUsd: .12, modelCalls: 3 }, settledAt: 2_000 });
    expect(completed).toMatchObject({ taskId: "task-1", outcome: "verified", successfulTaskCostUsd: .12, modelCalls: 3 });
  });

  test("AA-049 routing records exclude prompts, responses, and absolute paths", async () => {
    const observer = await routingObserver();
    observer.observe({ taskId: "task-1", taskKind: "debugging /secret/repo", ambiguity: .8, risk: "medium", contextPressure: .3, requiresCreativity: true, prompt: "private prompt", actual: { provider: "test", model: "m", thinking: "low" } });
    const serialized = JSON.stringify(observer.snapshot());
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("/secret/repo");
  });
});

describe("RED AA-050..053: external LSP evidence reaches the live impact graph", () => {
  test("AA-050 normalizes all bounded reference locations rather than only the first", () => {
    const adapters = createEcosystemAdapters({ cwd: process.cwd(), lspOwnership: "external" });
    const result: any = adapters.ingestLspResult({
      operation: "findReferences", query: { path: "src/a.ts", line: 1 },
      locations: [
        { uri: "file:///repo/src/a.ts", range: { start: { line: 0 } } },
        { uri: "file:///repo/src/b.ts", range: { start: { line: 4 } } },
      ],
    });
    expect(result.locations).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 1 }),
      expect.objectContaining({ path: "src/b.ts", line: 5 }),
    ]);
  });

  test("AA-051 emits reference edges from the query path to returned paths", () => {
    const adapters = createEcosystemAdapters({ cwd: process.cwd(), lspOwnership: "external" });
    const result: any = adapters.ingestLspResult({
      operation: "findReferences", query: { path: "src/a.ts" },
      locations: [{ uri: "file:///repo/src/b.ts", range: { start: { line: 4 } } }],
    });
    expect(result.edges).toContainEqual({ kind: "lsp", from: "src/b.ts", to: "src/a.ts" });
  });

  test("AA-052 drops absolute locations that cannot be proven inside the repository", () => {
    const adapters = createEcosystemAdapters({ cwd: process.cwd(), lspOwnership: "external" });
    const result: any = adapters.ingestLspResult({
      operation: "findReferences", query: { path: "src/a.ts" },
      locations: [{ uri: "file:///tmp/foreign.ts", range: { start: { line: 0 } } }],
    });
    expect(result.locations).toEqual([]);
    expect(result.rejectedLocations).toBe(1);
  });

  test("AA-053 retained LSP edges affect live impact without spawning an LSP process", async () => {
    const cwd = await fixtureRoot("lsp");
    try {
      await writeFixture(cwd, "package.json", "{}\n");
      await writeFixture(cwd, "src/a.ts", "export const a = 1;\n");
      await writeFixture(cwd, "src/consumer.ts", "export const consumer = 1;\n");
      await writeFixture(cwd, "tests/consumer.test.ts", "export {};\n");
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      runtime.ingestLspSignal({ kind: "lsp", from: "src/consumer.ts", to: "src/a.ts", repositoryFingerprint: runtime.repositoryFingerprint });
      runtime.ingestLspSignal({ kind: "lsp", from: "tests/consumer.test.ts", to: "src/consumer.ts", repositoryFingerprint: runtime.repositoryFingerprint });
      const impact = await runtime.buildImpact(["src/a.ts"]);
      expect(impact.selectedTests).toContain("tests/consumer.test.ts");
      expect(impact.edges).toContainEqual(expect.objectContaining({ kind: "lsp" }));
      expect(runtime.snapshot().adapters.lspOwnership).toBe("external");
      expect(runtime.snapshot().adapters.processesSpawned).toBe(0);
    } finally { await removeFixture(cwd); }
  });
});
