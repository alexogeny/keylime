import { describe, expect, test } from "bun:test";
import { compactToolResultContent } from "../extensions/tool-result-compactor";

describe("tool result compaction", () => {
  test("leaves small outputs unchanged", () => {
    const result = compactToolResultContent([{ type: "text", text: "short output" }], { thresholdChars: 100 });
    expect(result.shouldCompact).toBe(false);
    expect(result.compactedText).toBe("short output");
    expect(result.originalChars).toBe(12);
  });

  test("compacts large text with summary and head/tail preview", () => {
    const large = [
      "start line",
      "Error: failing assertion",
      ...Array.from({ length: 40 }, (_, i) => `boring line ${i}`),
      "tail line with final result",
    ].join("\n");
    const result = compactToolResultContent([{ type: "text", text: large }], { thresholdChars: 120, previewChars: 80 });
    expect(result.shouldCompact).toBe(true);
    expect(result.summary[0]).toMatch(/Original output:/);
    expect(result.summary.some(line => line.includes("Error: failing assertion"))).toBe(true);
    expect(result.compactedText).toContain("start line");
    expect(result.compactedText).toContain("tail line with final result");
    expect(result.compactedText.length).toBeLessThan(large.length);
  });

  test("serializes non-text content safely", () => {
    const result = compactToolResultContent([{ type: "json", value: { ok: true } }], { thresholdChars: 5, previewChars: 40 });
    expect(result.shouldCompact).toBe(true);
    expect(result.compactedText).toContain("json");
  });

  test("caps number of interesting summary lines", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Error ${i}: failed`).join("\n");
    const result = compactToolResultContent(text, { thresholdChars: 20, maxSummaryLines: 3 });
    expect(result.summary).toHaveLength(4);
  });
});
