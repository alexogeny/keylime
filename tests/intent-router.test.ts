import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { activeToolNames } from "../extensions/intent-router";

const allToolNames = [
  "read", "bash", "edit", "write", "code_search", "list_files", "inspect_json", "inspect_text_matches", "inspect_code_structure", "inspect_lines", "plan_code_replacements", "apply_code_replacements", "create_file", "create_directory", "run_checks", "retrieve_policy", "suggest_checks", "codemod_plan", "inspect_tool_result", "commit_history", "see_file_commit_history", "git_status", "git_diff", "inspect_at_checkpoint",
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

    expect(tools).not.toContain("read");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).toContain("code_search");
    expect(tools).toContain("list_files");
    expect(tools).toContain("inspect_json");
    expect(tools).toContain("inspect_lines");
    expect(tools).toContain("create_file");
    expect(tools).toContain("create_directory");
    expect(tools).toContain("commit_history");
    expect(tools).toContain("see_file_commit_history");
    expect(tools).toContain("git_status");
    expect(tools).toContain("git_diff");
    expect(tools).toContain("inspect_at_checkpoint");
    expect(tools).toContain("remember");
    expect(tools).toContain("custom_safe_tool");
    expect(tools).not.toContain("web_search");
    expect(tools).not.toContain("lookup_shoe");
  });

  test("shoe intent exposes shoe tools and always-on code primitives without web tools", () => {
    const tools = activeToolNames(pi(["custom_safe_tool"]), ["shoes", "memory-lite"]);

    expect(tools).toContain("lookup_shoe");
    expect(tools).toContain("query_shoes");
    expect(tools).toContain("recall_memories");
    expect(tools).toContain("list_files");
    expect(tools).toContain("inspect_json");
    expect(tools).toContain("inspect_lines");
    expect(tools).toContain("apply_code_replacements");
    expect(tools).not.toContain("read");
    expect(tools).not.toContain("bash");
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

  test("research tools are enabled when a provider key is configured in web-search config", () => {
    const dir = mkdtempSync(join(tmpdir(), "keylime-research-config-"));
    const configFile = join(dir, "config.json");
    const oldConfig = process.env.KEYLIME_WEB_SEARCH_CONFIG;
    const oldDisable = process.env.KEYLIME_DISABLE_RESEARCH;
    const oldEnable = process.env.KEYLIME_ENABLE_RESEARCH;
    const oldTavily = process.env.TAVILY_API_KEY;
    const oldSerper = process.env.SERPER_API_KEY;
    const oldBing = process.env.BING_API_KEY;

    process.env.KEYLIME_WEB_SEARCH_CONFIG = configFile;
    delete process.env.KEYLIME_DISABLE_RESEARCH;
    delete process.env.KEYLIME_ENABLE_RESEARCH;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.BING_API_KEY;
    writeFileSync(configFile, JSON.stringify({ TAVILY_API_KEY: "tvly-test" }));

    const tools = activeToolNames(pi(["custom_safe_tool"]), ["research", "fetch", "memory-lite"]);

    expect(tools).toContain("web_search");
    expect(tools).toContain("research_topic");
    expect(tools).toContain("fetch_url");

    if (oldConfig === undefined) delete process.env.KEYLIME_WEB_SEARCH_CONFIG;
    else process.env.KEYLIME_WEB_SEARCH_CONFIG = oldConfig;
    if (oldDisable === undefined) delete process.env.KEYLIME_DISABLE_RESEARCH;
    else process.env.KEYLIME_DISABLE_RESEARCH = oldDisable;
    if (oldEnable === undefined) delete process.env.KEYLIME_ENABLE_RESEARCH;
    else process.env.KEYLIME_ENABLE_RESEARCH = oldEnable;
    if (oldTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = oldTavily;
    if (oldSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = oldSerper;
    if (oldBing === undefined) delete process.env.BING_API_KEY;
    else process.env.BING_API_KEY = oldBing;
    rmSync(dir, { recursive: true, force: true });
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
    expect(calls.at(-1)).toContain("web_search");
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

describe("context rerouting", () => {
  test("context pass can shift tool visibility based on the latest user prompt", async () => {
    const { default: intentRouterExtension } = await import("../extensions/intent-router");
    const oldEnable = process.env.KEYLIME_ENABLE_RESEARCH;
    const oldDisable = process.env.KEYLIME_DISABLE_RESEARCH;
    process.env.KEYLIME_ENABLE_RESEARCH = "1";
    delete process.env.KEYLIME_DISABLE_RESEARCH;
    const handlers: Record<string, any> = {};
    let active = ["read", "edit", "code_search", "custom_safe_tool"];
    const calls: string[][] = [];
    const mockPi = {
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => active.map(name => ({ name })),
      setActiveTools: (names: string[]) => { active = names; calls.push(names); },
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
    } as any;
    const ctx = {
      ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
    };

    intentRouterExtension(mockPi);
    await handlers.context({ messages: [{ role: "user", content: "research the latest on cold water immersion" }] }, ctx);

    expect(calls.at(-1)).toContain("web_search");
    expect(calls.at(-1)).toContain("research_topic");
    expect(calls.at(-1)).not.toContain("edit");

    if (oldEnable === undefined) delete process.env.KEYLIME_ENABLE_RESEARCH;
    else process.env.KEYLIME_ENABLE_RESEARCH = oldEnable;
    if (oldDisable === undefined) delete process.env.KEYLIME_DISABLE_RESEARCH;
    else process.env.KEYLIME_DISABLE_RESEARCH = oldDisable;
  });

  test("context pass does not reset tools when the active schema set is already correct", async () => {
    const { default: intentRouterExtension } = await import("../extensions/intent-router");
    const handlers: Record<string, any> = {};
    const active = activeToolNames(pi(["custom_safe_tool"]), ["core", "repo", "coding", "project", "safety", "memory-lite"]);
    const calls: string[][] = [];
    const mockPi = {
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => active.map(name => ({ name })),
      setActiveTools: (names: string[]) => calls.push(names),
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerCommand: () => {},
    } as any;
    const ctx = {
      ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
    };

    intentRouterExtension(mockPi);
    await handlers.context({ messages: [{ role: "user", content: "implement code change" }] }, ctx);
    await handlers.context({ messages: [{ role: "user", content: "implement code change" }] }, ctx);

    expect(calls).toHaveLength(0);
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

test("policy-assisted routing upgrades low-confidence refactor phrasing", async () => {
  const { routeForPrompt } = await import("../extensions/intent-router");
  const calls: string[][] = [];
  const mockPi = {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => [],
    setActiveTools: (names: string[]) => calls.push(names),
  } as any;

  const route = routeForPrompt(mockPi, "make this less gross without changing behavior");

  expect(route.primaryIntent).toBe("refactor");
  expect(calls.at(-1)).toContain("codemod_plan");
  expect(calls.at(-1)).toContain("run_checks");
});

test("policy evidence ranks corpus docs for prompts without changing deterministic route", async () => {
  const { policyEvidenceForPrompt } = await import("../extensions/intent-router");
  const evidence = policyEvidenceForPrompt("refactor duplicate retrieval code and run checks");

  expect(evidence[0].id).toBe("routing.refactor");
  expect(evidence.some(item => item.id === "checks.retrieval")).toBe(true);
});

test("coding route exposes codemod primitives", () => {
  const tools = activeToolNames(pi(["custom_safe_tool"]), ["coding", "repo"]);

  expect(tools).toContain("inspect_text_matches");
  expect(tools).toContain("inspect_lines");
  expect(tools).toContain("plan_code_replacements");
  expect(tools).toContain("apply_code_replacements");
  expect(tools).toContain("create_file");
  expect(tools).toContain("create_directory");
  expect(tools).toContain("run_checks");
  expect(tools).toContain("retrieve_policy");
  expect(tools).toContain("suggest_checks");
  expect(tools).toContain("codemod_plan");
  expect(tools).toContain("inspect_tool_result");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("write");
});

test("review mode keeps always-on code primitives but removes unrelated domain tools", async () => {
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
  expect(tools).toContain("apply_code_replacements");
  expect(tools).toContain("create_file");
  expect(tools).toContain("custom_safe_tool");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("web_search");
});

test("agent-status command reports route, policy evidence, context, and compaction", async () => {
  const { default: intentRouterExtension, routeForPrompt } = await import("../extensions/intent-router");
  const commands: Record<string, any> = {};
  let notification = "";
  const mockPi = {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => ["code_search", "retrieve_policy", "inspect_tool_result"],
    setActiveTools: () => {},
    on: () => {},
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  } as any;
  intentRouterExtension(mockPi);
  routeForPrompt(mockPi, "refactor retrieval and compact tool results");

  await commands["agent-status"].handler("", {
    ui: { notify: (text: string) => { notification = text; } },
  });

  expect(notification).toContain("Agent Status");
  expect(notification).toContain("intent:");
  expect(notification).toContain("policy evidence:");
  expect(notification).toContain("turn-context composer");
  expect(notification).toContain("tool results: oversized successful results are compacted");
});

test("tool-policy command reports always-on and locked tools", async () => {
  const { default: intentRouterExtension } = await import("../extensions/intent-router");
  const commands: Record<string, any> = {};
  let notification = "";
  intentRouterExtension({
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => ["custom_safe_tool", "create_directory"],
    setActiveTools: () => {},
    on: () => {},
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  } as any);

  await commands["tool-policy"].handler("", {
    ui: { notify: (text: string) => { notification = text; } },
  });

  expect(notification).toContain("always-on code tools");
  expect(notification).toContain("create_directory");
  expect(notification).toContain("retrieve_policy");
  expect(notification).toContain("codemod_plan");
  expect(notification).toContain("inspect_tool_result");
  expect(notification).toContain("locked built-ins");
  expect(notification).toContain("policy evidence:");
});

test("coding reminders mention git checkpoint safety and codemod mutation policy", async () => {
  const { classifyIntent, setCurrentRoute } = await import("../extensions/shared/intent");
  const { reminderText } = await import("../extensions/intent-router");

  setCurrentRoute(classifyIntent("implement code change"));

  expect(reminderText()).toContain("Git checkpoints handle rollback safety");
  expect(reminderText()).toContain("use codemod tools");
  expect(reminderText()).toContain("do not use read/write/edit, bash, node, python, perl, sed, awk, tee, heredocs, shell redirection, or raw git mutation commands");
  expect(reminderText()).toContain("Use checkpoint/git inspection tools");
  expect(reminderText()).toContain("prefer run_checks");
});
