import { describe, expect, test } from "bun:test";
import {
  buildContextLedgerRecord,
  contextFingerprint,
  summarizeContextCategories,
  summarizeContextLedger,
} from "../extensions/shared/context-ledger";

describe("context ledger", () => {
  test("attributes request context by category without double counting", () => {
    const summary = summarizeContextCategories([
      { category: "system", text: "system" },
      { category: "tool_schema", text: "tool-a" },
      { category: "tool_schema", text: "tool-bb" },
      { category: "turn_provider", text: "route" },
      { category: "history", text: "hello" },
      { category: "tool_result", text: "result" },
    ]);

    expect(summary.categories).toEqual({
      system: { chars: 6 },
      tool_schema: { chars: 13 },
      turn_provider: { chars: 5 },
      history: { chars: 5 },
      tool_result: { chars: 6 },
    });
    expect(summary.totalChars).toBe(35);
  });

  test("records before and after sizes for each transform", () => {
    const record = buildContextLedgerRecord({
      ts: 123,
      activeToolNames: ["inspect_lines", "code_search"],
      parts: [{ category: "tool_result", text: "x".repeat(100) }],
      transforms: [
        { id: "dedupe-1", kind: "dedupe", beforeChars: 80, afterChars: 20, recoverable: true, reason: "duplicate read" },
        { id: "reduce-1", kind: "reduce", beforeChars: 100, afterChars: 40, recoverable: true, reason: "typed reducer" },
      ],
    });

    expect(record.transforms).toHaveLength(2);
    expect(record.transforms[0]).toMatchObject({ beforeChars: 80, afterChars: 20 });
    expect(summarizeContextLedger([record])).toMatchObject({ removedChars: 120, cacheReadTokens: 0 });
  });

  test("distinguishes cache savings from active context reduction", () => {
    const record = buildContextLedgerRecord({
      ts: 123,
      activeToolNames: ["code_search"],
      parts: [{ category: "system", text: "stable prefix" }],
      transforms: [],
      cacheReadTokens: 900,
    });

    expect(summarizeContextLedger([record])).toMatchObject({ removedChars: 0, cacheReadTokens: 900 });
  });

  test("keeps unavailable provider token telemetry missing rather than zero", () => {
    const record = buildContextLedgerRecord({
      ts: 123,
      activeToolNames: [],
      parts: [],
      transforms: [],
    });

    expect(record.cacheReadTokens).toBeUndefined();
    expect(record.cacheWriteTokens).toBeUndefined();
  });

  test("stores metrics and fingerprints without retaining source text", () => {
    const secret = "TOP_SECRET_SENTINEL";
    const record = buildContextLedgerRecord({
      ts: 123,
      activeToolNames: ["inspect_lines"],
      parts: [{ category: "history", text: secret }],
      transforms: [],
    });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain(secret);
    expect(record.activeToolFingerprint).toBe(contextFingerprint(["inspect_lines"]));
    expect(record.categories.history).toEqual({ chars: secret.length });
  });
});
