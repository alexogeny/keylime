import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { storeContextObject } from "../../extensions/context-object-store";
import { compileHarnessTrace } from "../../extensions/shared/harness-trace-ir";
import { fixtureRoot, productionModule, removeFixture, shaPattern } from "./helpers";

async function replayFixture() {
  const cwd = await fixtureRoot("harness-replay");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
  const object = await storeContextObject(cwd, {
    id: "evidence-1", kind: "repo_search", sourceTool: "code_search",
    content: "src/a.ts:1 export const a = 1", summary: "a declaration", retention: "pinned",
  });
  const trace = compileHarnessTrace({
    sessionId: "session-1",
    events: [
      { id: "step-1", type: "context_selection", handler: "context-runtime", objectIds: [object.object.id] },
      { id: "step-2", type: "policy_decision", parentId: "step-1", handler: "danger-guard", outcome: "allow" },
      { id: "step-3", type: "tool_result", parentId: "step-2", handler: "run-checks", outcome: "passed" },
    ],
    harnessArtifacts: [
      { path: "extensions/context-runtime.ts", symbols: ["createContextRuntimeCoordinator"] },
      { path: "extensions/danger-guard.ts", symbols: ["codingModeBlockReasonForToolCall"] },
    ],
  });
  return { cwd, trace, objectId: object.object.id };
}

describe("RED: deterministic harness replay laboratory", () => {
  test("replays structural harness decisions without invoking a model or tools", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle, replayHarnessTrace } = await productionModule("harness-replay");
      const bundle = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId] });
      const result = await replayHarnessTrace(bundle, { cwd: fixture.cwd });
      expect(result.modelCalls).toBe(0);
      expect(result.toolExecutions).toBe(0);
      expect(result.steps.map((step: any) => step.outcome)).toEqual([undefined, "allow", "passed"]);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("binds replay bundles to repository identity", async () => {
    const first = await replayFixture();
    const second = await replayFixture();
    try {
      const { createReplayBundle, replayHarnessTrace } = await productionModule("harness-replay");
      const bundle = await createReplayBundle({ cwd: first.cwd, trace: first.trace, objectIds: [first.objectId] });
      expect(bundle.repositoryFingerprint).toMatch(shaPattern());
      await expect(replayHarnessTrace(bundle, { cwd: second.cwd })).rejects.toThrow(/repository/i);
    } finally { await removeFixture(first.cwd); await removeFixture(second.cwd); }
  });

  test("rejects missing or hash-mismatched context-object dependencies", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle, replayHarnessTrace } = await productionModule("harness-replay");
      const bundle = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId] });
      bundle.dependencies[0].contentHash = "bad-hash";
      await expect(replayHarnessTrace(bundle, { cwd: fixture.cwd })).rejects.toThrow(/hash|dependency/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("diffs harness versions by decision, context, latency, and fallback", async () => {
    const { compareReplayResults } = await productionModule("harness-replay");
    const diff = compareReplayResults(
      { version: "baseline", decisions: ["allow"], objectIds: ["a"], durationMs: 10, fallbackUsed: false },
      { version: "candidate", decisions: ["block"], objectIds: ["b"], durationMs: 20, fallbackUsed: true },
    );
    expect(diff.decisionChanges).toEqual([{ index: 0, before: "allow", after: "block" }]);
    expect(diff.contextAdded).toEqual(["b"]);
    expect(diff.contextRemoved).toEqual(["a"]);
    expect(diff.latencyDeltaMs).toBe(10);
    expect(diff.fallbackChanged).toBe(true);
  });

  test("serializes only structural metadata and dependency hashes by default", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle, serializeReplayBundle } = await productionModule("harness-replay");
      const bundle = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId], prompt: "PRIVATE PROMPT", response: "PRIVATE RESPONSE" });
      const serialized = serializeReplayBundle(bundle);
      expect(serialized).not.toContain("PRIVATE PROMPT");
      expect(serialized).not.toContain("PRIVATE RESPONSE");
      expect(serialized).not.toContain(fixture.cwd);
      expect(serialized).not.toContain("export const a");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("supports deterministic branches from any replay event", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle, branchReplay } = await productionModule("harness-replay");
      const bundle = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId] });
      const first = branchReplay(bundle, "step-2", { policyOutcome: "block" });
      const second = branchReplay(bundle, "step-2", { policyOutcome: "block" });
      expect(first).toEqual(second);
      expect(first.parentFingerprint).toBe(bundle.fingerprint);
      expect(first.events.at(-1).outcome).toBe("block");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("identifies the first causal divergence rather than only final output", async () => {
    const { firstReplayDivergence } = await productionModule("harness-replay");
    const divergence = firstReplayDivergence(
      [{ id: "a", decision: "include" }, { id: "b", decision: "allow" }, { id: "c", decision: "pass" }],
      [{ id: "a", decision: "include" }, { id: "b", decision: "block" }, { id: "c", decision: "fail" }],
    );
    expect(divergence).toEqual({ eventId: "b", index: 1, baseline: "allow", candidate: "block" });
  });

  test("bounds replay events and dependencies", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle } = await productionModule("harness-replay");
      const trace = { ...fixture.trace, steps: Array.from({ length: 100_000 }, (_, index) => ({ id: `step-${index}`, type: "event" })) };
      const bundle = await createReplayBundle({ cwd: fixture.cwd, trace, objectIds: [fixture.objectId], maxEvents: 5_000, maxDependencies: 100 });
      expect(bundle.events.length).toBeLessThanOrEqual(5_000);
      expect(bundle.dependencies.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(bundle).length).toBeLessThan(2_000_000);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("produces the same fingerprint for byte-identical replay inputs", async () => {
    const fixture = await replayFixture();
    try {
      const { createReplayBundle } = await productionModule("harness-replay");
      const first = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId] });
      const second = await createReplayBundle({ cwd: fixture.cwd, trace: fixture.trace, objectIds: [fixture.objectId] });
      expect(first.fingerprint).toMatch(shaPattern());
      expect(first.fingerprint).toBe(second.fingerprint);
    } finally { await removeFixture(fixture.cwd); }
  });
});
