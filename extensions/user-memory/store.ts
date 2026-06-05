import { join } from "node:path";
import { homedir } from "node:os";
import { readJsonFile, writeJsonFile } from "../shared/json-store";
import { jaccardText } from "../shared/similarity";
import type { MemoryCategory, TimelineMemoryPayload, UserProfile } from "./types.js";
import type { SensitivityTier } from "./sensitivity.js";

export const DATA_DIR = join(homedir(), ".pi", "data", "user-memory");
export const MEMORY_FILE = join(DATA_DIR, "memories.json");

const HALF_LIFE: Record<MemoryCategory, number | null> = {
  preference: 180,
  fact: null,
  event: null,
  goal: 45,
  skill: 365,
  context: 14,
};

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  subcategory?: string;
  tags: string[];
  confidence: number;
  created_at: number;
  updated_at: number;
  expires_at?: number;
  temporal: boolean;
  date_ref?: string;
  source_session?: string;
  supersedes?: string[];
  embedding?: number[];
  tfidf?: Record<string, number>;
  mentions: number;
  first_seen: number;
  promoted_from?: MemoryCategory;
  promoted_at?: number;
  entity_refs: string[];
  sensitivity?: SensitivityTier;
  trace_only?: boolean;
  source_memories?: string[];
  timeline?: TimelineMemoryPayload;
}

export interface MemoryStore {
  version: 4;
  profile: UserProfile;
  memories: Memory[];
}

export function jaccard(a: string, b: string): number {
  return jaccardText(a, b);
}

export function decayedConfidence(mem: Memory, now: number): number {
  const hl = HALF_LIFE[mem.category];
  if (hl === null) return mem.confidence;
  const daysSince = (now - mem.updated_at) / 86_400_000;
  return mem.confidence * Math.exp(-daysSince * Math.LN2 / hl);
}

export async function loadStore(): Promise<MemoryStore> {
  try {
    const raw = await readJsonFile<MemoryStore>(MEMORY_FILE, { version: 4, profile: {}, memories: [] });
    raw.memories ||= [];
    raw.profile ||= {};
    if ((raw.version as number) < 3) {
      for (const m of raw.memories) {
        if (m.mentions == null) m.mentions = 1;
        if (m.first_seen == null) m.first_seen = m.created_at;
        if (m.entity_refs == null) m.entity_refs = [];
      }
    }
    raw.version = 4;
    return raw;
  } catch {
    return { version: 4, profile: {}, memories: [] };
  }
}

export async function saveStore(store: MemoryStore): Promise<void> {
  await writeJsonFile(MEMORY_FILE, store);
}

export function memoryText(m: Memory): string {
  const parts = [m.content];
  if (m.subcategory) parts.push(m.subcategory);
  if (m.tags.length) parts.push(m.tags.join(" "));
  if (m.date_ref) parts.push(m.date_ref);
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
