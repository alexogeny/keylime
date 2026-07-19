import { describe, expect, test } from "bun:test";
import { runBoundedToolPipeline } from "../extensions/shared/bounded-pipeline";

describe("bounded read-only tool pipeline", () => {
  test("runs allowlisted safe operations and returns only the projected aggregate", async () => {
    const registry = new Map([
      ["users", { risk: "safe" as const, execute: async () => [{ id: "a", spend: 10, secret: "x" }, { id: "b", spend: 30, secret: "y" }] }],
      ["more", { risk: "safe" as const, execute: async () => [{ id: "c", spend: 20, secret: "z" }] }],
    ]);
    const result = await runBoundedToolPipeline({
      steps: [{ id: "one", operation: "users", input: {} }, { id: "two", operation: "more", input: {} }],
      projection: {
        from: ["one", "two"],
        filters: [{ field: "spend", op: "gt", value: 15 }],
        select: ["id", "spend"],
        sort: [{ field: "spend", direction: "desc" }],
        limit: 2,
      },
    }, registry, { maxCalls: 3, maxIntermediateChars: 2000, maxOutputChars: 500 }, new AbortController().signal);

    expect(result.rows).toEqual([{ id: "b", spend: 30 }, { id: "c", spend: 20 }]);
    expect(result.metrics).toMatchObject({ calls: 2, inputRows: 3, outputRows: 2 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("rejects unsafe unknown and over-budget operations before execution", async () => {
    let calls = 0;
    const registry = new Map([
      ["safe", { risk: "safe" as const, execute: async () => { calls++; return []; } }],
      ["mutate", { risk: "stateful" as const, execute: async () => { calls++; return []; } }],
    ]);
    const signal = new AbortController().signal;
    await expect(runBoundedToolPipeline({
      steps: [{ id: "bad", operation: "mutate", input: {} }], projection: { from: ["bad"] },
    }, registry, { maxCalls: 2, maxIntermediateChars: 100, maxOutputChars: 100 }, signal)).rejects.toThrow("not safe");
    await expect(runBoundedToolPipeline({
      steps: [{ id: "missing", operation: "unknown", input: {} }], projection: { from: ["missing"] },
    }, registry, { maxCalls: 2, maxIntermediateChars: 100, maxOutputChars: 100 }, signal)).rejects.toThrow("Unknown pipeline operation");
    await expect(runBoundedToolPipeline({
      steps: [{ id: "a", operation: "safe", input: {} }, { id: "b", operation: "safe", input: {} }, { id: "c", operation: "safe", input: {} }], projection: { from: ["a"] },
    }, registry, { maxCalls: 2, maxIntermediateChars: 100, maxOutputChars: 100 }, signal)).rejects.toThrow("call budget");
    expect(calls).toBe(0);
  });

  test("enforces cancellation intermediate and output budgets", async () => {
    const registry = new Map([
      ["large", { risk: "safe" as const, execute: async () => [{ text: "x".repeat(500) }] }],
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(runBoundedToolPipeline({
      steps: [{ id: "large", operation: "large", input: {} }], projection: { from: ["large"] },
    }, registry, { maxCalls: 1, maxIntermediateChars: 1000, maxOutputChars: 100 }, controller.signal)).rejects.toThrow("aborted");
    await expect(runBoundedToolPipeline({
      steps: [{ id: "large", operation: "large", input: {} }], projection: { from: ["large"] },
    }, registry, { maxCalls: 1, maxIntermediateChars: 100, maxOutputChars: 1000 }, new AbortController().signal)).rejects.toThrow("intermediate byte budget");
  });
});
