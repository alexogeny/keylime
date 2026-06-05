import { describe, expect, test } from "bun:test";
import policyToolsExtension from "../extensions/policy-tools";

describe("policy tools extension", () => {
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
    ]);
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
