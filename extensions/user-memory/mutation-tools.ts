import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { daysUntil } from "../shared/time-format";
import { unlinkMemory } from "./entity.js";
import { checkOllama, embedText } from "./embeddings.js";
import { decayedConfidence } from "./store.js";
import type { MemoryCategory } from "./types.js";
import type { MemoryToolDeps } from "./memory-tool-types.js";

export function registerMemoryMutationTools(pi: ExtensionAPI, deps: MemoryToolDeps): void {
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
    async execute(_id, params, _signal): Promise<any> {
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
    async execute(_id, params, _signal): Promise<any> {
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
    async execute(_id, params, _signal): Promise<any> {
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
