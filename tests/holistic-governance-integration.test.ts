import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { storeContextObject } from "../extensions/context-object-store";
import { stabilizeCompactionControlPlane } from "../extensions/structured-compaction";
import { selectEvidencePacketsWithStats } from "../extensions/shared/evidence-packets";
import { createContextRuntimeCoordinator } from "../extensions/context-runtime";
import { createHarnessGovernanceRuntime, HARNESS_GOVERNANCE_COMMANDS, HARNESS_GOVERNANCE_HOOKS } from "../extensions/shared/harness-governance-runtime";
import { createExtensionTrustStore } from "../extensions/shared/extension-trust-store";

async function fixture(prefix = "governance") {
  const cwd = await mkdtemp(join(tmpdir(), `keylime-${prefix}-`));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "tests"), { recursive: true });
  await mkdir(join(cwd, "extensions"), { recursive: true });
  await writeFile(join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(cwd, "src/b.ts"), 'import {a} from "./a"; export const b = a;\n', "utf8");
  await writeFile(join(cwd, "tests/b.test.ts"), 'import {b} from "../src/b"; test("b",()=>b);\n', "utf8");
  await writeFile(join(cwd, "extensions/sample.ts"), 'export default function(pi:any){pi.on("tool_call",()=>{});}\n', "utf8");
  return cwd;
}

function checkpoint(objectId?: string) {
  return stabilizeCompactionControlPlane({
    version: 1, goal: "Integrate governance",
    constraints: [{ text: "Only modify src", sourceEntryIds: ["user-1"], status: "active" }],
    acceptanceCriteria: [{ text: "Tests pass", sourceEntryIds: ["user-2"], status: "active" }],
    decisions: [], activeFiles: [{ path: "src/a.ts", relevance: "target" }], changes: [], verification: [], failures: [], blockers: [],
    pendingActions: [{ text: "Verify impact", sourceEntryIds: ["user-3"], status: "active" }], safetyState: [], objectIds: objectId ? [objectId] : [],
  } as any);
}

describe("holistic harness governance integration", () => {
  test("shares repository identity, capability policy, metrics, and one repository snapshot", async () => {
    const cwd = await fixture();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      expect(runtime.repositoryFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(runtime.kernel.capabilityPolicy).toBe(runtime.capabilityPolicy);
      expect(runtime.kernel.metrics).toBe(runtime.metrics);
      await runtime.buildImpact(["src/a.ts"]);
      await runtime.auditExtensions();
      expect(runtime.performanceStats().repositoryScans).toBe(1);
      expect(runtime.performanceStats().duplicateFileReads).toBe(0);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("persists a privacy-safe trusted audit and detects real extension drift", async () => {
    const cwd = await fixture("governance-trust");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const audit = await runtime.auditHarness();
      expect((await runtime.extensionDrift()).status).toBe("untrusted");
      await runtime.trustCurrentAudit("reviewed locally");
      expect((await runtime.extensionDrift()).status).toBe("trusted");
      await writeFile(join(cwd, "extensions/sample.ts"), 'export default function(pi:any){pi.on("context",()=>{});}\n', "utf8");
      const drift = await runtime.extensionDrift();
      expect(drift.status).toBe("drifted");
      expect(drift.beforeFingerprint).toBe(audit.fingerprint);
      const serialized = await readFile(join(cwd, ".pi/extension-trust-v1.json"), "utf8");
      expect(serialized).not.toContain("export default");
      expect(serialized).not.toContain(cwd);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("captures the live Pi tool and command surface without retaining schemas or prompts", async () => {
    const cwd = await fixture("governance-surface");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const surface = await runtime.captureRuntimeSurface({
        tools: [{ name: "code_search", description: "PRIVATE DESCRIPTION", parameters: { secret: "PRIVATE SCHEMA" }, sourceInfo: { path: `${cwd}/extensions/sample.ts` } }, { name: "code_search", sourceInfo: { path: `${cwd}/extensions/sample.ts` } }],
        activeTools: ["code_search"], commands: [{ name: "extension-audit", source: "extension", sourceInfo: { scope: "project", path: `${cwd}/extensions/sample.ts` } }],
      });
      expect(surface.collisions.tools).toEqual(["code_search"]);
      expect(surface.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(surface.stats.originHashComputations).toBe(1);
      expect(JSON.stringify(surface)).not.toContain("PRIVATE");
      expect(JSON.stringify(surface)).not.toContain(cwd);
      await runtime.trustCurrentAudit("surface reviewed");
      await runtime.captureRuntimeSurface({ tools: [{ name: "different_tool" }], activeTools: ["different_tool"], commands: [] });
      expect((await runtime.extensionDrift()).status).toBe("drifted");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("fans lifecycle events into bounded trace, metrics, and replay without payload retention", async () => {
    const cwd = await fixture("governance-trace");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1", maxEvents: 100 });
      runtime.ingestEvent("tool_call", { toolName: "code_search", toolCallId: "call-1", content: "PRIVATE PAYLOAD".repeat(1_000) });
      runtime.ingestEvent("tool_result", { toolName: "code_search", toolCallId: "call-1", isError: false, content: "PRIVATE RESULT" });
      const bundle = await runtime.createReplayBundle([]);
      const replay = await runtime.replay(bundle);
      expect(replay.modelCalls).toBe(0);
      expect(replay.toolExecutions).toBe(0);
      expect(replay.steps).toHaveLength(2);
      expect(JSON.stringify(runtime.snapshot())).not.toContain("PRIVATE");
      expect(runtime.performanceStats().eventsNormalized).toBe(2);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("connects change impact, canonical verification evidence, and claim provenance", async () => {
    const cwd = await fixture("governance-evidence");
    try {
      const stored = await storeContextObject(cwd, { id: "verification-1", kind: "test_run", sourceTool: "run_checks", content: "tests pass", summary: "tests pass", retention: "pinned" });
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const impact = await runtime.buildImpact(["src/a.ts"]);
      expect(impact.affectedFiles).toEqual(expect.arrayContaining(["src/b.ts", "tests/b.test.ts"]));
      expect(impact.verificationCommands[0]).toContain("tests/b.test.ts");
      const graph = await runtime.buildEvidence({ checkpoint: checkpoint(stored.object.id), claims: [{ id: "verified", text: "Change is verified", filePaths: ["src/a.ts"], objectIds: [stored.object.id] }] });
      expect(graph.repositoryFingerprint).toBe(runtime.repositoryFingerprint);
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ to: "file:src/a.ts", kind: "located_in" }),
        expect.objectContaining({ to: `object:${stored.object.id}`, kind: "verified_by" }),
      ]));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("incrementally refreshes the shared dependency graph after real mutation outcomes", async () => {
    const cwd = await fixture("governance-refresh");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      expect((await runtime.buildImpact(["src/a.ts"])).affectedFiles).toContain("src/b.ts");
      await writeFile(join(cwd, "src/b.ts"), "export const b = 2;\n", "utf8");
      await runtime.recordToolOutcome({ toolName: "apply_code_replacements", toolCallId: "mutation-1", changedPaths: ["src/b.ts"], isError: false });
      expect((await runtime.buildImpact(["src/a.ts"])).affectedFiles).not.toContain("src/b.ts");
      expect(runtime.performanceStats().repositoryScans).toBe(1);
      expect(runtime.performanceStats().incrementalFileReads).toBe(1);
      expect(runtime.snapshot().modifiedPaths).toEqual(["src/b.ts"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("uses the same policy boundary for leases and delegated work", async () => {
    const cwd = await fixture("governance-authority");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const lease = runtime.issueLease({ intentId: "intent-1", trustedSourceEntryId: "user-1", tools: ["apply_code_replacements"], paths: ["src/**"], operations: ["modify"], expiresAfterTurns: 2, expiresAfterMs: 60_000 });
      expect(runtime.authorizeLease(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["src/a.ts"] }).allowed).toBe(true);
      expect(runtime.authorizeLease(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["tests/b.test.ts"] }).allowed).toBe(false);
      const contract = await runtime.createDelegationContract({ checkpoint: checkpoint(), goal: "Update src/a.ts", tools: ["apply_code_replacements"], paths: ["src/**"], requiredVerification: [] });
      expect(contract.repositoryFingerprint).toBe(runtime.repositoryFingerprint);
      expect(contract.controls.length).toBeGreaterThan(0);
      expect(() => runtime.deriveDelegationContract(contract, { paths: ["**"] })).toThrow(/broaden/i);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("feeds retrieval decisions into causal debugging through the shared runtime", async () => {
    const cwd = await fixture("governance-debug");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const intent: any = { objective: "edit a", symbols: ["a"], paths: ["src/a.ts"], pendingStep: "verify" };
      const candidates: any[] = [
        { id: "a", path: "src/a.ts", startLine: 1, endLine: 1, text: "export const a = 1", lexical: 1, semantic: 1, graph: 1, recency: 1, symbols: ["a"], objectId: "source-a", representation: "exact_source" },
        { id: "noise", path: "README.md", startLine: 1, endLine: 1, text: "noise", lexical: 0, semantic: 0, graph: 0, recency: 0, symbols: [], objectId: "noise", representation: "summary" },
      ];
      const budget: any = { maxTokens: 200, maxPackets: 1, maxFiles: 1 };
      const selected = selectEvidencePacketsWithStats(intent, candidates, budget);
      const explanation = runtime.explainContextSelection({ intent, candidates, budget, ...selected });
      expect(explanation.selectedIds).toEqual(["a"]);
      expect(explanation.candidates.find((item: any) => item.id === "noise").reason).toMatch(/relevance/i);
      const contextRuntime = createContextRuntimeCoordinator();
      contextRuntime.selectEvidence(intent, candidates, budget);
      contextRuntime.snapshot();
      const integrated = runtime.snapshot().contextRuntime.contextSelection;
      expect(integrated.selectedIds).toEqual(["a"]);
      expect(JSON.stringify(integrated)).not.toContain("export const a");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("evaluates canaries and keeps promotion state in the runtime boundary", async () => {
    const cwd = await fixture("governance-canary");
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session-1" });
      const runs = Array.from({ length: 20 }, (_, index) => [
        { fixtureId: `f-${index}`, strategy: "raw", resolutionPassed: true, safetyPassed: true, latencyMs: 1000, inputTokens: 1000, outputTokens: 100, activeControlIdsBefore: ["c"], activeControlIdsAfter: ["c"], optimizerId: "raw", evaluatorId: "eval" },
        { fixtureId: `f-${index}`, strategy: "candidate", resolutionPassed: true, safetyPassed: true, latencyMs: 500, inputTokens: 400, outputTokens: 100, activeControlIdsBefore: ["c"], activeControlIdsAfter: ["c"], optimizerId: "candidate", evaluatorId: "eval" },
      ]).flat();
      const report = runtime.evaluateCanary(runs, { minResolutionRate: .8 });
      expect(report.promotable).toBe(true);
      runtime.canaryRegistry.install("baseline", {});
      runtime.canaryRegistry.promote("candidate", { promotable: true, fingerprint: "candidate" });
      expect(runtime.canaryRegistry.activeVersion()).toBe("candidate");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("bounds concurrent trust history without losing checksum validity", async () => {
    const cwd = await fixture("governance-concurrency");
    try {
      const store = await createExtensionTrustStore({ cwd, maxEntries: 10 });
      await Promise.all(Array.from({ length: 50 }, (_, index) => store.trust({ fingerprint: index.toString(16).padStart(64, "0"), packages: [], resources: [] }, `review-${index}`)));
      const state = await store.state();
      expect(state.entries).toHaveLength(10);
      expect(state.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(state.entries.at(-1)!.reason).toMatch(/^review-/);
      await writeFile(store.path, JSON.stringify({ ...state, checksum: "corrupt" }), "utf8");
      await expect(store.state()).rejects.toThrow(/checksum|identity/i);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("declares the full command and lifecycle integration surface", () => {
    expect(HARNESS_GOVERNANCE_COMMANDS).toEqual(expect.arrayContaining(["extension-audit", "extension-diff", "extension-trust", "hook-topology", "evidence", "why-context", "change-impact", "harness-replay", "canary-status", "governance-status", "capability-lease", "capability-leases"]));
    expect(HARNESS_GOVERNANCE_HOOKS).toEqual(expect.arrayContaining(["session_start", "resources_discover", "tool_call", "tool_result", "context", "session_before_compact", "session_compact", "session_shutdown"]));
  });
});
