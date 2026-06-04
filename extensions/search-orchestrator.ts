/**
 * Search Orchestrator Extension
 *
 * Ties together web-search and search-memory into a coherent
 * research workflow.  Injects a research protocol into every
 * conversation, exposes a /research slash-command, and provides
 * a research_topic meta-tool that gives the LLM a step-by-step
 * plan for thorough, multi-source research with knowledge persistence.
 *
 * Depends on (but does not hard-require):
 *   web-search.ts      → web_search, save_search_knowledge
 *   search-memory.ts   → recall_web_knowledge, list_search_history
 *
 * Commands:
 *   /research <topic>   — kick off a focused research session
 *   /search-stats       — print knowledge-base statistics
 *   /forget-search <id> — remove a specific search from the index (not the file)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isCapabilityActive } from "./shared/intent";
import { registerContextProvider } from "./shared/turn-context";

// ─── Paths ─────────────────────────────────────────────────────────────────────

function stringEnum<const T extends readonly string[]>(values: T, options?: Record<string, unknown>) {
  return Type.Union(values.map(value => Type.Literal(value)), options);
}

const DATA_DIR     = join(homedir(), ".pi", "data", "web-search");
const SEARCHES_DIR = join(DATA_DIR, "searches");
const INDEX_FILE   = join(DATA_DIR, "index.json");

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getStats(): Promise<{
  total:       number;
  withKnowledge: number;
  allTags:     string[];
  allCategories: string[];
  newestQuery?: string;
  newestAge?:  string;
}> {
  if (!existsSync(INDEX_FILE)) return { total: 0, withKnowledge: 0, allTags: [], allCategories: [] };
  try {
    const index = JSON.parse(await readFile(INDEX_FILE, "utf8")) as {
      entries: Array<{ id: string; query: string; timestamp: number; tags: string[]; categories: string[]; summary?: string }>;
    };
    const allTags      = new Set<string>();
    const allCats      = new Set<string>();
    let withKnowledge  = 0;
    let newestTs       = 0;
    let newestQuery    = "";

    for (const e of index.entries) {
      if (e.summary) withKnowledge++;
      e.tags.forEach(t => allTags.add(t));
      e.categories.forEach(c => allCats.add(c));
      if (e.timestamp > newestTs) { newestTs = e.timestamp; newestQuery = e.query; }
    }

    const daysOld = Math.floor((Date.now() - newestTs) / 86_400_000);
    const newestAge = newestTs === 0 ? undefined :
      daysOld === 0 ? "today" : daysOld === 1 ? "yesterday" : `${daysOld}d ago`;

    return {
      total:          index.entries.length,
      withKnowledge,
      allTags:        [...allTags].sort(),
      allCategories:  [...allCats].sort(),
      newestQuery:    newestQuery || undefined,
      newestAge,
    };
  } catch {
    return { total: 0, withKnowledge: 0, allTags: [], allCategories: [] };
  }
}

function hasTools(pi: ExtensionAPI, ...names: string[]): boolean {
  const active = new Set(pi.getActiveTools().map(t => t.name));
  return names.every(n => active.has(n));
}

function researchProviderAvailable(): boolean {
  if (process.env.KEYLIME_DISABLE_RESEARCH === "1") return false;
  if (process.env.KEYLIME_ENABLE_RESEARCH === "1") return true;
  return Boolean(process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY || process.env.BING_API_KEY);
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function searchOrchestratorExtension(pi: ExtensionAPI) {

  // ── System-prompt injection (STATIC only — no volatile KB stats here) ────────
  //
  // CACHE NOTE: the KB stats line ("48 searches, 31 distilled...") changes every
  // time save_search_knowledge is called. Including it in the system prompt
  // invalidated the KV cache on every research turn.
  //
  // Static content (tools list + protocol) stays here — it never changes.
  // Volatile KB stats are injected via the `context` event as a system-reminder.

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!isCapabilityActive("research") || !researchProviderAvailable()) return;
    const hasSearch = hasTools(pi, "web_search");
    const hasMemory = hasTools(pi, "recall_web_knowledge");
    if (!hasSearch && !hasMemory) return;

    const toolList = [
      hasMemory ? "• recall_web_knowledge — check past research before searching" : null,
      hasSearch ? "• web_search — live search (Serper/Tavily/Bing)" : null,
      hasSearch ? "• save_search_knowledge — persist distilled insights after each search" : null,
      hasTools(pi, "research_topic") ? "• research_topic — orchestrated multi-step research" : null,
    ].filter(Boolean).join("\n");

    const appendix = [
      `\n\n## Research Capabilities`,
      `Available research tools:`,
      toolList,
      ``,
      `Standard research protocol:`,
      `1. Call recall_web_knowledge first — avoid duplicate searches`,
      `2. Call web_search for fresh/current information`,
      `3. After reviewing results, call save_search_knowledge with summary, key_facts, tags, and categories`,
      `4. Synthesise across sources before answering`,
    ].join("\n");

    return { systemPrompt: event.systemPrompt + appendix };
  });

  // ── Context provider: volatile KB stats ─────────────────────────────────────
  // Routed through turn-context-composer so research stats only appear when
  // research intent is active and provider config exists.

  registerContextProvider({
    id: "search-orchestrator",
    priority: 50,
    maxChars: 220,
    applies: () => isCapabilityActive("research") && researchProviderAvailable(),
    build: async () => {
      const hasSearch = hasTools(pi, "web_search");
      const hasMemory = hasTools(pi, "recall_web_knowledge");
      if (!hasSearch && !hasMemory) return null;

      const stats = await getStats();
      return stats.total > 0
        ? `Knowledge base: ${stats.total} searches (${stats.withKnowledge} distilled).` +
          (stats.newestQuery ? ` Most recent: "${stats.newestQuery}" (${stats.newestAge}).` : "")
        : "Knowledge base is empty — searches will be indexed as you research.";
    },
  });

  // ── /research command ────────────────────────────────────────────────────────
  pi.registerCommand("research", {
    description: "Start a focused web research session: /research <topic>",
    handler: async (args, ctx) => {
      const topic = args?.trim();
      if (!topic) { ctx.ui.notify("Usage: /research <topic>", "warning"); return; }

      ctx.ui.notify(`Researching: "${topic}"`, "info");
      pi.sendUserMessage(
        [
          `Please research the following topic thoroughly and give me a comprehensive, current answer.`,
          ``,
          `**Topic: ${topic}**`,
          ``,
          `Research protocol:`,
          `1. Check recall_web_knowledge for any existing knowledge on this topic`,
          `2. Use web_search with 2–3 targeted queries covering different angles`,
          `3. After each search, call save_search_knowledge (summary, key_facts, tags, categories, sources)`,
          `4. Synthesise everything into a well-structured answer`,
          `5. Clearly cite your sources and flag any information that may change quickly`,
        ].join("\n"),
        { deliverAs: "followUp" },
      );
    },
  });

  // ── /search-stats command ────────────────────────────────────────────────────
  pi.registerCommand("search-stats", {
    description: "Show web-search knowledge base statistics",
    handler: async (_args, ctx) => {
      const stats = await getStats();
      if (stats.total === 0) {
        ctx.ui.notify("Knowledge base is empty — use /research <topic> to start", "info");
        return;
      }
      const lines = [
        `Web Search Knowledge Base`,
        `  Searches:   ${stats.total} total, ${stats.withKnowledge} with distilled knowledge`,
        stats.newestQuery ? `  Most recent: "${stats.newestQuery}" (${stats.newestAge})` : "",
        stats.allTags.length     ? `  All tags:       ${stats.allTags.join(", ")}` : "",
        stats.allCategories.length ? `  All categories: ${stats.allCategories.join(", ")}` : "",
        `  Data dir:   ${DATA_DIR}`,
      ].filter(Boolean).join("\n");
      ctx.ui.notify(lines, "info");
    },
  });

  // ── /forget-search command ───────────────────────────────────────────────────
  pi.registerCommand("forget-search", {
    description: "Remove a search entry from the index by search_id: /forget-search <id>",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) { ctx.ui.notify("Usage: /forget-search <search_id>", "warning"); return; }
      if (!existsSync(INDEX_FILE)) { ctx.ui.notify("Index file not found", "error"); return; }
      try {
        const index  = JSON.parse(await readFile(INDEX_FILE, "utf8")) as { version: 1; entries: Array<{ id: string }> };
        const before = index.entries.length;
        index.entries = index.entries.filter(e => e.id !== id);
        if (index.entries.length === before) {
          ctx.ui.notify(`search_id not found in index: ${id}`, "warning");
          return;
        }
        await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
        ctx.ui.notify(`Removed from index: ${id}`, "info");
      } catch (e: any) {
        ctx.ui.notify(`Error: ${e.message}`, "error");
      }
    },
  });

  // ── research_topic meta-tool ─────────────────────────────────────────────────
  pi.registerTool({
    name:        "research_topic",
    label:       "Research Topic",
    description: [
      "Orchestrated research pipeline: checks the knowledge base first, then plans",
      "targeted web searches, and instructs the LLM to distill and persist results.",
      "Use this for thorough, multi-source research where comprehensiveness matters.",
    ].join(" "),
    promptSnippet: "Fully orchestrated research combining memory recall and live web search",
    promptGuidelines: [
      "Use research_topic when the user asks for thorough or comprehensive research on a topic.",
      "research_topic generates a step-by-step plan; follow it by calling recall_web_knowledge, web_search, and save_search_knowledge in sequence.",
    ],
    parameters: Type.Object({
      topic: Type.String({ description: "The topic or question to research thoroughly" }),
      depth: Type.Optional(stringEnum(["quick", "standard", "deep"] as const, {
        description: "quick = 1 search; standard = 2–3 searches (default); deep = 4+ searches with follow-ups",
      })),
      recency_required: Type.Optional(Type.Boolean({
        description: "If true, skip the memory-recall step and go straight to fresh searches (default false)",
      })),
      focus_tags: Type.Optional(Type.Array(Type.String(), {
        description: "Optional tags to guide query angles, e.g. [\"security\", \"performance\"]",
      })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const depth   = params.depth ?? "standard";
      const numSearches = depth === "quick" ? 1 : depth === "standard" ? 3 : 5;
      const recency = params.recency_required ?? false;
      const focus   = params.focus_tags ?? [];

      onUpdate?.({ content: [{ type: "text", text: `Planning ${depth} research on "${params.topic}"…` }] });

      const stats      = await getStats();
      const hasMemory  = hasTools(pi, "recall_web_knowledge");
      const hasSearch  = hasTools(pi, "web_search");

      // Build query angle suggestions
      const angleExamples = depth === "quick"
        ? [`"${params.topic}" overview`]
        : depth === "standard"
        ? [
            `"${params.topic}" ${new Date().getFullYear()}`,
            `"${params.topic}" how it works`,
            focus.length ? `"${params.topic}" ${focus.join(" ")}` : `"${params.topic}" latest developments`,
          ]
        : [
            `"${params.topic}" overview`,
            `"${params.topic}" ${new Date().getFullYear()} news`,
            `"${params.topic}" technical details`,
            `"${params.topic}" analysis OR comparison`,
            focus.length ? `"${params.topic}" ${focus.join(" ")}` : `"${params.topic}" criticism OR limitations`,
          ];

      const plan: string[] = [
        `# Research Plan: "${params.topic}"`,
        `Depth: ${depth} · Queries: ${numSearches} · Recency-required: ${recency}`,
        focus.length ? `Focus: ${focus.join(", ")}` : "",
        ``,
      ].filter(s => s !== "");

      // Step 1 — Memory check
      if (hasMemory && !recency) {
        plan.push(
          `## Step 1 — Memory Check`,
          `Call: recall_web_knowledge(query="${params.topic}"${focus.length ? `, tags=[${focus.map(t => `"${t}"`).join(", ")}]` : ""})`,
          stats.total > 0
            ? `  The knowledge base has ${stats.total} entries (${stats.withKnowledge} distilled). Check before searching.`
            : `  Knowledge base is empty — proceed directly to Step 2.`,
          ``,
        );
      } else if (recency) {
        plan.push(
          `## Step 1 — Memory Check`,
          `  Skipped (recency_required=true). Proceeding directly to fresh searches.`,
          ``,
        );
      }

      // Step 2 — Web searches
      if (hasSearch) {
        plan.push(`## Step 2 — Web Searches (${numSearches} queries)`);
        plan.push(`Run the following queries in sequence (or adjust angles based on memory results):`);
        angleExamples.forEach((q, i) => plan.push(`  ${i + 1}. web_search(query="${q}", num_results=8)`));
        plan.push(``);
      }

      // Step 3 — Distil and save
      if (hasSearch) {
        plan.push(
          `## Step 3 — Distil and Save (after EACH search)`,
          `For every web_search call, immediately follow up with save_search_knowledge:`,
          `  save_search_knowledge(`,
          `    search_id = <id from web_search>,`,
          `    summary   = "2–4 sentence summary of key findings",`,
          `    key_facts = ["fact 1", "fact 2", …],   // 5–8 concrete facts`,
          `    tags       = ["lowercase", "topic", "tags"],`,
          `    categories = ["technology" | "news" | "research" | "tutorial" | "product" | "science" | …],`,
          `    sources    = [{ title, url, relevance: "high"|"medium"|"low" }, …]`,
          `  )`,
          ``,
        );
      }

      // Step 4 — Synthesise
      plan.push(
        `## Step 4 — Synthesise`,
        `Write a comprehensive answer that:`,
        `  • Integrates all sources (memory recall + fresh searches)`,
        `  • Distinguishes established facts from recent/evolving developments`,
        `  • Notes conflicting information or uncertainty where present`,
        `  • Cites key sources inline (title + URL)`,
        depth === "deep" ? `  • Includes an executive summary at the top` : "",
        `  • Flags information likely to change quickly`,
      ).filter(s => s !== "");

      return {
        content: [{ type: "text", text: plan.join("\n") }],
        details: { topic: params.topic, depth, numSearches, recency, focusTags: focus },
      };
    },
  });

  // Session status disabled (noise reduction)
}
