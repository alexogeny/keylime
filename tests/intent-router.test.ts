import { describe, expect, test } from "bun:test";
import { activeToolNames } from "../extensions/intent-router";

const allToolNames = [
  "read", "bash", "edit", "write", "code_search", "inspect_text_matches", "inspect_code_structure", "plan_code_replacements", "apply_code_replacements", "run_checks",
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

describe("routeForPrompt", () => {
  test("routes extension-origin style prompts the same as user prompts", async () => {
    const { routeForPrompt } = await import("../extensions/intent-router");
    const calls: string[][] = [];
    const mockPi = {
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => ["web_search", "lookup_shoe", "custom_safe_tool"],
      setActiveTools: (names: string[]) => calls.push(names),
    } as any;

    const route = routeForPrompt(mockPi, "tell me about the latest brooks ghost");

    expect(route.primaryIntent).toBe("running_shoes");
    expect(calls.at(-1)).toContain("lookup_shoe");
    expect(calls.at(-1)).toContain("custom_safe_tool");
    expect(calls.at(-1)).not.toContain("web_search");
  });

  test("handles active tools returned as strings", () => {
    const mockPi = {
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => ["custom_safe_tool", "web_search"],
    } as any;

    const tools = activeToolNames(mockPi, ["shoes", "memory-lite"]);

    expect(tools).toContain("custom_safe_tool");
    expect(tools).toContain("lookup_shoe");
    expect(tools).not.toContain("web_search");
  });
});

test("switch-intent programming forces coding tools until cleared", async () => {
  const { default: intentRouterExtension, routeForPrompt } = await import("../extensions/intent-router");
  const commands: Record<string, any> = {};
  const calls: string[][] = [];
  const mockPi = {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => ["custom_safe_tool"],
    setActiveTools: (names: string[]) => calls.push(names),
    on: () => {},
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  } as any;
  const ctx = {
    ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
  };

  intentRouterExtension(mockPi);
  await commands["switch-intent"].handler("programming", ctx);

  const forcedRoute = routeForPrompt(mockPi, "tell me about the latest brooks ghost");

  expect(forcedRoute.primaryIntent).toBe("coding");
  expect(calls.at(-1)).toContain("apply_code_replacements");
  expect(calls.at(-1)).toContain("run_checks");
  expect(calls.at(-1)).not.toContain("web_search");

  await commands["switch-intent"].handler("auto", ctx);
  expect(routeForPrompt(mockPi, "tell me about the latest brooks ghost").primaryIntent).toBe("running_shoes");
});

test("coding route exposes codemod primitives", () => {
  const tools = activeToolNames(pi(["custom_safe_tool"]), ["coding", "repo"]);

  expect(tools).toContain("inspect_text_matches");
  expect(tools).toContain("plan_code_replacements");
  expect(tools).toContain("apply_code_replacements");
  expect(tools).toContain("run_checks");
});

test("review mode narrows active tools to readonly repo tools", async () => {
  const { default: operationalModesExtension } = await import("../extensions/operational-modes");
  const commands: Record<string, any> = {};
  operationalModesExtension({
    appendEntry: () => {},
    on: () => {},
    registerShortcut: () => {},
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  } as any);
  const ctx = {
    ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
  };

  await commands.mode.handler("review", ctx);
  const tools = activeToolNames(pi(["custom_safe_tool", "web_search", "edit"]), ["coding", "research", "memory-lite"]);
  await commands.mode.handler("conversational", ctx);

  expect(tools).toContain("read");
  expect(tools).toContain("code_search");
  expect(tools).toContain("inspect_code_structure");
  expect(tools).toContain("custom_safe_tool");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("web_search");
});

test("coding reminders mention git checkpoint safety", async () => {
  const { classifyIntent, setCurrentRoute } = await import("../extensions/shared/intent");
  const { reminderText } = await import("../extensions/intent-router");

  setCurrentRoute(classifyIntent("implement code change"));

  expect(reminderText()).toContain("Git checkpoints handle rollback safety");
});
