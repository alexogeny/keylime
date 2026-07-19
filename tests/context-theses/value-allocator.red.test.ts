import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Item = { id: string; category: string; chars: number; relevance: number; impact: number; freshness: number; confidence: number; lossRisk: number; recoverable: boolean; mandatory?: boolean };
type Allocation = { selected: Item[]; rejected: Item[]; totalChars: number; scores: Record<string, number>; categoryChars: Record<string, number> };

const item = (overrides: Partial<Item>): Item => ({ id: "item", category: "evidence", chars: 200, relevance: .5, impact: .5, freshness: .5, confidence: .8, lossRisk: .5, recoverable: true, ...overrides });

async function allocate(items: Item[], budget = 600, options: Record<string, unknown> = {}): Promise<Allocation> {
  const api = await loadThesisModule("context-value-allocator");
  const fn = thesisFunction<(items: Item[], options: Record<string, unknown>) => Allocation>(api, "allocateContextBudget");
  return fn(items, { maxChars: budget, ...options });
}

describe("RED thesis: utility-per-token context allocation", () => {
  test("never exceeds the hard context budget", async () => {
    const result = await allocate(Array.from({ length: 10 }, (_, id) => item({ id: String(id), chars: 180 })));
    expect(result.totalChars).toBeLessThanOrEqual(600);
    expect(result.selected.reduce((sum, entry) => sum + entry.chars, 0)).toBe(result.totalChars);
  });

  test("selects higher task relevance at equal size", async () => {
    const result = await allocate([item({ id: "low", relevance: .1 }), item({ id: "high", relevance: 1 })], 200);
    expect(result.selected.map(entry => entry.id)).toEqual(["high"]);
  });

  test("selects higher decision impact at equal relevance", async () => {
    const result = await allocate([item({ id: "minor", impact: .1 }), item({ id: "blocking", impact: 1 })], 200);
    expect(result.selected[0].id).toBe("blocking");
  });

  test("prefers dense evidence over verbose evidence with equal utility", async () => {
    const result = await allocate([item({ id: "dense", chars: 100 }), item({ id: "verbose", chars: 500 })], 500);
    expect(result.selected[0].id).toBe("dense");
  });

  test("discounts safely recoverable content", async () => {
    const result = await allocate([item({ id: "recoverable", recoverable: true }), item({ id: "unique", recoverable: false })], 200);
    expect(result.selected[0].id).toBe("unique");
  });

  test("retains high-loss-risk failures and constraints", async () => {
    const result = await allocate([
      item({ id: "failure", category: "failure", lossRisk: 1, recoverable: false }),
      item({ id: "constraint", category: "constraint", lossRisk: 1, recoverable: false }),
      item({ id: "noise", relevance: .9, lossRisk: .1 }),
    ], 400);
    expect(result.selected.map(entry => entry.id)).toEqual(expect.arrayContaining(["failure", "constraint"]));
  });

  test("always includes mandatory safety state", async () => {
    const result = await allocate([item({ id: "safety", category: "safety", chars: 100, mandatory: true, relevance: 0 }), item({ id: "useful", relevance: 1 })], 200);
    expect(result.selected.map(entry => entry.id)).toContain("safety");
  });

  test("exposes finite auditable scores for every candidate", async () => {
    const input = [item({ id: "a" }), item({ id: "b" })];
    const result = await allocate(input);
    expect(Object.keys(result.scores).sort()).toEqual(["a", "b"]);
    expect(Object.values(result.scores).every(Number.isFinite)).toBe(true);
  });

  test("reserves category floors for constraints failures and active plan", async () => {
    const input = [item({ id: "constraint", category: "constraint" }), item({ id: "failure", category: "failure" }), item({ id: "plan", category: "plan" }), ...Array.from({ length: 8 }, (_, index) => item({ id: `e-${index}`, relevance: 1 }))];
    const result = await allocate(input, 600, { categoryFloors: { constraint: 100, failure: 100, plan: 100 } });
    expect(result.categoryChars.constraint).toBeGreaterThanOrEqual(100);
    expect(result.categoryChars.failure).toBeGreaterThanOrEqual(100);
    expect(result.categoryChars.plan).toBeGreaterThanOrEqual(100);
  });

  test("is deterministic when utility scores tie", async () => {
    const input = [item({ id: "b" }), item({ id: "a" }), item({ id: "c" })];
    expect(await allocate(input, 400)).toEqual(await allocate([...input].reverse(), 400));
  });
});
