import { describe, expect, test } from "bun:test";
import { createHarnessGovernanceRuntime } from "../../extensions/shared/harness-governance-runtime";
import { fixtureRoot, removeFixture, writeFixture } from "./helpers";

async function repository() {
  const cwd = await fixtureRoot("governance");
  await writeFixture(cwd, "package.json", JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } }));
  await writeFixture(cwd, "bun.lock", "lockfile");
  await writeFixture(cwd, "src/a.ts", "export const a = 1;\n");
  await writeFixture(cwd, "src/b.ts", "import { a } from './a'; export const b = a;\n");
  await writeFixture(cwd, "tests/a.test.ts", "import { a } from '../src/a'; if (a !== 1) throw new Error();\n");
  return cwd;
}

describe("RED AA-018..025: rich policy is wired into the live governance runtime", () => {
  test("AA-018 treats package manifest changes as repository-wide high risk", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      const impact = await runtime.buildImpact(["package.json"]);
      expect(impact.scope).toBe("repository");
      expect(impact.risk.level).toBe("high");
      expect(impact.risk.reasons).toContain("repository_configuration_changed");
    } finally { await removeFixture(cwd); }
  });

  test("AA-019 selects full tests for lockfile changes", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      const impact = await runtime.buildImpact(["bun.lock"]);
      expect(impact.scope).toBe("repository");
      expect(impact.verificationCommands).toContain("bun test");
    } finally { await removeFixture(cwd); }
  });

  test("AA-020 marks deleted dependencies as high risk", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      const impact = await runtime.buildImpact(["src/a.ts"], { deletedPaths: ["src/a.ts"] });
      expect(impact.risk.level).toBe("high");
      expect(impact.risk.reasons).toContain("deleted_dependency");
    } finally { await removeFixture(cwd); }
  });

  test("AA-021 records passing verification in the live snapshot", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      await runtime.recordToolOutcome({
        toolName: "run_checks", toolCallId: "check-1", isError: false, verificationPassed: true,
        verification: [{ command: "bun test", passed: true }], contextObjectId: "check-object-1",
      });
      expect(runtime.snapshot().verifications).toEqual([
        expect.objectContaining({ toolCallId: "check-1", command: "bun test", passed: true }),
      ]);
    } finally { await removeFixture(cwd); }
  });

  test("AA-022 records failed verification without converting it to generic tool failure", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      await runtime.recordToolOutcome({
        toolName: "run_checks", toolCallId: "check-2", isError: true, verificationPassed: false,
        verification: [{ command: "bun test tests/a.test.ts", passed: false, diagnosticPaths: ["src/a.ts"] }],
      });
      expect(runtime.snapshot().verifications.at(-1)).toMatchObject({ passed: false, diagnosticPaths: ["src/a.ts"] });
    } finally { await removeFixture(cwd); }
  });

  test("AA-023 widens targeted impact after failed verification", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      const initial = await runtime.buildImpact(["src/a.ts"]);
      const expanded = await runtime.expandImpactAfterFailure(initial, {
        command: "bun test tests/a.test.ts", passed: false, diagnosticPaths: ["src/b.ts"],
      });
      expect(expanded.risk.level).toBe("high");
      expect(expanded.risk.reasons).toContain("targeted_verification_failed");
      expect(expanded.verificationCommands.length).toBeGreaterThan(initial.verificationCommands.length);
    } finally { await removeFixture(cwd); }
  });

  test("AA-024 links verification objects to mutation evidence", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      await runtime.recordToolOutcome({ toolName: "apply_code_replacements", toolCallId: "edit-1", isError: false, changedPaths: ["src/a.ts"] });
      await runtime.recordToolOutcome({ toolName: "run_checks", toolCallId: "check-1", isError: false, verificationPassed: true, verification: [{ command: "bun test", passed: true }], contextObjectId: "check-object-1" });
      const verification = runtime.snapshot().verifications.at(-1);
      expect(verification.changedPaths).toEqual(["src/a.ts"]);
      expect(verification.contextObjectId).toBe("check-object-1");
    } finally { await removeFixture(cwd); }
  });

  test("AA-025 richer live impact reuses the kernel snapshot rather than rescanning", async () => {
    const cwd = await repository();
    try {
      const runtime = await createHarnessGovernanceRuntime({ cwd, sessionId: "session" });
      const impact = await runtime.buildImpact(["package.json"]);
      expect(impact.scope).toBe("repository");
      expect(runtime.performanceStats().repositoryScans).toBe(1);
      expect(impact.stats.repositoryScans).toBe(1);
    } finally { await removeFixture(cwd); }
  });
});
