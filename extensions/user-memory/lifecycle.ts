import { randomUUID } from "node:crypto";
import type { Memory } from "./store.js";

const TRACE_EVENT_SUBCATS = new Set(["career","work","medical","health","running","fitness","financial","family","education"]);
const TRACE_RELATION_SUBCATS = new Set(["relationship","family","work-relationship"]);

export function buildExpiryTrace(expired: Memory, now: number): Memory | null {
  const sub = (expired.subcategory ?? "").toLowerCase();
  if (expired.category === "event" || TRACE_EVENT_SUBCATS.has(sub)) {
    const date = new Date(expired.created_at).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    return { ...expired, id: randomUUID(),
      content: `[Trace] ${expired.content.slice(0,80)}${expired.content.length>80 ? "..." : ""} — ${date}`,
      expires_at: undefined, temporal: false, confidence: 0.8,
      trace_only: true, source_memories: [expired.id], created_at: now, updated_at: now,
      mentions: 1, first_seen: expired.first_seen };
  }
  if (TRACE_RELATION_SUBCATS.has(sub) && expired.category === "context") {
    const date = new Date(expired.created_at).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    const brief = expired.content.slice(0,40).split(",")[0];
    return { ...expired, id: randomUUID(),
      content: `[Trace] Context note around ${date}: ${brief}`,
      expires_at: undefined, temporal: false, confidence: 0.5,
      trace_only: true, source_memories: [expired.id], created_at: now, updated_at: now,
      mentions: 1, first_seen: expired.first_seen };
  }
  return null;
}

const WORK_FRICTION_SUBCATS = new Set(["work","work-relationship","work-style","career","financial"]);

export function shouldCreateJobChapter(memories: Memory[], entityName: string): { should: boolean; sources: string[] } {
  const friction = memories.filter(m =>
    WORK_FRICTION_SUBCATS.has((m.subcategory ?? "").toLowerCase()) && !m.trace_only);
  if (friction.length < 3) return { should: false, sources: [] };
  const exists = memories.some(m => m.trace_only && m.content.includes("[Chapter]") &&
    m.content.toLowerCase().includes(entityName.toLowerCase()));
  if (exists) return { should: false, sources: [] };
  return { should: true, sources: friction.map(m => m.id) };
}

export function buildJobChapter(entityName: string, frictionMemories: Memory[], now: number): Memory {
  const dates = frictionMemories.map(m => m.created_at).sort((a,b) => a-b);
  const from = new Date(dates[0]).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
  const to = new Date(dates[dates.length-1]).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
  const period = from === to ? from : `${from}–${to}`;
  const themes = [...new Set(frictionMemories.map(m => m.subcategory ?? m.category))].slice(0,3).join(", ");
  return { id: randomUUID(),
    content: `[Chapter] ${entityName} (${period}): recurring friction across ${themes}. ${frictionMemories.length} related memories.`,
    category: "context", subcategory: "job-chapter",
    tags: [entityName.toLowerCase(), "work", "chapter", "narrative"],
    confidence: 0.9, created_at: now, updated_at: now, temporal: false,
    mentions: 1, first_seen: now, entity_refs: [], trace_only: false,
    source_memories: frictionMemories.map(m => m.id) };
}

export function checkPromotion(mem: Memory, now: number): { promoted: boolean; note: string } {
  if (mem.promoted_from) return { promoted: false, note: "" };

  let shouldPromote = false;
  if (mem.category === "context" && mem.expires_at && mem.mentions >= 2) shouldPromote = true;
  if (mem.category === "context" && !mem.expires_at && mem.mentions >= 3) shouldPromote = true;
  if (mem.category === "event" && mem.mentions >= 2) shouldPromote = true;

  if (!shouldPromote) return { promoted: false, note: "" };

  const from = mem.category;
  mem.category = "fact";
  mem.promoted_from = from;
  mem.promoted_at = now;
  mem.expires_at = undefined;
  mem.confidence = Math.min(1, mem.confidence + 0.2);
  const note = `⬆️ Promoted from ${from} → fact after ${mem.mentions} mentions`;
  return { promoted: true, note };
}
