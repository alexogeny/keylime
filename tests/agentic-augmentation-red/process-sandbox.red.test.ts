import { describe, expect, test } from "bun:test";
import { fixtureRoot, productionModule, removeFixture, writeFixture } from "./helpers";

async function executor(options: Record<string, unknown> = {}) {
  const cwd = await fixtureRoot("process");
  await writeFixture(cwd, "package.json", "{}\n");
  const api = await productionModule("process-executor");
  return { cwd, executor: api.createProcessExecutor({ cwd, mode: "observe", maxOutputChars: 2_000, timeoutMs: 5_000, ...options }) };
}

describe("RED AA-039..045: one bounded subprocess and sandbox seam", () => {
  test("AA-039 executes an argv command without a shell and returns structural audit metadata", async () => {
    const fixture = await executor();
    try {
      const result = await fixture.executor.run({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"] });
      expect(result).toMatchObject({ ok: true, stdout: "ok", shellUsed: false, sandboxMode: "observe" });
      expect(typeof result.audit.commandFingerprint).toBe("string");
      expect(typeof result.audit.durationMs).toBe("number");
      expect(JSON.stringify(result.audit)).not.toContain(fixture.cwd);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-040 rejects working directories outside the repository", async () => {
    const fixture = await executor();
    try {
      await expect(fixture.executor.run({ command: process.execPath, args: ["-e", ""], cwd: "/tmp" })).rejects.toThrow(/repository|cwd|outside/i);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-041 removes secrets from the child environment by default", async () => {
    const fixture = await executor({ environment: { KEYLIME_TEST_SECRET: "do-not-leak", PATH: process.env.PATH } });
    try {
      const result = await fixture.executor.run({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.KEYLIME_TEST_SECRET || 'absent')"] });
      expect(result.stdout).toBe("absent");
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-042 bounds stdout and stderr while retaining truncation metadata", async () => {
    const fixture = await executor({ maxOutputChars: 100 });
    try {
      const result = await fixture.executor.run({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1000)); process.stderr.write('y'.repeat(1000))"] });
      expect(result.stdout.length).toBeLessThanOrEqual(100);
      expect(result.stderr.length).toBeLessThanOrEqual(100);
      expect(result.audit.outputTruncated).toBe(true);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-043 kills commands that exceed the bounded timeout", async () => {
    const fixture = await executor({ timeoutMs: 25 });
    try {
      const result = await fixture.executor.run({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] });
      expect(result.ok).toBe(false);
      expect(result.audit.reason).toBe("timeout");
      expect(result.audit.durationMs).toBeLessThan(1_000);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-044 observe mode reports the enforce-mode sandbox plan without applying it", async () => {
    const fixture = await executor({ mode: "observe", backend: "bubblewrap", network: "deny" });
    try {
      const plan = fixture.executor.plan({ command: "bun", args: ["test"] });
      expect(plan).toMatchObject({ applied: false, backend: "bubblewrap", network: "deny", wouldSandbox: true });
      expect(plan.argv[0]).not.toMatch(/sh|bash/);
    } finally { await removeFixture(fixture.cwd); }
  });

  test("AA-045 enforce mode denies execution when the configured sandbox is unavailable", async () => {
    const fixture = await executor({ mode: "enforce", backend: "definitely-unavailable" });
    try {
      await expect(fixture.executor.run({ command: process.execPath, args: ["-e", ""] })).rejects.toThrow(/sandbox|unavailable|enforce/i);
    } finally { await removeFixture(fixture.cwd); }
  });
});
