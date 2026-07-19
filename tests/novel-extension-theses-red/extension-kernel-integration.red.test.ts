import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import { fixtureRoot, productionModule, removeFixture, shaPattern, writeFixture } from "./helpers";

async function kernelFixture() {
  const cwd = await fixtureRoot("extension-kernel");
  await writeFixture(cwd, "src/a.ts", `export const a = 1;`);
  await writeFixture(cwd, "src/b.ts", `import {a} from "./a"; export const b = a;`);
  await writeFixture(cwd, "tests/b.test.ts", `import {b} from "../src/b"; test("b",()=>b);`);
  await writeFixture(cwd, "package.json", JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }));
  return cwd;
}

describe("RED: tightly integrated extension kernel", () => {
  test("shares one repository scan across auditor, impact, and evidence features", async () => {
    const cwd = await kernelFixture();
    try {
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const kernel = await createExtensionKernel({ cwd });
      await kernel.auditExtensions();
      await kernel.buildImpactPlan({ changedPaths: ["src/a.ts"] });
      await kernel.buildEvidenceGraph({ claims: [{ id: "a", filePaths: ["src/a.ts"] }] });
      expect(kernel.performanceStats().repositoryScans).toBe(1);
      expect(kernel.performanceStats().duplicateFileReads).toBe(0);
    } finally { await removeFixture(cwd); }
  });

  test("shares content hashes and repository identity across all features", async () => {
    const cwd = await kernelFixture();
    try {
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const kernel = await createExtensionKernel({ cwd });
      const audit = await kernel.auditExtensions();
      const impact = await kernel.buildImpactPlan({ changedPaths: ["src/a.ts"] });
      const evidence = await kernel.buildEvidenceGraph({ claims: [{ id: "a", filePaths: ["src/a.ts"] }] });
      expect(kernel.repositoryFingerprint).toMatch(shaPattern());
      expect(audit.repositoryFingerprint).toBe(kernel.repositoryFingerprint);
      expect(impact.repositoryFingerprint).toBe(kernel.repositoryFingerprint);
      expect(evidence.repositoryFingerprint).toBe(kernel.repositoryFingerprint);
      expect(kernel.performanceStats().hashComputationsByPath["src/a.ts"]).toBe(1);
    } finally { await removeFixture(cwd); }
  });

  test("normalizes each Pi lifecycle event once before bounded feature fanout", async () => {
    const cwd = await kernelFixture();
    try {
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const kernel = await createExtensionKernel({ cwd, maxEventHistory: 100 });
      kernel.ingestPiEvent("tool_result", { toolName: "code_search", toolCallId: "call-1", content: [{ type: "text", text: "large payload".repeat(1_000) }] });
      expect(kernel.performanceStats().eventsNormalized).toBe(1);
      expect(kernel.performanceStats().featureDeliveries).toBeGreaterThan(1);
      expect(kernel.snapshot().events[0].payloadChars).toBeGreaterThan(1_000);
      expect(JSON.stringify(kernel.snapshot())).not.toContain("large payload");
    } finally { await removeFixture(cwd); }
  });

  test("uses one shared capability policy for tools, delegation, and replay", async () => {
    const cwd = await kernelFixture();
    try {
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const kernel = await createExtensionKernel({ cwd });
      expect(kernel.capabilityPolicy).toBe(kernel.delegation.capabilityPolicy);
      expect(kernel.capabilityPolicy).toBe(kernel.replay.capabilityPolicy);
      expect(kernel.capabilityPolicy).toBe(kernel.toolGuard.capabilityPolicy);
    } finally { await removeFixture(cwd); }
  });

  test("uses one metrics channel and bounded structural telemetry", async () => {
    const cwd = await kernelFixture();
    try {
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const kernel = await createExtensionKernel({ cwd });
      expect(kernel.metrics).toBe(kernel.contextDebugger.metrics);
      expect(kernel.metrics).toBe(kernel.canaries.metrics);
      expect(kernel.metrics).toBe(kernel.replay.metrics);
      kernel.metrics.publish({ kind: "feature_event", prompt: "PRIVATE", source: "PRIVATE" });
      expect(JSON.stringify(kernel.metrics.snapshot())).not.toContain("PRIVATE");
    } finally { await removeFixture(cwd); }
  });

  test("adapts MCP catalogs through deferred discovery rather than copying schemas", async () => {
    const { createEcosystemAdapters } = await productionModule("ecosystem-adapters");
    const adapters = createEcosystemAdapters();
    const tools = Array.from({ length: 500 }, (_, index) => ({ name: `mcp_tool_${index}`, description: "x".repeat(1_000), inputSchema: { properties: { payload: { type: "string", description: "x".repeat(1_000) } } } }));
    const catalog = adapters.ingestMcpCatalog("server-1", tools);
    expect(catalog.bootstrapTools).toHaveLength(1);
    expect(catalog.bootstrapChars).toBeLessThan(1_000);
    expect(catalog.deferredTools).toBe(500);
    expect(JSON.stringify(catalog)).not.toContain("properties");
  });

  test("normalizes optional LSP signals without owning language-server lifecycle", async () => {
    const { createEcosystemAdapters } = await productionModule("ecosystem-adapters");
    const adapters = createEcosystemAdapters({ lspOwnership: "external" });
    const signal = adapters.ingestLspResult({ operation: "findReferences", locations: [{ uri: "file:///repo/src/a.ts", range: { start: { line: 0 } } }] });
    expect(signal).toEqual(expect.objectContaining({ kind: "reference", path: "src/a.ts", line: 1 }));
    expect(adapters.stats().processesSpawned).toBe(0);
  });

  test("wraps third-party subagent results in Keylime delegation validation", async () => {
    const { createEcosystemAdapters } = await productionModule("ecosystem-adapters");
    const adapters = createEcosystemAdapters();
    const result = adapters.ingestSubagentResult({
      provider: "pi-subagents", contractId: "contract-1", summary: "done", transcript: "x".repeat(1_000_000),
      evidenceObjectIds: ["evidence-1"], verification: [{ command: "bun test", passed: true }],
    });
    expect(result.requiresContractValidation).toBe(true);
    expect(result.transcript).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });

  test("stores external context-mode or VCC payloads once behind canonical object references", async () => {
    const cwd = await kernelFixture();
    try {
      const { createEcosystemAdapters } = await productionModule("ecosystem-adapters");
      const adapters = createEcosystemAdapters({ cwd });
      const payload = "external context payload".repeat(10_000);
      const first = await adapters.ingestExternalContext({ provider: "context-mode", id: "external-1", payload });
      const second = await adapters.ingestExternalContext({ provider: "pi-vcc", id: "external-2", payload });
      expect(first.objectId).toBe(second.objectId);
      expect(second.deduplicated).toBe(true);
      expect(JSON.stringify(second)).not.toContain("external context payload");
    } finally { await removeFixture(cwd); }
  });

  test("keeps integrated analysis bounded on large repositories", async () => {
    const cwd = await fixtureRoot("kernel-volume");
    try {
      for (let index = 0; index < 1_000; index++) await writeFixture(cwd, `src/file-${index}.ts`, `export const value${index}=${index};`);
      const { createExtensionKernel } = await productionModule("extension-kernel");
      const started = performance.now();
      const kernel = await createExtensionKernel({ cwd, maxFiles: 2_000, maxMetadataChars: 2_000_000 });
      await Promise.all([
        kernel.auditExtensions(),
        kernel.buildImpactPlan({ changedPaths: ["src/file-500.ts"] }),
        kernel.buildEvidenceGraph({ claims: [{ id: "claim", filePaths: ["src/file-500.ts"] }] }),
      ]);
      const stats = kernel.performanceStats();
      expect(stats.repositoryScans).toBe(1);
      expect(stats.retainedMetadataChars).toBeLessThanOrEqual(2_000_000);
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally { await removeFixture(cwd); }
  });
});
