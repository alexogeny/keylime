import { describe, expect, test } from "bun:test";
import { createHarnessGovernanceRuntime } from "../../extensions/shared/harness-governance-runtime";
import { fixtureRoot, removeFixture, writeFixture } from "./helpers";

async function runtimeFixture(sessionId = "session") {
  const cwd = await fixtureRoot("canary");
  await writeFixture(cwd, "package.json", "{}\n");
  return { cwd, runtime: await createHarnessGovernanceRuntime({ cwd, sessionId, canaryPersistence: true } as any) };
}

const metric = {
  strategy: "structured", fixtureFingerprint: "fixture-a", schemaValid: true, fallbackUsed: false,
  durationMs: 500, inputTokens: 1_000, outputTokens: 200, resolutionPassed: true, safetyPassed: true,
  activeControlsBefore: 2, activeControlsAfter: 2, relinkingDetected: false, prohibitedBackendActions: 0,
};

describe("RED AA-026..031: runtime canaries contain promotion-grade evidence", () => {
  test("AA-026 records complete structural run samples rather than one-bit pass counts", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.runtime.recordCompactionOutcome(metric);
      expect(fixture.runtime.snapshot().canaries.runs).toEqual([
        expect.objectContaining({ strategy: "structured", resolutionPassed: true, durationMs: 500, inputTokens: 1_000 }),
      ]);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-027 uses a stable fixture fingerprint across repeated equivalent runs", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.runtime.recordCompactionOutcome(metric);
      fixture.runtime.recordCompactionOutcome({ ...metric, durationMs: 550 });
      const ids = fixture.runtime.snapshot().canaries.runs.map((run: any) => run.fixtureId);
      expect(new Set(ids).size).toBe(1);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-028 retains paired raw and candidate strategies for each fixture", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.runtime.recordCompactionOutcome({ ...metric, strategy: "raw" });
      fixture.runtime.recordCompactionOutcome(metric);
      const report = fixture.runtime.evaluateCanaries();
      expect(report.pairedFixtures).toBe(1);
      expect(report.strategies).toHaveProperty("raw");
      expect(report.strategies).toHaveProperty("structured");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-029 rejects a candidate that loses active controls", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.runtime.recordCompactionOutcome({ ...metric, strategy: "raw" });
      fixture.runtime.recordCompactionOutcome({ ...metric, activeControlsAfter: 1 });
      expect(fixture.runtime.evaluateCanaries().reasons).toContain("active_control_loss");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-030 requires an evaluator independent from the optimizer", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.runtime.recordCompactionOutcome({ ...metric, strategy: "raw", optimizerId: "baseline", evaluatorId: "eval" });
      fixture.runtime.recordCompactionOutcome({ ...metric, optimizerId: "agent-a", evaluatorId: "agent-a" });
      expect(fixture.runtime.evaluateCanaries().reasons).toContain("evaluator_not_independent");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-031 persists aggregate canary runs across runtime recreation", async () => {
    const fixture = await runtimeFixture("session-a");
    try {
      fixture.runtime.recordCompactionOutcome(metric);
      await fixture.runtime.flushCanaries();
      const restored = await createHarnessGovernanceRuntime({ cwd: fixture.cwd, sessionId: "session-b", canaryPersistence: true } as any);
      expect(restored.snapshot().canaries.runs).toHaveLength(1);
      expect(JSON.stringify(restored.snapshot().canaries)).not.toContain(fixture.cwd);
    } finally { await removeFixture(fixture.cwd); }
  });
});
