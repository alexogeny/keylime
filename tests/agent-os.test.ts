import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentOsExtension, { resetAgentOsMemoryForTests } from "../extensions/agent-os";
import { routeForPrompt } from "../extensions/intent-router";
import { classifyIntent, setCurrentRoute } from "../extensions/shared/intent";
import { mockPiFixture } from "./helpers/mock-pi";
import { clearContextProviders, composeTurnContext } from "../extensions/shared/turn-context";
import { bindRepositoryState, resolveRepositoryIdentity } from "../extensions/shared/repository-identity";

function registerAgentOs() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  agentOsExtension({
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
  } as any);
  return { tools, commands };
}

beforeEach(() => {
  resetAgentOsMemoryForTests();
});

describe("agent OS extension", () => {
  test("registers cognitive registers and injects compact hot state", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));
    const { tools } = registerAgentOs();

    await tools.update_agent_registers.execute("id", {
      goal: "implement agent OS",
      hypothesis: "registers act like CPU state",
      next_action: "run focused tests",
      risks: ["context bloat"],
      done_when: ["tests pass"],
    }, undefined, undefined, { cwd });

    const read = await tools.read_agent_registers.execute("id", {}, undefined, undefined, { cwd });
    expect(read.details.registers.goal).toBe("implement agent OS");

    setCurrentRoute(classifyIntent("implement code change"));
    const composed = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue" }]);
    expect(composed.providerIds).toContain("agent-os");
    expect(composed.messages[0].content).toContain("AGENT REGISTERS");
    expect(composed.messages[0].content).toContain("implement agent OS");
    clearContextProviders();
  });

  test("manages addressable context regions with pinning, ttl, and bounded reads", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));
    const { tools } = registerAgentOs();

    await tools.ctx_region_write.execute("id", {
      id: "failure-trace",
      kind: "failure",
      content: "latest check failed because finish_file_write did not invalidate index. ".repeat(8),
      priority: 90,
      pinned: true,
      source_refs: ["tests/repo-index.test.ts"],
    }, undefined, undefined, { cwd });

    const listed = await tools.ctx_region_list.execute("id", {}, undefined, undefined, { cwd });
    expect(listed.details.regions[0]).toMatchObject({ id: "failure-trace", kind: "failure", pinned: true });

    const read = await tools.ctx_region_read.execute("id", { id: "failure-trace", max_chars: 10 }, undefined, undefined, { cwd });
    expect(read.content[0].text).toContain("trimmed");

    setCurrentRoute(classifyIntent("debug failing tests"));
    const composed = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue" }]);
    expect(composed.messages[0].content).toContain("CTX REGION ctx://failure-trace");

    await tools.ctx_region_evict.execute("id", { id: "failure-trace" }, undefined, undefined, { cwd });
    const empty = await tools.ctx_region_list.execute("id", {}, undefined, undefined, { cwd });
    expect(empty.details.regions).toEqual([]);
    clearContextProviders();
  });

  test("active grammar preserves continuity tools through intent drift", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));
    const harness = mockPiFixture({ active: ["code_search"] });
    agentOsExtension(harness.pi);

    await harness.tools.compile_tool_grammar.execute("id", {
      intent: "existing_file_edit",
      risk_level: "medium",
    }, undefined, undefined, { cwd });

    const route = routeForPrompt(harness.pi, "thanks, that makes sense");
    expect(route.primaryIntent).toBe("chat");
    expect(harness.activeTools).toContain("apply_code_replacements");
    expect(harness.activeTools).toContain("run_checks");
    clearContextProviders();
  });

  test("agent registers bias weak follow-up routing toward coding", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));
    const harness = mockPiFixture({ active: ["code_search"] });
    agentOsExtension(harness.pi);

    await harness.tools.update_agent_registers.execute("id", {
      goal: "implement repo index invalidation fix",
      next_action: "apply code replacement and run checks",
    }, undefined, undefined, { cwd });

    const route = routeForPrompt(harness.pi, "continue");
    expect(["coding", "debugging", "refactor"]).toContain(route.primaryIntent);
    expect(harness.activeTools).toContain("plan_code_replacements");
    expect(harness.activeTools).toContain("apply_code_replacements");
    expect(harness.activeTools).toContain("tool_search");
    clearContextProviders();
  });

  test("compiles task-local tool grammars and budget plans", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));
    const { tools } = registerAgentOs();

    const grammar = await tools.compile_tool_grammar.execute("id", {
      intent: "large_file_create",
      risk_level: "medium",
    }, undefined, undefined, { cwd });
    expect(grammar.details.grammar.allowedTools).toEqual(["begin_file_write", "append_file_chunk", "finish_file_write", "abort_file_write", "run_checks"]);
    expect(grammar.content[0].text).toContain("begin_file_write → append_file_chunk* → finish_file_write");

    const budget = await tools.current_agent_budget.execute("id", {}, undefined, undefined, { cwd });
    expect(budget.details.budget.maxBranchCount).toBe(0);
    expect(budget.details.budget.reasoningBudget).toBe("medium");

    const current = await tools.current_tool_grammar.execute("id", {}, undefined, undefined, { cwd });
    expect(current.details.grammar.id).toBe("large_file_create");
    clearContextProviders();
  });
  test("compiles document workflow grammars", async () => {
    const { tools } = registerAgentOs();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-"));

    const readGrammar = await tools.compile_tool_grammar.execute("id", { intent: "document_read_summarize" }, undefined, undefined, { cwd });
    expect(readGrammar.details.grammar.id).toBe("document_read_summarize");
    expect(readGrammar.details.grammar.allowedTools).toContain("inspect_document");
    expect(readGrammar.details.grammar.allowedTools).toContain("summarize_document");

    const reporterGrammar = await tools.compile_tool_grammar.execute("id", { intent: "reporter_document_create" }, undefined, undefined, { cwd });
    expect(reporterGrammar.details.grammar.id).toBe("reporter_document_create");
    expect(reporterGrammar.details.grammar.allowedTools).toContain("create_reporter_document");
  });

  test("quarantines legacy and foreign agent OS state from context and routing", async () => {
    clearContextProviders();
    const cwd = await mkdtemp(join(tmpdir(), "agent-os-quarantine-"));
    const foreign = await mkdtemp(join(tmpdir(), "agent-os-foreign-"));
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const staleState = {
      registers: { goal: "unrelated foreign goal" },
      regions: [],
      budget: { maxContextChars: 1000, maxToolCalls: 4, maxCheckRuns: 1, maxBranchCount: 0, reasoningBudget: "low" },
    };
    await writeFile(join(cwd, ".pi", "agent-os.json"), JSON.stringify(staleState), "utf8");
    const { commands } = registerAgentOs();
    setCurrentRoute(classifyIntent("debug failing tests"));

    const legacyContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue" }]);
    expect(legacyContext.providerIds).not.toContain("agent-os");
    expect(legacyContext.messages[0].content).not.toContain("unrelated foreign goal");

    await commands["adopt-agent-os-state"].handler("", {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true, notify: () => {} },
    });
    const adoptedContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue" }]);
    expect(adoptedContext.providerIds).toContain("agent-os");
    expect(adoptedContext.messages[0].content).toContain("unrelated foreign goal");

    clearContextProviders();
    resetAgentOsMemoryForTests();
    const foreignIdentity = await resolveRepositoryIdentity(foreign);
    await writeFile(
      join(cwd, ".pi", "agent-os.json"),
      JSON.stringify(bindRepositoryState(foreignIdentity, staleState)),
      "utf8",
    );
    registerAgentOs();
    const foreignContext = await composeTurnContext({ cwd } as any, [{ role: "user", content: "continue" }]);
    expect(foreignContext.providerIds).not.toContain("agent-os");
    expect(foreignContext.messages[0].content).not.toContain("unrelated foreign goal");
  });
});
