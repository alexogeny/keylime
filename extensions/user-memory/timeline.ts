import {
  SENSITIVITY_TIERS,
  TIMELINE_SUBKINDS,
  type MemoryWizardSensitivity,
  type RememberParams,
  type TimelineDatePoint,
  type TimelineDatePrecision,
  type TimelineEntryDraft,
  type TimelineInterval,
  type TimelineMemoryPayload,
  type TimelineSubkind,
} from "./types.js";
import { uniqueCleanTags } from "./normalize.js";

function isSensitivity(value: string): value is MemoryWizardSensitivity {
  return (SENSITIVITY_TIERS as readonly string[]).includes(value);
}

function isTimelineSubkind(value: string): value is TimelineSubkind {
  return (TIMELINE_SUBKINDS as readonly string[]).includes(value);
}

export function inferTimelineSubkindFromQuery(query: string): TimelineSubkind | undefined {
  const q = query.toLowerCase();
  if (/\b(work(?:ed|ing)?|job|employ(?:ed|er|ment)?|company|role|position)\b/.test(q)) return "employment";
  if (/\b(lived|live|address|residence|resident|home|apartment|house)\b/.test(q)) return "residence";
  if (/\b(school|uni(?:versity)?|college|stud(?:y|ied|ent)|degree|education)\b/.test(q)) return "education";
  if (/\b(pet|dog|cat|bird|horse|rabbit)\b/.test(q)) return "pet";
  if (/\b(friend|family|mother|father|parent|sister|brother|sibling|cousin|aunt|uncle|grand(?:ma|mother|pa|father|parent)|colleague|mentor)\b/.test(q)) return "person";
  if (/\b(dated|partner|married|relationship|spouse)\b/.test(q)) return "relationship";
  if (/\b(event|happened|moved|born|birth|died|death|wedding|marriage|divorce|graduat(?:ed|ion)|started|finished|diagnos(?:ed|is))\b/.test(q)) return "life_event";
  if (/\b(health|diagnos(?:ed|is)|injury|illness|condition)\b/.test(q)) return "health";
  return undefined;
}

function datePrecision(value: string | undefined, approximate = false): TimelineDatePrecision {
  if (!value?.trim()) return "unknown";
  if (approximate) return "approximate";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "day";
  if (/^\d{4}-\d{2}$/.test(value)) return "month";
  if (/^\d{4}$/.test(value)) return "year";
  return "approximate";
}

function cleanTimelineDate(value: string | undefined, approximate = false): TimelineDatePoint | undefined {
  const cleaned = value?.trim();
  const precision = datePrecision(cleaned, approximate);
  if (precision === "unknown") return undefined;
  return { value: cleaned, precision, approximate: approximate || precision === "approximate" };
}

export function validateTimelineEntryDraft(draft: TimelineEntryDraft): { ok: true; draft: TimelineEntryDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const normalized: TimelineEntryDraft = {
    ...draft,
    label: draft.label?.trim() || undefined,
    entity: draft.entity?.trim() || undefined,
    notes: draft.notes?.trim() || undefined,
    sensitivity: draft.sensitivity ?? "auto",
    confidence: draft.confidence ?? 1,
    tags: uniqueCleanTags(draft.tags),
    data: Object.fromEntries(Object.entries(draft.data ?? {}).map(([key, value]) => [key, typeof value === "string" ? value.trim() || undefined : value])),
    interval: {
      start: draft.interval.start?.value ? cleanTimelineDate(draft.interval.start.value, draft.interval.start.approximate) : draft.interval.start,
      end: draft.interval.end?.value ? cleanTimelineDate(draft.interval.end.value, draft.interval.end.approximate) : draft.interval.end,
      current: draft.interval.current ?? false,
    },
  };
  if (!isTimelineSubkind(normalized.subkind)) errors.push(`unsupported timeline type: ${normalized.subkind}`);
  if (!normalized.label && !normalized.entity && !Object.values(normalized.data).some(Boolean)) errors.push("timeline entry needs a label, entity, or data field");
  if (!isSensitivity(normalized.sensitivity ?? "auto")) errors.push(`unsupported sensitivity: ${normalized.sensitivity}`);
  if ((normalized.confidence ?? 1) < 0 || (normalized.confidence ?? 1) > 1) errors.push("confidence must be between 0 and 1");
  if (normalized.interval.current && normalized.interval.end?.value) errors.push("current timeline entries cannot also have an end date");
  return errors.length ? { ok: false, errors } : { ok: true, draft: normalized };
}

function timelineRangeText(interval: TimelineInterval): string {
  const start = interval.start?.value ?? "unknown";
  const end = interval.current ? "present" : (interval.end?.value ?? "unknown");
  return `${start} → ${end}`;
}

export function timelineContent(draft: TimelineEntryDraft): string {
  const subject = draft.label || draft.entity || String(draft.data.employer || draft.data.institution || draft.data.name || draft.data.city || draft.subkind);
  const details = Object.entries(draft.data ?? {})
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  return `Timeline ${draft.subkind}: ${subject} (${timelineRangeText(draft.interval)})${details ? ` — ${details}` : ""}${draft.notes ? ` Notes: ${draft.notes}` : ""}`;
}

function timelineTagValues(data: Record<string, string | boolean | undefined>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    values.push(value);
    if (key === "people" || key === "places") values.push(...value.split(","));
  }
  return values;
}

export function convertTimelineDraftToRememberParams(draft: TimelineEntryDraft): RememberParams {
  const result = validateTimelineEntryDraft(draft);
  if (!result.ok) throw new Error(result.errors.join("; "));
  const normalized = result.draft;
  const tags = uniqueCleanTags(["timeline", normalized.subkind, normalized.entity, normalized.label, ...timelineTagValues(normalized.data), ...(normalized.tags ?? [])]);
  const payload: TimelineMemoryPayload = {
    kind: "profile.timeline",
    subkind: normalized.subkind,
    entity: "user",
    label: normalized.label || normalized.entity,
    interval: normalized.interval,
    data: Object.fromEntries(Object.entries(normalized.data).filter((entry): entry is [string, string | boolean] => entry[1] !== undefined && entry[1] !== "")),
    notes: normalized.notes,
  };
  const params: RememberParams = {
    content: timelineContent(normalized),
    category: "fact",
    subcategory: `timeline/${normalized.subkind}`,
    tags,
    temporal: true,
    date_ref: timelineRangeText(normalized.interval),
    confidence: normalized.confidence,
    timeline: payload,
  };
  if (normalized.sensitivity && normalized.sensitivity !== "auto") params.sensitivity = normalized.sensitivity;
  return params;
}

export function previewTimelineEntryDraft(draft: TimelineEntryDraft): string {
  const params = convertTimelineDraftToRememberParams(draft);
  const lines = [
    "Timeline memory preview",
    `type: ${params.timeline?.subkind}`,
    `range: ${params.date_ref}`,
    `content: ${params.content}`,
    `sensitivity: ${params.sensitivity ?? "auto"}`,
  ];
  if (params.tags?.length) lines.push(`tags: ${params.tags.map(tag => `#${tag}`).join(" ")}`);
  return lines.join("\n");
}
