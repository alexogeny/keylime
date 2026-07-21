import { describe, expect, test } from "bun:test";
import { createHarnessGovernanceRuntime } from "../../extensions/shared/harness-governance-runtime";
import { storeContextObject } from "../../extensions/context-object-store";
import { fixtureRoot, removeFixture, writeFixture } from "./helpers";

async function setup() {
  const cwd = await fixtureRoot("delegation");
  await writeFixture(cwd, "package.json", "{}\n");
  await writeFixture(cwd, "src/a.ts", "export const a = 1;\n");
  const evidence = await storeContextObject(cwd, {
    id: "delegated-evidence", kind: "repo_search", sourceTool: "code_search",
    content: "src/a.ts:1", summary: "Located a", retention: "pinned",
  });
  const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
  return { cwd, runtime, objectId: evidence.object.id };
}

async function issue(runtime: any, overrides: Record<string, unknown> = {}) {
  return runtime.issueDelegationContract({
    role: "scout", goal: "Locate the implementation", tools: ["code_search", "inspect_lines"], paths: ["src/**"],
    maxInputTokens: 5_000, maxOutputTokens: 1_000, timeoutMs: 30_000, maxDepth: 0, requiredVerification: [],
    ...overrides,
  });
}

describe("RED AA-032..038: delegation is registered and validated before trust", () => {
  test("AA-032 issuing a contract stores bounded live registry state", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime);
      expect(contract.role).toBe("scout");
      expect(fixture.runtime.snapshot().delegations).toMatchObject({ active: 1, accepted: 0, rejected: 0 });
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-033 read-only roles cannot return changed paths", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime);
      await expect(fixture.runtime.acceptDelegationResult({
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: ["src/a.ts"], evidenceObjectIds: [fixture.objectId], verification: [], usage: {},
      })).rejects.toThrow(/read.only|changed|mutation/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-034 rejects results for contracts that were never issued live", async () => {
    const fixture = await setup();
    try {
      await expect(fixture.runtime.acceptDelegationResult({
        version: 1, contractId: "unknown", repositoryFingerprint: fixture.runtime.repositoryFingerprint,
        changedPaths: [], evidenceObjectIds: [], verification: [], usage: {},
      })).rejects.toThrow(/unknown|issued|contract/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-035 accepts evidence-only results after contract validation", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime);
      const accepted = await fixture.runtime.acceptDelegationResult({
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        summary: "Located implementation", changedPaths: [], evidenceObjectIds: [fixture.objectId], verification: [],
        usage: { inputTokens: 100, outputTokens: 20, durationMs: 100 }, transcript: "must not persist",
      });
      expect(accepted).toMatchObject({ accepted: true, evidenceVerified: 1 });
      expect(JSON.stringify(accepted)).not.toContain("must not persist");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-036 consumes one-use contracts after an accepted result", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime);
      const result = { version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint, changedPaths: [], evidenceObjectIds: [fixture.objectId], verification: [], usage: {} };
      await fixture.runtime.acceptDelegationResult(result);
      await expect(fixture.runtime.acceptDelegationResult(result)).rejects.toThrow(/consumed|used|inactive/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-037 rejects expired contracts before evidence ingestion", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime, { expiresAfterMs: 1, issuedAt: 0 });
      await expect(fixture.runtime.acceptDelegationResult({
        version: 1, contractId: contract.id, repositoryFingerprint: contract.repositoryFingerprint,
        changedPaths: [], evidenceObjectIds: [fixture.objectId], verification: [], usage: {},
      })).rejects.toThrow(/expired/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-038 keeps recursive delegation disabled for initial live roles", async () => {
    const fixture = await setup();
    try {
      const contract = await issue(fixture.runtime);
      expect(contract.maxDepth).toBe(0);
      expect(contract.tools).not.toContain("delegate_readonly");
      expect(fixture.runtime.snapshot().delegations.maxConcurrent).toBeLessThanOrEqual(2);
    } finally { await removeFixture(fixture.cwd); }
  });
});
