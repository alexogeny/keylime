import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import intentRouterExtension, { activeToolNames, workflowToolNames } from "../extensions/intent-router";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { clearContextProviders, composeTurnContext } from "../extensions/shared/turn-context";
import { allKnownTestTools, mockPi } from "./helpers/mock-pi";

const allToolNames = allKnownTestTools();

function pi(active: string[]) {
  return mockPi(active);
}

describe("activeToolNames", () => {
  test("coding keeps code tools and removes unrelated domain tools", () => {
    const tools = activeToolNames(pi(["web_search", "lookup_shoe", "custom_safe_tool"]), ["core", "repo", "coding", "memory-lite"]);

    expect(tools).not.toContain("read");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).toContain("code_search");
    expect(tools).toContain("list_files");
    expect(tools).not.toContain("inspect_json");
    expect(tools).toContain("inspect_lines");
    expect(tools).not.toContain("create_file");
    expect(tools).not.toContain("begin_file_write");
    expect(tools).not.toContain("append_file_chunk");
    expect(tools).not.toContain("finish_file_write");
    expect(tools).not.toContain("abort_file_write");
    expect(tools).not.toContain("create_directory");
    expect(tools).toContain("tool_search");
    expect(tools).toContain("tool_help");
    expect(tools).not.toContain("read_agent_registers");
    expect(tools).not.toContain("ctx_region_write");
    expect(tools).not.toContain("compile_tool_grammar");
    expect(tools).not.toContain("current_agent_budget");
    expect(tools).not.toContain("commit_history");
    expect(tools).not.toContain("see_file_commit_history");
    expect(tools).not.toContain("git_status");
    expect(tools).not.toContain("git_diff");
    expect(tools).not.toContain("inspect_at_checkpoint");
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
    expect(tools).not.toContain("inspect_json");
    expect(tools).toContain("inspect_lines");
    expect(tools).not.toContain("apply_code_replacements");
    expect(tools).not.toContain("create_file");
    expect(tools).toContain("run_checks");
    expect(tools).not.toContain("read");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("web_search");
  });

  test("readonly routing avoids raw read by default", () => {
    const tools = activeToolNames(pi(["read", "bash", "fetch_url"]), ["readonly"]);

    expect(tools).toContain("code_search");
    expect(tools).toContain("inspect_lines");
    expect(tools).not.toContain("apply_code_replacements");
    expect(tools).not.toContain("create_file");
    expect(tools).toContain("fetch_url");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("read");
  });
});

describe("research gating", () => {
  test("research mode keeps safe file tools but not bash or raw read/write", () => {
    const tools = activeToolNames(pi(["bash", "read", "write", "web_search", "fetch_url"]), ["readonly", "research", "fetch", "memory-lite"]);

    expect(tools).toContain("web_search");
    expect(tools).toContain("fetch_url");
    expect(tools).toContain("inspect_lines");
    expect(tools).not.toContain("apply_code_replacements");
    expect(tools).not.toContain("create_file");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("read");
    expect(tools).not.toContain("write");
  });

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
  test("intent reminder is injected only when reminder content changes", async () => {
    clearContextProviders();
    const handlers: Record<string, any> = {};
    intentRouterExtension({
      getAllTools: () => allToolNames.map(name => ({ name })),
      getActiveTools: () => [],
      setActiveTools: () => {},
      registerCommand: () => {},
      on: (name: string, handler: any) => { handlers[name] = handler; },
    } as any);

    setCurrentRoute(classifyIntent("please implement this"));
    const first = await composeTurnContext({ getContextUsage: () => ({ percent: 10 }) } as any, [{ role: "user", content: "please implement this" }]);
    const second = await composeTurnContext({ getContextUsage: () => ({ percent: 10 }) } as any, [{ role: "user", content: "please implement this" }]);
    setCurrentRoute(classifyIntent("research this online"));
    const third = await composeTurnContext({ getContextUsage: () => ({ percent: 10 }) } as any, [{ role: "user", content: "research this online" }]);

    expect(first.providerIds).toContain("intent-router");
    expect(second.providerIds).not.toContain("intent-router");
    expect(third.providerIds).toContain("intent-router");
  });

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
    let active = activeToolNames(pi(["custom_safe_tool"]), ["core", "repo", "coding", "project", "safety", "memory-lite"]);
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
    await handlers.context({ messages: [{ role: "user", content: "implement code change" }] }, ctx);
    await handlers.context({ messages: [{ role: "user", content: "implement code change" }] }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("plan_code_replacements");
    expect(calls[0]).toContain("apply_code_replacements");
  });
});

test("switch-intent linux_ops activates the execution capability guard", async () => {
  const { default: intentRouterExtension, resetIntentRoutingForTests } = await import("../extensions/intent-router");
  const { getCurrentRoute, isCapabilityActive } = await import("../extensions/shared/intent");
  const { requireLinuxCapability } = await import("../extensions/shared/linux-safety");
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

  resetIntentRoutingForTests();
  intentRouterExtension(mockPi);
  await commands["switch-intent"].handler("linux_ops", ctx);

  expect(getCurrentRoute().primaryIntent).toBe("linux_ops");
  expect(isCapabilityActive("linux")).toBe(true);
  expect(() => requireLinuxCapability()).not.toThrow();
  expect(calls.at(-1)).toContain("inspect_kernel");

  await commands["switch-intent"].handler("auto", ctx);
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
  expect(calls.at(-1)).not.toContain("apply_code_replacements");
  expect(calls.at(-1)).toContain("run_checks");
  expect(calls.at(-1)).not.toContain("web_search");

  await commands["switch-intent"].handler("auto", ctx);
  expect(routeForPrompt(mockPi, "tell me about the latest brooks ghost").primaryIntent).toBe("running_shoes");
});

test("policy-assisted routing does not hijack ordinary chat, research, or domain prompts", async () => {
  const { routeForPrompt } = await import("../extensions/intent-router");
  const mockPi = {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any;

  expect(routeForPrompt(mockPi, "thanks that makes sense").primaryIntent).toBe("chat");
  expect(routeForPrompt(mockPi, "research current sources for this topic").primaryIntent).toBe("research");
  expect(routeForPrompt(mockPi, "what is the latest brooks ghost running shoe").primaryIntent).toBe("running_shoes");
  expect(routeForPrompt(mockPi, "remember that I prefer black coffee").primaryIntent).toBe("memory");
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

test("policy-assisted routing upgrades low-confidence debugging phrasing", async () => {
  const { routeForPrompt } = await import("../extensions/intent-router");
  const calls: string[][] = [];
  const mockPi = {
    getAllTools: () => allToolNames.map(name => ({ name })),
    getActiveTools: () => [],
    setActiveTools: (names: string[]) => calls.push(names),
  } as any;

  const route = routeForPrompt(mockPi, "why did this start exploding after the change");

  expect(route.primaryIntent).toBe("debugging");
  expect(calls.at(-1)).toContain("run_checks");
});

test("policy evidence ranks corpus docs for prompts without changing deterministic route", async () => {
  const { policyEvidenceForPrompt } = await import("../extensions/intent-router");
  const evidence = policyEvidenceForPrompt("refactor duplicate retrieval code and run checks");

  expect(evidence[0].id).toBe("routing.refactor");
  expect(evidence.some(item => item.id === "checks.retrieval")).toBe(true);
});

test("explicit coding mutations preactivate the guarded replacement workflow", () => {
  const route = classifyIntent("implement this code change and update the tests");

  expect(workflowToolNames(route)).toEqual([
    "apply_code_replacements",
    "plan_code_replacements",
    "run_checks",
  ]);
  expect(workflowToolNames(classifyIntent("explain how this implementation works"))).toEqual([]);
});

test("coding route starts with bootstrap tools and defers codemods", () => {
  const tools = activeToolNames(pi(["custom_safe_tool"]), ["coding", "repo"]);

  expect(tools).toContain("inspect_text_matches");
  expect(tools).toContain("inspect_lines");
  expect(tools).not.toContain("plan_code_replacements");
  expect(tools).not.toContain("apply_code_replacements");
  expect(tools).not.toContain("create_file");
  expect(tools).not.toContain("create_directory");
  expect(tools).toContain("run_checks");
  expect(tools).not.toContain("retrieve_policy");
  expect(tools).not.toContain("suggest_checks");
  expect(tools).not.toContain("codemod_plan");
  expect(tools).not.toContain("inspect_tool_result");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("write");
});

test("review mode keeps safe file primitives but removes unrelated domain tools", async () => {
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

  expect(tools).not.toContain("read");
  expect(tools).toContain("code_search");
  expect(tools).not.toContain("inspect_code_structure");
  expect(tools).not.toContain("apply_code_replacements");
  expect(tools).not.toContain("create_file");
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
  expect(notification).not.toContain("create_directory");
  expect(notification).not.toContain("retrieve_policy");
  expect(notification).not.toContain("codemod_plan");
  expect(notification).not.toContain("inspect_tool_result");
  expect(notification).toContain("locked built-ins");
  expect(notification).toContain("policy evidence:");
});

test("coding reminders use the short stable coding contract", async () => {
  const { classifyIntent, setCurrentRoute } = await import("../extensions/shared/intent");
  const { reminderText } = await import("../extensions/intent-router");
  const { CODING_CONTRACT } = await import("../extensions/shared/coding-contract");

  setCurrentRoute(classifyIntent("implement code change"));

  expect(reminderText()).toContain(`Coding contract: ${CODING_CONTRACT}`);
  expect(reminderText()).not.toContain("do not use read/write/edit");
});
