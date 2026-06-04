import { describe, expect, test } from "bun:test";
import { POLICY_DOCUMENTS, retrievePolicy } from "../extensions/shared/policy-corpus";

describe("policy corpus retrieval", () => {
  test("has unique, typed seed documents for routing, mutation, codemod, checks, context, and recall", () => {
    const ids = new Set(POLICY_DOCUMENTS.map(doc => doc.id));
    expect(ids.size).toBe(POLICY_DOCUMENTS.length);
    expect(new Set(POLICY_DOCUMENTS.map(doc => doc.kind))).toEqual(new Set(["routing", "mutation", "codemod", "check", "context", "recall"]));
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
});
