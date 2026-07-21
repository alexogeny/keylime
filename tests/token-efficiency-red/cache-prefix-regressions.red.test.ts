import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import intentRouterExtension, { resetIntentRoutingForTests } from "../../extensions/intent-router";
import policyToolsExtension from "../../extensions/policy-tools";
import repoIndexExtension from "../../extensions/repo-index/index";
import searchOrchestratorExtension from "../../extensions/search-orchestrator";
import adaptiveContextPolicyExtension from "../../extensions/adaptive-context-policy";
import toolResultCompactorExtension from "../../extensions/tool-result-compactor";
import { createContextRuntimeCoordinator } from "../../extensions/context-runtime";
import { classifyIntent, setCurrentRoute } from "../../extensions/shared/intent";
import { clearContextProviders, composeTurnContext, registerContextProvider } from "../../extensions/shared/turn-context";
import { registerUserMemoryContext } from "../../extensions/user-memory/context-provider";
import { buildPromptPrefixDiagnostic } from "../../extensions/shared/prompt-prefix-profiler";
import { mockPiFixture } from "../helpers/mock-pi";

const contextCtx = (percent = 10) => ({
  getContextUsage: () => ({ percent, tokens: percent * 100, contextWindow: 100_000 }),
  sessionManager: { getEntries: () => [] },
  ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
}) as any;

const toolLoopMessages = () => [
  { role: "user", content: "Please inspect the implementation." },
  { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "inspect_lines", arguments: {} }] },
  { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "bounded result" }] },
];

beforeEach(() => {
  clearContextProviders();
  resetIntentRoutingForTests();
  setCurrentRoute(classifyIntent(""));
});

afterEach(() => {
  clearContextProviders();
  resetIntentRoutingForTests();
});

describe("RED: cache-prefix regressions", () => {
  test("TE-CACHE-001 context providers do not rewrite a historical user message behind tool traffic", async () => {
    registerContextProvider({ id: "red-stable-reminder", priority: 100, maxChars: 200, build: () => "cache-safe reminder" });
    const original = toolLoopMessages();

    const result = await composeTurnContext(contextCtx(), original);

    expect(result.messages.slice(0, original.length)).toEqual(original);
    expect(JSON.stringify(result.messages.slice(original.length))).toContain("cache-safe reminder");
  });

  test("TE-CACHE-002 intent reminder output is identical on repeated provider rebuilds of one logical turn", async () => {
    const fixture = mockPiFixture();
    intentRouterExtension(fixture.pi);
    setCurrentRoute({ ...classifyIntent("refactor this module"), primaryIntent: "refactor", capabilityGroups: ["coding"] } as any);
    const messages = toolLoopMessages();

    const first = await composeTurnContext(contextCtx(), messages);
    const second = await composeTurnContext(contextCtx(), messages);

    expect(second.messages).toEqual(first.messages);
  });

  test("TE-CACHE-003 volatile providers are snapshotted for repeated context events in one logical turn", async () => {
    let builds = 0;
    registerContextProvider({
      id: "red-volatile-provider",
      priority: 100,
      maxChars: 200,
      stability: "turn",
      build: () => `volatile value ${++builds}`,
    });
    const messages = toolLoopMessages();

    const first = await composeTurnContext(contextCtx(), messages);
    const second = await composeTurnContext(contextCtx(), messages);

    expect(builds).toBe(1);
    expect(second.messages).toEqual(first.messages);
  });

  test("TE-CACHE-004 tool_search does not synchronously mutate the provider-visible tool prefix", async () => {
    const tools: Record<string, any> = {};
    const setCalls: string[][] = [];
    const active = ["tool_search", "tool_help"];
    policyToolsExtension({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      getActiveTools: () => active.map(name => ({ name })),
      getAllTools: () => [
        { name: "tool_search", description: "Search tools", parameters: {} },
        { name: "tool_help", description: "Inspect a tool", parameters: {} },
        { name: "apply_code_replacements", description: "Apply guarded replacements", parameters: { type: "object", properties: {} } },
      ],
      setActiveTools: (names: string[]) => { setCalls.push(names); },
    } as any);

    const result = await tools.tool_search.execute("call", { query: "apply_code_replacements", group: "coding" });

    expect(result.details.activated).toEqual(["apply_code_replacements"]);
    expect(setCalls).toEqual([]);
  });

  test("TE-CACHE-005 on-demand discovery never reorders the already-active tool prefix", async () => {
    const tools: Record<string, any> = {};
    let active = ["tool_search", "tool_help"];
    const original = [...active];
    policyToolsExtension({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      getActiveTools: () => active.map(name => ({ name })),
      getAllTools: () => [
        { name: "tool_search", description: "Search tools", parameters: {} },
        { name: "tool_help", description: "Inspect a tool", parameters: {} },
        { name: "apply_code_replacements", description: "Apply guarded replacements", parameters: {} },
      ],
      setActiveTools: (names: string[]) => { active = names; },
    } as any);

    await tools.tool_search.execute("call", { query: "apply_code_replacements", group: "coding" });

    expect(active.slice(0, original.length)).toEqual(original);
  });

  test("TE-CACHE-006 intent changes do not replace the provider-visible tool prefix mid-branch", async () => {
    const fixture = mockPiFixture();
    intentRouterExtension(fixture.pi);
    const input = fixture.handlers.input[0];

    await input({ text: "refactor the TypeScript implementation" }, fixture.ctx);
    const codingTools = [...fixture.activeTools];
    await input({ text: "remember that I prefer terse answers" }, fixture.ctx);

    expect(fixture.activeTools).toEqual(codingTools);
  });

  test("TE-CACHE-007 observation aging does not retroactively rewrite historical tool results", () => {
    const runtime = createContextRuntimeCoordinator({ hotTurns: 0, warmTurns: 0, maskCommitInterval: 1 });
    const exact = "historical exact result ".repeat(100);
    runtime.recordToolResult({ toolCallId: "old-result", toolName: "inspect_lines", text: exact, objectId: "context-old", isError: false });
    runtime.endTurn({ contextPercent: 20 });
    runtime.endTurn({ contextPercent: 20 });
    const messages = [{
      role: "toolResult",
      toolCallId: "old-result",
      content: [{ type: "text", text: exact }],
      details: { contextObjectId: "context-old" },
    }];

    const result = runtime.transformContext(messages);

    expect(result.messages).toEqual(messages);
    expect(result.transforms).toEqual([]);
  });

  test("TE-CACHE-008 source writes do not change an established repository system-prompt prefix", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-prefix-red-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "cache-red" }));
      await writeFile(join(cwd, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
      const handlers: Record<string, any> = {};
      await repoIndexExtension({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerTool: () => {},
        registerCommand: () => {},
      } as any);
      const ctx = {
        cwd,
        ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
      } as any;
      setCurrentRoute({ ...classifyIntent("refactor source"), primaryIntent: "coding", capabilityGroups: ["coding"] } as any);
      await handlers.session_start({}, ctx);
      const first = await handlers.before_agent_start({ systemPrompt: "stable base" }, ctx);

      await writeFile(join(cwd, "src", "beta.ts"), "export function beta() { return 2; }\n");
      await handlers.tool_result({ toolName: "create_file", input: { path: "src/beta.ts" }, isError: false }, ctx);
      const second = await handlers.before_agent_start({ systemPrompt: "stable base" }, ctx);

      expect(second?.systemPrompt).toBe(first?.systemPrompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("TE-CACHE-009 route changes do not conditionally add or remove repository system instructions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-route-prefix-red-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "route-red" }));
      await writeFile(join(cwd, "src", "alpha.ts"), "export const alpha = 1;\n");
      const handlers: Record<string, any> = {};
      await repoIndexExtension({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerTool: () => {},
        registerCommand: () => {},
      } as any);
      const ctx = { cwd, ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } } } as any;
      await handlers.session_start({}, ctx);
      const base = { systemPrompt: "stable base" };

      setCurrentRoute({ ...classifyIntent("review source"), primaryIntent: "review", capabilityGroups: ["coding"] } as any);
      const coding = await handlers.before_agent_start(base, ctx);
      setCurrentRoute(classifyIntent("hello"));
      const chat = await handlers.before_agent_start(base, ctx);

      expect(chat?.systemPrompt ?? base.systemPrompt).toBe(coding?.systemPrompt ?? base.systemPrompt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("TE-CACHE-010 pending memory hints are stable across repeated context events", async () => {
    const now = Date.now();
    const pendingHints = [{ category: "preference", text: "Prefer terse answers", score: 0.95 }];
    registerUserMemoryContext({
      pi: { on: () => {} } as any,
      ensureLoaded: async () => {},
      getStore: () => ({
        version: 4,
        profile: {},
        memories: [{
          id: "m1", content: "Prefer terse answers", category: "preference", tags: [], confidence: 1,
          created_at: now, updated_at: now, temporal: false, mentions: 1, first_seen: now, entity_refs: [],
        }],
      } as any),
      getEntityStore: () => ({ version: 1, entities: [] } as any),
      hybridSearch: async () => [],
      pendingHints: pendingHints as any,
      pendingClarifications: [],
    });
    const messages = [{ role: "user", content: "How should this be phrased?" }];

    const first = await composeTurnContext(contextCtx(), messages);
    const second = await composeTurnContext(contextCtx(), messages);

    expect(second.messages).toEqual(first.messages);
  });

  test("TE-CACHE-011 adaptive context percentage changes do not rewrite one logical turn", async () => {
    const previous = process.env.KEYLIME_ENABLE_ADAPTIVE_POLICY;
    process.env.KEYLIME_ENABLE_ADAPTIVE_POLICY = "1";
    try {
      adaptiveContextPolicyExtension({
        on: () => {},
        registerCommand: () => {},
        appendEntry: () => {},
      } as any);
      let percent = 10;
      const ctx = {
        getContextUsage: () => ({ percent, tokens: percent * 100, contextWindow: 100_000 }),
        sessionManager: { getEntries: () => [] },
        ui: { setStatus: () => {}, theme: { fg: (_style: string, text: string) => text } },
      } as any;
      const messages = toolLoopMessages();
      const first = await composeTurnContext(ctx, messages);
      percent = 11;
      const second = await composeTurnContext(ctx, messages);

      expect(second.messages).toEqual(first.messages);
    } finally {
      if (previous === undefined) delete process.env.KEYLIME_ENABLE_ADAPTIVE_POLICY;
      else process.env.KEYLIME_ENABLE_ADAPTIVE_POLICY = previous;
    }
  });

  test("TE-CACHE-012 changing search statistics are snapshotted within one logical turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "search-stats-red-"));
    const oldDir = process.env.KEYLIME_WEB_SEARCH_DATA_DIR;
    const oldEnabled = process.env.KEYLIME_ENABLE_RESEARCH;
    process.env.KEYLIME_WEB_SEARCH_DATA_DIR = cwd;
    process.env.KEYLIME_ENABLE_RESEARCH = "1";
    try {
      await writeFile(join(cwd, "index.json"), JSON.stringify({ version: 1, entries: [] }));
      const fixture = mockPiFixture({ active: ["web_search"] });
      searchOrchestratorExtension(fixture.pi);
      setCurrentRoute({ ...classifyIntent("research the latest release"), primaryIntent: "research", capabilityGroups: ["research"] } as any);
      const messages = toolLoopMessages();
      const first = await composeTurnContext(contextCtx(), messages);

      await writeFile(join(cwd, "index.json"), JSON.stringify({
        version: 1,
        entries: [{ id: "s1", query: "latest release", timestamp: Date.now(), tags: ["release"], categories: ["tech"], summary: "found" }],
      }));
      const second = await composeTurnContext(contextCtx(), messages);

      expect(second.messages).toEqual(first.messages);
    } finally {
      if (oldDir === undefined) delete process.env.KEYLIME_WEB_SEARCH_DATA_DIR;
      else process.env.KEYLIME_WEB_SEARCH_DATA_DIR = oldDir;
      if (oldEnabled === undefined) delete process.env.KEYLIME_ENABLE_RESEARCH;
      else process.env.KEYLIME_ENABLE_RESEARCH = oldEnabled;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("TE-CACHE-013 append-only history growth is not reported as a cache bust", () => {
    const firstPayload = {
      system: "stable system",
      tools: [{ name: "stable_tool", description: "stable", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
      ],
    };
    const first = buildPromptPrefixDiagnostic(undefined, firstPayload);
    const second = buildPromptPrefixDiagnostic(first, {
      ...firstPayload,
      messages: [...firstPayload.messages, { role: "user", content: "next append-only turn" }],
    });

    expect(second.diff).toEqual({ cacheBust: false, changedCategories: [], firstChangedPath: "" });
  });

  test("TE-CACHE-014 already-bounded inspect_lines output is not compacted into a second recovery round trip", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bounded-inspect-red-"));
    try {
      const handlers: Record<string, any> = {};
      toolResultCompactorExtension({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerTool: () => {},
      } as any);
      const bounded = Array.from({ length: 80 }, (_, index) => `${index + 1} | ${"bounded source ".repeat(6)}`).join("\n");

      const patch = await handlers.tool_result({
        toolName: "inspect_lines",
        toolCallId: "bounded-lines",
        content: [{ type: "text", text: bounded }],
        details: { requestedRange: [1, 80], bounded: true },
        isError: false,
      }, { cwd });

      expect(patch).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
