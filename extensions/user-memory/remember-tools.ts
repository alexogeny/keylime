import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { convertTimelineDraftToRememberParams } from "./wizard.js";
import type { RememberParams as WizardRememberParams } from "./types.js";
import type { MemoryToolDeps } from "./memory-tool-types.js";

const MEMORY_CATEGORY_SCHEMA = Type.Union([
  Type.Literal("preference"), Type.Literal("fact"), Type.Literal("event"),
  Type.Literal("goal"), Type.Literal("skill"), Type.Literal("context"),
], { description: "Category" });

const SENSITIVITY_SCHEMA = Type.Union([
  Type.Literal("baseline"), Type.Literal("general"),
  Type.Literal("context_gated"), Type.Literal("temporal_gated"),
], { description: "Injection sensitivity tier" });

export function registerRememberTools(pi: ExtensionAPI, deps: MemoryToolDeps): void {
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
}
