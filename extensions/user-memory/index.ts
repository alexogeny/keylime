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
import { BM25Index, TFIDFStore, tokenize } from "../shared/retrieval";
import { ageString } from "../shared/time-format";
import { rawTextFromContent } from "../shared/message-content";
import {
  type EntityStore,
  loadEntityStore, saveEntityStore,
} from "./entity.js";
import {
  registerMemoryWizardCommand,
  type ProfilePatch,
} from "./wizard.js";
import type { RememberParams as WizardRememberParams } from "./types.js";
import { decayedConfidence, loadStore, memoryText, saveStore, type Memory, type MemoryStore } from "./store.js";
import { cachedQueryEmbedding, checkOllama, embedText } from "./embeddings.js";
import { findDuplicateMemory, hybridSearch } from "./retrieval.js";
import { buildExpiryTrace } from "./lifecycle.js";
import { registerUserMemoryContext } from "./context-provider.js";
import { registerMemoryDetector } from "./memory-detector.js";
import { TEMPORAL_GATE_DAYS } from "./sensitivity.js";
import { currentProfile as currentProfileFromStore, rememberStructuredMemory as rememberStructuredMemoryWithDeps, updateProfile as updateProfileInStore } from "./memory-service.js";
import { autoBackupMemorySession, registerMemoryBackupCommands } from "./commands.js";
import { registerUserMemoryTools } from "./memory-tools.js";
import { registerMemoryEntityTools } from "./entity-tools.js";
import {
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
    return rememberStructuredMemoryWithDeps({
      store,
      entityStore,
      bm25,
      tfidf,
      persist,
      findDuplicate: (content, category) => findDuplicateMemory(retrievalDeps(), content, category),
      checkOllama,
      embedText,
    }, params);
  }

  async function currentProfile(): Promise<ProfilePatch> {
    await ensureLoaded();
    return currentProfileFromStore(store);
  }

  async function updateProfile(patch: ProfilePatch): Promise<{ text: string }> {
    await ensureLoaded();
    return updateProfileInStore(store, persist, patch);
  }

  // ── Command: memory-wizard ─────────────────────────────────────────────────

  registerMemoryWizardCommand(pi, updateProfile, async (params) => {
    const result = await rememberStructuredMemory(params);
    return { text: result.content[0]?.text ?? "Memory saved" };
  }, currentProfile);

  registerUserMemoryTools(pi, {
    ensureLoaded,
    getStore: () => store,
    getEntityStore: () => entityStore,
    rememberStructuredMemory,
    hybridSearch: (query, topK, filterFn) => hybridSearch(retrievalDeps(), query, topK, filterFn),
    persist,
    removeFromIndexes: (id) => { bm25.remove(id); tfidf.remove(id); },
    reindexMemory: (mem) => {
      const text = memoryText(mem);
      bm25.add(mem.id, text);
      tfidf.add(mem.id, text);
    },
    age,
  });

  registerMemoryEntityTools(pi, {
    ensureLoaded,
    getStore: () => store,
    getEntityStore: () => entityStore,
    age,
  });

  registerMemoryBackupCommands(pi, {
    getStore: () => store,
    getEntityStore: () => entityStore,
    ensureLoaded,
    markUnloaded: () => { loaded = false; },
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
    try {
      await autoBackupMemorySession(store, entityStore);
    } catch { /* non-fatal */ }
    // Session status disabled (noise reduction)
  });

  pi.on("session_shutdown", async () => {
    loaded = false;
    entityStore = { version: 1, entities: [] };
    memoryDetector.reset();
  });
}
