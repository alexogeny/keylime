import { describe, expect, test } from "bun:test";
import {
  BM25Index,
  JMLMIndex,
  RetrievalIndex,
  TFIDFStore,
  buildRetrievalIndex,
  documentText,
  tokenize,
  type SearchDocument,
} from "../extensions/shared/retrieval";

describe("shared retrieval tokenization", () => {
  test("normalizes prose, paths, punctuation, and camelCase code tokens", () => {
    expect(tokenize("Use extensions/shared/retrieval/bm25.ts for addImportTool now."))
      .toEqual(["extensions", "shared", "retrieval", "bm25", "ts", "add", "import", "tool"]);
  });

  test("honors custom stop words and minimum token length", () => {
    expect(tokenize("AI UI API", { stopWords: new Set(["ui"]), minLength: 1 }))
      .toEqual(["ai", "api"]);
  });

  test("documentText includes metadata fields without losing body", () => {
    const text = documentText({
      id: "x",
      kind: "routing",
      title: "Refactor mode",
      body: "Safe code cleanup",
      fields: { tools: ["code_search", "run_checks"], risk: "low", enabled: true },
      tags: ["coding"],
    });
    expect(text).toContain("routing");
    expect(text).toContain("Refactor mode");
    expect(text).toContain("code_search");
    expect(text).toContain("enabled true");
  });
});

describe("BM25Index", () => {
  test("returns relevant documents in deterministic order", () => {
    const index = new BM25Index();
    index.add("debug", "debug failing test stack trace regression");
    index.add("docs", "write markdown readme documentation");
    index.add("refactor", "refactor code cleanup without behavior changes");
    expect(index.search("cleanup refactor code", 2).map(r => r.id)).toEqual(["refactor"]);
  });

  test("supports remove, replacement by id, empty query, and topK zero", () => {
    const index = new BM25Index();
    index.add("a", "old shell mutation");
    index.add("a", "new safe inspection");
    index.add("b", "shell mutation danger");
    expect(index.size).toBe(2);
    expect(index.search("old", 5)).toEqual([]);
    expect(index.search("shell", 0)).toEqual([]);
    index.remove("b");
    expect(index.search("shell mutation", 5)).toEqual([]);
  });

  test("does not crash on empty documents", () => {
    const index = new BM25Index();
    index.add("empty", "the and or");
    index.add("real", "runtime eval blocked");
    expect(index.search("runtime", 5).map(r => r.id)).toEqual(["real"]);
  });
});

describe("TFIDFStore", () => {
  test("finds cosine matches and constrains candidates", () => {
    const store = new TFIDFStore();
    store.add("intent", "route refactor request to safe code tools");
    store.add("memory", "recall durable user preference");
    expect(store.search("safe refactor tools", 5).map(r => r.id)).toEqual(["intent"]);
    expect(store.search("safe refactor tools", 5, ["memory"])).toEqual([]);
  });

  test("remove updates document frequencies", () => {
    const store = new TFIDFStore();
    store.add("a", "alpha beta");
    store.add("b", "beta gamma");
    store.remove("a");
    expect(store.size).toBe(1);
    expect(store.search("alpha", 5)).toEqual([]);
    expect(store.search("gamma", 5).map(r => r.id)).toEqual(["b"]);
  });
});

describe("JMLMIndex", () => {
  test("scores query likelihood with collection smoothing", () => {
    const index = new JMLMIndex();
    index.add("policy", "runtime eval node python blocked mutation");
    index.add("checks", "bun test targeted verification");
    expect(index.search("python eval mutation", 2)[0]?.id).toBe("policy");
  });

  test("handles removal and unmatched queries", () => {
    const index = new JMLMIndex();
    index.add("a", "agent status observability");
    index.remove("a");
    expect(index.search("agent", 5)).toEqual([]);
    index.add("b", "checkpoint major successful mutation");
    expect(index.search("unrelated", 5)).toEqual([]);
  });
});

describe("RetrievalIndex hybrid search", () => {
  const docs: SearchDocument[] = [
    { id: "routing.refactor", kind: "routing", title: "Refactor", body: "clean up code without changing behavior", tags: ["coding"] },
    { id: "mutation.runtime-eval", kind: "mutation", title: "Runtime eval", body: "node -e python -c deno eval shell bypass blocked", tags: ["safety"] },
    { id: "checks.danger-guard", kind: "check", title: "Danger guard checks", body: "run tests/danger-guard.test.ts after safety policy changes" },
  ];

  test("combines BM25, TF-IDF, JMLM, metadata, and heuristic scores", () => {
    const index = buildRetrievalIndex(docs);
    const results = index.search("safety policy node eval bypass", {
      topK: 2,
      heuristic: doc => doc.kind === "mutation" ? 1 : 0,
    });
    expect(results[0].id).toBe("mutation.runtime-eval");
    expect(results[0].document?.title).toBe("Runtime eval");
    expect(results[0].scores?.heuristic).toBe(1);
  });

  test("updates and removes documents consistently", () => {
    const index = new RetrievalIndex();
    index.add(docs[0]);
    expect(index.search("clean", { topK: 1 })[0]?.id).toBe("routing.refactor");
    index.add({ ...docs[0], body: "write markdown docs" });
    expect(index.search("clean", { topK: 1 })).toEqual([]);
    index.remove("routing.refactor");
    expect(index.size).toBe(0);
  });

  test("returns empty results for empty index, stopword-only query, and zero topK", () => {
    const index = buildRetrievalIndex(docs);
    expect(new RetrievalIndex().search("anything")).toEqual([]);
    expect(index.search("the and or")).toEqual([]);
    expect(index.search("runtime", { topK: 0 })).toEqual([]);
  });

  test("replaces duplicate document ids consistently across all rankers", () => {
    const index = new RetrievalIndex();
    index.add({ id: "same", kind: "routing", title: "Old", body: "alpha beta" });
    index.add({ id: "same", kind: "routing", title: "New", body: "gamma delta" });

    expect(index.size).toBe(1);
    expect(index.search("alpha", { topK: 5 })).toEqual([]);
    expect(index.search("gamma", { topK: 5 })[0]?.document?.title).toBe("New");
  });

  test("searches metadata-only and path-like/code-token documents", () => {
    const index = buildRetrievalIndex([
      { id: "meta", kind: "check", body: "", fields: { paths: ["extensions/shared/safety-policy.ts"], commands: ["bun test tests/safety-policy.test.ts"] } },
      { id: "code", kind: "codemod", body: "handle addImportSymbol and repo-index/index.ts path tokens" },
    ]);

    expect(index.search("safety-policy.ts", { topK: 1 })[0]?.id).toBe("meta");
    expect(index.search("add import symbol", { topK: 1 })[0]?.id).toBe("code");
    expect(index.search("repo index", { topK: 1 })[0]?.id).toBe("code");
  });

  test("handles non-ascii text without crashing and still ranks ascii overlap", () => {
    const index = buildRetrievalIndex([
      { id: "emoji", kind: "context", body: "café résumé naïve 🚀 context" },
      { id: "ascii", kind: "context", body: "plain context routing" },
    ]);

    expect(index.search("context", { topK: 2 }).map(r => r.id)).toContain("ascii");
    expect(index.search("🚀", { topK: 2 })).toEqual([]);
  });
  test("replaces document ids without growing the index", () => {
    const index = new BM25Index();
    index.add("same", "alpha original");
    index.add("same", "beta replacement");
    expect(index.size).toBe(1);
    expect(index.search("alpha")).toEqual([]);
    expect(index.search("beta")[0]?.id).toBe("same");
  });
  test("applies filters before candidate truncation", () => {
    const index = new RetrievalIndex();
    for (let i = 0; i < 20; i++) index.add({ id: `excluded-${i}`, kind: "excluded", body: "alpha alpha alpha" });
    index.add({ id: "allowed", kind: "allowed", body: "alpha" });
    const results = index.search("alpha", { topK: 1, candidateMultiplier: 1, filter: doc => doc.kind === "allowed" });
    expect(results.map(result => result.id)).toEqual(["allowed"]);
  });
});
