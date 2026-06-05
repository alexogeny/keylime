import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { daysUntil } from "../shared/time-format";
import { profileSearchLines } from "./profile-context.js";
import { decayedConfidence, type Memory } from "./store.js";
import { shouldPromptToAddTimelineMemory, temporalContextForMemory } from "./timeline-memory.js";
import type { MemoryToolDeps } from "./memory-tool-types.js";

export function registerRecallMemoryTools(pi: ExtensionAPI, deps: MemoryToolDeps): void {
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
}
