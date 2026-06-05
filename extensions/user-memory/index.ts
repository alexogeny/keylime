/**
 * User Memory Extension
 *
 * A persistent, hybrid-retrieval personal memory system for pi.
 * Captures facts, preferences, events, goals, and context about you
 * and injects relevant memories into every conversation turn.
 *
 * Retrieval stack (zero external dependencies):
 *   1. BM25   — fast full-text candidate retrieval
 *   2. TF-IDF cosine — deterministic vector similarity for reranking + dedup
 *   3. Ollama (optional) — swap in neural embeddings if nomic-embed-text is available
 *
 * Memory categories:
 *   preference  — tool choices, style, workflow (e.g. "prefers Bun over npm")
 *   fact        — biographical / contextual facts (e.g. "works at X law firm")
 *   event       — temporal events with a date (e.g. "marathon on 2026-08-15")
 *   goal        — current projects, aspirations, targets
 *   skill       — expertise levels, known technologies
 *   context     — current project / environment state
 *
 * Storage: ~/.pi/data/user-memory/memories.json
 *
 * Tools registered:
 *   remember        — store a new memory (with dedup gate)
 *   recall_memories — hybrid BM25+cosine search over the memory store
 *   update_memory   — correct or extend an existing memory
 *   forget_memory   — delete or expire a memory
 *   list_memories   — browse all memories with category/tag filters
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { BM25Index, TFIDFStore, tokenize } from "../shared/retrieval";
import { ageString, daysUntil } from "../shared/time-format";
import { rawTextFromContent } from "../shared/message-content";
import {
  type Entity, type EntityStore,
  loadEntityStore, saveEntityStore,
  upsertEntity, unlinkMemory, findEntity,
} from "./entity.js";
import {
  registerMemoryWizardCommand,
  convertTimelineDraftToRememberParams,
  type ProfilePatch,
} from "./wizard.js";
import type { MemoryCategory, RememberParams as WizardRememberParams, TimelineMemoryPayload, UserProfile } from "./types.js";
import { backupLabels, createMemoryBackup, listMemoryBackups, loadMemoryBackup, pruneMemoryBackups, restoreEntityBackup } from "./backups.js";
import { profileSearchLines } from "./profile-context.js";
import { tierToMs, type ExpiryTier } from "./expiry.js";
import { DATA_DIR, decayedConfidence, jaccard, loadStore, memoryText, saveStore, type Memory, type MemoryStore } from "./store.js";
import { cachedQueryEmbedding, checkOllama, embedText } from "./embeddings.js";
import { findDuplicateMemory, hybridSearch } from "./retrieval.js";
import { buildExpiryTrace, buildJobChapter, checkPromotion, shouldCreateJobChapter } from "./lifecycle.js";
import { registerUserMemoryContext } from "./context-provider.js";
import { registerMemoryDetector } from "./memory-detector.js";
import { inferSensitivityTier, TEMPORAL_GATE_DAYS, type SensitivityTier } from "./sensitivity.js";
import {
  memoryEntities,
  shouldPromptToAddTimelineMemory,
  temporalContextForMemory,
} from "./timeline-memory.js";
export { shouldPromptToAddTimelineMemory, temporalContextForMemory, timelineLinkedEntities } from "./timeline-memory.js";

// ─── Human-readable age ───────────────────────────────────────────────────────

function age(ts: number): string {
  const text = ageString(ts);
  if (!text.endsWith("d ago")) return text;
  const days = Number(text.slice(0, -5));
  return days < 365 ? text : `${Math.round(days / 365)}y ago`;
}

// ─── Context injection helpers ─────────────────────────────────────────────────────────────

/** Extract plain text from a user message content (string or content block array). */
function extractMsgText(content: unknown): string {
  return rawTextFromContent(content);
}

// ─── Signal Detection Pipeline ──────────────────────────────────────────────────
//
// Deterministic, zero-LLM, three-stage pipeline for detecting memorable content
// in conversation turns.  No regex — all matching is token-set overlap.
//
// Stage 1 — Feature Scorer
//   Weighted token groups.  Score = Σ weight × min(group_hits, 2).
//   The cap prevents any single group dominating ("I always always always" shouldn't
//   score higher than "I always prefer Bun").
//
// Stage 2 — Novelty Gate
//   BM25 against the existing memory store.  If we already know this, skip.
//
// Stage 3 — Category Prototype Classifier  (the SetFit equivalent)
//   One dense prototype document per memory category.  TF-IDF cosine against
//   each prototype picks the best category.  Catches paraphrases and synonyms
//   that share tokens — same semantic signal regardless of sentence structure.

// ── Feature groups ────────────────────────────────────────────────────────────
// Each group captures a semantic signal type.  Weight reflects how strong a
// signal it is on its own.  They accumulate — hitting multiple groups is
// much more likely to be a genuine memorable fact.

// ─── Extension ────────────────────────────────────────────────────────────────

export default function userMemoryExtension(pi: ExtensionAPI) {

  // In-memory index — rebuilt once per session, updated incrementally on writes
  let bm25   = new BM25Index();
  let tfidf  = new TFIDFStore();
  let store:        MemoryStore = { version: 4, profile: {}, memories: [] };
  let entityStore:  EntityStore = { version: 1, entities: [] };
  let loaded = false;

  const retrievalDeps = () => ({ memories: store.memories, bm25, tfidf, checkOllama, cachedQueryEmbedding, embedText });

  // ── Load & build index ────────────────────────────────────────────────────

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    [store, entityStore] = await Promise.all([loadStore(), loadEntityStore()]);
    bm25   = new BM25Index();
    tfidf  = new TFIDFStore();
    const now = Date.now();
    // Prune expired memories before indexing
    // Process expired memories: convert to traces or delete, per r5 policy
    const traces: Memory[] = [];
    store.memories = store.memories.filter(m => {
      if (!m.expires_at || m.expires_at > now) return true;
      if (m.trace_only) return false; // already a trace, just remove
      const trace = buildExpiryTrace(m, now);
      if (trace) traces.push(trace);
      return false;
    });
    store.memories.push(...traces);
    for (const m of store.memories) {
      const text = memoryText(m);
      bm25.add(m.id, text);
      tfidf.add(m.id, text);
    }
    loaded = true;
  }

  async function persist(): Promise<void> {
    // Merge-on-write: re-read the file, incorporate any memories written by
    // a concurrent session, then write the merged result.  Prevents one
    // parallel pi window silently overwriting another's writes.
    const onDisk = await loadStore();
    const diskIds = new Set(onDisk.memories.map(m => m.id));
    const inMemIds = new Set(store.memories.map(m => m.id));
    store.profile = { ...onDisk.profile, ...store.profile };
    for (const [section, fields] of Object.entries(onDisk.profile)) {
      store.profile[section] = { ...fields, ...(store.profile[section] ?? {}) };
    }
    // Add any memories present on disk but missing from our in-memory store
    for (const m of onDisk.memories) {
      if (!inMemIds.has(m.id)) {
        store.memories.push(m);
        bm25.add(m.id, memoryText(m));
        tfidf.add(m.id, memoryText(m));
      }
    }
    await Promise.all([saveStore(store), saveEntityStore(entityStore)]);
  }

  async function rememberStructuredMemory(params: WizardRememberParams) {
    await ensureLoaded();

    // Resolve expires_at: expiry_tier takes precedence over raw expires_at
    if (params.expiry_tier && ["2d","7d","30d"].includes(params.expiry_tier)) {
      params.expires_at = tierToMs(params.expiry_tier as ExpiryTier);
      if (!params.temporal) params.temporal = true;
    }

    // ── Adversarial protection ─────────────────────────────────────────────────────
    // Reject prompt-injection attempts that try to rewrite how I behave rather
    // than record facts about the user.
    const adversarialPatterns = [
      /\byou (always|should|must|will|are|have to|need to)\b/i,
      /\bremember that you\b/i,
      /\bas an ai\b/i,
      /\bignore (previous|prior|your|all)\b/i,
      /\byour (instructions|rules|guidelines|system prompt)\b/i,
      /\bforget (everything|all|your|prior)\b/i,
    ];
    if (adversarialPatterns.some(p => p.test(params.content))) {
      throw new Error(
        `Rejected: this looks like a prompt injection attempt rather than a personal memory. ` +
        `Memories should be facts about you, not instructions to me.`
      );
    }

    // Deduplication check
    const dup = await findDuplicateMemory(retrievalDeps(), params.content, params.category);
    if (dup) {
      // ── Reinforce existing memory ──
      const now = Date.now();
      dup.content    = params.content;
      dup.updated_at = now;
      dup.mentions   = (dup.mentions ?? 1) + 1;
      if (params.tags?.length)     dup.tags = [...new Set([...dup.tags, ...params.tags])];
      if (params.subcategory)      dup.subcategory = params.subcategory;
      if (params.date_ref)         dup.date_ref = params.date_ref;
      if (params.expires_at)       dup.expires_at = params.expires_at;
      if (params.temporal != null) dup.temporal = params.temporal;
      if (params.sensitivity)      dup.sensitivity = params.sensitivity as SensitivityTier;
      if (params.timeline)         dup.timeline = params.timeline;
      dup.confidence = params.confidence ?? 1.0;
      if (await checkOllama()) dup.embedding = await embedText(params.content) ?? undefined;

      // Check for promotion
      const { promoted, note: promoNote } = checkPromotion(dup, now);

      // Extract entities from updated content
      const newEntities = memoryEntities(params.content, params.timeline);
      for (const e of newEntities) {
        const eid = upsertEntity(entityStore, e, dup.id, now);
        if (!dup.entity_refs.includes(eid)) dup.entity_refs.push(eid);
      }

      // Rebuild index entry
      bm25.remove(dup.id);
      tfidf.remove(dup.id);
      const text = memoryText(dup);
      bm25.add(dup.id, text);
      tfidf.add(dup.id, text);
      await persist();

      const statusLine = promoted
        ? `Reinforced + promoted [${dup.id.slice(0,8)}]: ${promoNote}`
        : `Reinforced [${dup.id.slice(0,8)}] (×${dup.mentions}): "${dup.content}"`;
      return {
        content: [{ type: "text", text: statusLine }],
        details: { action: promoted ? "promoted" : "reinforced", memory: dup, promoted },
      };
    }

    // ── Create new memory ──
    const now = Date.now();
    const mem: Memory = {
      id:           randomUUID(),
      content:      params.content,
      category:     params.category,
      subcategory:  params.subcategory,
      tags:         params.tags ?? [],
      confidence:   params.confidence ?? 1.0,
      created_at:   now,
      updated_at:   now,
      expires_at:   params.expires_at,
      temporal:     params.temporal ?? false,
      date_ref:     params.date_ref,
      sensitivity:   params.sensitivity as SensitivityTier | undefined,
      timeline:      params.timeline,
      mentions:     1,
      first_seen:   now,
      entity_refs:  [],
    };
    if (await checkOllama()) mem.embedding = await embedText(params.content) ?? undefined;

    // Auto-detect sensitivity tier if not provided
    if (!mem.sensitivity) {
      mem.sensitivity = inferSensitivityTier(mem);
    }

    // Extract and link entities
    const entities = memoryEntities(params.content, params.timeline);
    for (const e of entities) {
      const eid = upsertEntity(entityStore, e, mem.id, now);
      mem.entity_refs.push(eid);
    }

    store.memories.push(mem);

    // Check if a job chapter should be created for any work entity
    for (const entity of entities.filter(e => e.subtype === "work")) {
      const { should, sources } = shouldCreateJobChapter(store.memories, entity.canonical);
      if (should) {
        const frictionMems = store.memories.filter(m => sources.includes(m.id));
        const chapter = buildJobChapter(entity.canonical, frictionMems, now);
        store.memories.push(chapter);
        bm25.add(chapter.id, memoryText(chapter));
        tfidf.add(chapter.id, memoryText(chapter));
      }
    }
    const text = memoryText(mem);
    bm25.add(mem.id, text);
    tfidf.add(mem.id, text);
    await persist();

    const entityNames = entities.map(e => e.canonical).join(", ");
    return {
      content: [{ type: "text", text: `Remembered [${mem.id.slice(0,8)}] (${mem.category}): "${mem.content}"${entityNames ? ` | entities: ${entityNames}` : ""}` }],
      details: { action: "created", memory: mem, entities },
    };
  }

  async function currentProfile(): Promise<ProfilePatch> {
    await ensureLoaded();
    return store.profile as ProfilePatch;
  }

  async function updateProfile(patch: ProfilePatch): Promise<{ text: string }> {
    await ensureLoaded();
    for (const [section, fields] of Object.entries(patch)) {
      store.profile[section] = { ...(store.profile[section] ?? {}), ...fields };
    }
    await persist();
    const count = Object.values(patch).reduce((sum, fields) => sum + Object.keys(fields).length, 0);
    return { text: `Saved ${count} structured profile fields` };
  }

  // ── Command: memory-wizard ─────────────────────────────────────────────────

  registerMemoryWizardCommand(pi, updateProfile, async (params) => {
    const result = await rememberStructuredMemory(params);
    return { text: result.content[0]?.text ?? "Memory saved" };
  }, currentProfile);

  // ── Tool: remember ────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "remember",
    label:       "Remember",
    description: "Store a durable user memory with deduplication.",
    promptSnippet: "Store durable user memory",
    promptGuidelines: ["Use for durable user preferences, facts, events, goals, or context."],
    parameters: Type.Object({
      content:      Type.String({ description: "Memory text" }),
      category:     Type.Union([
        Type.Literal("preference"), Type.Literal("fact"), Type.Literal("event"),
        Type.Literal("goal"),       Type.Literal("skill"), Type.Literal("context"),
      ], { description: "Category" }),
      subcategory:  Type.Optional(Type.String({ description: "Subcategory" })),
      tags:         Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      temporal:     Type.Optional(Type.Boolean({ description: "Time-bound" })),
      date_ref:     Type.Optional(Type.String({ description: "Date reference" })),
      expires_at:   Type.Optional(Type.Number({ description: "Expiry unix ms" })),
      confidence:   Type.Optional(Type.Number({ description: "Confidence 0-1" })),
      sensitivity:   Type.Optional(Type.Union([
        Type.Literal("baseline"), Type.Literal("general"),
        Type.Literal("context_gated"), Type.Literal("temporal_gated"),
      ], { description: "Injection sensitivity tier" })),
      expiry_tier:  Type.Optional(Type.String({ description: "How long to keep: '2d' (today), '7d' (this week), '30d' (this month), or omit for permanent" })),
    }),

    async execute(_id, params, _signal) {
      return rememberStructuredMemory(params as WizardRememberParams);
    },
  });

  // ── Tool: remember_timeline ───────────────────────────────────────────────

  pi.registerTool({
    name:        "remember_timeline",
    label:       "Remember Timeline Entry",
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
      sensitivity: Type.Optional(Type.Union([
        Type.Literal("baseline"), Type.Literal("general"),
        Type.Literal("context_gated"), Type.Literal("temporal_gated"),
      ])),
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
      return rememberStructuredMemory(rememberParams);
    },
  });

  // ── Tool: recall_memories ─────────────────────────────────────────────────

  pi.registerTool({
    name:        "recall_memories",
    label:       "Recall Memories",
    description: "Search user memories.",
    promptSnippet: "Search user memories",
    promptGuidelines: ["Use for user-context lookup."],
    parameters: Type.Object({
      query:    Type.String({ description: "What to look up" }),
      top_k:    Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 20 })),
      category: Type.Optional(Type.String({ description: "Category" })),
      tags:     Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      include_expired: Type.Optional(Type.Boolean({ description: "Include expired" })),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
      const now  = Date.now();
      const hits = await hybridSearch(
        retrievalDeps(),
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
        return {
          content: [{ type: "text", text }],
          details: { count: 0, hits: [], profileHits: [], addTimelinePrompt: addPrompt },
        };
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
        const timeInfo = m.expires_at
          ? `expires in ${daysUntil(m.expires_at)}d`
          : age(m.updated_at);
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
          for (const related of temporalContext) {
            lines.push(`  - [${related.id.slice(0,8)}] ${related.timeline?.subkind ?? related.subcategory}: ${related.content}`);
          }
          lines.push("");
        }
      }
      if (addPrompt.shouldPrompt) {
        lines.push(`No strong ${addPrompt.inferredSubkind} timeline match was found. To add it, run /memory-wizard → timeline / history entry.`);
      }

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

  // ── Tool: update_memory ───────────────────────────────────────────────────

  pi.registerTool({
    name:        "update_memory",
    label:       "Update Memory",
    description: "Update a memory by id prefix.",
    promptSnippet: "Update memory by ID",
    promptGuidelines: ["Use when the user corrects or updates remembered information."],
    parameters: Type.Object({
      id_prefix:   Type.String({ description: "First 8+ characters of the memory ID to update" }),
      content:     Type.Optional(Type.String({ description: "New content (if changing the text)" })),
      tags:        Type.Optional(Type.Array(Type.String(), { description: "Replace tags entirely" })),
      subcategory: Type.Optional(Type.String()),
      confidence:  Type.Optional(Type.Number({ description: "New confidence 0–1" })),
      date_ref:    Type.Optional(Type.String()),
      expires_at:  Type.Optional(Type.Number()),
      note:        Type.Optional(Type.String({ description: "Reason for the update (not stored, just for logging)" })),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
      const mem = store.memories.find(m => m.id.startsWith(params.id_prefix));
      if (!mem) throw new Error(`No memory found with ID prefix "${params.id_prefix}"`);

      const old = { ...mem };
      if (params.content)     { mem.content     = params.content; }
      if (params.tags)        { mem.tags         = params.tags; }
      if (params.subcategory) { mem.subcategory  = params.subcategory; }
      if (params.confidence != null) { mem.confidence = params.confidence; }
      if (params.date_ref)    { mem.date_ref     = params.date_ref; }
      if (params.expires_at)  { mem.expires_at   = params.expires_at; }
      mem.updated_at = Date.now();

      if (params.content) {
        if (await checkOllama()) mem.embedding = await embedText(params.content) ?? undefined;
        bm25.remove(mem.id);
        tfidf.remove(mem.id);
        const text = memoryText(mem);
        bm25.add(mem.id, text);
        tfidf.add(mem.id, text);
      }

      await persist();
      return {
        content: [{ type: "text", text: `Updated [${mem.id.slice(0,8)}]: "${old.content}" → "${mem.content}"` }],
        details: { old, updated: mem },
      };
    },
  });

  // ── Tool: forget_memory ───────────────────────────────────────────────────

  pi.registerTool({
    name:        "forget_memory",
    label:       "Forget Memory",
    description: "Forget a memory by id prefix.",
    promptSnippet: "Delete or expire a memory by ID",
    parameters: Type.Object({
      id_prefix: Type.String({ description: "First 8+ characters of the memory ID" }),
      reason:    Type.Optional(Type.String({ description: "Why forgetting this memory" })),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
      const idx = store.memories.findIndex(m => m.id.startsWith(params.id_prefix));
      if (idx === -1) throw new Error(`No memory found with ID prefix "${params.id_prefix}"`);
      const [removed] = store.memories.splice(idx, 1);
      bm25.remove(removed.id);
      tfidf.remove(removed.id);
      unlinkMemory(entityStore, removed.id);
      await persist();
      return {
        content: [{ type: "text", text: `Forgot [${removed.id.slice(0,8)}]: "${removed.content}"${params.reason ? ` (${params.reason})` : ""}` }],
        details: { removed },
      };
    },
  });

  // ── Tool: list_memories ───────────────────────────────────────────────────

  pi.registerTool({
    name:        "list_memories",
    label:       "List Memories",
    description: "List user memories.",
    promptSnippet: "Browse all stored memories about the user",
    parameters: Type.Object({
      category:   Type.Optional(Type.String({ description: "Filter by category" })),
      tag:        Type.Optional(Type.String({ description: "Filter by tag" })),
      temporal:   Type.Optional(Type.Boolean({ description: "Only show temporal/event memories" })),
      upcoming:   Type.Optional(Type.Boolean({ description: "Only show memories with a future expiry date" })),
      limit:      Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 100 })),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
      const now = Date.now();
      let pool = [...store.memories];
      if (params.category)         pool = pool.filter(m => m.category === params.category);
      if (params.tag)              pool = pool.filter(m => m.tags.includes(params.tag!));
      if (params.temporal)         pool = pool.filter(m => m.temporal);
      if (params.upcoming)         pool = pool.filter(m => m.expires_at && m.expires_at > now);
      pool.sort((a, b) => b.updated_at - a.updated_at);
      const total = pool.length;
      pool = pool.slice(0, params.limit ?? 30);

      const byCat = new Map<string, number>();
      for (const m of store.memories) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
      const summary = [...byCat.entries()].map(([c, n]) => `${c}:${n}`).join("  ");

      if (pool.length === 0) {
        return {
          content: [{ type: "text", text: `No memories match the given filters.\nTotal memories: ${store.memories.length} (${summary})` }],
          details: { total: 0, memories: [] },
        };
      }

      const lines: string[] = [
        `${total} memories${total < store.memories.length ? ` (of ${store.memories.length} total)` : ""} — ${summary}\n`,
      ];
      for (const m of pool) {
        const conf = decayedConfidence(m, now);
        const timeInfo = m.expires_at
          ? (m.expires_at > now ? `⏰ in ${daysUntil(m.expires_at)}d` : "⌛ expired")
          : age(m.updated_at);
        lines.push(
          `[${m.id.slice(0,8)}] ${m.category}${m.subcategory ? `/${m.subcategory}` : ""}  ${timeInfo}  conf:${(conf*100).toFixed(0)}%`,
          `  ${m.content}`,
          m.date_ref ? `  📅 ${m.date_ref}` : "",
          m.tags.length ? `  🏷  ${m.tags.join(", ")}` : "",
          "",
        );
      }
      if (total > pool.length) lines.push(`… and ${total - pool.length} more`);

      return {
        content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
        details: { total, memories: pool },
      };
    },
  });

  // ── Tool: recall_entity ────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "recall_entity",
    label:       "Recall Entity",
    description: "Recall memories linked to a named entity.",
    promptSnippet: "Recall entity memory",
    promptGuidelines: ["Use for named people, orgs, roles, places, or systems."],
    parameters: Type.Object({
      name: Type.String({ description: "Entity name" }),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
      const entity = findEntity(entityStore, params.name);
      if (!entity) {
        return {
          content: [{ type: "text", text: `No entity found matching "${params.name}". Known entities: ${entityStore.entities.map(e=>e.name).join(", ") || "none yet"}.` }],
          details: { found: false },
        };
      }

      const memMap   = new Map(store.memories.map(m => [m.id, m]));
      const memories = entity.memory_ids.map(id => memMap.get(id)).filter(Boolean) as Memory[];
      const now      = Date.now();

      const lines = [
        `Entity: ${entity.name}  (${entity.type}${entity.subtype ? "/"+entity.subtype : ""})`,
        `Aliases: ${entity.aliases.length ? entity.aliases.join(", ") : "none"}`,
        `Mentions: ${entity.mentions}  |  Linked memories: ${memories.length}`,
        "",
      ];
      for (const m of memories.sort((a,b) => b.updated_at - a.updated_at)) {
        const conf = decayedConfidence(m, now);
        const timeInfo = m.expires_at ? `expires in ${daysUntil(m.expires_at)}d` : age(m.updated_at);
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

  // ── Tool: list_entities ────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "list_entities",
    label:       "List Entities",
    description: "List memory entities.",
    promptSnippet: "List memory entities",
    parameters: Type.Object({
      type:  Type.Optional(Type.String({ description: "Entity type" })),
      limit: Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 100 })),
    }),

    async execute(_id, params, _signal) {
      await ensureLoaded();
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

  // ── Command: /backup-memory ─────────────────────────────────────────────

  pi.registerCommand("backup-memory", {
    description: "Back up memory + entity store to a timestamped snapshot",
    handler: async (_args, ctx) => {
      await ensureLoaded();
      const { timestamp: ts } = await createMemoryBackup(DATA_DIR, store, entityStore);
      ctx.ui.notify(
        `💾 Backed up ${store.memories.length} memories → backups/memories-${ts}.json`,
        "info",
      );
    },
  });

  // ── Command: /restore-memory ───────────────────────────────────────────

  pi.registerCommand("restore-memory", {
    description: "Restore memory store from a backup snapshot",
    handler: async (_args, ctx) => {
      const files = await listMemoryBackups(DATA_DIR);

      if (files.length === 0) {
        ctx.ui.notify("No backups found. Run /backup-memory first.", "error");
        return;
      }

      const labels = await backupLabels(DATA_DIR, files);

      const choice = await ctx.ui.select("Restore from backup:", labels);
      if (!choice) return;

      const chosen = files[labels.indexOf(choice)];
      if (!chosen) return;

      const ok = await ctx.ui.confirm(
        "Restore memory store?",
        `This will REPLACE your current ${store.memories.length} memories with the backup. Continue?`,
      );
      if (!ok) return;

      // Auto-backup current state before restoring
      const { timestamp: safetyTs } = await createMemoryBackup(DATA_DIR, store, entityStore);

      // Load the chosen backup
      const restored = await loadMemoryBackup<MemoryStore>(DATA_DIR, chosen);
      await saveStore(restored);
      await restoreEntityBackup(DATA_DIR, chosen);

      // Rebuild in-memory index
      loaded = false;
      await ensureLoaded();

      ctx.ui.notify(
        `✅ Restored ${store.memories.length} memories from ${chosen}\n(Previous state auto-backed up as ${safetyTs})`,
        "info",
      );
    },
  });

  // /memories was retired in favor of /memory-wizard plus memory tools.

  const memoryDetector = registerMemoryDetector({
    pi,
    ensureLoaded,
    getStore: () => store,
    getBm25: () => bm25,
  });


  const memoryContext = registerUserMemoryContext({
    pi,
    ensureLoaded,
    getStore: () => store,
    getEntityStore: () => entityStore,
    pendingHints: memoryDetector.pendingHints,
    pendingClarifications: memoryDetector.pendingClarifications,
    hybridSearch: (prompt, topK) => hybridSearch(retrievalDeps(), prompt, topK),
  });

  // ── Session status ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    loaded         = false;
    memoryContext.resetSessionState();
    await ensureLoaded();

    // Auto-backup on session start (keeps last 10; prunes older ones)
    if (store.memories.length > 0) {
      try {
        await createMemoryBackup(DATA_DIR, store, entityStore);
        // Prune: keep only the 10 most recent backups
        await pruneMemoryBackups(DATA_DIR, 10);
      } catch { /* non-fatal */ }
    }
    // Session status disabled (noise reduction)
  });

  pi.on("session_shutdown", async () => {
    loaded = false;
    entityStore = { version: 1, entities: [] };
    memoryDetector.reset();
  });
}
