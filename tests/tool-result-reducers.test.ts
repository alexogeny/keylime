import { describe, expect, test } from "bun:test";
import {
  bypassGenericToolResultReduction,
  contextObjectKindForTool,
  reduceToolResultText,
} from "../extensions/shared/tool-result-reducers";

describe("typed tool-result reducers", () => {
  test("protects failures mutation evidence and exact recovery", () => {
    expect(bypassGenericToolResultReduction({ toolName: "run_checks", isError: true })).toBe(true);
    expect(bypassGenericToolResultReduction({ toolName: "apply_code_replacements", isError: false })).toBe(true);
    expect(bypassGenericToolResultReduction({ toolName: "inspect_context_object", isError: false })).toBe(true);
    expect(bypassGenericToolResultReduction({ toolName: "code_search", isError: false })).toBe(false);
  });

  test("classifies common high-volume result kinds", () => {
    expect(contextObjectKindForTool("run_checks")).toBe("test_run");
    expect(contextObjectKindForTool("code_search")).toBe("repo_search");
    expect(contextObjectKindForTool("inspect_lines")).toBe("file_read");
    expect(contextObjectKindForTool("web_search")).toBe("research");
  });

  test("test reducer retains causal diagnostics and indexes original lines", () => {
    const text = [
      ...Array.from({ length: 50 }, (_, i) => `PASS test ${i}`),
      "FAIL auth rejects expired token",
      "Error: expected 401 received 200",
      "  at tests/auth.test.ts:42:7",
      ...Array.from({ length: 30 }, (_, i) => `PASS later ${i}`),
    ].join("\n");

    const reduced = reduceToolResultText("run_checks", text, { maxChars: 800 });
    expect(reduced.activeText).toContain("FAIL auth rejects expired token");
    expect(reduced.activeText).toContain("tests/auth.test.ts:42:7");
    expect(reduced.activeText.length).toBeLessThan(800);
    expect(reduced.sections.diagnostics).toEqual({ startLine: 51, endLine: 53 });
  });

  test("search reducer keeps ranked leading matches and reports omitted lines", () => {
    const text = Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts:${i + 1}: match`).join("\n");
    const reduced = reduceToolResultText("code_search", text, { maxChars: 500 });
    expect(reduced.activeText).toContain("src/file-0.ts:1");
    expect(reduced.activeText).toContain("omitted");
    expect(reduced.activeText.length).toBeLessThan(600);
  });
});
