import { describe, expect, test } from "bun:test";
import { POLICY_DOCUMENTS, retrievePolicy, validatePolicyCorpus } from "../extensions/shared/policy-corpus";
import { knownToolNames } from "../extensions/shared/tool-policy";

describe("policy corpus retrieval", () => {
  test("has unique, typed seed documents for routing, mutation, codemod, checks, context, and recall", () => {
    const ids = new Set(POLICY_DOCUMENTS.map(doc => doc.id));
    expect(ids.size).toBe(POLICY_DOCUMENTS.length);
    expect(new Set(POLICY_DOCUMENTS.map(doc => doc.kind))).toEqual(new Set(["routing", "mutation", "codemod", "check", "context", "recall"]));
  });

  test("retrieves detailed safe primitive policy moved out of always-on prompts", () => {
    const results = retrievePolicy("safe source edits raw shell runtime commands", { kind: "mutation", topK: 3 });
    const doc = results.find(result => result.document.id === "mutation.safe-source-primitives")?.document;
    expect(doc?.body).toContain("Do not use read/write/edit, bash, node, python, perl, sed, awk, tee, heredocs, shell redirection");
    expect(doc?.fields?.active_tools).toContain("apply_code_replacements");
  });

  test("retrieves runtime eval policy for shell bypass phrasing", () => {
    const hits = retrievePolicy("block node -e and python -c command bypasses", { topK: 3 });
    expect(hits[0].id).toBe("mutation.runtime-eval");
  });

  test("filters by policy kind while preserving relevant ranking", () => {
    const hits = retrievePolicy("missing TypeScript import unresolved symbol", { kind: "codemod", topK: 2 });
    expect(hits.map(hit => hit.document?.kind)).toEqual(["codemod"]);
    expect(hits[0].id).toBe("codemod.add-import");
  });

  test("boosts check recipes by changed path", () => {
    const hits = retrievePolicy("what should I run after editing safety", {
      kind: "check",
      paths: ["extensions/shared/safety-policy.ts"],
      topK: 1,
    });
    expect(hits[0].id).toBe("checks.danger-guard");
    expect(hits[0].document?.fields?.commands).toContain("bun test tests/danger-guard.test.ts");
  });

  test("returns empty list when kind filter excludes all lexical matches", () => {
    expect(retrievePolicy("runtime eval python node", { kind: "recall", topK: 2 })).toEqual([]);
  });

  test("validates policy corpus ids, kinds, bodies, tool names, and check commands", () => {
    expect(validatePolicyCorpus(POLICY_DOCUMENTS, knownToolNames()).errors).toEqual([]);
  });

  test("validator catches duplicate ids, empty bodies, and stale tool references", () => {
    const result = validatePolicyCorpus([
      { ...POLICY_DOCUMENTS[0], id: "dup", body: "" },
      { ...POLICY_DOCUMENTS[1], id: "dup", fields: { active_tools: ["missing_tool"] } },
    ] as any, new Set(["code_search"]));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate policy id: dup"),
      expect.stringContaining("empty body"),
      expect.stringContaining("unknown tool missing_tool"),
    ]));
  });
});
