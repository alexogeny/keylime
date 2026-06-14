/**
 * Web Search Extension
 *
 * Searches the web and persists raw + LLM-distilled results to
 * ~/.pi/data/web-search/ so they can be recalled later.
 *
 * Set ONE of these env vars (pick a free-tier provider):
 *   SERPER_API_KEY  — serper.dev      (2 500 free queries/month)
 *   TAVILY_API_KEY  — tavily.com      (1 000 free queries/month, LLM-optimised)
 *   BING_API_KEY    — Azure Bing      (1 000 free queries/month)
 *
 * Tools registered:
 *   web_search             — perform a live web search, save raw results
 *   save_search_knowledge  — persist LLM-distilled summary, facts, tags, categories
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { stringEnum } from "./shared/schema";
import {
  ensureWebSearchDirs,
  loadSearchConfig,
  loadSearchEntry,
  loadSearchIndex,
  saveSearchEntry,
  saveSearchIndex,
} from "./shared/web-search-store";
import type { SearchEntry } from "./shared/web-search-types";

// ─── Config (env vars with fallback to config.json) ──────────────────────────

let _config: Record<string, string> | null = null;

async function getKey(name: string): Promise<string | undefined> {
  if (process.env[name]) return process.env[name];
  _config ??= await loadSearchConfig();
  return _config[name];
}

// ─── Search providers ─────────────────────────────────────────────────────────

async function searchSerper(
  query: string,
  num: number,
  signal: AbortSignal,
  key: string,
): Promise<SearchEntry["raw"]> {
  const res = await fetch("https://google.serper.dev/search", {
    method:  "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body:    JSON.stringify({ q: query, num }),
    signal,
  });
  if (!res.ok) throw new Error(`Serper ${res.status}: ${await res.text()}`);
  const d = await res.json() as any;
  return {
    results: (d.organic ?? []).map((r: any, i: number) => ({
      title: r.title ?? "", url: r.link ?? "", snippet: r.snippet ?? "", position: i + 1,
    })),
    answerBox: d.answerBox?.answer ?? d.answerBox?.snippet,
    knowledgeGraph: d.knowledgeGraph
      ? { title: d.knowledgeGraph.title ?? "", description: d.knowledgeGraph.description ?? "" }
      : undefined,
  };
}

async function searchTavily(
  query: string,
  num: number,
  signal: AbortSignal,
  key: string,
): Promise<SearchEntry["raw"]> {
  const res = await fetch("https://api.tavily.com/search", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      api_key: key,
      query, max_results: num, search_depth: "basic", include_answer: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const d = await res.json() as any;
  return {
    results: (d.results ?? []).map((r: any, i: number) => ({
      title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "", position: i + 1,
    })),
    answerBox: d.answer,
  };
}

async function searchBing(
  query: string,
  num: number,
  signal: AbortSignal,
  key: string,
): Promise<SearchEntry["raw"]> {
  const params = new URLSearchParams({ q: query, count: String(num) });
  const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
    headers: { "Ocp-Apim-Subscription-Key": key },
    signal,
  });
  if (!res.ok) throw new Error(`Bing ${res.status}: ${await res.text()}`);
  const d = await res.json() as any;
  return {
    results: (d.webPages?.value ?? []).map((r: any, i: number) => ({
      title: r.name ?? "", url: r.url ?? "", snippet: r.snippet ?? "", position: i + 1,
    })),
  };
}

async function detectProvider(): Promise<{ provider: "serper" | "tavily" | "bing"; key: string } | null> {
  for (const [name, provider] of [
    ["SERPER_API_KEY", "serper"],
    ["TAVILY_API_KEY", "tavily"],
    ["BING_API_KEY",   "bing"],
  ] as const) {
    const key = await getKey(name);
    if (key) return { provider, key };
  }
  return null;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {

  // ── Tool: web_search ────────────────────────────────────────────────────────
  pi.registerTool({
    name:        "web_search",
    label:       "Web Search",
    description: "Live web search; returns results plus a search_id.",
    promptSnippet: "Search the web",
    promptGuidelines: ["Use only for current or external information."],
    parameters: Type.Object({
      query:       Type.String({ description: "Search query" }),
      num_results: Type.Optional(Type.Number({
        description: "Result count",
        minimum: 1, maximum: 20,
      })),
      summarize: Type.Optional(Type.Boolean({
        description: "Fetch top result pages and append deterministic summaries when fetch extension is active",
      })),
    }),

    async execute(_id, params, signal, onUpdate) {
      const found = await detectProvider();
      if (!found) {
        throw new Error(
          "No search API key found. Set one of: " +
          "SERPER_API_KEY (serper.dev, 2500 free/mo), " +
          "TAVILY_API_KEY (tavily.com, 1000 free/mo), " +
          "BING_API_KEY (Azure Bing, 1000 free/mo). " +
          `Or add a key to ${CONFIG_FILE}`
        );
      }
      const { provider, key } = found;

      await ensureWebSearchDirs();
      const num = Math.min(params.num_results ?? 8, 20);

      onUpdate?.({ content: [{ type: "text", text: `Searching "${params.query}" via ${provider}…` }] });

      let raw: SearchEntry["raw"];
      switch (provider) {
        case "serper": raw = await searchSerper(params.query, num, signal, key); break;
        case "tavily": raw = await searchTavily(params.query, num, signal, key); break;
        case "bing":   raw = await searchBing(params.query, num, signal, key);   break;
      }

      const entry: SearchEntry = {
        id:        randomUUID(),
        query:     params.query,
        provider,
        timestamp: Date.now(),
        raw,
      };

      await saveSearchEntry(entry);

      // Stub in the index (will be enriched by save_search_knowledge)
      const index = await loadSearchIndex();
      index.entries.push({
        id:         entry.id,
        query:      entry.query,
        timestamp:  entry.timestamp,
        tags:       [],
        categories: [],
        provider,
      });
      await saveSearchIndex(index);

      // Format for LLM
      const lines: string[] = [
        `search_id: ${entry.id}`,
        `query:     "${params.query}"`,
        `provider:  ${provider}`,
        `results:   ${raw.results.length}`,
        ``,
      ];

      if (raw.answerBox) {
        lines.push(`⬡ Answer Box: ${raw.answerBox}`, ``);
      }
      if (raw.knowledgeGraph?.title) {
        lines.push(`⬡ Knowledge Graph: ${raw.knowledgeGraph.title}`, raw.knowledgeGraph.description ?? "", ``);
      }

      for (const r of raw.results) {
        lines.push(
          `${r.position ?? "•"}) ${r.title}`,
          `   ${r.url}`,
          `   ${r.snippet}`,
          ``,
        );
      }

      lines.push(
        `───`,
        `Review the results above, then call:`,
        `  save_search_knowledge(search_id="${entry.id}", summary=..., key_facts=[...], tags=[...], categories=[...], sources=[...])`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details:  { searchId: entry.id, query: params.query, provider, resultCount: raw.results.length, summarize: params.summarize === true },
      };
    },
  });

  // ── Tool: save_search_knowledge ─────────────────────────────────────────────
  pi.registerTool({
    name:        "save_search_knowledge",
    label:       "Save Search Knowledge",
    description: "Save distilled knowledge from a web_search result.",
    promptSnippet: "Save web-search knowledge",
    parameters: Type.Object({
      search_id:  Type.String({ description: "web_search id" }),
      summary:    Type.String({ description: "Summary" }),
      key_facts:  Type.Array(Type.String(), { description: "Key facts" }),
      tags:       Type.Array(Type.String(), { description: "Lowercase topic tags, e.g. [\"llm\", \"python\", \"openai\"]" }),
      categories: Type.Array(Type.String(), {
        description: "Content categories, e.g. [\"technology\", \"news\", \"tutorial\", \"research\", \"product\", \"science\"]",
      }),
      sources: Type.Array(
        Type.Object({
          title:     Type.String({ description: "Title" }),
          url:       Type.String({ description: "URL" }),
          relevance: stringEnum(["high", "medium", "low"] as const),
        }),
        { description: "Sources" }
      ),
    }),

    async execute(_id, params, _signal) {
      await ensureWebSearchDirs();

      const entry = await loadSearchEntry(params.search_id);
      if (!entry) throw new Error(`search_id not found: ${params.search_id}. Was it created in this session?`);

      entry.distilled = {
        summary:    params.summary,
        keyFacts:   params.key_facts,
        tags:       params.tags.map(t => t.toLowerCase()),
        categories: params.categories.map(c => c.toLowerCase()),
        sources:    params.sources,
      };

      await saveSearchEntry(entry);

      // Update master index
      const index = await loadSearchIndex();
      const idx   = index.entries.findIndex(e => e.id === params.search_id);
      if (idx >= 0) {
        index.entries[idx] = {
          ...index.entries[idx],
          tags:       entry.distilled.tags,
          categories: entry.distilled.categories,
          summary:    params.summary,
        };
        await saveSearchIndex(index);
      }

      return {
        content: [{
          type: "text",
          text: [
            `✓ Knowledge saved for: "${entry.query}"`,
            `  tags:       ${entry.distilled.tags.join(", ")}`,
            `  categories: ${entry.distilled.categories.join(", ")}`,
            `  key facts:  ${params.key_facts.length}`,
            `  sources:    ${params.sources.length} (${params.sources.filter(s => s.relevance === "high").length} high-relevance)`,
          ].join("\n"),
        }],
        details: {
          searchId:   params.search_id,
          query:      entry.query,
          tags:       entry.distilled.tags,
          categories: entry.distilled.categories,
        },
      };
    },
  });

  // Session status disabled (noise reduction)
}
