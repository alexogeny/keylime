import { extractEntities, type ExtractedEntity } from "./entity.js";
import { inferTimelineSubkindFromQuery } from "./timeline.js";
import type { TimelineMemoryPayload, TimelineSubkind } from "./types.js";

export type TimelineMemoryLike = {
  id: string;
  timeline?: TimelineMemoryPayload;
  subcategory?: string;
};

export function sortableTimelineDate(value: string | undefined, current = false): number | undefined {
  if (current) return Number.POSITIVE_INFINITY;
  if (!value) return undefined;
  const match = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2] ?? "01");
  const day = Number(match[3] ?? "01");
  return Date.UTC(year, month - 1, day);
}

export function timelineOverlaps(a: TimelineMemoryPayload, b: TimelineMemoryPayload): boolean {
  const aStart = sortableTimelineDate(a.interval.start?.value) ?? Number.NEGATIVE_INFINITY;
  const aEnd = sortableTimelineDate(a.interval.end?.value, a.interval.current) ?? Number.POSITIVE_INFINITY;
  const bStart = sortableTimelineDate(b.interval.start?.value) ?? Number.NEGATIVE_INFINITY;
  const bEnd = sortableTimelineDate(b.interval.end?.value, b.interval.current) ?? Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}

export function temporalContextForMemory<T extends TimelineMemoryLike>(memory: T, memories: T[], limit = 6): T[] {
  if (!memory.timeline) return [];
  return memories
    .filter(candidate => candidate.id !== memory.id && candidate.timeline && timelineOverlaps(memory.timeline!, candidate.timeline))
    .slice(0, limit);
}

export function shouldPromptToAddTimelineMemory<T extends TimelineMemoryLike>(query: string, hits: Array<{ memory: T; score: number }>, threshold = 0.22): { shouldPrompt: boolean; inferredSubkind?: TimelineSubkind } {
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

export function uniqueStructuredEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
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

export function memoryEntities(content: string, timeline?: TimelineMemoryPayload): ExtractedEntity[] {
  return uniqueStructuredEntities([...extractEntities(content), ...timelineLinkedEntities(timeline)]);
}
