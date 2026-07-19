import { describe, expect, test } from "bun:test";
import { chars, loadThesisModule, thesisFunction } from "./helpers";

type Observation = {
  id: string;
  toolName: string;
  text: string;
  turn: number;
  kind: "success" | "failure" | "constraint" | "safety" | "state";
  objectId?: string;
  supersedes?: string[];
  referencedBy?: string[];
};

type LifecycleResult = {
  observations: Array<Observation & { tier: "hot" | "warm" | "cold"; rendered: string }>;
  rendered: string;
};

const base = (overrides: Partial<Observation>): Observation => ({
  id: "obs", toolName: "inspect_lines", text: "ordinary output", turn: 1, kind: "success", ...overrides,
});

async function compact(observations: Observation[], options: Record<string, unknown> = {}): Promise<LifecycleResult> {
  const api = await loadThesisModule("observation-lifecycle");
  const fn = thesisFunction<(items: Observation[], options: Record<string, unknown>) => LifecycleResult>(api, "applyObservationLifecycle");
  return fn(observations, { currentTurn: 20, hotTurns: 2, warmTurns: 8, ...options });
}

describe("Context thesis: trajectory-aware observation lifecycle", () => {
  test("keeps the newest observation exact and hot", async () => {
    const result = await compact([base({ id: "latest", turn: 20, text: "exact latest evidence" })]);
    expect(result.observations[0]).toMatchObject({ tier: "hot", rendered: "exact latest evidence" });
  });

  test("demotes old recoverable output to a cold tombstone", async () => {
    const result = await compact([base({ id: "old", turn: 1, text: "x".repeat(4_000), objectId: "ctx-old" })]);
    expect(result.observations[0].tier).toBe("cold");
    expect(result.observations[0].rendered).toContain("ctx-old");
    expect(result.observations[0].rendered).not.toContain("x".repeat(500));
  });

  test("retains unresolved failures despite age", async () => {
    const failure = base({ id: "failure", turn: 1, kind: "failure", text: "AssertionError: expected 2, received 1" });
    const result = await compact([failure]);
    expect(result.rendered).toContain("AssertionError: expected 2, received 1");
    expect(result.observations[0].tier).not.toBe("cold");
  });

  test("never masks user constraints", async () => {
    const result = await compact([base({ id: "constraint", turn: 0, kind: "constraint", text: "Do not change the public API" })]);
    expect(result.rendered).toContain("Do not change the public API");
  });

  test("never masks safety and permission decisions", async () => {
    const result = await compact([base({ id: "safety", turn: 0, kind: "safety", text: "User denied production deployment" })]);
    expect(result.rendered).toContain("User denied production deployment");
  });

  test("keeps observations referenced by the active plan warm or hot", async () => {
    const result = await compact([base({ id: "dep", turn: 1, referencedBy: ["active-step"], text: "API requires an AbortSignal" })], { activeReferences: ["active-step"] });
    expect(result.observations[0].tier).not.toBe("cold");
    expect(result.rendered).toContain("AbortSignal");
  });

  test("folds superseded state while retaining the replacement", async () => {
    const result = await compact([
      base({ id: "old-state", turn: 10, kind: "state", text: "tests failing" }),
      base({ id: "new-state", turn: 19, kind: "state", text: "tests passing", supersedes: ["old-state"] }),
    ]);
    expect(result.observations.find(item => item.id === "old-state")?.tier).toBe("cold");
    expect(result.rendered).toContain("tests passing");
  });

  test("is deterministic for identical trajectories", async () => {
    const input = [base({ id: "a", objectId: "ctx-a" }), base({ id: "b", turn: 20 })];
    expect(await compact(input)).toEqual(await compact(input));
  });

  test("achieves at least 50 percent reduction on stale recoverable observations", async () => {
    const input = Array.from({ length: 12 }, (_, index) => base({ id: `old-${index}`, text: `payload-${index}-`.repeat(400), objectId: `ctx-${index}`, turn: index }));
    const result = await compact(input);
    expect(chars(result.rendered)).toBeLessThan(chars(input) * 0.5);
  });

  test("all removed exact content remains addressable by object id", async () => {
    const input = Array.from({ length: 5 }, (_, index) => base({ id: `old-${index}`, text: "large".repeat(500), objectId: `ctx-${index}` }));
    const result = await compact(input);
    for (const item of result.observations.filter(item => item.tier === "cold")) expect(item.rendered).toContain(item.objectId!);
  });
});
