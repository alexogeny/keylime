import { describe, expect, test } from "bun:test";

const usagePath = "../../extensions/usage-tracker";
const telemetryPath = "../../extensions/passive-context-telemetry";
async function usageApi(): Promise<any> { return import(usagePath); }
async function telemetryApi(): Promise<any> { return import(telemetryPath); }

describe("RED: spend telemetry migration and runtime attribution", () => {
  test("TE-030 migrates v1 records without inventing cache or cost data", async () => {
    const { migrateUsageRecord } = await usageApi();
    const migrated = migrateUsageRecord({ version: 1, ts: 1, input: 100, output: 20 });
    expect(migrated.spend.currentTurn).toMatchObject({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null });
  });

  test("TE-031 migrates v2 records while preserving provider and context-ledger fields", async () => {
    const { migrateUsageRecord } = await usageApi();
    const migrated = migrateUsageRecord({ version: 2, ts: 2, input: 50, output: 10, cacheRead: 400, provider: "anthropic", context: { totalChars: 8_000 } });
    expect(migrated).toMatchObject({ provider: "anthropic", context: { totalChars: 8_000 } });
    expect(migrated.spend.currentTurn.cacheReadTokens).toBe(400);
  });

  test("TE-032 normalizes passive telemetry from the same spend vocabulary", async () => {
    const { normalizePassiveSpendSample } = await telemetryApi();
    const sample = normalizePassiveSpendSample({ input: 70, output: 8, cacheRead: 600, cacheWrite: 30, cost: { total: 0.04 } }, { tokens: 9_000, percent: 18, contextWindow: 50_000 });
    expect(sample).toMatchObject({ inputTokens: 70, outputTokens: 8, cacheReadTokens: 600, cacheWriteTokens: 30, costUsd: 0.04, contextTokens: 9_000, contextPercent: 18 });
  });

  test("TE-033 attributes main, tool-search, compression, retry, and delegation calls to one task", async () => {
    const { createTaskSpendLedger } = await usageApi();
    const ledger = createTaskSpendLedger("task-1");
    ledger.record({ purpose: "main", cost: 0.08 });
    ledger.record({ purpose: "tool-search", cost: 0.01 });
    ledger.record({ purpose: "compression", cost: 0.02 });
    ledger.record({ purpose: "retry", cost: 0.03 });
    ledger.record({ purpose: "delegation", cost: 0.04 });
    expect(ledger.snapshot()).toMatchObject({ taskId: "task-1", modelCalls: 5, auxiliaryCostUsd: 0.1, totalCostUsd: 0.18 });
  });

  test("TE-034 closes task attribution only after queued follow-ups complete", async () => {
    const { createTaskSpendLedger } = await usageApi();
    const ledger = createTaskSpendLedger("task-2");
    ledger.record({ purpose: "main", cost: 0.05 });
    ledger.queue("follow-up-1");
    expect(ledger.complete()).toMatchObject({ complete: false, pending: ["follow-up-1"] });
    ledger.resolve("follow-up-1");
    expect(ledger.complete()).toMatchObject({ complete: true, pending: [] });
  });

  test("TE-035 persists aggregate diagnostics without prompt, response, source, or tool bodies", async () => {
    const { sanitizeUsageRecordForPersistence } = await usageApi();
    const persisted = sanitizeUsageRecordForPersistence({
      taskId: "task-3", input: 10, prompt: "PRIVATE_PROMPT", response: "PRIVATE_RESPONSE",
      source: "PRIVATE_SOURCE", toolResult: "PRIVATE_TOOL_RESULT", promptPrefix: { current: { hash: "a".repeat(64), prefixChars: 10 } },
    });
    const text = JSON.stringify(persisted);
    for (const secret of ["PRIVATE_PROMPT", "PRIVATE_RESPONSE", "PRIVATE_SOURCE", "PRIVATE_TOOL_RESULT"]) expect(text).not.toContain(secret);
  });

  test("TE-036 restores branch totals and the last safe prefix diagnostic across session reload", async () => {
    const { restoreUsageRuntimeState } = await usageApi();
    const state = restoreUsageRuntimeState([
      { type: "custom", customType: "usage-record-v2", data: { input: 10, output: 2, cacheRead: 90, promptPrefix: { current: { hash: "b".repeat(64), prefixChars: 400 } } } },
      { type: "custom", customType: "usage-record-v2", data: { input: 5, output: 1, cacheRead: 95 } },
    ]);
    expect(state.branchTotals).toMatchObject({ uncachedInputTokens: 15, cacheReadTokens: 185, outputTokens: 3 });
    expect(state.previousPromptPrefix.current.hash).toBe("b".repeat(64));
  });
});
