import { describe, expect, test } from "bun:test";
import {
  clearDiscoveredToolsForTurn,
  discoveredToolsForTurn,
  estimateRegisteredToolChars,
  recordDiscoveredToolsForTurn,
  searchToolCatalog,
  toolPolicyLoadAllowed,
} from "../extensions/shared/tool-catalog";
import { toolPolicyFor } from "../extensions/shared/tool-policy";

describe("tool catalog", () => {
  test("ranks registered descriptions rather than names alone", () => {
    const policy = toolPolicyFor("compare_files");
    if (!policy) throw new Error("missing compare_files policy");
    const matches = searchToolCatalog([
      { name: "compare_files", description: "Diff two repository files and summarize changes" },
    ], [policy], "diff repository", 3);
    expect(matches[0]?.name).toBe("compare_files");
  });

  test("review mode allows safe inspection but rejects coding mutations", () => {
    const compare = toolPolicyFor("compare_files");
    const apply = toolPolicyFor("apply_code_replacements");
    if (!compare || !apply) throw new Error("missing policies");

    expect(toolPolicyLoadAllowed(compare, { mode: "REVIEW", researchEnabled: true })).toBe(true);
    expect(toolPolicyLoadAllowed(apply, { mode: "REVIEW", researchEnabled: true })).toBe(false);
  });

  test("tracks additive discoveries until the next user-turn reset", () => {
    clearDiscoveredToolsForTurn();
    recordDiscoveredToolsForTurn(["compare_files", "inspect_json"]);
    recordDiscoveredToolsForTurn(["compare_files"]);
    expect(discoveredToolsForTurn()).toEqual(["compare_files", "inspect_json"]);
    clearDiscoveredToolsForTurn();
    expect(discoveredToolsForTurn()).toEqual([]);
  });

  test("registered tool character estimate includes schemas and prompt guidance", () => {
    const chars = estimateRegisteredToolChars([{
      name: "example",
      description: "Example tool",
      promptSnippet: "Use example",
      promptGuidelines: ["Use example only for tests"],
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }]);
    expect(chars).toBeGreaterThan("exampleExample toolUse example".length);
  });
});
