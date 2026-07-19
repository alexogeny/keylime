import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { storeContextObject } from "../../extensions/context-object-store";
import { stabilizeCompactionControlPlane } from "../../extensions/structured-compaction";
import { fixtureRoot, productionModule, removeFixture, shaPattern } from "./helpers";

async function evidenceFixture() {
  const cwd = await fixtureRoot("evidence-graph");
  await mkdir(join(cwd, "src"), { recursive: true });
  const source = "export function validateOrder(total: number) { return total > 0; }\n";
  await writeFile(join(cwd, "src/order.ts"), source, "utf8");
  const stored = await storeContextObject(cwd, {
    id: "test-run-1", kind: "test_run", sourceTool: "run_checks",
    content: "order test passed", summary: "order test passed", retention: "pinned",
  });
  const checkpoint: any = stabilizeCompactionControlPlane({
    version: 1, goal: "Validate orders",
    constraints: [{ text: "Do not accept negative totals", sourceEntryIds: ["user-1"], status: "active" }],
    acceptanceCriteria: [{ text: "Order test passes", objectIds: [stored.object.id], status: "active" }],
    decisions: [], activeFiles: [{ path: "src/order.ts", relevance: "edited validator" }], changes: [],
    verification: [{ text: "Order test passes", objectIds: [stored.object.id], status: "active" }],
    failures: [], blockers: [], pendingActions: [], safetyState: [], objectIds: [stored.object.id],
  });
  return { cwd, source, checkpoint, objectId: stored.object.id };
}

describe("RED: evidence graph and claim inspector", () => {
  test("links claims to checkpoint controls, files, context objects, and verification", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph } = await productionModule("evidence-graph");
      const graph = await buildEvidenceGraph({
        cwd: fixture.cwd,
        checkpoint: fixture.checkpoint,
        claims: [{ id: "claim-1", text: "Negative totals are rejected", sourceEntryIds: ["user-1"], filePaths: ["src/order.ts"], objectIds: [fixture.objectId] }],
      });
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "claim:claim-1", kind: "grounded_by" }),
        expect.objectContaining({ to: `object:${fixture.objectId}`, kind: "verified_by" }),
        expect.objectContaining({ to: "file:src/order.ts", kind: "located_in" }),
      ]));
      expect(graph.nodes.find((node: any) => node.kind === "control").id).toContain(fixture.checkpoint.constraints[0].controlId);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("marks file evidence stale after real bytes change", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph, verifyEvidenceGraph } = await productionModule("evidence-graph");
      const graph = await buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [{ id: "claim-1", text: "Validator behavior", filePaths: ["src/order.ts"] }] });
      await writeFile(join(fixture.cwd, "src/order.ts"), `${fixture.source}// changed\n`, "utf8");
      const verification = await verifyEvidenceGraph(graph, fixture.cwd);
      expect(verification.staleClaims).toContain("claim-1");
      expect(verification.staleNodes).toContain("file:src/order.ts");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("classifies unsupported claims separately from stale claims", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph, inspectClaims } = await productionModule("evidence-graph");
      const graph = await buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [
        { id: "supported", text: "Order test passes", objectIds: [fixture.objectId] },
        { id: "unsupported", text: "All payment providers are reliable" },
      ] });
      const inspection = inspectClaims(graph);
      expect(inspection.supported).toContain("supported");
      expect(inspection.unsupported).toContain("unsupported");
      expect(inspection.stale).toEqual([]);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects cycles and dangling evidence edges", async () => {
    const { validateEvidenceGraph } = await productionModule("evidence-graph");
    expect(() => validateEvidenceGraph({
      nodes: [{ id: "a", kind: "claim" }, { id: "b", kind: "claim" }],
      edges: [{ from: "a", to: "b", kind: "supports" }, { from: "b", to: "a", kind: "supports" }, { from: "a", to: "missing", kind: "supports" }],
    })).toThrow(/cycle|dangling/i);
  });

  test("explains a claim with bounded provenance rather than full payloads", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph, explainClaim } = await productionModule("evidence-graph");
      const graph = await buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [{ id: "claim-1", text: "Order test passes", objectIds: [fixture.objectId] }] });
      const explanation = explainClaim(graph, "claim-1");
      expect(explanation.objectIds).toContain(fixture.objectId);
      expect(explanation.text.length).toBeLessThan(2_000);
      expect(JSON.stringify(explanation)).not.toContain("order test passed");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("uses content hashes as stable identity across repeated graph builds", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph } = await productionModule("evidence-graph");
      const input = { cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [{ id: "claim-1", text: "Order test passes", objectIds: [fixture.objectId] }] };
      const first = await buildEvidenceGraph(input);
      const second = await buildEvidenceGraph(input);
      expect(first.fingerprint).toMatch(shaPattern());
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.nodes).toEqual(second.nodes);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects unknown or corrupt context-object evidence", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph } = await productionModule("evidence-graph");
      await expect(buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [{ id: "bad", text: "Bad evidence", objectIds: ["missing-object"] }] })).rejects.toThrow(/object/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("bounds graph fanout and retained metadata for adversarial claims", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph } = await productionModule("evidence-graph");
      const claims = Array.from({ length: 10_000 }, (_, index) => ({ id: `claim-${index}`, text: `Claim ${index}`, filePaths: ["src/order.ts"] }));
      const graph = await buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims, maxClaims: 1_000, maxEdges: 5_000 });
      expect(graph.nodes.filter((node: any) => node.kind === "claim").length).toBeLessThanOrEqual(1_000);
      expect(graph.edges.length).toBeLessThanOrEqual(5_000);
      expect(JSON.stringify(graph).length).toBeLessThan(1_000_000);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("never serializes repository paths outside their relative evidence locators", async () => {
    const fixture = await evidenceFixture();
    try {
      const { buildEvidenceGraph } = await productionModule("evidence-graph");
      const graph = await buildEvidenceGraph({ cwd: fixture.cwd, checkpoint: fixture.checkpoint, claims: [{ id: "claim-1", text: "Validator exists", filePaths: ["src/order.ts"] }] });
      expect(JSON.stringify(graph)).not.toContain(fixture.cwd);
      expect(graph.nodes.find((node: any) => node.kind === "file").contentHash).toMatch(shaPattern());
      expect(await readFile(join(fixture.cwd, "src/order.ts"), "utf8")).toBe(fixture.source);
    } finally { await removeFixture(fixture.cwd); }
  });
});
