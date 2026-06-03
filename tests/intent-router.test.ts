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

describe("research gating", () => {
  test("research tools are disabled when explicitly disabled", () => {
    const old = process.env.KEYLIME_DISABLE_RESEARCH;
    process.env.KEYLIME_DISABLE_RESEARCH = "1";
    const tools = activeToolNames(pi(["custom_safe_tool"]), ["research", "fetch", "memory-lite"]);

    expect(tools).toContain("fetch_url");
    expect(tools).not.toContain("web_search");
    expect(tools).not.toContain("research_topic");

    if (old === undefined) delete process.env.KEYLIME_DISABLE_RESEARCH;
    else process.env.KEYLIME_DISABLE_RESEARCH = old;
  });
});

describe("router reminders", () => {
  test("freshness with disabled research puts the warning first", async () => {
    const { classifyIntent, setCurrentRoute } = await import("../extensions/shared/intent");
    const { reminderText } = await import("../extensions/intent-router");
    const oldDisable = process.env.KEYLIME_DISABLE_RESEARCH;
    const oldEnable = process.env.KEYLIME_ENABLE_RESEARCH;
    process.env.KEYLIME_DISABLE_RESEARCH = "1";
    delete process.env.KEYLIME_ENABLE_RESEARCH;

    setCurrentRoute(classifyIntent("tell me about the latest brooks ghost"));
    const text = reminderText();

    expect(text.split("\n")[0]).toContain("Freshness requested but web research is DISABLED");
    expect(text).toContain("local/catalog-only");

    if (oldDisable === undefined) delete process.env.KEYLIME_DISABLE_RESEARCH;
    else process.env.KEYLIME_DISABLE_RESEARCH = oldDisable;
    if (oldEnable === undefined) delete process.env.KEYLIME_ENABLE_RESEARCH;
    else process.env.KEYLIME_ENABLE_RESEARCH = oldEnable;
  });
});
