import { describe, expect, test } from "bun:test";
import { activeToolNames } from "../extensions/intent-router";

const allToolNames = [
  "read", "bash", "edit", "write", "code_search",
  "remember", "recall_memories", "recall_entity", "list_memories",
  "web_search", "research_topic", "fetch_url",
  "lookup_shoe", "query_shoes",
  "save_project_plan", "update_feature_tdd", "custom_safe_tool",
];

function pi(active: string[]) {
  return {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => active.map(name => ({ name })),
  } as any;
}

describe("activeToolNames", () => {
  test("coding keeps code tools and removes unrelated domain tools", () => {
    const tools = activeToolNames(pi(["web_search", "lookup_shoe", "custom_safe_tool"]), ["core", "repo", "coding", "memory-lite"]);

    expect(tools).toContain("read");
    expect(tools).toContain("edit");
    expect(tools).toContain("code_search");
    expect(tools).toContain("remember");
    expect(tools).toContain("custom_safe_tool");
    expect(tools).not.toContain("web_search");
    expect(tools).not.toContain("lookup_shoe");
  });

  test("shoe intent exposes shoe tools without web tools", () => {
    const tools = activeToolNames(pi(["custom_safe_tool"]), ["shoes", "memory-lite"]);

    expect(tools).toContain("lookup_shoe");
    expect(tools).toContain("query_shoes");
    expect(tools).toContain("recall_memories");
    expect(tools).not.toContain("web_search");
  });
});
