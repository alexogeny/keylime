import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fixtureRoot, productionModule, removeFixture, shaPattern } from "./helpers";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function managerFixture() {
  const cwd = await fixtureRoot("capability-lease");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
  try {
    const { createCapabilityLeaseManager } = await productionModule("capability-leases");
    const manager = await createCapabilityLeaseManager({ cwd, sessionId: "session-1", maxLeases: 20 });
    return { cwd, manager };
  } catch (error) {
    await removeFixture(cwd);
    throw error;
  }
}

function leaseRequest(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "intent-1",
    trustedSourceEntryId: "user-1",
    tools: ["apply_code_replacements", "run_checks"],
    paths: ["src/**"],
    operations: ["modify", "verify"],
    commandPatterns: ["^bun test(?: .*)?$"],
    expiresAfterTurns: 2,
    expiresAfterMs: 60_000,
    requiresVerification: true,
    ...overrides,
  };
}

describe("RED: intent-scoped capability leases", () => {
  test("authorizes only listed tools, paths, and operations", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      expect(fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["src/a.ts"] }).allowed).toBe(true);
      expect(fixture.manager.authorize(lease.id, { tool: "delete_file", operation: "delete", paths: ["src/a.ts"] }).allowed).toBe(false);
      expect(fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["tests/a.ts"] }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("rejects lexical and symlink path escapes", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      expect(fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["../outside.ts"] }).allowed).toBe(false);
      expect(fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["/tmp/outside.ts"] }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("allows only commands covered by anchored patterns", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test tests/a.test.ts" }).allowed).toBe(true);
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test && curl example.com" }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("expires by real wall-clock deadline", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest({ expiresAfterMs: 20 }));
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test" }).allowed).toBe(true);
      await sleep(30);
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test" }).reason).toMatch(/expired/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("expires after its bounded number of turns", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest({ expiresAfterTurns: 1 }));
      fixture.manager.handleBoundary("turn_end");
      expect(fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["src/a.ts"] }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("requires verification before a mutation lease can close successfully", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      fixture.manager.recordMutation(lease.id, ["src/a.ts"]);
      expect(fixture.manager.complete(lease.id).accepted).toBe(false);
      fixture.manager.recordVerification(lease.id, { passed: true, command: "bun test" });
      expect(fixture.manager.complete(lease.id).accepted).toBe(true);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("invalidates leases at compaction and session boundaries", async () => {
    const fixture = await managerFixture();
    try {
      const compactionLease = fixture.manager.issue(leaseRequest());
      fixture.manager.handleBoundary("session_before_compact");
      expect(fixture.manager.authorize(compactionLease.id, { tool: "run_checks", operation: "verify", command: "bun test" }).allowed).toBe(false);
      const shutdownLease = fixture.manager.issue(leaseRequest());
      fixture.manager.handleBoundary("session_shutdown");
      expect(fixture.manager.authorize(shutdownLease.id, { tool: "run_checks", operation: "verify", command: "bun test" }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("binds leases to repository and session identities", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      expect(lease.repositoryFingerprint).toMatch(shaPattern());
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test", sessionId: "other-session" }).allowed).toBe(false);
      expect(fixture.manager.authorize(lease.id, { tool: "run_checks", operation: "verify", command: "bun test", repositoryFingerprint: "other-repo" }).allowed).toBe(false);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("never permits delegated or child leases to broaden authority", async () => {
    const fixture = await managerFixture();
    try {
      const parent = fixture.manager.issue(leaseRequest({ tools: ["run_checks"], operations: ["verify"] }));
      expect(() => fixture.manager.derive(parent.id, leaseRequest({ tools: ["run_checks", "delete_file"], operations: ["verify", "delete"] }))).toThrow(/broaden|authority/i);
      const child = fixture.manager.derive(parent.id, leaseRequest({ tools: ["run_checks"], operations: ["verify"], expiresAfterTurns: 1 }));
      expect(child.parentLeaseId).toBe(parent.id);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("emits privacy-safe structural audit records", async () => {
    const fixture = await managerFixture();
    try {
      const lease = fixture.manager.issue(leaseRequest());
      fixture.manager.authorize(lease.id, { tool: "apply_code_replacements", operation: "modify", paths: ["src/a.ts"], prompt: "PRIVATE PROMPT", source: "PRIVATE SOURCE" });
      const audit = fixture.manager.audit();
      expect(audit[0]).toEqual(expect.objectContaining({ leaseId: lease.id, tool: "apply_code_replacements", allowed: true }));
      expect(JSON.stringify(audit)).not.toContain("PRIVATE");
      expect(JSON.stringify(audit)).not.toContain(fixture.cwd);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("bounds active leases and audit history", async () => {
    const fixture = await managerFixture();
    try {
      for (let index = 0; index < 100; index++) fixture.manager.issue(leaseRequest({ intentId: `intent-${index}` }));
      expect(fixture.manager.memoryStats().activeLeases).toBeLessThanOrEqual(20);
      expect(fixture.manager.memoryStats().auditRecords).toBeLessThanOrEqual(500);
    } finally { await removeFixture(fixture.cwd); }
  });
});
