import { describe, expect, test } from "bun:test";
import {
  formatPlanPreview,
  inspectTextMatches,
  isProbablyBinary,
  planReplacement,
  resolveSafePath,
  summarizePlan,
} from "../extensions/shared/code-primitives";

describe("inspectTextMatches", () => {
  test("finds exact matches with line, column, full line, and context", () => {
    const matches = inspectTextMatches("one\ntwo words\nthree two", { query: "two", contextLines: 1 });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ line: 2, column: 1, text: "two", lineText: "two words", before: ["one"], after: ["three two"] });
    expect(matches[1]).toMatchObject({ line: 3, column: 7, lineText: "three two" });
  });

  test("finds regex matches", () => {
    const matches = inspectTextMatches("foo1 foo2 bar", { query: "foo\\d", regex: true });

    expect(matches.map(m => m.text)).toEqual(["foo1", "foo2"]);
  });

  test("rejects empty queries", () => {
    expect(() => inspectTextMatches("abc", { query: "" })).toThrow("query must not be empty");
  });

  test("clamps max matches and context lines", () => {
    const matches = inspectTextMatches("a\na\na", { query: "a", contextLines: -10, maxMatches: 0 });

    expect(matches).toHaveLength(1);
    expect(matches[0].before).toEqual([]);
    expect(matches[0].after).toEqual([]);
  });
});

describe("planReplacement", () => {
  test("applies one exact replacement by default", () => {
    const plan = planReplacement("alpha beta", { path: "x.ts", oldText: "beta", newText: "gamma" });

    expect(plan.after).toBe("alpha gamma");
    expect(plan.replacements).toBe(1);
    expect(plan.previews).toEqual([{ line: 1, before: "alpha beta", after: "alpha gamma" }]);
    expect(summarizePlan(plan)).toContain("x.ts: 1 replacement");
  });

  test("requires specificity for repeated exact matches", () => {
    expect(() => planReplacement("x x", { path: "x.ts", oldText: "x", newText: "y" })).toThrow("matched 2 times");
  });

  test("can replace all exact matches", () => {
    const plan = planReplacement("x x", { path: "x.ts", oldText: "x", newText: "y", replaceAll: true });

    expect(plan.after).toBe("y y");
    expect(plan.replacements).toBe(2);
  });

  test("supports regex replacement", () => {
    const plan = planReplacement("foo1 foo2", { path: "x.ts", regex: "foo\\d", newText: "bar", replaceAll: true });

    expect(plan.after).toBe("bar bar");
    expect(plan.replacements).toBe(2);
  });

  test("rejects regex patterns that can match empty strings", () => {
    expect(() => planReplacement("abc", { path: "x.ts", regex: ".*", newText: "x", replaceAll: true })).toThrow("must not match empty strings");
  });

  test("adds near-match diagnostics for whitespace mismatch", () => {
    expect(() => planReplacement("const x = 1;\nconst y = 2;", {
      path: "x.ts",
      oldText: "const x = 1; const y = 2;",
      newText: "const z = 3;",
    })).toThrow("Possible whitespace/indentation mismatch");
  });

  test("formats dry-run previews", () => {
    const plan = planReplacement("a\nb\nc", { path: "x.ts", oldText: "b", newText: "bee" });

    expect(formatPlanPreview(plan)).toContain("line 2");
    expect(formatPlanPreview(plan)).toContain("- b");
    expect(formatPlanPreview(plan)).toContain("+ bee");
  });
});

describe("path and binary safety", () => {
  test("resolves relative paths inside cwd", () => {
    expect(resolveSafePath("/repo", "src/file.ts")).toBe("/repo/src/file.ts");
  });

  test("rejects path traversal outside cwd", () => {
    expect(() => resolveSafePath("/repo", "../secret.txt")).toThrow("outside cwd");
  });

  test("rejects absolute paths outside cwd", () => {
    expect(() => resolveSafePath("/repo", "/tmp/secret.txt")).toThrow("outside cwd");
  });

  test("detects binary buffers", () => {
    expect(isProbablyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isProbablyBinary(Buffer.from("plain text"))).toBe(false);
  });
});
