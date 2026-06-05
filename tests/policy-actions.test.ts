import { describe, expect, test } from "bun:test";
import { planCodemod, retrievePolicyEvidence, suggestChecks } from "../extensions/shared/policy-actions";

describe("policy actions", () => {
  test("retrieves kind-filtered policy evidence with fields and tags", () => {
    const results = retrievePolicyEvidence({ query: "node -e python -c shell bypass", kind: "mutation", topK: 2 });
    expect(results[0].id).toBe("mutation.runtime-eval");
    expect(results[0].fields?.severity).toBe("high");
    expect(results[0].tags).toContain("bypass");
  });

  test("suggests targeted checks from paths and returns executable commands", () => {
    const suggestions = suggestChecks("changed shared safety policy", ["extensions/shared/safety-policy.ts"], 2);
    expect(suggestions[0].id).toBe("checks.danger-guard");
    expect(suggestions[0].commands).toContain("bun test tests/danger-guard.test.ts");
    expect(suggestions[0].paths).toContain("extensions/shared/safety-policy.ts");
  });

  test("plans add-import codemod with inspections, tools, checks, and evidence", () => {
    const plan = planCodemod("add missing TypeScript import for unresolved symbol", ["extensions/intent-router.ts"]);
    expect(plan.selectedPrimitive).toBe("codemod.add-import");
    expect(plan.confidence).toBeGreaterThan(0);
    expect(plan.requiredInspections).toContain("Inspect relevant files before editing");
    expect(plan.preferredTools).toContain("inspect_code_structure");
    expect(plan.risks[0]).toContain("advisory");
    expect(plan.evidence[0].id).toBe("codemod.add-import");
  });

  test("falls back safely when no codemod primitive matches", () => {
    const plan = planCodemod("frobnicate unrelated sandwich preferences", []);
    expect(plan.selectedPrimitive).toBeUndefined();
    expect(plan.confidence).toBe(0);
    expect(plan.preferredTools).toEqual([]);
    expect(plan.risks[0]).toContain("No matching codemod primitive");
  });

  test("suggestChecks handles multiple paths and empty query without crashing", () => {
    const suggestions = suggestChecks("", ["extensions/shared/safety-policy.ts", "extensions/shared/retrieval/bm25.ts"], 5);
    expect(suggestions.map(s => s.id)).toContain("checks.danger-guard");
    expect(suggestions.map(s => s.id)).toContain("checks.retrieval");
  });

  test("codemod plan returns only known preferred tools from corpus docs", () => {
    const plan = planCodemod("update json package script", ["extensions/package.json"]);
    expect(plan.selectedPrimitive).toBe("codemod.update-json-key");
    expect(plan.preferredTools).toEqual(expect.arrayContaining(["inspect_json", "apply_code_replacements"]));
    expect(plan.preferredTools.every(tool => typeof tool === "string" && tool.length > 0)).toBe(true);
  });
});
