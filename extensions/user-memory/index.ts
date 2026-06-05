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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../shared/json-store";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerContextProvider } from "../shared/turn-context";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BM25Index, TFIDFStore, tokenize } from "../shared/retrieval";
import { createOllamaEmbedder } from "../shared/ollama-embeddings";
import { ageString, daysUntil, safeTimestampForFilename } from "../shared/time-format";
import { cosineSimilarity, jaccardText } from "../shared/similarity";
import {
  type Entity, type EntityStore, type ExtractedEntity,
  loadEntityStore, saveEntityStore,
  extractEntities, upsertEntity, unlinkMemory, queryEntities, findEntity,
} from "./entity.js";
import {
  type PendingClarification,
  detectThirdPartyShare, detectBorderlineScope, detectContradiction,
} from "./clarify.js";
import {
  registerMemoryWizardCommand,
  inferTimelineSubkindFromQuery,
  convertTimelineDraftToRememberParams,
  type ProfilePatch,
  type RememberParams as WizardRememberParams,
  type TimelineMemoryPayload,
  type TimelineSubkind,
} from "./wizard.js";

// ─── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR     = join(homedir(), ".pi", "data", "user-memory");
const MEMORY_FILE  = join(DATA_DIR, "memories.json");

// ─── Types ─────────────────────────────────────────────────────────────────────

type MemoryCategory = "preference" | "fact" | "event" | "goal" | "skill" | "context";

// Confidence half-lives in days — governs how quickly a memory loses relevance
const HALF_LIFE: Record<MemoryCategory, number | null> = {
  preference: 180,   // slow decay — preferences are sticky
  fact:       null,  // never decays — facts are facts
  event:      null,  // doesn't decay, just expires at event date
  goal:       45,    // moderate decay — goals change
  skill:      365,   // very slow decay — skills persist
  context:    14,    // fast decay — context changes quickly
};

// SensitivityTier is declared with its implementation after the memoryText() helper.
// TypeScript type aliases are hoisted so the interface reference below resolves fine.

interface Memory {
  id:               string;
  content:          string;            // The memory text — what is remembered
  category:         MemoryCategory;
  subcategory?:     string;            // freeform, e.g. "tooling", "running", "reading"
  tags:             string[];          // searchable tags
  confidence:       number;           // 0–1, decayed over time for applicable categories
  created_at:       number;           // unix ms
  updated_at:       number;           // unix ms
  expires_at?:      number;           // unix ms — for events, auto-remove after this date
  temporal:         boolean;          // is this time-bound?
  date_ref?:        string;           // human-readable date ("2026-08-15", "every Monday", etc.)
  source_session?:  string;           // which session created this
  supersedes?:      string[];         // IDs of older memories this one replaces
  embedding?:       number[];         // neural embedding if Ollama available
  tfidf?:           Record<string, number>; // TF-IDF term vector for pure-TS cosine
  // ── Evolution fields ──
  mentions:         number;           // how many times reinforced (starts at 1)
  first_seen:       number;           // = created_at for new memories
  promoted_from?:   MemoryCategory;   // if auto-promoted, the original category
  promoted_at?:     number;           // when promotion occurred
  // ── Entity graph ──
  entity_refs:      string[];         // entity IDs extracted from this memory's content
  // ── Sensitivity ──
  sensitivity?:     SensitivityTier;  // injection control (default: "general")
  trace_only?:      boolean;          // true = minimal episodic trace, not for active injection
  source_memories?: string[];         // for narrative/summary memories, IDs of originals
  // ── Structured temporal profile memories ──
  timeline?: TimelineMemoryPayload;   // first-class multi-entry temporal profile/history data
}

interface ProfileMetric {
  value: string | number;
  unit?: string;
  measured_at?: string;
}

type UserProfile = Record<string, Record<string, string | number | ProfileMetric | ProfileMetric[] | undefined>>;

interface MemoryStore {
  version:  4;
  profile:  UserProfile;
  memories: Memory[];
}

// ─── Shared lexical retrieval (BM25 + TF-IDF) ────────────────────────────────

// ─── Ollama (optional neural embeddings) ──────────────────────────────────────

const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL ?? "nomic-embed-text";
const ollama = createOllamaEmbedder({ model: EMBED_MODEL, tagsTimeoutMs: 1200, embedTimeoutMs: 8000 });

async function checkOllama(): Promise<boolean> {
  return ollama.check();
}

async function embedText(text: string): Promise<number[] | null> {
  return ollama.embed(text);
}

// ─── Jaccard similarity (token-set overlap, fast dedup fallback) ──────────────

function jaccard(a: string, b: string): number {
  return jaccardText(a, b);
}

// ─── Confidence decay ──────────────────────────────────────────────────────────

function decayedConfidence(mem: Memory, now: number): number {
  const hl = HALF_LIFE[mem.category];
  if (hl === null) return mem.confidence;
  const daysSince = (now - mem.updated_at) / 86_400_000;
  return mem.confidence * Math.exp(-daysSince * Math.LN2 / hl);
}

// ─── Storage ──────────────────────────────────────────────────────────────────

async function loadStore(): Promise<MemoryStore> {
  try {
    const raw = await readJsonFile<MemoryStore>(MEMORY_FILE, { version: 4, profile: {}, memories: [] });
    raw.memories ||= [];
    raw.profile ||= {};
    // Migrate v2 → v3: backfill evolution + entity fields
    if ((raw.version as number) < 3) {
      for (const m of raw.memories) {
        if (m.mentions     == null) m.mentions    = 1;
        if (m.first_seen   == null) m.first_seen  = m.created_at;
        if (m.entity_refs  == null) m.entity_refs = [];
      }
    }
    raw.version = 4;
    return raw;
  } catch { return { version: 4, profile: {}, memories: [] }; }
}

async function saveStore(store: MemoryStore): Promise<void> {
  await writeJsonFile(MEMORY_FILE, store);
}

// ─── Memory text for indexing ─────────────────────────────────────────────────

function memoryText(m: Memory): string {
  const parts = [m.content];
  if (m.subcategory) parts.push(m.subcategory);
  if (m.tags.length) parts.push(m.tags.join(" "));
  if (m.date_ref)    parts.push(m.date_ref);
  if (m.timeline) {
    parts.push("profile.timeline", m.timeline.subkind, m.timeline.label ?? "");
    parts.push(...Object.values(m.timeline.data).map(String));
    if (m.timeline.notes) parts.push(m.timeline.notes);
    if (m.timeline.interval.start?.value) parts.push(m.timeline.interval.start.value);
    if (m.timeline.interval.end?.value) parts.push(m.timeline.interval.end.value);
    if (m.timeline.interval.current) parts.push("present current now");
  }
  return parts.filter(Boolean).join(" ");
}

function sortableTimelineDate(value: string | undefined, current = false): number | undefined {
  if (current) return Number.POSITIVE_INFINITY;
  if (!value) return undefined;
  const match = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2] ?? "01");
  const day = Number(match[3] ?? "01");
  return Date.UTC(year, month - 1, day);
}

function timelineOverlaps(a: TimelineMemoryPayload, b: TimelineMemoryPayload): boolean {
  const aStart = sortableTimelineDate(a.interval.start?.value) ?? Number.NEGATIVE_INFINITY;
  const aEnd = sortableTimelineDate(a.interval.end?.value, a.interval.current) ?? Number.POSITIVE_INFINITY;
  const bStart = sortableTimelineDate(b.interval.start?.value) ?? Number.NEGATIVE_INFINITY;
  const bEnd = sortableTimelineDate(b.interval.end?.value, b.interval.current) ?? Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}

export function temporalContextForMemory(memory: Memory, memories: Memory[], limit = 6): Memory[] {
  if (!memory.timeline) return [];
  return memories
    .filter(candidate => candidate.id !== memory.id && candidate.timeline && timelineOverlaps(memory.timeline!, candidate.timeline))
    .slice(0, limit);
}

export function shouldPromptToAddTimelineMemory(query: string, hits: Array<{ memory: Memory; score: number }>, threshold = 0.22): { shouldPrompt: boolean; inferredSubkind?: TimelineSubkind } {
  const inferredSubkind = inferTimelineSubkindFromQuery(query);
  const timelineHits = hits.filter(hit => hit.memory.timeline || hit.memory.subcategory?.startsWith("timeline/"));
  const bestTimelineScore = timelineHits[0]?.score ?? 0;
  return { shouldPrompt: !!inferredSubkind && bestTimelineScore < threshold, inferredSubkind };
}

function splitLinkedNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(splitLinkedNames);
  if (typeof value !== "string") return [];
  return value.split(",").map(part => part.trim()).filter(Boolean);
}

function relationshipSubtype(value: unknown): string {
  const text = String(value ?? "").toLowerCase();
  if (/mum|mom|mother|dad|father|parent|sister|brother|sibling|cousin|aunt|uncle|grand|wife|husband|spouse|partner|son|daughter/.test(text)) return "family";
  if (/boss|manager|colleague|coworker|teammate|mentor|client/.test(text)) return "work";
  if (/doctor|therapist|gp|psych/.test(text)) return "health";
  return "social";
}

function uniqueStructuredEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  return entities.filter(entity => {
    const key = `${entity.type}:${entity.subtype ?? ""}:${entity.canonical.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function timelineLinkedEntities(timeline: TimelineMemoryPayload | undefined): ExtractedEntity[] {
  if (!timeline) return [];
  const entities: ExtractedEntity[] = [];
  const data = timeline.data ?? {};
  const add = (raw: string, type: ExtractedEntity["type"], subtype?: string) => {
    const canonical = raw.trim();
    if (!canonical) return;
    entities.push({ raw: canonical, canonical, type, subtype, source: "proper_noun" });
  };

  if (timeline.subkind === "person") {
    const name = String(data.name ?? timeline.label ?? "").trim();
    if (name) add(name, "person", relationshipSubtype(data.relationship));
  }
  if (timeline.subkind === "life_event" || timeline.subkind === "relationship" || timeline.subkind === "custom") {
    for (const person of splitLinkedNames(data.people)) add(person, "person", "social");
    for (const place of splitLinkedNames(data.places)) add(place, "place");
  }
  if (timeline.subkind === "employment") {
    const employer = String(data.employer ?? timeline.label ?? "").trim();
    if (employer) add(employer, "organization", "work");
    for (const person of splitLinkedNames(data.people)) add(person, "person", "work");
  }
  if (timeline.subkind === "education") {
    const institution = String(data.institution ?? timeline.label ?? "").trim();
    if (institution) add(institution, "organization", "education");
    for (const person of splitLinkedNames(data.people)) add(person, "person", "education");
  }
  if (timeline.subkind === "residence") {
    for (const place of [data.street, data.city, data.region, data.country, data.places].flatMap(splitLinkedNames)) add(place, "place");
    for (const person of splitLinkedNames(data.people)) add(person, "person", "social");
  }
  if (timeline.subkind === "pet") {
    const name = String(data.name ?? timeline.label ?? "").trim();
    if (name) add(name, "person", "pet");
  }

  return uniqueStructuredEntities(entities);
}

function memoryEntities(content: string, timeline?: TimelineMemoryPayload): ExtractedEntity[] {
  return uniqueStructuredEntities([...extractEntities(content), ...timelineLinkedEntities(timeline)]);
}

// ─── Human-readable age ───────────────────────────────────────────────────────

// ─── Sensitivity tier inference ─────────────────────────────────────────────
type SensitivityTier = "baseline" | "context_gated" | "temporal_gated" | "general";
const TEMPORAL_GATE_DAYS = 7;
const BASELINE_SUBCATS      = new Set(["identity","health","neurodivergent","disability"]);
const BASELINE_CONTENT_TOKS = new Set(["antidepressant","antidepressants","adhd","autism","bisexual","gay","lesbian","queer","trans","nonbinary","disability","chronic"]);
const CONTEXT_GATED_SUBCATS = new Set(["financial","infidelity","relationship-secret"]);
const GRIEF_TOKENS          = new Set(["died","death","passed","funeral","grief","loss","buried","cremated","miscarriage","stillborn"]);

function inferSensitivityTier(mem: Pick<Memory,"category"|"subcategory"|"content"|"tags">): SensitivityTier {
  const sub  = (mem.subcategory ?? "").toLowerCase();
  const toks = new Set(tokenize(mem.content));
  const tags = new Set(mem.tags.map(t => t.toLowerCase()));
  if (BASELINE_SUBCATS.has(sub))                                              return "baseline";
  if ([...BASELINE_CONTENT_TOKS].some(t => toks.has(t) || tags.has(t)))      return "baseline";
  if (CONTEXT_GATED_SUBCATS.has(sub))                                         return "context_gated";
  if (mem.category==="fact" && sub==="financial" && /\$[\d,]+|\d+k/.test(mem.content)) return "context_gated";
  if ([...GRIEF_TOKENS].some(t => toks.has(t)))                              return "temporal_gated";
  return "general";
}

// ─── Expiry-to-trace ──────────────────────────────────────────────────────────
// Validated r5: events+career+medical → compressed trace. Relationship context
// → minimal timestamp note. Transient emotional states → full delete.
const TRACE_EVENT_SUBCATS    = new Set(["career","work","medical","health","running","fitness","financial","family","education"]);
const TRACE_RELATION_SUBCATS = new Set(["relationship","family","work-relationship"]);

function buildExpiryTrace(expired: Memory, now: number): Memory | null {
  const sub = (expired.subcategory ?? "").toLowerCase();
  if (expired.category==="event" || TRACE_EVENT_SUBCATS.has(sub)) {
    const date = new Date(expired.created_at).toLocaleDateString("en-AU",{month:"long",year:"numeric"});
    return { ...expired, id:randomUUID(),
      content:`[Trace] ${expired.content.slice(0,80)}${expired.content.length>80?"...": ""} — ${date}`,
      expires_at:undefined, temporal:false, confidence:0.8,
      trace_only:true, source_memories:[expired.id], created_at:now, updated_at:now,
      mentions:1, first_seen:expired.first_seen };
  }
  if (TRACE_RELATION_SUBCATS.has(sub) && expired.category==="context") {
    const date  = new Date(expired.created_at).toLocaleDateString("en-AU",{month:"long",year:"numeric"});
    const brief = expired.content.slice(0,40).split(",")[0];
    return { ...expired, id:randomUUID(),
      content:`[Trace] Context note around ${date}: ${brief}`,
      expires_at:undefined, temporal:false, confidence:0.5,
      trace_only:true, source_memories:[expired.id], created_at:now, updated_at:now,
      mentions:1, first_seen:expired.first_seen };
  }
  return null;
}

// ─── Job chapter meta-memory ──────────────────────────────────────────────────
// Validated r5 #18: keep individual memories AND add a narrative chapter when
// 3+ work-friction memories accumulate for the same employer entity.
const WORK_FRICTION_SUBCATS = new Set(["work","work-relationship","work-style","career","financial"]);

function shouldCreateJobChapter(memories: Memory[], entityName: string): { should: boolean; sources: string[] } {
  const friction = memories.filter(m =>
    WORK_FRICTION_SUBCATS.has((m.subcategory??"").toLowerCase()) && !m.trace_only);
  if (friction.length < 3) return { should:false, sources:[] };
  const exists = memories.some(m => m.trace_only && m.content.includes("[Chapter]") &&
    m.content.toLowerCase().includes(entityName.toLowerCase()));
  if (exists) return { should:false, sources:[] };
  return { should:true, sources:friction.map(m=>m.id) };
}

function buildJobChapter(entityName: string, frictionMemories: Memory[], now: number): Memory {
  const dates  = frictionMemories.map(m=>m.created_at).sort((a,b)=>a-b);
  const from   = new Date(dates[0]).toLocaleDateString("en-AU",{month:"short",year:"numeric"});
  const to     = new Date(dates[dates.length-1]).toLocaleDateString("en-AU",{month:"short",year:"numeric"});
  const period = from===to ? from : `${from}–${to}`;
  const themes = [...new Set(frictionMemories.map(m=>m.subcategory??m.category))].slice(0,3).join(", ");
  return { id:randomUUID(),
    content:`[Chapter] ${entityName} (${period}): recurring friction across ${themes}. ${frictionMemories.length} related memories.`,
    category:"context", subcategory:"job-chapter",
    tags:[entityName.toLowerCase(),"work","chapter","narrative"],
    confidence:0.9, created_at:now, updated_at:now, temporal:false,
    mentions:1, first_seen:now, entity_refs:[], trace_only:false,
    source_memories:frictionMemories.map(m=>m.id) };
}

function age(ts: number): string {
  const text = ageString(ts);
  if (!text.endsWith("d ago")) return text;
  const days = Number(text.slice(0, -5));
  return days < 365 ? text : `${Math.round(days / 365)}y ago`;
}

// ─── Context injection helpers ─────────────────────────────────────────────────────────────

/** Extract plain text from a user message content (string or content block array). */
function extractMsgText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text as string)
      .join("\n");
  }
  return "";
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

interface FeatureGroup {
  name:    string;
  weight:  number;
  tokens:  Set<string>;
}

const FEATURE_GROUPS: FeatureGroup[] = [
  {
    // Strong explicit preference language
    name:   "preference_strong",
    weight: 3.5,
    tokens: new Set([
      "prefer", "love", "hate", "despise", "dislike", "enjoy", "adore",
      "always", "never", "non-negotiable", "must", "only", "exclusively",
      "favourite", "favorite", "best", "worst",
    ]),
  },
  {
    // Comparison / substitution language — "X over Y", "X instead of Y"
    name:   "comparison",
    weight: 2.5,
    tokens: new Set([
      "over", "instead", "rather", "versus", "vs", "avoid",
      "ditch", "ditched", "switch", "switched", "migrated", "moved",
      "replaced", "dropped", "abandoned", "chose", "chosen", "pick", "picked",
    ]),
  },
  {
    // Personal ownership — elevates signal when combined with others
    name:   "personal",
    weight: 1.5,
    tokens: new Set(["i", "my", "mine", "we", "our", "im", "ive", "ill"]),
  },
  {
    // Temporal / event language — high standalone weight
    name:   "temporal",
    weight: 4.0,
    tokens: new Set([
      "marathon", "ultramarathon", "race", "triathlon", "ironman",
      "deadline", "due", "launch", "release", "ship", "shipped", "go-live",
      "birthday", "anniversary", "wedding", "graduation", "holiday",
      "appointment", "meeting", "interview", "conference", "summit", "event",
      "training", "scheduled", "booked", "registered", "signed", "enrolled",
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ]),
  },
  {
    // Biographical fact / lifestyle assertions
    name:   "fact_assertion",
    weight: 2.0,
    tokens: new Set([
      "work", "job", "role", "position", "title", "company", "employer", "firm",
      "live", "based", "located", "moved", "relocated",
      "read", "reading", "book", "novel", "currently",
      "run", "running", "train", "training", "gym", "swim", "cycle", "hike", "walk",
      "eat", "diet", "vegan", "vegetarian",
    ]),
  },
  {
    // Goal / aspiration language
    name:   "goal",
    weight: 2.5,
    tokens: new Set([
      "want", "plan", "planning", "trying", "goal", "aim", "target",
      "hoping", "aiming", "working", "building", "learning", "studying",
      "achieve", "complete", "finish", "ship",
    ]),
  },
  {
    // Correction / update language — signals a preference change
    name:   "correction",
    weight: 3.0,
    tokens: new Set([
      "actually", "correction", "wrong", "changed", "updated",
      "wait", "meant", "anymore", "nevermind", "scratch",
    ]),
  },
  {
    // Recurrence markers — "again" / "keeps" / "every time" elevates a single
    // event or vent to a PATTERN fact worth storing.
    // "the PR got rejected again" → not a vent, a recurring friction pattern.
    name:   "recurrence",
    weight: 3.5,
    tokens: new Set([
      "again", "keeps", "always", "every", "constantly", "repeatedly",
      "never", "pattern", "habit", "chronic", "ongoing", "still", "continue",
    ]),
  },
  {
    // Short-lived context — "today" / "this week" etc. = temporal anchor
    name:   "temporal_context",
    weight: 2.0,
    tokens: new Set([
      "today", "tonight", "morning", "afternoon", "evening",
      "currently", "right now", "atm", "this week", "lately", "recently",
    ]),
  },
  {
    // Hyperbolic frustration — "literally dying", "going to kill me", "insane"
    // These sound like noise but are strong emotional signals about recurring
    // situations.  Validated rounds 2 + 4: "that meeting was a waste of time"
    // and "literally going to die in planning meetings" both confirmed as memory.
    name:   "hyperbolic_frustration",
    weight: 2.5,
    tokens: new Set([
      "literally", "dying", "killing", "kill", "die", "dead", "insane",
      "insanity", "torture", "unbearable", "insufferable", "nightmare",
      "impossible", "absurd", "ridiculous",
    ]),
  },
];

// ── Significant life event vocabulary ─────────────────────────────────────────
// Events that are biographical facts fixed in time, regardless of temporal anchor.
// "my dog died yesterday" → permanent, not 2d.
// "diagnosed last week" → permanent health fact, not 7d.

const SIGNIFICANT_EVENT_TOKENS = new Set([
  // Death / loss
  "died", "death", "passed", "funeral", "buried", "cremated", "killed", "lost",
  // Medical
  "diagnosed", "diagnosis", "cancer", "surgery", "hospitalised", "hospitalized",
  "transplant", "stroke", "heart", "overdosed", "collapsed",
  // Birth / family
  "born", "birth", "pregnant", "miscarriage", "stillborn", "adopted",
  // Major life
  "married", "divorced", "separated", "engaged", "wedding", "graduation",
  "fired", "redundant", "redundancy", "bankrupt", "arrested", "assaulted",
]);

// ── Activity-class anchors ───────────────────────────────────────────────────
// Activities that are inherently multi-week even if the anchor phrase is "this week".
// "applying for jobs this week" → 30d (job search is months-long)
// "had chemo this week" → 30d (treatment is months-long)

const ACTIVITY_CLASS_TOKENS = new Set([
  // Job search
  "applying", "applications", "interviewing", "interviews", "headhunter", "recruiter",
  // Medical — treatment and pending results both span weeks
  "chemo", "chemotherapy", "radiation", "physio", "physiotherapy", "rehab",
  "treatment", "counselling", "counseling",
  "bloodwork", "biopsy", "scan", "mri", "ultrasound", "xray",
  "appointment", "referral", "followup", "results", "awaiting", "waiting",
  // Major purchases
  "house", "apartment", "mortgage", "deposit", "auction", "inspection",
  // Life transitions
  "moving", "relocating", "visa", "immigration",
]);

// Feature group names that, when combined with temporal_context alone, suggest
// a short-lived context memory rather than a permanent fact.
// These get a 2-day expiry when stored.
const SHORT_LIVED_FEATURES = new Set(["temporal_context", "fact_assertion"]);

// Tokens that suppress detection when dominant — pure task commands are not memories
const TASK_SUPPRESSORS = new Set([
  "implement", "fix", "refactor", "debug", "write", "create", "build",
  "delete", "remove", "add", "update", "change", "modify", "edit",
  "run", "execute", "test", "deploy", "check", "review", "explain",
  "show", "list", "print", "generate", "make", "give", "help", "please",
  "can", "could", "would", "should", "shall", "will", "let", "open",
]);

interface SignalScore {
  score:        number;
  features:     string[];   // which groups fired
  suppressed:   boolean;    // dominated by task commands
}

function scoreSegment(text: string): SignalScore {
  const tokens = tokenize(text);
  if (tokens.length < 4) return { score: 0, features: [], suppressed: false };

  // Suppression: if >28% of tokens are task commands, this is a task, not a memory
  const taskHits = tokens.filter(t => TASK_SUPPRESSORS.has(t)).length;
  const suppressed = taskHits / tokens.length > 0.28;

  const tset    = new Set(tokens);
  const features: string[] = [];
  let score = 0;

  for (const group of FEATURE_GROUPS) {
    let hits = 0;
    for (const t of tset) if (group.tokens.has(t)) hits++;
    if (hits > 0) {
      score += group.weight * Math.min(hits, 2);
      features.push(group.name);
    }
  }

  return { score, features, suppressed };
}

// ── Segment extractor ──────────────────────────────────────────────────────────
// Splits text on sentence boundaries (punctuation + newlines), scores each
// segment, returns candidates above threshold sorted by score descending.
// This is structural splitting, not pattern matching on content.

const LOW_SIGNAL_THRESHOLD  = 2.3;   // worth queuing (LLM will decide — favour recall over precision)
const HIGH_SIGNAL_THRESHOLD = 5.5;   // confident hit — inject with higher weight

interface TextCandidate {
  text:     string;
  score:    number;
  features: string[];
}

function extractCandidates(rawText: string): TextCandidate[] {
  // Split on sentence-ending punctuation and newlines
  const segments = rawText
    .split(/[.!?;\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  const out: TextCandidate[] = [];
  for (const seg of segments) {
    const { score, features, suppressed } = scoreSegment(seg);
    if (!suppressed && score >= LOW_SIGNAL_THRESHOLD) {
      out.push({ text: seg, score, features });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Category prototype classifier ─────────────────────────────────────────────
// One dense prototype document per memory category.  TF-IDF cosine picks the
// best-matching category.  This is the SetFit equivalent — hand-crafted centroids
// instead of learned ones.  Catches synonyms and paraphrases through token overlap.
//
// Keys: all the discriminative tokens for that category, space-separated.
// Breadth > depth — more unique tokens per prototype is better than long sentences.

const CATEGORY_PROTOTYPES: Record<MemoryCategory, string> = {
  preference:
    "prefer use tool framework library package manager always never instead over versus like hate enjoy dislike " +
    "workflow style editor language runtime choice switch switched migrated replaced avoid ditch exclusively " +
    "favourite favorite best worst non-negotiable must only bun npm yarn pnpm uv pip conda poetry brew apt " +
    "vscode neovim vim emacs cursor dark light theme font keyboard shortcut tdd testing approach methodology",

  fact:
    "work job company role position based live city country book read reading favourite hobby sport " +
    "run swim gym cycle hike background experience biography age name diet vegan vegetarian family " +
    "partner spouse child dog cat pet house flat apartment commute remote office hybrid",

  event:
    "marathon race ultramarathon triathlon deadline birthday anniversary wedding graduation holiday " +
    "meeting appointment interview conference summit launch release ship date scheduled booked registered " +
    "enrolled signed training january february march april may june july august september october november december",

  goal:
    "want plan planning trying goal aim target hoping aiming working building learning studying " +
    "achieve complete finish ship improve get better reach hit milestone project personal professional",

  skill:
    "know expert proficient experienced learning studying mastering understand familiar comfortable " +
    "beginner intermediate advanced certified qualified rust typescript python go java kotlin swift " +
    "react nextjs postgres sql nosql docker kubernetes aws gcp azure",

  context:
    "project current working building configured stack environment setup using active deployed running " +
    "repository codebase module service api database schema migration team sprint backlog feature bug",
};

// Pre-built TF-IDF store for prototype classification — built once at module load
function buildPrototypeClassifier(): TFIDFStore {
  const store = new TFIDFStore();
  for (const [cat, text] of Object.entries(CATEGORY_PROTOTYPES)) {
    store.add(cat, text);
  }
  return store;
}

const PROTO_CLASSIFIER = buildPrototypeClassifier();

function classifyCategory(text: string): { category: MemoryCategory; confidence: number } {
  const results = PROTO_CLASSIFIER.search(text, 6);
  if (results.length === 0) return { category: "fact", confidence: 0 };
  const top = results[0];
  return { category: top.id as MemoryCategory, confidence: top.score };
}

// ── Expiry tiers ────────────────────────────────────────────────────────────────
//
// null = permanent (no expiry)
// Tiers map human-readable signals to how long a memory should live:
//   2d  — today-scoped: "today", "tonight", "right now", "atm"
//   7d  — this-week:    "this week", "lately", "recently", "past few days"
//   30d — this-month:   "these days", "this month", "for now", "at the moment"
//         also the default for moderate ambiguous signals ("default to store" rule)
//   null — permanent:   strong preferences, patterns, identity, biographical facts

type ExpiryTier = "2d" | "7d" | "30d" | null;

const TIER_2D_TOKENS  = new Set(["today","tonight","morning","afternoon","evening","rn","atm"]);
const TIER_7D_PHRASES = ["this week","past few days","past couple days","last few days"];
const TIER_7D_TOKENS  = new Set(["recently","yesterday","earlier"]);  // 'lately' moved to 30d
const TIER_30D_PHRASES= ["these days","this month","for now","right now","at the moment","at this point","currently"];
const TIER_30D_TOKENS = new Set(["currently","nowadays","lately"]);  // 'lately' = weeks not days

function inferExpiryTier(
  text:       string,
  features:   string[],
  score:      number,
): ExpiryTier {
  const featureSet = new Set(features);
  const tokens     = new Set(tokenize(text));
  const rawLower   = text.toLowerCase();

  // Rule 1 — Permanent: strong preference/pattern/identity facts never expire
  if (featureSet.has("recurrence"))                                         return null;
  if (featureSet.has("preference_strong") && featureSet.has("comparison")) return null;
  if (featureSet.has("preference_strong") && score >= HIGH_SIGNAL_THRESHOLD) return null;

  // Rule 2 — Significant life events are biographical facts, always permanent.
  // "my dog died yesterday" → permanent regardless of 'yesterday' anchor.
  if ([...SIGNIFICANT_EVENT_TOKENS].some(t => tokens.has(t)))               return null;

  // Rule 3 — Activity-class bump: inherently multi-week activities → 30d minimum,
  // overriding shorter temporal anchors.
  // "applying for jobs this week" → 30d, not 7d.
  const isActivityClass = [...ACTIVITY_CLASS_TOKENS].some(t => tokens.has(t));

  // Rule 4 — Recurrence hints bump tier up.  Count the signals — multiple
  // recurrence markers mean the pattern is establishing → jump straight to 30d.
  const recurrenceWords = (rawLower.match(/\b(again|second|third|fourth|fifth|keep|keeps|still|another|twice|times)\b/g) || []).length;
  const hasMildRecurrence = recurrenceWords >= 1;
  const hasStrongRecurrence = recurrenceWords >= 2 || featureSet.has("recurrence");

  // Now apply temporal anchors, modified by rules 3 and 4

  // 2d: today-scoped (NOT overridden by activity class — 2d meta-instructions are still 2d)
  const is2d = [...TIER_2D_TOKENS].some(t => tokens.has(t));
  if (is2d && !isActivityClass && !hasMildRecurrence)                       return "2d";
  if (is2d && hasStrongRecurrence)                                          return "30d"; // multiple recurrence signals
  if (is2d && hasMildRecurrence)                                            return "7d";  // one recurrence signal

  // 7d baseline → bump to 30d if activity class or mild recurrence
  const is7d = TIER_7D_PHRASES.some(p => rawLower.includes(p)) ||
               [...TIER_7D_TOKENS].some(t => tokens.has(t));
  if (is7d && (isActivityClass || hasMildRecurrence))                       return "30d";
  if (is7d)                                                                 return "7d";

  // 30d: explicit medium-duration anchors
  if (TIER_30D_PHRASES.some(p => rawLower.includes(p)))                     return "30d";
  if ([...TIER_30D_TOKENS].some(t => tokens.has(t)))                        return "30d";
  if (isActivityClass)                                                      return "30d";

  // Default for moderate signals: 30d ("default to store" rule)
  if (score < HIGH_SIGNAL_THRESHOLD)                                        return "30d";

  // High-confidence, no anchor — permanent
  return null;
}

/** Convert an ExpiryTier to a unix-ms expiry from now. */
function tierToMs(tier: ExpiryTier): number | undefined {
  if (!tier) return undefined;
  const days = tier === "2d" ? 2 : tier === "7d" ? 7 : 30;
  return Date.now() + days * 86_400_000;
}

// ── Pending hint type ──────────────────────────────────────────────────────────

interface DetectedHint {
  text:        string;
  category:    MemoryCategory;
  features:    string[];
  score:       number;      // feature signal score
  confidence:  number;      // prototype classifier confidence
  novelty:     number;      // 0=already known, 1=fully novel
  expiry:      ExpiryTier;  // null=permanent, "2d"/"7d"/"30d" = short-lived
  isPattern:   boolean;     // true = recurrence marker detected
  turnIndex?:  number;
}

// ─── Extension ────────────────────────────────────────────────────────────────

function profileValueText(value: string | number | ProfileMetric | ProfileMetric[] | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(profileValueText).filter(Boolean).join("; ");
  if (typeof value === "object") return `${value.value}${value.unit ? ` ${value.unit}` : ""}${value.measured_at ? ` measured at ${value.measured_at}` : ""}`;
  return String(value);
}

function profileContextLines(profile: UserProfile): string[] {
  const lines: string[] = [];
  for (const [section, fields] of Object.entries(profile)) {
    const parts = Object.entries(fields)
      .map(([key, value]) => [key, profileValueText(value)] as const)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`);
    if (parts.length) lines.push(`- (${section}) ${parts.join("; ")}`);
  }
  return lines;
}

function profileSearchLines(profile: UserProfile, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const matches: string[] = [];
  for (const [section, fields] of Object.entries(profile)) {
    for (const [key, value] of Object.entries(fields)) {
      const text = profileValueText(value);
      const haystack = `${section} ${key} ${text}`.toLowerCase();
      if (text && haystack.includes(q)) matches.push(`[profile/${section}] ${key}: ${text}`);
    }
  }
  return matches.slice(0, limit);
}

export default function userMemoryExtension(pi: ExtensionAPI) {

  // In-memory index — rebuilt once per session, updated incrementally on writes
  let bm25   = new BM25Index();
  let tfidf  = new TFIDFStore();
  let store:        MemoryStore = { version: 4, profile: {}, memories: [] };
  let entityStore:  EntityStore = { version: 1, entities: [] };
  let loaded = false;

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

  // ── Promotion logic ──────────────────────────────────────────────────────────────────
  //
  // Called after mentions is incremented on an existing memory.
  // Rules (ordered, first match wins):
  //   context + shortLived (expires_at set) + mentions ≥ 2  →  fact
  //   context (not shortLived)              + mentions ≥ 3  →  fact
  //   event                                + mentions ≥ 2  →  fact  (confirmed recurring)
  // A promoted memory loses its expiry, gains promoted_from + promoted_at.

  function checkPromotion(mem: Memory, now: number): { promoted: boolean; note: string } {
    if (mem.promoted_from) return { promoted: false, note: "" }; // already promoted

    let shouldPromote = false;
    // Time-limited context (any tier) that recurs → promote to permanent fact
    if (mem.category === "context" && mem.expires_at && mem.mentions >= 2) shouldPromote = true;
    // Permanent context (stored without expiry) that recurs even more → promote to fact
    if (mem.category === "context" && !mem.expires_at && mem.mentions >= 3) shouldPromote = true;
    // Events that recur → confirmed recurring fact
    if (mem.category === "event"   && mem.mentions >= 2)                     shouldPromote = true;

    if (!shouldPromote) return { promoted: false, note: "" };

    const from         = mem.category;
    mem.category       = from === "event" ? "fact" : "fact";
    mem.promoted_from  = from;
    mem.promoted_at    = now;
    mem.expires_at     = undefined;   // permanent now
    mem.confidence     = Math.min(1, mem.confidence + 0.2); // confidence boost
    const note = `⬆️ Promoted from ${from} → fact after ${mem.mentions} mentions`;
    return { promoted: true, note };
  }

  // ── Hybrid search ─────────────────────────────────────────────────────────
  //
  // 1. BM25 retrieves top-20 candidates (fast full-text)
  // 2. TF-IDF cosine reranks candidates (deterministic vector similarity)
  // 3. Ollama cosine overrides if neural embeddings available
  //
  // Final score = 0.45 * bm25_norm + 0.55 * cosine

  async function hybridSearch(
    query:        string,
    topK:         number,
    filterFn?:    (m: Memory) => boolean,
  ): Promise<Array<{ memory: Memory; score: number }>> {
    await ensureLoaded();
    const memMap = new Map(store.memories.map(m => [m.id, m]));
    let pool = store.memories;
    if (filterFn) pool = pool.filter(filterFn);
    const poolIds = new Set(pool.map(m => m.id));

    // BM25 stage — retrieve 3× topK candidates
    const bm25Hits = bm25.search(query, topK * 3).filter(h => poolIds.has(h.id));
    const maxBM25  = bm25Hits[0]?.score ?? 1;
    const bm25Map  = new Map(bm25Hits.map(h => [h.id, h.score / maxBM25]));

    // Determine candidate set: BM25 hits + ensure we don't miss anything for small pools
    const candidateIds = bm25Hits.length >= Math.min(pool.length, topK * 2)
      ? bm25Hits.map(h => h.id)
      : pool.map(m => m.id);

    // Neural cosine (Ollama) if available — otherwise TF-IDF cosine
    const useNeural = await checkOllama();
    const qEmbed = useNeural ? await embedText(query) : null;
    const cosineMap = new Map<string, number>();

    if (qEmbed) {
      for (const id of candidateIds) {
        const mem = memMap.get(id);
        if (!mem) continue;
        if (mem.embedding) {
          cosineMap.set(id, cosineSimilarity(qEmbed, mem.embedding));
        } else {
          // Fall back to TF-IDF for memories without stored embedding
          cosineMap.set(id, tfidf.search(query, 1, [id])[0]?.score ?? 0);
        }
      }
    } else {
      const tfidfHits = tfidf.search(query, candidateIds.length, candidateIds);
      for (const { id, score } of tfidfHits) cosineMap.set(id, score);
    }

    // Normalize cosine scores
    const maxCos = Math.max(...cosineMap.values(), 0.001);

    // Combine: BM25 40% + cosine 55% + confidence 5%
    const now = Date.now();
    const results: Array<{ memory: Memory; score: number }> = [];
    for (const id of candidateIds) {
      const mem = memMap.get(id);
      if (!mem) continue;
      const bm25s   = (bm25Map.get(id)    ?? 0);
      const cosines = (cosineMap.get(id)  ?? 0) / maxCos;
      const conf    = decayedConfidence(mem, now);
      const score   = 0.40 * bm25s + 0.55 * cosines + 0.05 * conf;
      if (score > 0.01) results.push({ memory: mem, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ── Deduplication gate ────────────────────────────────────────────────────
  //
  // Before inserting, check if a semantically equivalent memory exists.
  // Returns the duplicate memory if found, null otherwise.

  async function findDuplicate(
    content:  string,
    category: MemoryCategory,
  ): Promise<Memory | null> {
    if (store.memories.length === 0) return null;

    // Stage 1: BM25 fast retrieval of candidates
    const candidates = bm25.search(content, 8).map(h => h.id);
    if (candidates.length === 0) return null;

    // Stage 2: Jaccard similarity for fast exact-near-duplicate detection
    // 0.55 threshold: 55% token overlap is unambiguously the same preference/fact
    const memMap = new Map(store.memories.map(m => [m.id, m]));
    for (const id of candidates) {
      const mem = memMap.get(id);
      if (!mem) continue;
      if (jaccard(content, mem.content) > 0.55) return mem;
    }

    // Stage 3: TF-IDF cosine for semantic dedup (same category only)
    const cosHits = tfidf.search(content, 5, candidates);
    for (const { id, score } of cosHits) {
      const mem = memMap.get(id);
      if (!mem) continue;
      if (mem.category === category && score > 0.88) return mem;
    }

    // Stage 4: Neural cosine if Ollama available
    if (await checkOllama()) {
      const qEmbed = await embedText(content);
      if (qEmbed) {
        for (const id of candidates) {
          const mem = memMap.get(id);
          if (!mem?.embedding) continue;
          if (mem.category === category && cosineSimilarity(qEmbed, mem.embedding) > 0.92) return mem;
        }
      }
    }

    return null;
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
    const dup = await findDuplicate(params.content, params.category);
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
      const backupDir = join(DATA_DIR, "backups");
      await mkdir(backupDir, { recursive: true });
      const ts  = safeTimestampForFilename();
      const mDst = join(backupDir, `memories-${ts}.json`);
      const eDst = join(backupDir, `entities-${ts}.json`);
      await writeFile(mDst, JSON.stringify(store, null, 2), "utf8");
      await writeFile(eDst, JSON.stringify(entityStore, null, 2), "utf8");
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
      const backupDir = join(DATA_DIR, "backups");
      await mkdir(backupDir, { recursive: true });

      // List available memory backups
      const { readdir } = await import("node:fs/promises");
      const files = (await readdir(backupDir).catch(() => [] as string[]))
        .filter(f => f.startsWith("memories-") && f.endsWith(".json"))
        .sort()
        .reverse(); // newest first

      if (files.length === 0) {
        ctx.ui.notify("No backups found. Run /backup-memory first.", "error");
        return;
      }

      // Show picker
      const labels = await Promise.all(files.map(async f => {
        try {
          const raw  = JSON.parse(await readFile(join(backupDir, f), "utf8")) as MemoryStore;
          const count = raw.memories?.length ?? 0;
          const ts    = f.replace("memories-", "").replace(".json", "").replace(/-/g, (m, i) => i === 13 ? ":" : i === 16 ? ":" : i === 10 ? "T" : "-");
          return `${ts}  (${count} memories)`;
        } catch {
          return f;
        }
      }));

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
      const safetyTs  = safeTimestampForFilename();
      await writeFile(join(backupDir, `memories-${safetyTs}.json`), JSON.stringify(store, null, 2), "utf8");
      await writeFile(join(backupDir, `entities-${safetyTs}.json`), JSON.stringify(entityStore, null, 2), "utf8");

      // Load the chosen backup
      const restored = JSON.parse(await readFile(join(backupDir, chosen), "utf8")) as MemoryStore;
      await writeFile(MEMORY_FILE, JSON.stringify(restored, null, 2), "utf8");

      // Try to load matching entities backup
      const eBackup = chosen.replace("memories-", "entities-");
      const eBackupPath = join(backupDir, eBackup);
      if (existsSync(eBackupPath)) {
        const restoredEntities = JSON.parse(await readFile(eBackupPath, "utf8")) as EntityStore;
        await writeFile(join(DATA_DIR, "entities.json"), JSON.stringify(restoredEntities, null, 2), "utf8");
      }

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

  // ── Auto-detection: pending hints + clarification queues ────────────────────
  // Populated by agent_end, consumed by before_agent_start on the next turn.
  const pendingHints:         DetectedHint[]         = [];
  const pendingClarifications: PendingClarification[] = [];

  // ── agent_end: run the signal detection pipeline ───────────────────────────
  //
  // Runs AFTER the LLM has finished responding.  Looks at the USER messages
  // from this turn, runs all three deterministic stages, and queues hints for
  // the next turn.  Zero LLM calls — formulation happens on the next turn
  // when I see the hint in my system prompt and decide whether to call remember().

  pi.on("agent_end", async (event, _ctx) => {
    await ensureLoaded();

    // Extract user message text from this turn
    const userTexts: string[] = [];
    for (const msg of event.messages) {
      if (msg.role !== "user") continue;
      for (const part of msg.content) {
        if (part.type === "text") userTexts.push(part.text);
      }
    }
    if (userTexts.length === 0) return;
    const fullUserText = userTexts.join(" ");

    // Stage 1: Feature scoring — segment and score
    const candidates = extractCandidates(fullUserText);
    if (candidates.length === 0) return;

    for (const candidate of candidates.slice(0, 3)) { // cap at 3 candidates per turn
      // Stage 2: Novelty gate — skip if already well-represented in memory store
      const existing = bm25.search(candidate.text, 5);
      const topBM25  = existing[0]?.score ?? 0;
      const novelty  = Math.max(0, 1 - topBM25 / 4.0);
      if (novelty < 0.25) continue; // already well-known, skip

      // Stage 3: Category classification via prototype TF-IDF cosine
      const { category, confidence } = classifyCategory(candidate.text);

      // Determine hint meta-flags
      const featureSet = new Set(candidate.features);
      const isPattern  = featureSet.has("recurrence");

      // Infer how long this memory should live
      const expiry = inferExpiryTier(candidate.text, candidate.features, candidate.score);

      // Dedup against existing pending hints (Jaccard)
      const isDup = pendingHints.some(h => jaccard(h.text, candidate.text) > 0.55);
      if (isDup) continue;

      pendingHints.push({
        text:       candidate.text,
        category:   expiry ? "context" : category,
        features:   candidate.features,
        score:      candidate.score,
        confidence,
        novelty,
        expiry,
        isPattern,
      });

      // ── Clarification checks (run on the same candidate) ───────────────────────
      // At most one clarification per turn (ICLR 2025: pick the most informative).
      if (pendingClarifications.length === 0) {
        // Check 3: Contradiction — run first, highest priority
        const contradictionC = detectContradiction(
          candidate.text,
          existing.map(h => ({ id: h.id, content: store.memories.find(m=>m.id===h.id)?.content ?? "", score: h.score })),
        );
        if (contradictionC) {
          pendingClarifications.push(contradictionC);
        } else {
          // Check 1: Third-party share
          const thirdPartyC = detectThirdPartyShare(fullUserText);
          if (thirdPartyC) {
            pendingClarifications.push(thirdPartyC);
          } else {
            // Check 2: Borderline scope
            const borderlineC = detectBorderlineScope(candidate.text, candidate.score, LOW_SIGNAL_THRESHOLD);
            if (borderlineC) pendingClarifications.push(borderlineC);
          }
        }
      }
    }
  });

  // ── Inject memories + pending hints into every turn ───────────────────────
  //
  // Strategy:
  //   A) Pending detection hints from last turn (consume and clear)
  //   B) Always include: upcoming events within 90 days
  //   C) Query-relevant: top-5 BM25+cosine hits for the current user prompt
  //   D) Always include: top-3 highest-confidence preferences (baseline)
  //
  // ── Memory injection — split into STATIC (system prompt) + VOLATILE (context) ──
  //
  // CACHE NOTE: the old single before_agent_start block ran a live BM25+cosine
  // search against the current prompt and appended ALL results to the system
  // prompt. Because the results differ every turn, this broke the KV cache on
  // every request — even the stable project plan and tool definitions sitting
  // above the memory block were re-processed from scratch each time.
  //
  // New architecture:
  //
  //  before_agent_start  → STATIC: baseline identity + top-3 locked preferences.
  //                        These are computed once at session start and only
  //                        rebuilt when a new memory is stored (store version bump).
  //                        Stable → cached → free to process on subsequent turns.
  //
  //  turn-context provider → VOLATILE: pending hints, clarifications, upcoming
  //                          events, entity matches, BM25 hits for the prompt.
  //                          Composed with other providers into one capped
  //                          reminder, never stored, never breaks the cache.
  //
  //  Session ledger      → Tracks which memory IDs have been injected this session.
  //                        After a memory has been injected 3+ times without a direct
  //                        recall query, it is suppressed from volatile injection
  //                        (the model already knows it from conversation history).

  // ── Session-level state ────────────────────────────────────────────────────
  let stableBlock       = "";           // cached static injection (system prompt)
  let stableStoreLen    = -1;           // store.memories.length when stableBlock was built
  const injectionLedger = new Map<string, number>(); // memId → times injected this session
  const LEDGER_SUPPRESS = 3;           // suppress volatile re-injection after N turns
  const VOLATILE_CAP    = 7;           // max memories in the volatile reminder per turn

  const PINNED_PROFILE_TAGS = new Set(["name", "height", "weight", "measurements", "body", "dob", "birthday", "age"]);

  function isPinnedProfileMemory(m: Memory): boolean {
    return !m.trace_only && m.tags.some(t => PINNED_PROFILE_TAGS.has(t.toLowerCase()));
  }

  function buildStableBlock(): string {
    const profileLines = profileContextLines(store.profile);
    if (store.memories.length === 0 && profileLines.length === 0) return "";
    const now  = Date.now();

    // Pin critical profile facts so they are always injected when present.
    // This fixes misses like name/body stats not being present in context.
    const pinned = store.memories.filter(isPinnedProfileMemory);

    const base = store.memories.filter(m => {
      if (m.trace_only) return false;
      const tier = m.sensitivity ?? inferSensitivityTier(m);
      // baseline = identity, health — always stable, always inject
      if (tier === "baseline") return true;
      // Top preferences by decayed confidence (general tier only)
      if (tier === "general" && m.category === "preference") return true;
      return false;
    });

    const unique = new Map<string, Memory>();
    for (const m of [...pinned, ...base]) unique.set(m.id, m);

    const stableMems = [...unique.values()]
      .map(m => ({ m, conf: decayedConfidence(m, now) }))
      .sort((a, b) => b.conf - a.conf)
      .slice(0, 5)  // keep the stable system prompt tight; volatile recall handles the rest
      .map(x => x.m);

    if (stableMems.length === 0 && profileLines.length === 0) return "";

    const lines = ["## What you know about this user"];
    lines.push(...profileLines.slice(0, 8));
    for (const m of stableMems) {
      const prefix   = `(${m.category}${m.promoted_from ? " ⬆️" : ""}) `;
      const mentions = m.mentions > 1 ? ` [×${m.mentions}]` : "";
      const dateRef  = m.date_ref ? ` [${m.date_ref}]` : "";
      lines.push(`- ${prefix}${m.content}${dateRef}${mentions}`);
    }
    return lines.join("\n");
  }

  // ── STATIC injection: baseline + top preferences ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    await ensureLoaded();
    if (store.memories.length === 0) return;

    // Rebuild only when the store has grown (new memory added)
    if (store.memories.length !== stableStoreLen) {
      stableBlock    = buildStableBlock();
      stableStoreLen = store.memories.length;
    }

    if (!stableBlock) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + stableBlock };
  });

  // ── VOLATILE injection: BM25 hits, events, hints, clarifications ─────────
  registerContextProvider({
    id: "user-memory",
    priority: 60,
    maxChars: 520,
    build: async ({ prompt }) => {
      await ensureLoaded();
      if (store.memories.length === 0) return null;

      const now = Date.now();
      const lines: string[] = [];

      if (pendingHints.length > 0) {
        const hints = pendingHints.splice(0);
        lines.push("Memory hints detected:");
        for (const h of hints.slice(0, 3)) {
          const strength = h.score >= HIGH_SIGNAL_THRESHOLD ? "strong" : "moderate";
          lines.push(`- [${h.category}, ${strength}] "${h.text.slice(0, 100)}"`);
        }
      }

      if (pendingClarifications.length > 0) {
        const [clar] = pendingClarifications.splice(0);
        pendingClarifications.length = 0;
        lines.push(clar.priority === "high" ? "Contradiction: ask before proceeding:" : "Consider asking:");
        lines.push(`- ${clar.question}`);
      }

      if (prompt.trim()) {
        const memMap = new Map(store.memories.map(m => [m.id, m]));
        const stableIds = new Set(
          store.memories
            .filter(m => {
              if (isPinnedProfileMemory(m)) return true;
              const tier = m.sensitivity ?? inferSensitivityTier(m);
              return tier === "baseline" || (tier === "general" && m.category === "preference");
            })
            .map(m => m.id)
        );

        const upcoming = store.memories
          .filter(m => m.expires_at && m.expires_at > now && daysUntil(m.expires_at) <= 90)
          .sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0));

        const mentionedEntities = queryEntities(entityStore, prompt);
        const entityMems: Memory[] = [];
        for (const entity of mentionedEntities.slice(0, 3)) {
          for (const mid of entity.memory_ids) {
            const m = memMap.get(mid);
            if (m) entityMems.push(m);
          }
        }

        const relevant = await hybridSearch(prompt, 5);
        const seen = new Set<string>(stableIds);
        const volatile: Memory[] = [];
        const candidates = [...upcoming, ...entityMems, ...relevant.map(r => r.memory)];

        for (const m of candidates) {
          if (seen.has(m.id) || m.trace_only) continue;
          seen.add(m.id);

          const ledgerCount = injectionLedger.get(m.id) ?? 0;
          const isEntityHit = entityMems.some(em => em.id === m.id);
          if (ledgerCount >= LEDGER_SUPPRESS && !isEntityHit) continue;

          volatile.push(m);
          if (volatile.length >= VOLATILE_CAP) break;
        }

        if (volatile.length > 0) {
          lines.push("Relevant memory:");
          for (const m of volatile.slice(0, 5)) {
            const prefix = m.expires_at ? `in ${daysUntil(m.expires_at)}d` : m.category;
            const mentions = m.mentions > 1 ? ` [×${m.mentions}]` : "";
            lines.push(`- (${prefix}) ${m.content}${m.date_ref ? ` [${m.date_ref}]` : ""}${mentions}`);
            injectionLedger.set(m.id, (injectionLedger.get(m.id) ?? 0) + 1);
          }
          if (mentionedEntities.length > 0) {
            lines.push(`entity context: ${mentionedEntities.map(e => e.name).join(", ")}`);
          }
        }
      }

      return lines.length > 0 ? lines.join("\n") : null;
    },
  });

  // ── Session status ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    loaded         = false;
    stableStoreLen = -1;           // force rebuild of static block
    injectionLedger.clear();       // reset per-session suppression ledger
    await ensureLoaded();

    // Auto-backup on session start (keeps last 10; prunes older ones)
    if (store.memories.length > 0) {
      try {
        const backupDir = join(DATA_DIR, "backups");
        await mkdir(backupDir, { recursive: true });
        const ts = safeTimestampForFilename();
        await writeFile(join(backupDir, `memories-${ts}.json`), JSON.stringify(store, null, 2), "utf8");
        await writeFile(join(backupDir, `entities-${ts}.json`), JSON.stringify(entityStore, null, 2), "utf8");
        // Prune: keep only the 10 most recent backups
        const { readdir } = await import("node:fs/promises");
        const all = (await readdir(backupDir)).filter(f => f.startsWith("memories-")).sort();
        for (const old of all.slice(0, Math.max(0, all.length - 10))) {
          const { unlink } = await import("node:fs/promises");
          await unlink(join(backupDir, old)).catch(() => {});
          await unlink(join(backupDir, old.replace("memories-", "entities-"))).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }
    // Session status disabled (noise reduction)
  });

  pi.on("session_shutdown", async () => {
    loaded = false;
    entityStore = { version: 1, entities: [] };
    pendingHints.length = 0;
    pendingClarifications.length = 0;
  });
}
