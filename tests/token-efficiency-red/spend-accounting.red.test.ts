import { describe, expect, test } from "bun:test";
import { buildUsageSpendSnapshot } from "../../extensions/usage-tracker";

const modulePath = "../../extensions/shared/spend-accounting";
async function spendApi(): Promise<any> {
  return import(modulePath);
}

describe("RED: spend accounting distinguishes context, traffic, cache, and task cost", () => {
  test("does not present cumulative branch input as current active context", async () => {
    const { buildSpendSnapshot } = await spendApi();
    const snapshot = buildSpendSnapshot({
      activeContext: { chars: 48_000, tokens: 12_000 },
      currentTurn: { input: 2_000, output: 300, cacheRead: 8_000, cacheWrite: 0, cost: 0.04 },
      branchTotals: { input: 90_000, output: 12_000, cacheRead: 240_000, cacheWrite: 10_000, cost: 2.1 },
    });

    expect(snapshot.activeContext.tokens).toBe(12_000);
    expect(snapshot.currentTurn.uncachedInputTokens).toBe(2_000);
    expect(snapshot.branchTotals.uncachedInputTokens).toBe(90_000);
    expect(snapshot.activeContext.tokens).not.toBe(snapshot.branchTotals.uncachedInputTokens);
  });

  test("preserves missing provider token fields as unknown instead of zero", async () => {
    const { buildSpendSnapshot } = await spendApi();
    const snapshot = buildSpendSnapshot({
      activeContext: { chars: 20_000 },
      currentTurn: { input: 500, output: 40 },
      branchTotals: { input: 500, output: 40 },
    });

    expect(snapshot.activeContext.tokens).toBeNull();
    expect(snapshot.currentTurn.cacheReadTokens).toBeNull();
    expect(snapshot.currentTurn.cacheWriteTokens).toBeNull();
    expect(snapshot.currentTurn.costUsd).toBeNull();
  });

  test("keeps uncached input, cache reads, cache writes, and output separate", async () => {
    const { buildSpendSnapshot } = await spendApi();
    const snapshot = buildSpendSnapshot({
      activeContext: { chars: 40_000, tokens: 10_000 },
      currentTurn: { input: 700, cacheRead: 8_500, cacheWrite: 800, output: 250, cost: 0.08 },
      branchTotals: { input: 700, cacheRead: 8_500, cacheWrite: 800, output: 250, cost: 0.08 },
    });

    expect(snapshot.currentTurn).toMatchObject({
      uncachedInputTokens: 700,
      cacheReadTokens: 8_500,
      cacheWriteTokens: 800,
      outputTokens: 250,
    });
  });

  test("includes auxiliary compression and routing calls in successful-task cost", async () => {
    const { aggregateTaskSpend } = await spendApi();
    const aggregate = aggregateTaskSpend([
      { purpose: "main", input: 2_000, output: 300, cost: 0.08, succeeded: true },
      { purpose: "tool-search", input: 500, output: 40, cost: 0.01, succeeded: true },
      { purpose: "compression", input: 4_000, output: 500, cost: 0.03, succeeded: true },
    ]);

    expect(aggregate.totalCostUsd).toBeCloseTo(0.12, 8);
    expect(aggregate.auxiliaryCostUsd).toBeCloseTo(0.04, 8);
    expect(aggregate.modelCalls).toBe(3);
  });

  test("builds an unambiguous footer view for current context, turn spend, and branch totals", async () => {
    const { buildSpendDisplay } = await spendApi();
    const display = buildSpendDisplay({
      activeContext: { tokens: 12_000, percent: 12 },
      currentTurn: { uncachedInputTokens: 800, cacheReadTokens: 9_200, outputTokens: 200, costUsd: 0.03 },
      branchTotals: { uncachedInputTokens: 50_000, outputTokens: 7_000, costUsd: 1.2 },
    });

    expect(display).toContain("ctx 12k");
    expect(display).toContain("turn");
    expect(display).toContain("cached");
    expect(display).toContain("branch");
  });

  test("builds the normalized spend snapshot recorded by the usage tracker", () => {
    const snapshot = buildUsageSpendSnapshot(
      [{ input: 100, output: 20, cacheRead: 400, cacheWrite: 10, cost: 0.2 }],
      { input: 50, output: 10, cacheRead: 500, cost: { total: 0.1 } },
      { chars: 48_000, tokens: 12_000, percent: 12 },
    );

    expect(snapshot.activeContext).toEqual({ chars: 48_000, tokens: 12_000, percent: 12 });
    expect(snapshot.currentTurn).toMatchObject({ uncachedInputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: null, costUsd: 0.1 });
    expect(snapshot.branchTotals).toMatchObject({ uncachedInputTokens: 150, cacheReadTokens: 900, cacheWriteTokens: 10, outputTokens: 30 });
    expect(snapshot.branchTotals.costUsd).toBeCloseTo(0.3, 8);
  });
});
