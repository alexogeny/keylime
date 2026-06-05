import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("search memory recall", () => {
  test("recall_web_knowledge ranks persisted distilled entries with shared BM25 retrieval", async () => {
    const home = await mkdtemp(join(tmpdir(), "search-memory-home-"));
    const oldDataDir = process.env.KEYLIME_WEB_SEARCH_DATA_DIR;
    const dataDir = join(home, ".pi", "data", "web-search");
    process.env.KEYLIME_WEB_SEARCH_DATA_DIR = dataDir;
    const searchesDir = join(dataDir, "searches");
    await mkdir(searchesDir, { recursive: true });

    const recent = Date.now();
    await writeFile(join(searchesDir, "safety.json"), JSON.stringify({
      id: "safety",
      query: "mutation testing safety policy",
      provider: "fixture",
      timestamp: recent,
      raw: { results: [{ title: "Mutation testing", url: "https://example.test/mutation", snippet: "Mutation testing checks whether tests catch changed code." }] },
      distilled: {
        summary: "Mutation testing finds weak assertions beyond line coverage.",
        keyFacts: ["Mutation score measures whether tests detect injected faults."],
        tags: ["testing", "safety"],
        categories: ["research"],
        sources: [{ title: "Mutation testing", url: "https://example.test/mutation", relevance: "high" }],
      },
    }), "utf8");
    await writeFile(join(searchesDir, "shoes.json"), JSON.stringify({
      id: "shoes",
      query: "running shoe foam",
      provider: "fixture",
      timestamp: recent,
      raw: { results: [{ title: "Foam", url: "https://example.test/shoes", snippet: "Running shoe midsole foam." }] },
      distilled: {
        summary: "Shoe foam comparison.",
        keyFacts: ["PEBA is light."],
        tags: ["running"],
        categories: ["shoes"],
        sources: [],
      },
    }), "utf8");

    try {
      const mod = await import(`../extensions/search-memory.ts?test=${Date.now()}`);
      const tools: Record<string, any> = {};
      mod.default({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);

      const result = await tools.recall_web_knowledge.execute("id", {
        query: "weak assertions mutation coverage",
        top_k: 1,
        tags: ["testing"],
      });

      expect(result.details.count).toBe(1);
      expect(result.details.results[0].id).toBe("safety");
      expect(result.details.indexCacheHit).toBe(false);
      expect(result.content[0].text).toContain("Mutation testing finds weak assertions");
      expect(result.content[0].text).toContain("search_id: safety");

      const cached = await tools.recall_web_knowledge.execute("id", {
        query: "weak assertions mutation coverage",
        top_k: 1,
        tags: ["testing"],
      });
      expect(cached.details.results[0].id).toBe("safety");
      expect(cached.details.indexCacheHit).toBe(true);
    } finally {
      if (oldDataDir === undefined) delete process.env.KEYLIME_WEB_SEARCH_DATA_DIR;
      else process.env.KEYLIME_WEB_SEARCH_DATA_DIR = oldDataDir;
    }
  });
});
