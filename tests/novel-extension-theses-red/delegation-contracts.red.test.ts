import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { storeContextObject } from "../../extensions/context-object-store";
import { stabilizeCompactionControlPlane } from "../../extensions/structured-compaction";
import { fixtureRoot, productionModule, removeFixture, shaPattern } from "./helpers";

async function delegationFixture() {
  const cwd = await fixtureRoot("delegation-contract");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
  const evidence = await storeContextObject(cwd, {
    id: "delegated-evidence", kind: "test_run", sourceTool: "run_checks",
    content: "targeted tests pass", summary: "targeted tests pass", retention: "pinned",
  });
  const checkpoint: any = stabilizeCompactionControlPlane({
    version: 1, goal: "Safe delegation",
    constraints: [{ text: "Never modify outside src", sourceEntryIds: ["user-1"], status: "active" }],
    acceptanceCriteria: [{ text: "Targeted tests pass", sourceEntryIds: ["user-2"], status: "active" }],
    decisions: [], activeFiles: [{ path: "src/a.ts", relevance: "target" }], changes: [], verification: [], failures: [], blockers: [],
    pendingActions: [{ text: "Update src/a.ts", sourceEntryIds: ["user-3"], status: "active" }], safetyState: [], objectIds: [],
  });
  return { cwd, checkpoint, objectId: evidence.object.id };
}

function request(checkpoint: any) {
  return {
    goal: "Inspect and update src/a.ts",
    checkpoint,
    tools: ["code_search", "inspect_lines", "apply_code_replacements", "run_checks"],
    paths: ["src/**", "tests/**"],
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
    timeoutMs: 60_000,
    maxDepth: 0,
    requiredResultSchema: "keylime-delegation-result-v1",
    requiredVerification: ["bun test"],
  };
}

describe("RED: policy-preserving delegation contracts", () => {
  test("copies active control IDs and hashes exactly into the contract", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      expect(contract.controls).toEqual(expect.arrayContaining([
        expect.objectContaining({ controlId: fixture.checkpoint.constraints[0].controlId, contentHash: fixture.checkpoint.constraints[0].contentHash }),
        expect.objectContaining({ controlId: fixture.checkpoint.acceptanceCriteria[0].controlId, contentHash: fixture.checkpoint.acceptanceCriteria[0].contentHash }),
      ]));
      expect(contract.repositoryFingerprint).toMatch(shaPattern());
    } finally { await removeFixture(fixture.cwd); }
  });

  test("prevents child contracts from broadening tools, paths, budgets, or depth", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, deriveDelegationContract } = await productionModule("delegation-contracts");
      const parent = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      expect(() => deriveDelegationContract(parent, { tools: [...parent.tools, "delete_file"] })).toThrow(/broaden/i);
      expect(() => deriveDelegationContract(parent, { paths: ["**"] })).toThrow(/broaden/i);
      expect(() => deriveDelegationContract(parent, { maxInputTokens: parent.budgets.maxInputTokens + 1 })).toThrow(/budget/i);
      expect(() => deriveDelegationContract(parent, { maxDepth: 1 })).toThrow(/depth|delegat/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects results from another repository or contract", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      expect(() => validateDelegationResult(contract, { version: 1, contractId: "other", repositoryFingerprint: contract.repositoryFingerprint, changedPaths: [], evidenceObjectIds: [], verification: [] }, fixture.cwd)).toThrow(/contract/i);
      expect(() => validateDelegationResult(contract, { version: 1, contractId: contract.id, repositoryFingerprint: "other", changedPaths: [], evidenceObjectIds: [], verification: [] }, fixture.cwd)).toThrow(/repository/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("requires the declared structured result schema", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      expect(() => validateDelegationResult(contract, "free-form prose", fixture.cwd)).toThrow(/schema|result/i);
      expect(() => validateDelegationResult(contract, { version: 2, contractId: contract.id }, fixture.cwd)).toThrow(/version|schema/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("verifies returned evidence through the real context-object store", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      const valid = await validateDelegationResult(contract, {
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: ["src/a.ts"], evidenceObjectIds: [fixture.objectId], verification: [{ command: "bun test", passed: true }],
      }, fixture.cwd);
      expect(valid.evidenceVerified).toBe(1);
      await expect(validateDelegationResult(contract, {
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: [], evidenceObjectIds: ["missing"], verification: [],
      }, fixture.cwd)).rejects.toThrow(/evidence|object/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects changed paths outside delegated scope", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      await expect(validateDelegationResult(contract, {
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: ["../outside.ts"], evidenceObjectIds: [fixture.objectId], verification: [{ command: "bun test", passed: true }],
      }, fixture.cwd)).rejects.toThrow(/path|scope/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("requires all delegated verification gates before merge", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      await expect(validateDelegationResult(contract, {
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: ["src/a.ts"], evidenceObjectIds: [fixture.objectId], verification: [{ command: "bun test", passed: false }],
      }, fixture.cwd)).rejects.toThrow(/verification/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects token, time, and tool-call budget overruns", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, validateDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      await expect(validateDelegationResult(contract, {
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        usage: { inputTokens: 30_000, outputTokens: 5_000, durationMs: 70_000 }, changedPaths: [], evidenceObjectIds: [], verification: [],
      }, fixture.cwd)).rejects.toThrow(/budget/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("produces deterministic contracts without prompts or source payloads", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, serializeDelegationContract } = await productionModule("delegation-contracts");
      const first = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      const second = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      expect(first.id).toBe(second.id);
      const serialized = serializeDelegationContract(first);
      expect(serialized).not.toContain(fixture.cwd);
      expect(serialized).not.toContain("export const a");
      expect(serialized.length).toBeLessThan(20_000);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("returns evidence packets instead of full subagent transcripts", async () => {
    const fixture = await delegationFixture();
    try {
      const { createDelegationContract, normalizeDelegationResult } = await productionModule("delegation-contracts");
      const contract = await createDelegationContract({ cwd: fixture.cwd, ...request(fixture.checkpoint) });
      const normalized = normalizeDelegationResult(contract, {
        transcript: "x".repeat(1_000_000),
        evidenceObjectIds: [fixture.objectId],
        summary: "Targeted change verified",
      });
      expect(normalized.transcript).toBeUndefined();
      expect(normalized.evidenceObjectIds).toEqual([fixture.objectId]);
      expect(JSON.stringify(normalized).length).toBeLessThan(10_000);
    } finally { await removeFixture(fixture.cwd); }
  });
});
