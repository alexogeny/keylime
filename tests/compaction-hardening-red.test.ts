import { describe, expect, test } from "bun:test";
import type { CompactionCheckpoint } from "../extensions/shared/compaction-schema";
import { createCompactionMetricsChannel } from "../extensions/shared/compaction-metrics-channel";

const checkpoint: CompactionCheckpoint = {
  version: 1,
  goal: "Recover compaction safely",
  constraints: [{ text: "Preserve active controls", sourceEntryIds: ["user-1"], status: "active" }],
  acceptanceCriteria: [], decisions: [], activeFiles: [], changes: [], verification: [], failures: [], blockers: [],
  pendingActions: [{ text: "Continue implementation", sourceEntryIds: ["user-2"], status: "active" }],
  safetyState: [], objectIds: [],
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function compactionApi(): Promise<any> {
  return import("../extensions/structured-compaction");
}

async function healthApi(): Promise<any> {
  return import("../extensions/context-health");
}

describe("RED: recurrent compaction failure hardening", () => {
  test("keeps the critical two-attempt deadline inside Pi's likely outer cancellation window", async () => {
    const { COMPACTION_CRITICAL_INITIAL_TIMEOUT_MS, COMPACTION_RETRY_TIMEOUT_MS } = await compactionApi();
    expect(COMPACTION_CRITICAL_INITIAL_TIMEOUT_MS + COMPACTION_RETRY_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  test("uses attempt-local deadlines without aborting the source compaction signal", async () => {
    const { createCompactionAttemptSignal } = await compactionApi();
    const source = new AbortController();
    const attempt = createCompactionAttemptSignal(source.signal, 10);
    await wait(20);
    expect(attempt.aborted).toBe(true);
    expect(source.signal.aborted).toBe(false);
  });

  test("creates a fresh non-aborted deadline for a corrective retry", async () => {
    const { createCompactionAttemptSignal } = await compactionApi();
    const source = new AbortController();
    const first = createCompactionAttemptSignal(source.signal, 5);
    await wait(10);
    const retry = createCompactionAttemptSignal(source.signal, 50);
    expect(first.aborted).toBe(true);
    expect(retry.aborted).toBe(false);
  });

  test("propagates explicit Pi cancellation to every attempt", async () => {
    const { createCompactionAttemptSignal } = await compactionApi();
    const source = new AbortController();
    const attempt = createCompactionAttemptSignal(source.signal, 1_000);
    source.abort(new Error("session cancelled"));
    expect(attempt.aborted).toBe(true);
  });

  test("actually retries after a locally aborted and truncated first response", async () => {
    const { createStructuredCompactionHandler } = await compactionApi();
    const signals: AbortSignal[] = [];
    const handler = createStructuredCompactionHandler({
      attemptTimeoutMs: 10,
      retryTimeoutMs: 50,
      generateCheckpoint: async (_input: unknown, signal: AbortSignal, _ctx: unknown, attempt = 0) => {
        signals.push(signal);
        if (attempt === 0) {
          await wait(20);
          throw new SyntaxError("Invalid checkpoint JSON (stop=aborted, chars=8642, attempt=1): Unterminated string");
        }
        return checkpoint;
      },
    });
    const source = new AbortController();
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: source.signal,
    }, { cwd: "/tmp/repo", ui: { notify: () => {} } });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(source.signal.aborted).toBe(false);
    expect(result?.compaction.summary).toContain("Recover compaction safely");
  });

  test("retries a provider AbortError when Pi did not cancel compaction", async () => {
    const { createStructuredCompactionHandler } = await compactionApi();
    let calls = 0;
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async () => {
        calls++;
        if (calls === 1) throw new DOMException("local request timed out", "AbortError");
        return checkpoint;
      },
    });
    const source = new AbortController();
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: source.signal,
    }, { cwd: "/tmp/repo", ui: { notify: () => {} } });
    expect(calls).toBe(2);
    expect(result?.compaction.summary).toContain("Recover compaction safely");
  });

  test("does not retry after explicit source cancellation", async () => {
    const { createStructuredCompactionHandler } = await compactionApi();
    const source = new AbortController();
    let calls = 0;
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async () => {
        calls++;
        source.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    });
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: source.signal,
    }, { cwd: "/tmp/repo", ui: { notify: () => { throw new Error("cancelled compaction must not warn"); } } });
    expect(calls).toBe(1);
    expect(result).toBeUndefined();
  });

  test("pre-bounds the first extraction request under critical context pressure", async () => {
    const { prepareCompactionInitialInput } = await compactionApi();
    const prepared = prepareCompactionInitialInput({
      conversation: `OLDEST-${"x".repeat(120_000)}-NEWEST`,
      previousSummary: `SUMMARY-${"p".repeat(30_000)}-LATEST`,
      reason: "auto",
      willRetry: false,
    }, 92.01532258064516);
    expect(prepared.conversation.length).toBeLessThanOrEqual(60_000);
    expect(prepared.conversation).toContain("OLDEST");
    expect(prepared.conversation).toContain("NEWEST");
    expect(prepared.previousSummary.length).toBeLessThanOrEqual(16_000);
    expect(prepared.previousSummary).toContain("SUMMARY");
    expect(prepared.previousSummary).toContain("LATEST");
  });

  test("shrinks retry input and bounds corrective feedback", async () => {
    const { prepareCompactionRetryInput } = await compactionApi();
    const prepared = prepareCompactionRetryInput({
      conversation: `OLDEST-${"x".repeat(90_000)}-NEWEST`,
      previousSummary: "p".repeat(30_000),
      runtimeFold: "r".repeat(10_000),
      validationError: `Unterminated string\n${"e".repeat(10_000)}`,
    });
    expect(prepared.conversation.length).toBeLessThanOrEqual(32_000);
    expect(prepared.conversation).toContain("NEWEST");
    expect(prepared.previousSummary.length).toBeLessThanOrEqual(8_000);
    expect(prepared.runtimeFold.length).toBeLessThanOrEqual(1_200);
    expect(prepared.validationError.length).toBeLessThanOrEqual(512);
    expect(prepared.validationError).not.toContain("\n");
    expect(prepared.compactRetry).toBe(true);
  });

  test("extracts one balanced checkpoint object from harmless wrapper text", async () => {
    const { extractCheckpointJsonText } = await compactionApi();
    const wrapped = `Here is the checkpoint:\n{\"goal\":\"brace } inside string\",\"nested\":{\"ok\":true}}\nDone.`;
    expect(extractCheckpointJsonText(wrapped)).toBe(`{\"goal\":\"brace } inside string\",\"nested\":{\"ok\":true}}`);
  });

  test("never invents closing braces or accepts a truncated JSON prefix", async () => {
    const { extractCheckpointJsonText } = await compactionApi();
    expect(() => extractCheckpointJsonText(`{\"goal\":\"unterminated`)).toThrow(/truncated|balanced|complete/i);
  });

  test("rounds fractional pressure and warns only once per escalation band", async () => {
    const { createContextPressureWarningPolicy } = await healthApi();
    const policy = createContextPressureWarningPolicy();
    expect(policy.observe(84.9)).toBeUndefined();
    expect(policy.observe(92.01532258064516)).toContain("92%");
    expect(policy.observe(92.8)).toBeUndefined();
    expect(policy.observe(97.1)).toContain("97%");
    expect(policy.observe(98)).toBeUndefined();
    policy.observe(70);
    expect(policy.observe(92)).toContain("92%");
  });

  test("readiness snapshots advance by pressure band rather than every new entry", async () => {
    const { compactionReadinessBand } = await compactionApi();
    expect(compactionReadinessBand(64)).toBe(0);
    expect(compactionReadinessBand(65)).toBe(65);
    expect(compactionReadinessBand(79.9)).toBe(65);
    expect(compactionReadinessBand(80)).toBe(80);
    expect(compactionReadinessBand(92.015)).toBe(90);
    expect(compactionReadinessBand(98)).toBe(95);
  });

  test("records bounded aggregate retry and truncation telemetry", async () => {
    const channel = createCompactionMetricsChannel();
    const recorded: any[] = [];
    channel.attachStore({ recordCompaction: async metric => { recorded.push(metric); } });
    channel.publish({
      attempts: 2,
      localTimeouts: 1,
      outputTruncations: 1,
      schemaValid: true,
      fallbackUsed: false,
      prompt: "PRIVATE PROMPT",
      response: "PRIVATE RESPONSE",
    } as any);
    await channel.flush();
    expect(recorded[0]).toMatchObject({ attempts: 2, localTimeouts: 1, outputTruncations: 1 });
    expect(JSON.stringify(recorded)).not.toContain("PRIVATE");
  });
});
