import { describe, expect, test } from "bun:test";
import { inspectTextMatches, planReplacement, summarizePlan } from "../extensions/shared/code-primitives";

describe("inspectTextMatches", () => {
  test("finds exact matches with line and context", () => {
    const matches = inspectTextMatches("one\ntwo\nthree two", { query: "two", contextLines: 1 });

    expect(matches).toHaveLength(2);
    expect(matches[0].line).toBe(2);
    expect(matches[0].before).toEqual(["one"]);
    expect(matches[1].line).toBe(3);
  });

  test("finds regex matches", () => {
    const matches = inspectTextMatches("foo1 foo2 bar", { query: "foo\\d", regex: true });

    expect(matches.map(m => m.text)).toEqual(["foo1", "foo2"]);
  });
});

describe("planReplacement", () => {
  test("applies one exact replacement by default", () => {
    const plan = planReplacement("alpha beta", { path: "x.ts", oldText: "beta", newText: "gamma" });

    expect(plan.after).toBe("alpha gamma");
    expect(plan.replacements).toBe(1);
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
});
