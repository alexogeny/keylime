import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { daysUntil } from "../shared/time-format";
import { unlinkMemory, type EntityStore } from "./entity.js";
import { profileSearchLines } from "./profile-context.js";
import { decayedConfidence, memoryText, type Memory, type MemoryStore } from "./store.js";
import { convertTimelineDraftToRememberParams } from "./wizard.js";
import type { MemoryCategory, RememberParams as WizardRememberParams } from "./types.js";
import { shouldPromptToAddTimelineMemory, temporalContextForMemory } from "./timeline-memory.js";
import { checkOllama, embedText } from "./embeddings.js";

type MemoryHit = { memory: Memory; score: number };

type MemoryToolDeps = {
  ensureLoaded: () => Promise<void>;
  getStore: () => MemoryStore;
  getEntityStore: () => EntityStore;
  rememberStructuredMemory: (params: WizardRememberParams) => Promise<any>;
  hybridSearch: (query: string, topK: number, filterFn?: (m: Memory) => boolean) => Promise<MemoryHit[]>;
  persist: () => Promise<void>;
  removeFromIndexes: (id: string) => void;
  reindexMemory: (mem: Memory) => void;
  age: (ts: number) => string;
};

const MEMORY_CATEGORY_SCHEMA = Type.Union([
  Type.Literal("preference"), Type.Literal("fact"), Type.Literal("event"),
  Type.Literal("goal"), Type.Literal("skill"), Type.Literal("context"),
], { description: "Category" });

const SENSITIVITY_SCHEMA = Type.Union([
  Type.Literal("baseline"), Type.Literal("general"),
  Type.Literal("context_gated"), Type.Literal("temporal_gated"),
], { description: "Injection sensitivity tier" });

export function registerUserMemoryTools(pi: ExtensionAPI, deps: MemoryToolDeps): void {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Store a durable user memory with deduplication.",
    promptSnippet: "Store durable user memory",
    promptGuidelines: ["Use for durable user preferences, facts, events, goals, or context."],
    parameters: Type.Object({
      content: Type.String({ description: "Memory text" }),
      category: MEMORY_CATEGORY_SCHEMA,
      subcategory: Type.Optional(Type.String({ description: "Subcategory" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      temporal: Type.Optional(Type.Boolean({ description: "Time-bound" })),
      date_ref: Type.Optional(Type.String({ description: "Date reference" })),
      expires_at: Type.Optional(Type.Number({ description: "Expiry unix ms" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0-1" })),
      sensitivity: Type.Optional(SENSITIVITY_SCHEMA),
      expiry_tier: Type.Optional(Type.String({ description: "How long to keep: '2d' (today), '7d' (this week), '30d' (this month), or omit for permanent" })),
    }),
    async execute(_id, params, _signal) {
      return deps.rememberStructuredMemory(params as WizardRememberParams);
    },
  });

  pi.registerTool({
    name: "remember_timeline",
    label: "Remember Timeline Entry",
    description: "Store a structured temporal profile/history memory such as residence, employment, education, pets, significant people, relationships, or life events.",
    promptSnippet: "Store structured temporal profile history",
    promptGuidelines: ["Use for addresses, employment history, schooling, pets, significant people, relationships, life events, and other multi-entry temporal profile facts. Life events can link people and places via data.people and data.places."],
    parameters: Type.Object({
      subkind: Type.Union([
        Type.Literal("residence"), Type.Literal("employment"), Type.Literal("education"),
        Type.Literal("pet"), Type.Literal("person"), Type.Literal("relationship"),
        Type.Literal("life_event"), Type.Literal("health"), Type.Literal("custom"),
      ]),
      label: Type.Optional(Type.String()),
      data: Type.Object({}, { additionalProperties: true }),
      start: Type.Optional(Type.String({ description: "Start date as YYYY, YYYY-MM, YYYY-MM-DD, or approximate text" })),
      end: Type.Optional(Type.String({ description: "End date as YYYY, YYYY-MM, YYYY-MM-DD, or approximate text" })),
      current: Type.Optional(Type.Boolean({ description: "Whether this entry is current/present" })),
      notes: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      sensitivity: Type.Optional(SENSITIVITY_SCHEMA),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    async execute(_id, params, _signal) {
      const rememberParams = convertTimelineDraftToRememberParams({
        subkind: params.subkind,
        label: params.label,
        data: params.data ?? {},
        interval: {
          start: params.start ? { value: params.start, precision: "unknown" } : undefined,
          end: params.end ? { value: params.end, precision: "unknown" } : undefined,
          current: params.current ?? false,
        },
        notes: params.notes,
        tags: params.tags,
        sensitivity: params.sensitivity,
        confidence: params.confidence,
      });
      return deps.rememberStructuredMemory(rememberParams);
    },
  });

  pi.registerTool({
    name: "recall_memories",
    label: "Recall Memories",
    description: "Search user memories.",
    promptSnippet: "Search user memories",
    promptGuidelines: ["Use for user-context lookup."],
    parameters: Type.Object({
      query: Type.String({ description: "What to look up" }),
      top_k: Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 20 })),
      category: Type.Optional(Type.String({ description: "Category" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      include_expired: Type.Optional(Type.Boolean({ description: "Include expired" })),
    }),
    async execute(_id, params, _signal) {
      await deps.ensureLoaded();
      const store = deps.getStore();
      const now = Date.now();
      const hits = await deps.hybridSearch(
        params.query,
        params.top_k ?? 8,
        m => {
          if (!params.include_expired && m.expires_at && m.expires_at < now) return false;
          if (params.category && m.category !== params.category) return false;
          if (params.tags?.length && !params.tags.some(t => m.tags.includes(t))) return false;
          return true;
        },
      );

      const profileHits = profileSearchLines(store.profile, params.query, params.top_k ?? 8);
      const addPrompt = shouldPromptToAddTimelineMemory(params.query, hits);

      if (hits.length === 0 && profileHits.length === 0) {
        const text = addPrompt.shouldPrompt
          ? `No memories found matching "${params.query}". This looks like ${addPrompt.inferredSubkind} history; open /memory-wizard → timeline / history entry to add it.`
          : `No memories found matching "${params.query}".`;
        return { content: [{ type: "text", text }], details: { count: 0, hits: [], profileHits: [], addTimelinePrompt: addPrompt } };
      }

      const contextByHit = new Map<string, Memory[]>();
      for (const hit of hits) {
        const context = temporalContextForMemory(hit.memory, store.memories, 4);
        if (context.length) contextByHit.set(hit.memory.id, context);
      }

      const lines: string[] = [`Found ${hits.length + profileHits.length} memory/profile results for "${params.query}":\n`];
      if (profileHits.length) lines.push(...profileHits, "");
      for (const { memory: m, score } of hits) {
        const conf = decayedConfidence(m, now);
        const timeInfo = m.expires_at ? `expires in ${daysUntil(m.expires_at)}d` : deps.age(m.updated_at);
        lines.push(
          `[${m.id.slice(0,8)}] (${m.category}${m.subcategory ? `/${m.subcategory}` : ""}) score:${score.toFixed(3)} conf:${(conf*100).toFixed(0)}% ${timeInfo}`,
          `  "${m.content}"`,
          m.date_ref ? `  📅 ${m.date_ref}` : "",
          m.tags.length ? `  🏷  ${m.tags.join(", ")}` : "",
          "",
        );
        const temporalContext = contextByHit.get(m.id) ?? [];
        if (temporalContext.length) {
          lines.push("  Same temporal context:");
          for (const related of temporalContext) lines.push(`  - [${related.id.slice(0,8)}] ${related.timeline?.subkind ?? related.subcategory}: ${related.content}`);
          lines.push("");
        }
      }
      if (addPrompt.shouldPrompt) lines.push(`No strong ${addPrompt.inferredSubkind} timeline match was found. To add it, run /memory-wizard → timeline / history entry.`);

      return {
        content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
        details: {
          count: hits.length + profileHits.length,
          hits: hits.map(h => ({ id: h.memory.id, score: h.score, content: h.memory.content, timeline: h.memory.timeline })),
          profileHits,
          temporalContext: Object.fromEntries([...contextByHit.entries()].map(([id, related]) => [id, related.map(m => m.id)])),
          addTimelinePrompt: addPrompt,
        },
      };
    },
  });

  pi.registerTool({
    name: "update_memory",
    label: "Update Memory",
    description: "Update a memory by id prefix.",
    promptSnippet: "Update memory by ID",
    promptGuidelines: ["Use when the user corrects or updates remembered information."],
    parameters: Type.Object({
      id_prefix: Type.String({ description: "First 8+ characters of the memory ID to update" }),
      content: Type.Optional(Type.String({ description: "New content (if changing the text)" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Replace tags entirely" })),
      subcategory: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number({ description: "New confidence 0–1" })),
      date_ref: Type.Optional(Type.String()),
      expires_at: Type.Optional(Type.Number()),
      note: Type.Optional(Type.String({ description: "Reason for the update (not stored, just for logging)" })),
    }),
    async execute(_id, params, _signal) {
      await deps.ensureLoaded();
      const mem = deps.getStore().memories.find(m => m.id.startsWith(params.id_prefix));
      if (!mem) throw new Error(`No memory found with ID prefix "${params.id_prefix}"`);

      const old = { ...mem };
      if (params.content) mem.content = params.content;
      if (params.tags) mem.tags = params.tags;
      if (params.subcategory) mem.subcategory = params.subcategory;
      if (params.confidence != null) mem.confidence = params.confidence;
      if (params.date_ref) mem.date_ref = params.date_ref;
      if (params.expires_at) mem.expires_at = params.expires_at;
      mem.updated_at = Date.now();

      if (params.content) {
        if (await checkOllama()) mem.embedding = await embedText(params.content) ?? undefined;
        deps.removeFromIndexes(mem.id);
        deps.reindexMemory(mem);
      }

      await deps.persist();
      return { content: [{ type: "text", text: `Updated [${mem.id.slice(0,8)}]: "${old.content}" → "${mem.content}"` }], details: { old, updated: mem } };
    },
  });

  pi.registerTool({
    name: "forget_memory",
    label: "Forget Memory",
    description: "Forget a memory by id prefix.",
    promptSnippet: "Delete or expire a memory by ID",
    parameters: Type.Object({
      id_prefix: Type.String({ description: "First 8+ characters of the memory ID" }),
      reason: Type.Optional(Type.String({ description: "Why forgetting this memory" })),
    }),
    async execute(_id, params, _signal) {
      await deps.ensureLoaded();
      const store = deps.getStore();
      const idx = store.memories.findIndex(m => m.id.startsWith(params.id_prefix));
      if (idx === -1) throw new Error(`No memory found with ID prefix "${params.id_prefix}"`);
      const [removed] = store.memories.splice(idx, 1);
      deps.removeFromIndexes(removed.id);
      unlinkMemory(deps.getEntityStore(), removed.id);
      await deps.persist();
      return { content: [{ type: "text", text: `Forgot [${removed.id.slice(0,8)}]: "${removed.content}"${params.reason ? ` (${params.reason})` : ""}` }], details: { removed } };
    },
  });

  pi.registerTool({
    name: "list_memories",
    label: "List Memories",
    description: "List user memories.",
    promptSnippet: "Browse all stored memories about the user",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      tag: Type.Optional(Type.String({ description: "Filter by tag" })),
      temporal: Type.Optional(Type.Boolean({ description: "Only show temporal/event memories" })),
      upcoming: Type.Optional(Type.Boolean({ description: "Only show memories with a future expiry date" })),
      limit: Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal) {
      await deps.ensureLoaded();
      const store = deps.getStore();
      const now = Date.now();
      let pool = [...store.memories];
      if (params.category) pool = pool.filter(m => m.category === params.category as MemoryCategory);
      if (params.tag) pool = pool.filter(m => m.tags.includes(params.tag!));
      if (params.temporal) pool = pool.filter(m => m.temporal);
      if (params.upcoming) pool = pool.filter(m => m.expires_at && m.expires_at > now);
      pool.sort((a, b) => b.updated_at - a.updated_at);
      const total = pool.length;
      pool = pool.slice(0, params.limit ?? 30);

      const byCat = new Map<string, number>();
      for (const m of store.memories) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
      const summary = [...byCat.entries()].map(([c, n]) => `${c}:${n}`).join("  ");

      if (pool.length === 0) return { content: [{ type: "text", text: `No memories match the given filters.\nTotal memories: ${store.memories.length} (${summary})` }], details: { total: 0, memories: [] } };

      const lines: string[] = [`${total} memories${total < store.memories.length ? ` (of ${store.memories.length} total)` : ""} — ${summary}\n`];
      for (const m of pool) {
        const conf = decayedConfidence(m, now);
        const timeInfo = m.expires_at ? (m.expires_at > now ? `⏰ in ${daysUntil(m.expires_at)}d` : "⌛ expired") : deps.age(m.updated_at);
        lines.push(
          `[${m.id.slice(0,8)}] ${m.category}${m.subcategory ? `/${m.subcategory}` : ""}  ${timeInfo}  conf:${(conf*100).toFixed(0)}%`,
          `  ${m.content}`,
          m.date_ref ? `  📅 ${m.date_ref}` : "",
          m.tags.length ? `  🏷  ${m.tags.join(", ")}` : "",
          "",
        );
      }
      if (total > pool.length) lines.push(`… and ${total - pool.length} more`);
      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: { total, memories: pool } };
    },
  });
}
