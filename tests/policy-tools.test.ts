import { afterEach, describe, expect, test } from "bun:test";
import policyToolsExtension from "../extensions/policy-tools";
import { clearDiscoveredToolsForTurn } from "../extensions/shared/tool-catalog";

describe("policy tools extension", () => {
  afterEach(() => clearDiscoveredToolsForTurn());

  function register() {
    const tools: Record<string, any> = {};
    policyToolsExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
    return tools;
  }

  test("registers policy retrieval, checks, planning, and low-risk codemod executors", () => {
    const tools = register();
    expect(Object.keys(tools).sort()).toEqual([
      "codemod_add_import",
      "codemod_insert_test_case",
      "codemod_plan",
      "codemod_update_json",
      "retrieve_policy",
      "suggest_checks",
      "tool_help",
      "tool_search",
    ]);
  });

  test("tool_search and tool_help expose compact tool policy metadata", async () => {
    const tools = register();
    const search = await tools.tool_search.execute("id", { query: "file write", group: "coding" });
    expect(search.content[0].text).toContain("begin_file_write");
    expect(search.content[0].text).toContain("finish_file_write");

    const help = await tools.tool_help.execute("id", { name: "begin_file_write" });
    expect(help.details.policy.group).toBe("coding");
  });

  test("tool_search additively loads bounded available matches without locked built-ins", async () => {
    const tools: Record<string, any> = {};
    let active = ["tool_search", "code_search"];
    const available = ["tool_search", "code_search", "compare_files", "inspect_lines", "web_search", "write", "edit"];
    policyToolsExtension({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      getActiveTools: () => active.map(name => ({ name })),
      getAllTools: () => available.map(name => ({ name })),
      setActiveTools: (names: string[]) => { active = names; },
    } as any);

    const loaded = await tools.tool_search.execute("id", { query: "compare files", limit: 3 });
    expect(active).toContain("tool_search");
    expect(active).toContain("code_search");
    expect(active).toContain("compare_files");
    expect(loaded.details.loaded).toEqual(["compare_files"]);

    await tools.tool_search.execute("id", { query: "write edit", limit: 5 });
    expect(active).not.toContain("write");
    expect(active).not.toContain("edit");

    const previousDisable = process.env.KEYLIME_DISABLE_RESEARCH;
    process.env.KEYLIME_DISABLE_RESEARCH = "1";
    try {
      await tools.tool_search.execute("id", { query: "web search", limit: 5 });
      expect(active).not.toContain("web_search");
    } finally {
      if (previousDisable === undefined) delete process.env.KEYLIME_DISABLE_RESEARCH;
      else process.env.KEYLIME_DISABLE_RESEARCH = previousDisable;
    }
  });

  test("tool_search reports next-step activation and exposes the registered schema", async () => {
    const tools: Record<string, any> = {};
    let active = ["tool_search", "tool_help"];
    const parameters = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["newText"],
          },
        },
      },
      required: ["edits"],
    };
    policyToolsExtension({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      getActiveTools: () => active.map(name => ({ name })),
      getAllTools: () => [
        { name: "tool_search", description: "search tools", parameters: {} },
        { name: "tool_help", description: "help", parameters: {} },
        { name: "apply_code_replacements", description: "Apply replacements", parameters },
      ],
      setActiveTools: (names: string[]) => { active = names; },
    } as any);

    const result = await tools.tool_search.execute("id", { query: "apply_code_replacements", group: "coding" });
    expect(result.content[0].text).toContain("ACTIVATED FOR NEXT MODEL STEP: apply_code_replacements");
    expect(result.content[0].text).toContain("Do not call it as a sibling");
    expect(result.content[0].text).toContain("oldText");
    expect(result.content[0].text).toContain("newText");
    expect(result.details.callableAfter).toBe("next_model_step");
    expect(result.details.activated).toEqual(["apply_code_replacements"]);

    const second = await tools.tool_search.execute("id", { query: "apply_code_replacements", group: "coding" });
    expect(second.content[0].text).toContain("ALREADY ACTIVE: apply_code_replacements");

    const help = await tools.tool_help.execute("id", { name: "ApplyCodeReplacements" });
    expect(help.content[0].text).toContain("Exact name: apply_code_replacements");
    expect(help.content[0].text).toContain("oldText");
  });

  test("tool_search uses registered tool descriptions for capability queries", async () => {
    const tools: Record<string, any> = {};
    let active = ["tool_search"];
    policyToolsExtension({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      getActiveTools: () => active.map(name => ({ name })),
      getAllTools: () => [
        { name: "tool_search", description: "search tools" },
        { name: "compare_files", description: "Diff two repository files and summarize changes" },
      ],
      setActiveTools: (names: string[]) => { active = names; },
    } as any);

    const result = await tools.tool_search.execute("id", { query: "diff repository", limit: 3 });
    expect(result.details.loaded).toEqual(["compare_files"]);
    expect(active).toContain("compare_files");
  });

  test("retrieve_policy returns kind-filtered corpus evidence", async () => {
    const tools = register();
    const result = await tools.retrieve_policy.execute("id", { query: "python -c runtime eval", kind: "mutation", top_k: 1 });
    expect(result.details.results[0].id).toBe("mutation.runtime-eval");
    expect(result.content[0].text).toContain("mutation.runtime-eval");
  });

  test("suggest_checks returns path-aware commands", async () => {
    const tools = register();
    const result = await tools.suggest_checks.execute("id", { query: "safety policy", paths: ["extensions/danger-guard.ts"], top_k: 1 });
    expect(result.details.suggestions[0].commands).toContain("bun test tests/danger-guard.test.ts");
  });

  test("codemod_plan returns advisory primitive and does not mutate", async () => {
    const tools = register();
    const result = await tools.codemod_plan.execute("id", { goal: "update package script json key", files: ["extensions/package.json"] });
    expect(result.details.selectedPrimitive).toBe("codemod.update-json-key");
    expect(result.details.risks[0]).toContain("advisory");
  });
});
