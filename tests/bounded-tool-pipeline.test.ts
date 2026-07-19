import { describe, expect, test } from "bun:test";
import { PipelineExecutionError, runBoundedToolPipeline } from "../extensions/shared/bounded-pipeline";

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

  test("supports a fixed aggregate operator set without expressions", async () => {
    const registry = new Map([
      ["rows", { risk: "safe" as const, execute: async () => [{ amount: 2 }, { amount: 5 }, { amount: 3 }] }],
    ]);
    const result = await runBoundedToolPipeline({
      steps: [{ id: "rows", operation: "rows", input: {} }],
      projection: {
        from: ["rows"],
        aggregate: [
          { op: "count", as: "records" },
          { op: "sum", field: "amount", as: "total" },
          { op: "max", field: "amount", as: "largest" },
        ],
      },
    }, registry, { maxCalls: 1, maxIntermediateChars: 500, maxOutputChars: 200 }, new AbortController().signal);
    expect(result.rows).toEqual([{ records: 3, total: 10, largest: 5 }]);
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

  test("stores oversized intermediates outside the aggregate and returns references", async () => {
    const stored: string[] = [];
    const registry = new Map([
      ["large", { risk: "safe" as const, execute: async () => [{ id: "a", text: "x".repeat(200) }] }],
    ]);
    const result = await runBoundedToolPipeline({
      steps: [{ id: "large", operation: "large", input: {} }],
      projection: { from: ["large"], select: ["id"] },
    }, registry, { maxCalls: 1, maxIntermediateChars: 1000, maxOutputChars: 100 }, new AbortController().signal, {
      inlineIntermediateChars: 100,
      storeIntermediate: async (stepId, content) => { stored.push(content); return `object://${stepId}`; },
    });
    expect(result.rows).toEqual([{ id: "a" }]);
    expect(result.objectIds).toEqual(["object://large"]);
    expect(stored[0]).toContain("xxx");
    expect(JSON.stringify(result.rows)).not.toContain("xxx");
  });

  test("reports partial failures without rendering a successful aggregate", async () => {
    const registry = new Map([
      ["ok", { risk: "safe" as const, execute: async () => [{ id: "a" }] }],
      ["fails", { risk: "safe" as const, execute: async () => { throw new Error("upstream unavailable"); } }],
    ]);
    try {
      await runBoundedToolPipeline({
        steps: [{ id: "one", operation: "ok", input: {} }, { id: "two", operation: "fails", input: {} }],
        projection: { from: ["one", "two"] },
      }, registry, { maxCalls: 2, maxIntermediateChars: 1000, maxOutputChars: 100 }, new AbortController().signal);
      throw new Error("expected pipeline failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineExecutionError);
      expect((error as PipelineExecutionError).details).toEqual({ failedStepId: "two", completedStepIds: ["one"], calls: 2, objectIds: [] });
      expect(error).not.toHaveProperty("rows");
    }
  });

  test("enforces wall-clock cancellation intermediate and output budgets", async () => {
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

    const slow = new Map([
      ["slow", { risk: "safe" as const, execute: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return []; } }],
    ]);
    await expect(runBoundedToolPipeline({
      steps: [{ id: "slow", operation: "slow", input: {} }], projection: { from: ["slow"] },
    }, slow, { maxCalls: 1, maxIntermediateChars: 100, maxOutputChars: 100 }, new AbortController().signal, {
      maxWallClockMs: 5,
    })).rejects.toThrow("wall-clock budget");
  });
});
