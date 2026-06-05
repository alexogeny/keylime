/**
 * Search Memory Extension
 *
 * BM25-ranked search over the web-search knowledge base built by
 * the web-search extension.  No external dependencies — BM25 runs
 * entirely in-process.
 *
 * Optionally uses Ollama embeddings for reranking if a small
 * embedding model is available (e.g. `ollama pull nomic-embed-text`).
 * Falls back gracefully to pure BM25 when Ollama is unavailable.
 *
 * Tools registered:
 *   recall_web_knowledge  — BM25 search over indexed knowledge base
 *   list_search_history   — browse past searches with filters
 *   get_search_entry      — fetch full detail for a specific search_id
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readJsonDir, readJsonFile } from "./shared/json-store";
import { join } from "node:path";
import { homedir } from "node:os";
import { BM25Index } from "./shared/retrieval";
import { createOllamaEmbedder } from "./shared/ollama-embeddings";
import { cosineSimilarity } from "./shared/similarity";
import { ageString } from "./shared/time-format";

// ─── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR     = process.env.KEYLIME_WEB_SEARCH_DATA_DIR ?? join(homedir(), ".pi", "data", "web-search");
const SEARCHES_DIR = join(DATA_DIR, "searches");
const INDEX_FILE   = join(DATA_DIR, "index.json");

// ─── Types ─────────────────────────────────────────────────────────────────────

interface RawResult {
  title:    string;
  url:      string;
  snippet:  string;
  position?: number;
}

interface SearchEntry {
  id:        string;
  query:     string;
  provider:  string;
  timestamp: number;
  raw: {
    results:        RawResult[];
    answerBox?:     string;
    knowledgeGraph?: Record<string, string>;
  };
  distilled?: {
    summary:    string;
    keyFacts:   string[];
    tags:       string[];
    categories: string[];
    sources:    Array<{ title: string; url: string; relevance: string }>;
  };
}

interface IndexEntry {
  id:         string;
  query:      string;
  timestamp:  number;
  tags:       string[];
  categories: string[];
  summary?:   string;
  provider:   string;
}

interface SearchIndex {
  version: 1;
  entries: IndexEntry[];
}

// ─── Shared lexical retrieval ────────────────────────────────────────────────

// ─── Ollama embedding helpers (optional reranking) ──────────────────────────

const EMBED_MODEL = process.env.SEARCH_EMBED_MODEL ?? "nomic-embed-text";
const ollama = createOllamaEmbedder({ model: EMBED_MODEL, tagsTimeoutMs: 1500, embedTimeoutMs: 10000 });

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function loadIndex(): Promise<SearchIndex> {
  return readJsonFile(INDEX_FILE, { version: 1, entries: [] });
}

async function loadAllEntries(): Promise<SearchEntry[]> {
  return readJsonDir<SearchEntry>(SEARCHES_DIR);
}

async function loadEntry(id: string): Promise<SearchEntry | null> {
  return readJsonFile<SearchEntry | null>(join(SEARCHES_DIR, `${id}.json`), null);
}

// ─── Document text for indexing ───────────────────────────────────────────────

function buildDocText(entry: SearchEntry): string {
  const parts: string[] = [entry.query];
  if (entry.distilled?.summary)                         parts.push(entry.distilled.summary);
  if (entry.distilled?.keyFacts?.length)                parts.push(...entry.distilled.keyFacts);
  if (entry.distilled?.tags?.length)                    parts.push(entry.distilled.tags.join(" "));
  if (entry.distilled?.categories?.length)              parts.push(entry.distilled.categories.join(" "));
  for (const s of entry.distilled?.sources ?? [])       parts.push(s.title);
  for (const r of entry.raw.results.slice(0, 6))        parts.push(r.title, r.snippet);
  if (entry.raw.answerBox)                              parts.push(entry.raw.answerBox);
  return parts.join(" ");
}

let recallIndexCache: { key: string; index: BM25Index } | null = null;

function recallPoolKey(pool: SearchEntry[]): string {
  return pool.map(entry => `${entry.id}:${entry.timestamp}`).sort().join("|");
}

function recallIndexFor(pool: SearchEntry[]): { index: BM25Index; cacheHit: boolean } {
  const key = recallPoolKey(pool);
  if (recallIndexCache?.key === key) return { index: recallIndexCache.index, cacheHit: true };
  const index = new BM25Index();
  for (const entry of pool) index.add(entry.id, buildDocText(entry));
  recallIndexCache = { key, index };
  return { index, cacheHit: false };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function searchMemoryExtension(pi: ExtensionAPI) {

  // ── Tool: recall_web_knowledge ──────────────────────────────────────────────
  pi.registerTool({
    name:        "recall_web_knowledge",
    label:       "Recall Web Knowledge",
    description: "Search saved web-research knowledge.",
    promptSnippet: "Recall past web research",
    promptGuidelines: ["Use before web_search when research is active."],
    parameters: Type.Object({
      query:        Type.String({ description: "Query" }),
      top_k:        Type.Optional(Type.Number({ description: "Result count", minimum: 1, maximum: 20 })),
      tags:         Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      categories:   Type.Optional(Type.Array(Type.String(), { description: "Categories" })),
      max_age_days: Type.Optional(Type.Number({ description: "Max age days" })),
      only_distilled: Type.Optional(Type.Boolean({ description: "Require distilled entries" })),
    }),

    async execute(_id, params, _signal) {
      const all = await loadAllEntries();
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "Knowledge base is empty — use web_search + save_search_knowledge to build it up." }],
          details: { count: 0, results: [] },
        };
      }

      // Filters
      const onlyDistilled = params.only_distilled ?? true;
      let pool = onlyDistilled ? all.filter(e => e.distilled) : all;

      if (params.tags?.length) {
        const req = new Set(params.tags.map(t => t.toLowerCase()));
        pool = pool.filter(e => e.distilled?.tags.some(t => req.has(t)));
      }
      if (params.categories?.length) {
        const req = new Set(params.categories.map(c => c.toLowerCase()));
        pool = pool.filter(e => e.distilled?.categories.some(c => req.has(c)));
      }
      if (params.max_age_days != null) {
        const cutoff = Date.now() - params.max_age_days * 86_400_000;
        pool = pool.filter(e => e.timestamp >= cutoff);
      }

      if (pool.length === 0) {
        return {
          content: [{ type: "text", text: "No matching entries found with the given filters." }],
          details: { count: 0, results: [] },
        };
      }

      // BM25 index, cached by filtered entry ids/timestamps to avoid rebuilding on repeated recalls.
      const { index: bm25, cacheHit: indexCacheHit } = recallIndexFor(pool);
      const hits = bm25.search(params.query, params.top_k ?? 5);

      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `No relevant past research found for: "${params.query}"\nTry web_search for fresh results.` }],
          details: { count: 0, results: [] },
        };
      }

      // Optional Ollama reranking
      const useOllama = await ollama.check();
      let ranked = hits;
      if (useOllama) {
        const qEmbed = await ollama.embed(params.query);
        if (qEmbed) {
          const poolMap = new Map(pool.map(e => [e.id, e]));
          const reranked: Array<{ id: string; score: number }> = [];
          for (const h of hits) {
            const e = poolMap.get(h.id)!;
            const dEmbed = await ollama.embed(buildDocText(e));
            if (dEmbed) {
              const semScore = cosineSimilarity(qEmbed, dEmbed);
              reranked.push({ id: h.id, score: 0.4 * h.score + 0.6 * semScore * 10 });
            } else {
              reranked.push(h);
            }
          }
          ranked = reranked.sort((a, b) => b.score - a.score);
        }
      }

      const entryMap = new Map(pool.map(e => [e.id, e]));
      const lines:   string[] = [
        `Found ${ranked.length} relevant past searches for "${params.query}"`,
        useOllama ? `(Ollama-reranked with ${EMBED_MODEL})` : "(BM25 ranked)",
        ``,
      ];

      for (const { id, score } of ranked) {
        const e = entryMap.get(id)!;
        lines.push(
          `## "${e.query}"  [${ageString(e.timestamp)} · score ${score.toFixed(2)} · ${e.provider}]`,
          `search_id: ${e.id}`,
        );
        if (e.distilled?.tags?.length)       lines.push(`tags:       ${e.distilled.tags.join(", ")}`);
        if (e.distilled?.categories?.length) lines.push(`categories: ${e.distilled.categories.join(", ")}`);
        if (e.distilled?.summary)            lines.push(``, `Summary: ${e.distilled.summary}`);
        if (e.distilled?.keyFacts?.length) {
          lines.push(``, `Key facts:`);
          e.distilled.keyFacts.forEach(f => lines.push(`  • ${f}`));
        }
        if (e.distilled?.sources?.length) {
          const hi = e.distilled.sources.filter(s => s.relevance === "high").slice(0, 3);
          if (hi.length) {
            lines.push(``, `Top sources:`);
            hi.forEach(s => lines.push(`  [high] ${s.title}`, `         ${s.url}`));
          }
        }
        lines.push(``);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count:       ranked.length,
          reranked:    useOllama,
          indexCacheHit,
          indexDocuments: pool.length,
          results:     ranked.map(h => ({ id: h.id, score: h.score, query: entryMap.get(h.id)?.query })),
        },
      };
    },
  });

  // ── Tool: list_search_history ───────────────────────────────────────────────
  pi.registerTool({
    name:        "list_search_history",
    label:       "List Search History",
    description: "List saved web searches.",
    promptSnippet: "List web-search history",
    parameters: Type.Object({
      limit:         Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 100 })),
      tag:           Type.Optional(Type.String({ description: "Tag" })),
      category:      Type.Optional(Type.String({ description: "Category" })),
      only_distilled: Type.Optional(Type.Boolean({ description: "Only distilled" })),
    }),

    async execute(_id, params, _signal) {
      const index = await loadIndex();
      let entries = [...index.entries].sort((a, b) => b.timestamp - a.timestamp);

      if (params.tag)           entries = entries.filter(e => e.tags.includes(params.tag!.toLowerCase()));
      if (params.category)      entries = entries.filter(e => e.categories.includes(params.category!.toLowerCase()));
      if (params.only_distilled) entries = entries.filter(e => !!e.summary);

      const totalBeforeSlice = entries.length;
      entries = entries.slice(0, params.limit ?? 20);

      if (totalBeforeSlice === 0) {
        return {
          content: [{ type: "text", text: "No searches in history yet." }],
          details: { count: 0, total: index.entries.length },
        };
      }

      // Aggregate all known tags & categories for discoverability
      const allTags  = new Set<string>();
      const allCats  = new Set<string>();
      index.entries.forEach(e => { e.tags.forEach(t => allTags.add(t)); e.categories.forEach(c => allCats.add(c)); });

      const withKnowledge = index.entries.filter(e => !!e.summary).length;

      const lines: string[] = [
        `Search History — ${totalBeforeSlice} matches (${index.entries.length} total, ${withKnowledge} with knowledge)`,
        `All tags:       ${[...allTags].sort().join(", ") || "none yet"}`,
        `All categories: ${[...allCats].sort().join(", ") || "none yet"}`,
        ``,
      ];

      for (const e of entries) {
        const status = e.summary ? "✓ distilled" : "⊘ raw only";
        lines.push(`[${ageString(e.timestamp)}] ${status}  "${e.query}"  (${e.provider})`);
        if (e.tags.length)       lines.push(`  tags:       ${e.tags.join(", ")}`);
        if (e.categories.length) lines.push(`  categories: ${e.categories.join(", ")}`);
        if (e.summary)           lines.push(`  summary:    ${e.summary.slice(0, 140)}${e.summary.length > 140 ? "…" : ""}`);
        lines.push(`  search_id:  ${e.id}`, ``);
      }

      if (totalBeforeSlice > entries.length) {
        lines.push(`… and ${totalBeforeSlice - entries.length} more (increase limit to see them)`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: entries.length, total: index.entries.length, withKnowledge },
      };
    },
  });

  // ── Tool: get_search_entry ──────────────────────────────────────────────────
  pi.registerTool({
    name:        "get_search_entry",
    label:       "Get Search Entry",
    description: "Get a saved search by id.",
    promptSnippet: "Get web-search entry",
    parameters: Type.Object({
      search_id:   Type.String({ description: "Search id" }),
      include_raw: Type.Optional(Type.Boolean({ description: "Include raw results" })),
    }),

    async execute(_id, params, _signal) {
      const entry = await loadEntry(params.search_id);
      if (!entry) throw new Error(`search_id not found: ${params.search_id}`);

      const lines: string[] = [
        `search_id: ${entry.id}`,
        `query:     "${entry.query}"`,
        `provider:  ${entry.provider}`,
        `date:      ${new Date(entry.timestamp).toISOString().slice(0, 19).replace("T", " ")} (${ageString(entry.timestamp)})`,
        ``,
      ];

      if (entry.distilled) {
        const d = entry.distilled;
        lines.push(`## Distilled Knowledge`);
        lines.push(``, `Summary: ${d.summary}`, ``);
        if (d.keyFacts.length) {
          lines.push(`Key facts:`);
          d.keyFacts.forEach(f => lines.push(`  • ${f}`));
          lines.push(``);
        }
        lines.push(`tags:       ${d.tags.join(", ")}`);
        lines.push(`categories: ${d.categories.join(", ")}`, ``);
        if (d.sources.length) {
          lines.push(`Sources:`);
          d.sources.forEach(s => lines.push(`  [${s.relevance}] ${s.title}`, `            ${s.url}`));
          lines.push(``);
        }
      } else {
        lines.push(`⚠ No distilled knowledge yet — call save_search_knowledge to add it.`, ``);
      }

      if (params.include_raw) {
        lines.push(`## Raw Results (${entry.raw.results.length})`);
        if (entry.raw.answerBox) lines.push(`Answer Box: ${entry.raw.answerBox}`, ``);
        for (const r of entry.raw.results) {
          lines.push(`${r.position ?? "•"}) ${r.title}`, `   ${r.url}`, `   ${r.snippet}`, ``);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { entry },
      };
    },
  });

  // Session status disabled (noise reduction)
}
