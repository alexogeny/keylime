import { randomUUID } from "node:crypto";
import type { BM25Index, TFIDFStore } from "../shared/retrieval";
import { upsertEntity, type EntityStore } from "./entity.js";
import { tierToMs, type ExpiryTier } from "./expiry.js";
import { buildJobChapter, checkPromotion, shouldCreateJobChapter } from "./lifecycle.js";
import { memoryEntities } from "./timeline-memory.js";
import { inferSensitivityTier, type SensitivityTier } from "./sensitivity.js";
import { memoryText, type Memory, type MemoryStore } from "./store.js";
import type { RememberParams as WizardRememberParams } from "./types.js";
import type { ProfilePatch } from "./wizard.js";

type RememberServiceDeps = {
  store: MemoryStore;
  entityStore: EntityStore;
  bm25: BM25Index;
  tfidf: TFIDFStore;
  persist: () => Promise<void>;
  findDuplicate: (content: string, category: WizardRememberParams["category"]) => Promise<Memory | null>;
  checkOllama: () => Promise<boolean>;
  embedText: (text: string) => Promise<number[] | null>;
};

function assertPersonalMemoryContent(content: string): void {
  const adversarialPatterns = [
    /\byou (always|should|must|will|are|have to|need to)\b/i,
    /\bremember that you\b/i,
    /\bas an ai\b/i,
    /\bignore (previous|prior|your|all)\b/i,
    /\byour (instructions|rules|guidelines|system prompt)\b/i,
    /\bforget (everything|all|your|prior)\b/i,
  ];
  if (adversarialPatterns.some(p => p.test(content))) {
    throw new Error(
      `Rejected: this looks like a prompt injection attempt rather than a personal memory. ` +
      `Memories should be facts about you, not instructions to me.`
    );
  }
}

function reindexMemory(bm25: BM25Index, tfidf: TFIDFStore, mem: Memory): void {
  const text = memoryText(mem);
  bm25.add(mem.id, text);
  tfidf.add(mem.id, text);
}

export async function rememberStructuredMemory(deps: RememberServiceDeps, params: WizardRememberParams) {
  if (params.expiry_tier && ["2d","7d","30d"].includes(params.expiry_tier)) {
    params.expires_at = tierToMs(params.expiry_tier as ExpiryTier);
    if (!params.temporal) params.temporal = true;
  }

  assertPersonalMemoryContent(params.content);

  const dup = await deps.findDuplicate(params.content, params.category);
  if (dup) {
    const now = Date.now();
    dup.content = params.content;
    dup.updated_at = now;
    dup.mentions = (dup.mentions ?? 1) + 1;
    if (params.tags?.length) dup.tags = [...new Set([...dup.tags, ...params.tags])];
    if (params.subcategory) dup.subcategory = params.subcategory;
    if (params.date_ref) dup.date_ref = params.date_ref;
    if (params.expires_at) dup.expires_at = params.expires_at;
    if (params.temporal != null) dup.temporal = params.temporal;
    if (params.sensitivity) dup.sensitivity = params.sensitivity as SensitivityTier;
    if (params.timeline) dup.timeline = params.timeline;
    dup.confidence = params.confidence ?? 1.0;
    if (await deps.checkOllama()) dup.embedding = await deps.embedText(params.content) ?? undefined;

    const { promoted, note: promoNote } = checkPromotion(dup, now);

    const newEntities = memoryEntities(params.content, params.timeline);
    for (const e of newEntities) {
      const eid = upsertEntity(deps.entityStore, e, dup.id, now);
      if (!dup.entity_refs.includes(eid)) dup.entity_refs.push(eid);
    }

    deps.bm25.remove(dup.id);
    deps.tfidf.remove(dup.id);
    reindexMemory(deps.bm25, deps.tfidf, dup);
    await deps.persist();

    const statusLine = promoted
      ? `Reinforced + promoted [${dup.id.slice(0,8)}]: ${promoNote}`
      : `Reinforced [${dup.id.slice(0,8)}] (×${dup.mentions}): "${dup.content}"`;
    return {
      content: [{ type: "text", text: statusLine }],
      details: { action: promoted ? "promoted" : "reinforced", memory: dup, promoted },
    };
  }

  const now = Date.now();
  const mem: Memory = {
    id: randomUUID(),
    content: params.content,
    category: params.category,
    subcategory: params.subcategory,
    tags: params.tags ?? [],
    confidence: params.confidence ?? 1.0,
    created_at: now,
    updated_at: now,
    expires_at: params.expires_at,
    temporal: params.temporal ?? false,
    date_ref: params.date_ref,
    sensitivity: params.sensitivity as SensitivityTier | undefined,
    timeline: params.timeline,
    mentions: 1,
    first_seen: now,
    entity_refs: [],
  };
  if (await deps.checkOllama()) mem.embedding = await deps.embedText(params.content) ?? undefined;

  if (!mem.sensitivity) mem.sensitivity = inferSensitivityTier(mem);

  const entities = memoryEntities(params.content, params.timeline);
  for (const e of entities) {
    const eid = upsertEntity(deps.entityStore, e, mem.id, now);
    mem.entity_refs.push(eid);
  }

  deps.store.memories.push(mem);

  for (const entity of entities.filter(e => e.subtype === "work")) {
    const { should, sources } = shouldCreateJobChapter(deps.store.memories, entity.canonical);
    if (should) {
      const frictionMems = deps.store.memories.filter(m => sources.includes(m.id));
      const chapter = buildJobChapter(entity.canonical, frictionMems, now);
      deps.store.memories.push(chapter);
      reindexMemory(deps.bm25, deps.tfidf, chapter);
    }
  }
  reindexMemory(deps.bm25, deps.tfidf, mem);
  await deps.persist();

  const entityNames = entities.map(e => e.canonical).join(", ");
  return {
    content: [{ type: "text", text: `Remembered [${mem.id.slice(0,8)}] (${mem.category}): "${mem.content}"${entityNames ? ` | entities: ${entityNames}` : ""}` }],
    details: { action: "created", memory: mem, entities },
  };
}

export async function currentProfile(store: MemoryStore): Promise<ProfilePatch> {
  return store.profile as ProfilePatch;
}

export async function updateProfile(store: MemoryStore, persist: () => Promise<void>, patch: ProfilePatch): Promise<{ text: string }> {
  for (const [section, fields] of Object.entries(patch)) {
    store.profile[section] = { ...(store.profile[section] ?? {}), ...fields };
  }
  await persist();
  const count = Object.values(patch).reduce((sum, fields) => sum + Object.keys(fields).length, 0);
  return { text: `Saved ${count} structured profile fields` };
}
