import { describe, expect, test } from "bun:test";
import { parseRipgrepCodeRegions, rankCodeRegions } from "../extensions/shared/repo-regions";

describe("fixed-budget repository regions", () => {
  test("merges overlaps before applying line character and file budgets", () => {
    const result = rankCodeRegions([
      { path: "src/auth.ts", startLine: 10, lines: ["a", "b", "c"], score: 0.9, reasons: ["symbol"] },
      { path: "src/auth.ts", startLine: 12, lines: ["c", "d", "e"], score: 0.8, reasons: ["lexical"] },
      { path: "src/noise.ts", startLine: 1, lines: ["noise one", "noise two"], score: 0.2, reasons: ["lexical"] },
    ], { maxLines: 5, maxChars: 80, maxFiles: 1 });

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ path: "src/auth.ts", startLine: 10, endLine: 14, score: 0.9 });
    expect(result.regions[0].reasons).toEqual(["symbol", "lexical"]);
    expect(result.metrics.returnedLines).toBe(5);
    expect(result.metrics.returnedFiles).toBe(1);
    expect(result.metrics.omittedCandidates).toBe(1);
  });

  test("uses deterministic path and line ordering for score ties", () => {
    const result = rankCodeRegions([
      { path: "src/z.ts", startLine: 5, lines: ["z"], score: 1, reasons: [] },
      { path: "src/a.ts", startLine: 8, lines: ["a8"], score: 1, reasons: [] },
      { path: "src/a.ts", startLine: 2, lines: ["a2"], score: 1, reasons: [] },
    ], { maxLines: 10, maxChars: 100, maxFiles: 3 });
    expect(result.regions.map(region => `${region.path}:${region.startLine}`)).toEqual([
      "src/a.ts:2",
      "src/a.ts:8",
      "src/z.ts:5",
    ]);
  });

  test("parses ripgrep match and context lines into mergeable regions", () => {
    const candidates = parseRipgrepCodeRegions([
      "src/auth.ts:10:export function verify() {",
      "src/auth.ts-11-  return token.valid;",
      "--",
      "src/other.ts:4:verify();",
    ].join("\n"));
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ path: "src/auth.ts", startLine: 10, score: 1, reasons: ["lexical_match"] });
    expect(candidates[1]).toMatchObject({ path: "src/auth.ts", startLine: 11, score: 0.6, reasons: ["context_line"] });
  });

  test("never exceeds the character budget", () => {
    const result = rankCodeRegions([
      { path: "src/large.ts", startLine: 1, lines: ["x".repeat(90)], score: 1, reasons: ["exact"] },
      { path: "src/small.ts", startLine: 1, lines: ["small"], score: 0.5, reasons: ["lexical"] },
    ], { maxLines: 5, maxChars: 20, maxFiles: 2 });
    expect(result.metrics.returnedChars).toBeLessThanOrEqual(20);
    expect(result.regions.map(region => region.path)).toEqual(["src/small.ts"]);
  });
});
