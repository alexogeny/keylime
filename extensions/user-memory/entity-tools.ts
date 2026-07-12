import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { daysUntil } from "../shared/time-format";
import { findEntity, type EntityStore } from "./entity.js";
import { decayedConfidence, type Memory, type MemoryStore } from "./store.js";

type EntityToolDeps = {
  ensureLoaded: () => Promise<void>;
  getStore: () => MemoryStore;
  getEntityStore: () => EntityStore;
  age: (ts: number) => string;
};

export function registerMemoryEntityTools(pi: ExtensionAPI, deps: EntityToolDeps): void {
  pi.registerTool({
    name: "recall_entity",
    label: "Recall Entity",
    description: "Recall memories linked to a named entity.",
    promptSnippet: "Recall entity memory",
    promptGuidelines: ["Use for named people, orgs, roles, places, or systems."],
    parameters: Type.Object({
      name: Type.String({ description: "Entity name" }),
    }),

    async execute(_id, params, _signal): Promise<any> {
      await deps.ensureLoaded();
      const entityStore = deps.getEntityStore();
      const store = deps.getStore();
      const entity = findEntity(entityStore, params.name);
      if (!entity) {
        return {
          content: [{ type: "text", text: `No entity found matching "${params.name}". Known entities: ${entityStore.entities.map(e=>e.name).join(", ") || "none yet"}.` }],
          details: { found: false },
        };
      }

      const memMap = new Map(store.memories.map(m => [m.id, m]));
      const memories = entity.memory_ids.map(id => memMap.get(id)).filter(Boolean) as Memory[];
      const now = Date.now();

      const lines = [
        `Entity: ${entity.name}  (${entity.type}${entity.subtype ? "/"+entity.subtype : ""})`,
        `Aliases: ${entity.aliases.length ? entity.aliases.join(", ") : "none"}`,
        `Mentions: ${entity.mentions}  |  Linked memories: ${memories.length}`,
        "",
      ];
      for (const m of memories.sort((a,b) => b.updated_at - a.updated_at)) {
        const conf = decayedConfidence(m, now);
        const timeInfo = m.expires_at ? `expires in ${daysUntil(m.expires_at)}d` : deps.age(m.updated_at);
        lines.push(
          `[${m.id.slice(0,8)}] (${m.category}${m.promoted_from ? ` ⬆️${m.promoted_from}` : ""}) ×${m.mentions} ${timeInfo} conf:${(conf*100).toFixed(0)}%`,
          `  "${m.content}"`,
          "",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { entity, memories },
      };
    },
  });

  pi.registerTool({
    name: "list_entities",
    label: "List Entities",
    description: "List memory entities.",
    promptSnippet: "List memory entities",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Entity type" })),
      limit: Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 100 })),
    }),

    async execute(_id, params, _signal): Promise<any> {
      await deps.ensureLoaded();
      const entityStore = deps.getEntityStore();
      let pool = [...entityStore.entities];
      if (params.type) pool = pool.filter(e => e.type === params.type);
      pool.sort((a, b) => b.mentions - a.mentions);
      const total = pool.length;
      pool = pool.slice(0, params.limit ?? 30);

      if (pool.length === 0) {
        return {
          content: [{ type: "text", text: "No entities found. Entities are extracted automatically when you call remember()." }],
          details: { total: 0, entities: [] },
        };
      }

      const byType = new Map<string, number>();
      for (const e of entityStore.entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      const summary = [...byType.entries()].map(([t,n]) => `${t}:${n}`).join("  ");

      const lines = [`${total} entities — ${summary}`, ""];
      for (const e of pool) {
        lines.push(
          `[${e.id.slice(0,8)}] ${e.name}  (${e.type}${e.subtype ? "/"+e.subtype : ""})  ×${e.mentions}  ${e.memory_ids.length} memories`,
          e.aliases.length ? `  aliases: ${e.aliases.join(", ")}` : "",
          "",
        );
      }

      return {
        content: [{ type: "text", text: lines.filter(l => l !== undefined).join("\n") }],
        details: { total, entities: pool },
      };
    },
  });
}
