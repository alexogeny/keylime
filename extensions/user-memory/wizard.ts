import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const MEMORY_CATEGORIES = ["preference", "fact", "event", "goal", "skill", "context"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export const TIMELINE_SUBKINDS = ["residence", "employment", "education", "pet", "relationship", "health", "custom"] as const;
export type TimelineSubkind = typeof TIMELINE_SUBKINDS[number];
export type TimelineDatePrecision = "day" | "month" | "year" | "approximate" | "unknown";

export type TimelineDatePoint = {
  value?: string;
  precision: TimelineDatePrecision;
  approximate?: boolean;
};

export type TimelineInterval = {
  start?: TimelineDatePoint;
  end?: TimelineDatePoint;
  current?: boolean;
};

export type TimelineEntryDraft = {
  subkind: TimelineSubkind;
  label?: string;
  entity?: string;
  data: Record<string, string | boolean | undefined>;
  interval: TimelineInterval;
  notes?: string;
  sensitivity?: MemoryWizardSensitivity;
  confidence?: number;
  tags?: string[];
};

export const SENSITIVITY_TIERS = ["auto", "baseline", "general", "context_gated", "temporal_gated"] as const;
export type MemoryWizardSensitivity = typeof SENSITIVITY_TIERS[number];
export type StoredSensitivityTier = Exclude<MemoryWizardSensitivity, "auto">;

const EXPIRY_CHOICES = ["permanent", "2d", "7d", "30d", "custom"] as const;
export type MemoryWizardExpiryChoice = typeof EXPIRY_CHOICES[number];

const PINNED_PROFILE_TAGS = new Set(["name", "height", "weight", "measurements", "body", "dob", "birthday", "age"]);

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/y;

export function fitTuiLine(line: string, width: number): string {
  const limit = Math.max(1, width - 1);
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length && visible < limit;) {
    ANSI_RE.lastIndex = i;
    const ansi = ANSI_RE.exec(line);
    if (ansi) {
      out += ansi[0];
      i = ANSI_RE.lastIndex;
      continue;
    }
    const codePoint = line.codePointAt(i);
    if (codePoint === undefined) break;
    out += String.fromCodePoint(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
    visible += 1;
  }
  return out;
}

export type MemoryWizardDraft = {
  content: string;
  category: MemoryCategory;
  subcategory?: string;
  sensitivity?: MemoryWizardSensitivity;
  expiry?: MemoryWizardExpiryChoice;
  customExpiresAt?: number;
  dateRef?: string;
  tags?: string[];
  pinnedProfile?: boolean;
  confidence?: number;
};

export type RememberParams = {
  content: string;
  category: MemoryCategory;
  subcategory?: string;
  tags?: string[];
  temporal?: boolean;
  date_ref?: string;
  expires_at?: number;
  confidence?: number;
  expiry_tier?: "2d" | "7d" | "30d";
  sensitivity?: StoredSensitivityTier;
  timeline?: TimelineMemoryPayload;
};

export type TimelineMemoryPayload = {
  kind: "profile.timeline";
  subkind: TimelineSubkind;
  entity: "user";
  label?: string;
  interval: TimelineInterval;
  data: Record<string, string | boolean>;
  notes?: string;
};

export type MemoryWizardValidationResult =
  | { ok: true; draft: MemoryWizardDraft }
  | { ok: false; errors: string[] };

function uniqueCleanTags(tags: Array<string | undefined> | undefined): string[] {
  return [...new Set((tags ?? [])
    .filter((tag): tag is string => typeof tag === "string")
    .map(tag => tag.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean))];
}

function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

function isSensitivity(value: string): value is MemoryWizardSensitivity {
  return (SENSITIVITY_TIERS as readonly string[]).includes(value);
}

function isExpiryChoice(value: string): value is MemoryWizardExpiryChoice {
  return (EXPIRY_CHOICES as readonly string[]).includes(value);
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
  if (/\b(dated|partner|married|relationship|spouse)\b/.test(q)) return "relationship";
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

export function parseCommaList(input: string | undefined): string[] {
  return uniqueCleanTags(input?.split(","));
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

export function convertTimelineDraftToRememberParams(draft: TimelineEntryDraft): RememberParams {
  const result = validateTimelineEntryDraft(draft);
  if (!result.ok) throw new Error(result.errors.join("; "));
  const normalized = result.draft;
  const tags = uniqueCleanTags(["timeline", normalized.subkind, normalized.entity, normalized.label, ...Object.values(normalized.data).filter((v): v is string => typeof v === "string"), ...(normalized.tags ?? [])]);
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

export function validateMemoryWizardDraft(draft: MemoryWizardDraft): MemoryWizardValidationResult {
  const errors: string[] = [];
  const normalized: MemoryWizardDraft = {
    ...draft,
    content: draft.content.trim(),
    subcategory: draft.subcategory?.trim() || undefined,
    sensitivity: draft.sensitivity ?? "auto",
    expiry: draft.expiry ?? "permanent",
    dateRef: draft.dateRef?.trim() || undefined,
    tags: uniqueCleanTags(draft.tags),
    confidence: draft.confidence ?? 1,
  };

  if (!normalized.content) errors.push("content is required");
  if (!isMemoryCategory(normalized.category)) errors.push(`unsupported category: ${normalized.category}`);
  if (!isSensitivity(normalized.sensitivity ?? "auto")) errors.push(`unsupported sensitivity: ${normalized.sensitivity}`);
  if (!isExpiryChoice(normalized.expiry ?? "permanent")) errors.push(`unsupported expiry: ${normalized.expiry}`);
  if ((normalized.confidence ?? 1) < 0 || (normalized.confidence ?? 1) > 1) errors.push("confidence must be between 0 and 1");
  if (normalized.expiry === "custom" && (!normalized.customExpiresAt || normalized.customExpiresAt <= Date.now())) {
    errors.push("custom expiry must be a future unix-ms timestamp");
  }
  if (normalized.pinnedProfile && !(normalized.tags ?? []).some(tag => PINNED_PROFILE_TAGS.has(tag))) {
    errors.push("pinned/profile memories need a profile tag: name, height, weight, measurements, body, dob, birthday, or age");
  }

  return errors.length ? { ok: false, errors } : { ok: true, draft: normalized };
}

export function convertDraftToRememberParams(draft: MemoryWizardDraft): RememberParams {
  const result = validateMemoryWizardDraft(draft);
  if (!result.ok) throw new Error(result.errors.join("; "));

  const normalized = result.draft;
  const params: RememberParams = {
    content: normalized.content,
    category: normalized.category,
    tags: normalized.tags,
    confidence: normalized.confidence,
  };

  if (normalized.subcategory) params.subcategory = normalized.subcategory;
  if (normalized.dateRef) params.date_ref = normalized.dateRef;
  if (normalized.sensitivity && normalized.sensitivity !== "auto") params.sensitivity = normalized.sensitivity;

  if (normalized.expiry === "2d" || normalized.expiry === "7d" || normalized.expiry === "30d") {
    params.expiry_tier = normalized.expiry;
    params.temporal = true;
  } else if (normalized.expiry === "custom") {
    params.expires_at = normalized.customExpiresAt;
    params.temporal = true;
  } else if (normalized.dateRef) {
    params.temporal = true;
  }

  return params;
}

export function previewMemoryWizardDraft(draft: MemoryWizardDraft): string {
  const params = convertDraftToRememberParams(draft);
  const lines = [
    "Memory preview",
    `category: ${params.category}`,
    `content: ${params.content}`,
    `sensitivity: ${params.sensitivity ?? "auto"}`,
    `expiry: ${params.expiry_tier ?? (params.expires_at ? new Date(params.expires_at).toISOString() : "permanent")}`,
  ];
  if (params.subcategory) lines.push(`subcategory: ${params.subcategory}`);
  if (params.date_ref) lines.push(`date: ${params.date_ref}`);
  if (params.tags?.length) lines.push(`tags: ${params.tags.map(tag => `#${tag}`).join(" ")}`);
  return lines.join("\n");
}

export const PROFILE_FACT_SECTIONS = [
  "identity", "body", "health", "athlete", "mental", "life", "contact", "work", "preferences",
] as const;
export type ProfileFactSection = typeof PROFILE_FACT_SECTIONS[number];

export type ProfileFactFieldKind = "text" | "date" | "datetime" | "select" | "number";

export type ProfileFactField = {
  id: string;
  label: string;
  section: ProfileFactSection;
  kind: ProfileFactFieldKind;
  placeholder?: string;
  tags: string[];
  options?: string[];
  sensitivity?: MemoryWizardSensitivity;
  measured?: boolean;
  includeMeasurementTime?: boolean;
  unit?: string;
  unitOptions?: string[];
  contentLabel?: string;
};

export const PROFILE_FACT_FIELDS: ProfileFactField[] = [
  // Identity / demographics
  { id: "preferred_name", label: "Preferred name", section: "identity", kind: "text", placeholder: "Alex", tags: ["profile", "name"], sensitivity: "baseline" },
  { id: "legal_name", label: "Legal name", section: "identity", kind: "text", tags: ["profile", "name"], sensitivity: "context_gated" },
  { id: "pronouns", label: "Pronouns", section: "identity", kind: "select", options: ["", "he/him", "she/her", "they/them", "he/they", "she/they", "other"], tags: ["profile", "identity"], sensitivity: "baseline" },
  { id: "gender", label: "Gender", section: "identity", kind: "select", options: ["", "woman", "man", "nonbinary", "agender", "genderfluid", "trans woman", "trans man", "questioning", "prefer not to say", "other / custom"], tags: ["profile", "identity"], sensitivity: "context_gated" },
  { id: "date_of_birth", label: "Date of birth", section: "identity", kind: "date", placeholder: "YYYY-MM-DD", tags: ["profile", "dob", "birthday", "age"], sensitivity: "baseline" },
  { id: "primary_language", label: "Primary language", section: "identity", kind: "select", options: ["", "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Arabic", "Mandarin", "Japanese", "Korean", "Hindi", "other / custom"], tags: ["profile", "identity", "language"], sensitivity: "general" },
  { id: "other_languages", label: "Other languages", section: "identity", kind: "text", placeholder: "type comma-separated languages", tags: ["profile", "identity", "language"], sensitivity: "general" },

  // Physical stat sheet
  { id: "height", label: "Height", section: "body", kind: "number", placeholder: "183", tags: ["profile", "height", "measurements", "body"], sensitivity: "baseline", unitOptions: ["cm", "in", "ft/in"] },
  { id: "weight", label: "Weight", section: "body", kind: "number", placeholder: "75", tags: ["profile", "weight", "measurements", "body"], sensitivity: "baseline", measured: true, includeMeasurementTime: true, unitOptions: ["kg", "lb"] },
  { id: "body_fat_percent", label: "Body fat %", section: "body", kind: "number", placeholder: "15", tags: ["profile", "measurements", "body", "body-composition"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "%" },
  { id: "lean_mass", label: "Lean mass", section: "body", kind: "text", placeholder: "63 kg", tags: ["profile", "measurements", "body", "body-composition"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "waist", label: "Waist", section: "body", kind: "number", placeholder: "32", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unitOptions: ["in", "cm"] },
  { id: "chest", label: "Chest", section: "body", kind: "number", placeholder: "40", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unitOptions: ["in", "cm"] },
  { id: "hips", label: "Hips", section: "body", kind: "number", placeholder: "38", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unitOptions: ["in", "cm"] },
  { id: "inseam", label: "Inseam", section: "body", kind: "number", placeholder: "32", tags: ["profile", "measurements", "body", "clothing"], sensitivity: "general", unitOptions: ["in", "cm"] },
  { id: "cup_size", label: "Cup / bra size", section: "body", kind: "text", placeholder: "34D / 75D", tags: ["profile", "measurements", "body", "cup-size"], sensitivity: "context_gated" },
  { id: "shoe_size", label: "Shoe size", section: "body", kind: "text", placeholder: "US 10 / EU 44", tags: ["profile", "measurements", "body", "shoe"], sensitivity: "baseline" },
  { id: "dominant_hand", label: "Dominant hand", section: "body", kind: "select", options: ["", "right", "left", "ambidextrous"], tags: ["profile", "body"], sensitivity: "general" },
  { id: "dominant_foot", label: "Dominant foot", section: "body", kind: "select", options: ["", "right", "left", "ambidextrous"], tags: ["profile", "body", "sport"], sensitivity: "general" },

  // Health / biometrics
  { id: "blood_type", label: "Blood type", section: "health", kind: "select", options: ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"], tags: ["profile", "health"], sensitivity: "context_gated" },
  { id: "allergies", label: "Allergies", section: "health", kind: "text", placeholder: "type allergy list, or 'none known'", tags: ["profile", "health", "allergy"], sensitivity: "context_gated" },
  { id: "medications", label: "Medications", section: "health", kind: "text", tags: ["profile", "health", "medication"], sensitivity: "context_gated" },
  { id: "conditions", label: "Health conditions", section: "health", kind: "text", tags: ["profile", "health"], sensitivity: "context_gated" },
  { id: "injury_history", label: "Injury history", section: "health", kind: "text", tags: ["profile", "health", "injury", "sport"], sensitivity: "context_gated" },
  { id: "resting_heart_rate", label: "Resting heart rate", section: "health", kind: "number", placeholder: "52", tags: ["profile", "health", "athlete", "rhr", "heart-rate"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "bpm" },
  { id: "hrv", label: "HRV", section: "health", kind: "number", placeholder: "65", tags: ["profile", "health", "athlete", "hrv", "recovery"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "ms", contentLabel: "HRV" },
  { id: "blood_pressure", label: "Blood pressure", section: "health", kind: "text", placeholder: "120/80", tags: ["profile", "health", "blood-pressure"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "sleep_baseline", label: "Sleep baseline", section: "health", kind: "text", placeholder: "7.5h, 23:30-07:00", tags: ["profile", "health", "sleep", "recovery"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },

  // Athlete profile / performance metrics
  { id: "primary_sports", label: "Primary sports", section: "athlete", kind: "text", placeholder: "running, cycling", tags: ["profile", "athlete", "sport"], sensitivity: "general" },
  { id: "training_goal", label: "Training goal", section: "athlete", kind: "text", placeholder: "sub-3 marathon", tags: ["profile", "athlete", "goal", "sport"], sensitivity: "general" },
  { id: "training_volume", label: "Training volume", section: "athlete", kind: "text", placeholder: "50 km/week", tags: ["profile", "athlete", "training"], sensitivity: "general", measured: true, includeMeasurementTime: true },
  { id: "vo2max", label: "VO2 max", section: "athlete", kind: "number", placeholder: "55", tags: ["profile", "athlete", "vo2max", "fitness"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "ml/kg/min", contentLabel: "VO2 max" },
  { id: "max_heart_rate", label: "Max heart rate", section: "athlete", kind: "number", placeholder: "188", tags: ["profile", "athlete", "heart-rate"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "bpm" },
  { id: "lactate_threshold_hr", label: "Lactate threshold HR", section: "athlete", kind: "number", placeholder: "172", tags: ["profile", "athlete", "threshold", "heart-rate"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "bpm" },
  { id: "ftp", label: "Cycling FTP", section: "athlete", kind: "number", placeholder: "280", tags: ["profile", "athlete", "cycling", "ftp"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "W" },
  { id: "critical_power", label: "Critical power", section: "athlete", kind: "number", placeholder: "300", tags: ["profile", "athlete", "power"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "W" },
  { id: "running_threshold_pace", label: "Running threshold pace", section: "athlete", kind: "text", placeholder: "4:15/km", tags: ["profile", "athlete", "running", "threshold"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "easy_pace", label: "Easy pace", section: "athlete", kind: "text", placeholder: "5:30/km", tags: ["profile", "athlete", "running", "pace"], sensitivity: "general", measured: true, includeMeasurementTime: true },
  { id: "race_prs", label: "Race PRs", section: "athlete", kind: "text", placeholder: "5K 19:30; marathon 3:15", tags: ["profile", "athlete", "race", "prs"], sensitivity: "general", measured: true, includeMeasurementTime: true, contentLabel: "race PRs" },
  { id: "zones", label: "Training zones", section: "athlete", kind: "text", placeholder: "Z2 130-145 bpm", tags: ["profile", "athlete", "training", "zones"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "current_shoes", label: "Current running shoes", section: "athlete", kind: "text", tags: ["profile", "athlete", "running", "shoe"], sensitivity: "general" },
  { id: "foot_strike", label: "Foot strike", section: "athlete", kind: "select", options: ["", "heel", "midfoot", "forefoot", "mixed"], tags: ["profile", "athlete", "running", "gait"], sensitivity: "general" },
  { id: "pronation", label: "Pronation", section: "athlete", kind: "select", options: ["", "neutral", "overpronation", "supination", "unknown"], tags: ["profile", "athlete", "running", "gait"], sensitivity: "general" },
  { id: "measurement_datetime", label: "Metric measured at", section: "athlete", kind: "datetime", placeholder: "YYYY-MM-DD HH:mm", tags: ["profile", "athlete", "measurement-date"], sensitivity: "temporal_gated" },

  // Mental / cognitive profile
  { id: "chronotype", label: "Chronotype", section: "mental", kind: "select", options: ["", "morning", "intermediate", "evening", "variable"], tags: ["profile", "mental", "sleep"], sensitivity: "context_gated" },
  { id: "focus_style", label: "Focus style", section: "mental", kind: "select", options: ["", "deep work blocks", "short sprints", "body doubling", "deadline-driven", "morning focus", "evening focus", "variable", "other / custom"], tags: ["profile", "mental", "work-style"], sensitivity: "general" },
  { id: "learning_style", label: "Learning style", section: "mental", kind: "select", options: ["", "examples first", "theory first", "visual", "hands-on", "written docs", "video", "conversation", "other / custom"], tags: ["profile", "mental", "learning"], sensitivity: "general" },
  { id: "communication_style", label: "Communication style", section: "mental", kind: "select", options: ["", "direct", "gentle", "concise", "detailed", "step-by-step", "high context", "low context", "other / custom"], tags: ["profile", "mental", "communication"], sensitivity: "general" },
  { id: "stress_signals", label: "Stress signals", section: "mental", kind: "text", tags: ["profile", "mental", "stress"], sensitivity: "context_gated" },
  { id: "support_needs", label: "Support needs", section: "mental", kind: "text", tags: ["profile", "mental", "support"], sensitivity: "context_gated" },
  { id: "sensory_preferences", label: "Sensory preferences", section: "mental", kind: "text", tags: ["profile", "mental", "sensory"], sensitivity: "context_gated" },

  // Life / contact / work / prefs
  { id: "city", label: "City / region", section: "life", kind: "text", tags: ["profile", "location"], sensitivity: "general" },
  { id: "timezone", label: "Timezone", section: "life", kind: "text", placeholder: "Europe/London", tags: ["profile", "location"], sensitivity: "general" },
  { id: "email", label: "Email", section: "contact", kind: "text", tags: ["profile", "contact"], sensitivity: "context_gated" },
  { id: "phone", label: "Phone", section: "contact", kind: "text", tags: ["profile", "contact"], sensitivity: "context_gated" },
  { id: "emergency_contact", label: "Emergency contact", section: "contact", kind: "text", tags: ["profile", "contact", "emergency"], sensitivity: "context_gated" },
  { id: "employer", label: "Employer", section: "work", kind: "text", tags: ["profile", "work"], sensitivity: "general" },
  { id: "role", label: "Role / title", section: "work", kind: "text", tags: ["profile", "work"], sensitivity: "general" },
  { id: "work_schedule", label: "Work schedule", section: "work", kind: "text", tags: ["profile", "work", "schedule"], sensitivity: "general" },
  { id: "diet", label: "Diet", section: "preferences", kind: "select", options: ["", "omnivore", "vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free", "low FODMAP", "keto", "halal", "kosher", "other / custom"], tags: ["profile", "preference", "food"], sensitivity: "general" },
  { id: "coffee_temperature", label: "Coffee temperature", section: "preferences", kind: "select", options: ["", "hot", "iced", "either"], tags: ["profile", "preference", "coffee", "food"], sensitivity: "general" },
  { id: "coffee_style", label: "Coffee style", section: "preferences", kind: "select", options: ["", "black coffee", "espresso", "americano", "latte", "flat white", "cappuccino", "mocha", "cold brew", "filter coffee", "tea instead", "no caffeine", "other / custom"], tags: ["profile", "preference", "coffee", "food"], sensitivity: "general" },
  { id: "coffee_milk", label: "Coffee milk", section: "preferences", kind: "select", options: ["", "none / black", "whole milk", "semi-skimmed milk", "skimmed milk", "oat milk", "soy milk", "almond milk", "coconut milk", "lactose-free milk", "cream", "other / custom"], tags: ["profile", "preference", "coffee", "food"], sensitivity: "general" },
  { id: "coffee_sweetener", label: "Coffee sweetener", section: "preferences", kind: "select", options: ["", "none", "sugar", "brown sugar", "honey", "syrup", "stevia", "sweetener", "other / custom"], tags: ["profile", "preference", "coffee", "food"], sensitivity: "general" },
  { id: "coffee_size", label: "Coffee size", section: "preferences", kind: "select", options: ["", "small", "medium", "large", "single", "double", "one cup", "two cups", "other / custom"], tags: ["profile", "preference", "coffee", "food"], sensitivity: "general" },
  { id: "caffeine_timing", label: "Caffeine timing", section: "preferences", kind: "select", options: ["", "morning only", "before noon", "afternoon ok", "all day", "none", "other / custom"], tags: ["profile", "preference", "caffeine", "food"], sensitivity: "general" },
  { id: "accessibility", label: "Accessibility needs", section: "preferences", kind: "text", placeholder: "type specific needs, or 'none'", tags: ["profile", "preference", "accessibility"], sensitivity: "context_gated" },
];

export type ProfileFactValues = Record<string, string>;
export type ProfilePatchValue = string | number | { value: string | number; unit?: string; measured_at?: string };
export type ProfilePatch = Record<string, Record<string, ProfilePatchValue>>;

function cleanProfileFactValues(values: ProfileFactValues): ProfileFactValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
}

function labelForField(field: ProfileFactField): string {
  return field.contentLabel ?? field.label.toLowerCase();
}

function validIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(value) && validIsoDate(value.slice(0, 10));
}

function measuredAt(values: ProfileFactValues): string | undefined {
  return cleanProfileFactValues(values).measurement_datetime;
}

function unitKey(field: ProfileFactField): string {
  return `${field.id}__unit`;
}

function defaultUnit(field: ProfileFactField): string | undefined {
  return field.unitOptions?.[0] ?? field.unit;
}

export function convertedUnitHint(value: string, unit: string | undefined): string | undefined {
  const n = Number(value);
  if (!unit || Number.isNaN(n)) return undefined;
  if (unit === "cm") return `${(n / 2.54).toFixed(1)} in`;
  if (unit === "in") return `${(n * 2.54).toFixed(1)} cm`;
  if (unit === "kg") return `${(n * 2.2046226218).toFixed(1)} lb`;
  if (unit === "lb") return `${(n / 2.2046226218).toFixed(1)} kg`;
  return undefined;
}

export function sectionCompleteness(values: ProfileFactValues, section: ProfileFactSection): number {
  const fields = PROFILE_FACT_FIELDS.filter(field => field.section === section && field.id !== "measurement_datetime");
  if (fields.length === 0) return 0;
  const clean = cleanProfileFactValues(values);
  return Math.round((fields.filter(field => clean[field.id]).length / fields.length) * 100);
}

function formatProfileValue(field: ProfileFactField, value: string, values: ProfileFactValues): string {
  const cleanValue = value.replace(/^custom: /, "");
  const unit = values[unitKey(field)] || defaultUnit(field);
  if (unit && /^-?\d+(?:\.\d+)?$/.test(cleanValue)) {
    const hint = convertedUnitHint(cleanValue, unit);
    return `${cleanValue} ${unit}${hint ? ` (${hint})` : ""}`;
  }
  if (field.unit && /^-?\d+(?:\.\d+)?$/.test(cleanValue)) return `${cleanValue} ${field.unit}`;
  return cleanValue;
}

function profileFactContent(field: ProfileFactField, value: string, measuredAtValue: string | undefined, values: ProfileFactValues): string {
  const formatted = formatProfileValue(field, value, values);
  const suffix = field.measured && measuredAtValue ? ` measured at ${measuredAtValue}` : "";
  return `User's ${labelForField(field)} is ${formatted}${suffix}.`;
}

export function validateProfileFactValues(values: ProfileFactValues): string[] {
  const errors: string[] = [];
  const clean = cleanProfileFactValues(values);
  const dob = clean.date_of_birth;
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push("date of birth must use YYYY-MM-DD");
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) && !validIsoDate(dob)) errors.push("date of birth is not a valid calendar date");

  const metricTime = clean.measurement_datetime;
  if (metricTime && !validDateTime(metricTime)) errors.push("metric measured at must use YYYY-MM-DD or YYYY-MM-DD HH:mm");

  for (const field of PROFILE_FACT_FIELDS) {
    const value = clean[field.id];
    if (value && field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${field.label.toLowerCase()} must use YYYY-MM-DD`);
    if (value && field.kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !validIsoDate(value)) errors.push(`${field.label.toLowerCase()} is not a valid calendar date`);
    if (value && field.kind === "datetime" && !validDateTime(value)) errors.push(`${field.label.toLowerCase()} must use YYYY-MM-DD or YYYY-MM-DD HH:mm`);
    if (value && field.kind === "number" && Number.isNaN(Number(value))) errors.push(`${field.label.toLowerCase()} must be numeric`);
  }

  return [...new Set(errors)];
}

export function buildProfileFactDrafts(values: ProfileFactValues): MemoryWizardDraft[] {
  const clean = cleanProfileFactValues(values);
  const errors = validateProfileFactValues(clean);
  if (errors.length) throw new Error(errors.join("; "));
  const metricTime = measuredAt(clean);

  return PROFILE_FACT_FIELDS
    .filter(field => clean[field.id] && field.id !== "measurement_datetime")
    .map(field => ({
      content: profileFactContent(field, clean[field.id], metricTime, clean),
      category: "fact" as const,
      subcategory: field.section,
      sensitivity: field.sensitivity ?? "general",
      expiry: "permanent" as const,
      tags: field.tags,
      pinnedProfile: field.tags.some(tag => PINNED_PROFILE_TAGS.has(tag)),
      dateRef: field.id === "date_of_birth" ? clean[field.id] : field.includeMeasurementTime ? metricTime : undefined,
      confidence: 1,
    }));
}

export function profilePatchToFactValues(profile: ProfilePatch | undefined): ProfileFactValues {
  const values: ProfileFactValues = {};
  if (!profile) return values;

  for (const field of PROFILE_FACT_FIELDS) {
    const stored = profile[field.section]?.[field.id];
    if (stored == null) continue;
    if (typeof stored === "object") {
      values[field.id] = String(stored.value);
      if (stored.unit) values[unitKey(field)] = stored.unit;
      if (stored.measured_at && field.includeMeasurementTime && !values.measurement_datetime) {
        values.measurement_datetime = stored.measured_at;
      }
    } else {
      values[field.id] = String(stored);
    }
  }

  return values;
}

export function buildProfilePatch(values: ProfileFactValues): ProfilePatch {
  const clean = cleanProfileFactValues(values);
  const errors = validateProfileFactValues(clean);
  if (errors.length) throw new Error(errors.join("; "));
  const metricTime = measuredAt(clean);
  const patch: ProfilePatch = {};

  for (const field of PROFILE_FACT_FIELDS) {
    if (!clean[field.id] || field.id === "measurement_datetime") continue;
    const raw = clean[field.id].replace(/^custom: /, "");
    const unit = clean[unitKey(field)] || defaultUnit(field);
    const numeric = field.kind === "number" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    patch[field.section] ??= {};
    patch[field.section][field.id] = (unit || field.measured)
      ? { value: numeric, unit, measured_at: field.includeMeasurementTime ? metricTime : undefined }
      : numeric;
  }

  return patch;
}

export function previewProfilePatch(patch: ProfilePatch): string {
  const lines = ["Structured profile preview"];
  for (const [section, fields] of Object.entries(patch)) {
    lines.push(section.toUpperCase());
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "object") lines.push(`- ${key}: ${value.value}${value.unit ? ` ${value.unit}` : ""}${value.measured_at ? ` measured at ${value.measured_at}` : ""}`);
      else lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.length === 1 ? "No profile facts entered." : lines.join("\n");
}

export function previewProfileFactDrafts(drafts: MemoryWizardDraft[]): string {
  if (drafts.length === 0) return "No profile facts entered.";
  return ["Profile fact preview", ...drafts.map(draft => `- ${draft.content}`)].join("\n");
}

function shiftIsoDate(value: string, part: "year" | "month" | "day", delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(Date.UTC(1990, 0, 1));
  if (part === "year") date.setUTCFullYear(date.getUTCFullYear() + delta);
  if (part === "month") date.setUTCMonth(date.getUTCMonth() + delta);
  if (part === "day") date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

type ProfileFactFormResult =
  | { action: "done"; values: ProfileFactValues }
  | { action: "back"; dirty: boolean };

class ProfileFactForm implements Component {
  private selected = 0;
  private datePart: "year" | "month" | "day" = "year";
  private dirty = false;

  constructor(
    private readonly theme: { fg: (name: string, text: string) => string; bold: (text: string) => string },
    private readonly section: ProfileFactSection,
    private readonly fields: ProfileFactField[],
    private readonly values: ProfileFactValues,
    private readonly done: (result: ProfileFactFormResult) => void,
  ) {}

  private dateDisplay(field: ProfileFactField, value: string): string {
    const base = /^\d{4}-\d{2}-\d{2}/.test(value) ? value : "1990-01-01";
    const time = field.kind === "datetime" ? (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})$/.exec(value)?.[1] ?? " HH:mm") : "";
    const [year, month, day] = base.slice(0, 10).split("-");
    const part = (name: "year" | "month" | "day", text: string) => name === this.datePart ? this.theme.fg("accent", this.theme.bold(text)) : text;
    return `${part("year", year)}-${part("month", month)}-${part("day", day)}${time}`;
  }

  private optionDisplay(field: ProfileFactField): string[] {
    const options = field.options ?? [];
    if (!options.length) return [];
    const current = this.values[field.id] ?? "";
    return [`  ${this.theme.fg("dim", "options:")} ${options.map(option => option === current ? this.theme.fg("accent", `[${option || "blank"}]`) : (option || "blank")).join("  ")}`];
  }

  private unitDisplay(field: ProfileFactField): string[] {
    if (!field.unitOptions) return [];
    const current = this.values[unitKey(field)] || defaultUnit(field);
    return [`  ${this.theme.fg("dim", "units:")} ${field.unitOptions.map(unit => unit === current ? this.theme.fg("accent", `[${unit}]`) : unit).join("  ")}`];
  }

  render(width: number): string[] {
    const completeness = sectionCompleteness(this.values, this.section);
    const lines = [
      this.theme.fg("accent", this.theme.bold(`Structured profile facts › ${this.section} (${completeness}% complete)`)),
      this.theme.fg("dim", "ENTER preview/save this section · ESC goes back without saving this edit screen"),
      this.theme.fg("dim", "TAB or ↑↓ changes field · type edits · BACKSPACE deletes"),
      this.theme.fg("dim", "Select fields show all choices below: ←/→ cycles · choose other/custom then type for custom text"),
      this.theme.fg("dim", "Unit fields show unit chips below: ←/→ cycles units · Date fields: ←/→ choose Y/M/D, +/- changes value"),
      "",
    ];
    this.fields.forEach((field, index) => {
      const active = index === this.selected;
      const value = this.values[field.id] || "";
      const unit = field.unitOptions ? ` ${this.theme.fg("accent", `[${this.values[unitKey(field)] || defaultUnit(field)}]`)}` : "";
      const hint = field.unitOptions && value ? this.theme.fg("dim", ` ≈ ${convertedUnitHint(value, this.values[unitKey(field)] || defaultUnit(field)) ?? ""}`) : "";
      const shown = (field.kind === "date" || field.kind === "datetime") ? this.dateDisplay(field, value) : (value || this.theme.fg("dim", field.placeholder ?? "optional"));
      const picker = (field.kind === "date" || field.kind === "datetime") && active ? ` (${this.datePart}; +/- changes selected part)` : "";
      const kindHint = field.kind === "select" ? this.theme.fg("dim", " ←/→ choose") : field.unitOptions ? this.theme.fg("dim", " ←/→ unit") : "";
      const prefix = active ? this.theme.fg("accent", "›") : " ";
      lines.push(fitTuiLine(`${prefix} ${field.label}${picker}${unit}: ${shown}${hint}${kindHint}`, width));
      if (active) {
        lines.push(...this.optionDisplay(field), ...this.unitDisplay(field));
        if (field.kind === "text") lines.push(`  ${this.theme.fg("dim", "text input: type the exact value you want saved")}`);
        if (field.kind === "number") lines.push(`  ${this.theme.fg("dim", "number input: type digits/decimal; unit chip is saved with conversion hint when available")}`);
        if (field.kind === "date" || field.kind === "datetime") lines.push(`  ${this.theme.fg("dim", "date picker: highlighted part changes with +/-, move highlight with ←/→")}`);
      }
    });
    lines.push("");
    lines.push(this.theme.fg("warning", "Important: ESC cancels/back-outs. Press ENTER when you want to preview and save."));
    return lines.map(line => fitTuiLine(line, width));
  }

  invalidate() {}

  handleInput(data: string) {
    const field = this.fields[this.selected];
    if (data === "\x1b") return this.done({ action: "back", dirty: this.dirty });
    if (data === "\r" || data === "\n") return this.done({ action: "done", values: cleanProfileFactValues(this.values) });
    if (data === "\t" || data === "\x1b[B") {
      this.selected = (this.selected + 1) % this.fields.length;
      return;
    }
    if (data === "\x1b[Z" || data === "\x1b[A") {
      this.selected = (this.selected - 1 + this.fields.length) % this.fields.length;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.values[field.id] = (this.values[field.id] ?? "").replace(/^custom: /, "").slice(0, -1);
      if (field.kind === "select" && this.values[field.id]) this.values[field.id] = `custom: ${this.values[field.id]}`;
      this.dirty = true;
      return;
    }
    if (field.unitOptions && (data === "\x1b[C" || data === "\x1b[D")) {
      const options = field.unitOptions;
      const current = Math.max(0, options.indexOf(this.values[unitKey(field)] ?? defaultUnit(field) ?? options[0]));
      const delta = data === "\x1b[C" ? 1 : -1;
      this.values[unitKey(field)] = options[(current + delta + options.length) % options.length];
      this.dirty = true;
      return;
    }
    if (field.kind === "select" && (data === "\x1b[C" || data === "\x1b[D")) {
      const options = field.options ?? [""];
      const current = Math.max(0, options.indexOf(this.values[field.id] ?? ""));
      const delta = data === "\x1b[C" ? 1 : -1;
      this.values[field.id] = options[(current + delta + options.length) % options.length];
      this.dirty = true;
      return;
    }
    if ((field.kind === "date" || field.kind === "datetime") && (data === "\x1b[C" || data === "\x1b[D")) {
      if (data === "\x1b[C") this.datePart = this.datePart === "year" ? "month" : this.datePart === "month" ? "day" : "year";
      else this.datePart = this.datePart === "year" ? "day" : this.datePart === "month" ? "year" : "month";
      return;
    }
    if ((field.kind === "date" || field.kind === "datetime") && (data === "+" || data === "=" || data === "-")) {
      const current = this.values[field.id] ?? "";
      const time = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})$/.exec(current)?.[1] ?? "";
      this.values[field.id] = `${shiftIsoDate(current.slice(0, 10), this.datePart, data === "-" ? -1 : 1)}${time}`;
      this.dirty = true;
      return;
    }
    if (/^[\x20-\x7E]$/.test(data)) {
      if (field.kind === "select") {
        const existing = this.values[field.id] ?? "";
        if (existing === "other / custom" || existing.startsWith("custom: ")) {
          this.values[field.id] = `custom: ${existing.replace(/^custom: |^other \/ custom$/, "")}${data}`;
          this.dirty = true;
        }
        return;
      }
      this.values[field.id] = `${this.values[field.id] ?? ""}${data}`;
      this.dirty = true;
    }
  }
}

function sectionMenuLabels(values: ProfileFactValues): string[] {
  return [
    ...PROFILE_FACT_SECTIONS.map(section => `${section} (${sectionCompleteness(values, section)}%)`),
    "preview + save all entered facts",
    "cancel without saving",
  ];
}

function sectionFromLabel(label: string | undefined): ProfileFactSection | undefined {
  const section = label?.split(" ")[0];
  return PROFILE_FACT_SECTIONS.find(s => s === section);
}

async function editProfileFactSection(ctx: any, section: ProfileFactSection, values: ProfileFactValues): Promise<ProfileFactValues | null> {
  const before = { ...values };
  const fields = PROFILE_FACT_FIELDS.filter(field => field.section === section);
  const result = await ctx.ui.custom<ProfileFactFormResult>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: (result: ProfileFactFormResult) => void) => {
    const form = new ProfileFactForm(theme, section, fields, values, done);
    return {
      render: (width: number) => form.render(width),
      invalidate: () => form.invalidate(),
      handleInput: (data: string) => {
        form.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result.action === "done") return result.values;
  if (!result.dirty) return null;

  const discard = await ctx.ui.confirm(
    "Go back without saving this section?",
    "You changed fields on this screen. Choose Yes to discard those edits and return to the category menu, or No to keep editing.",
  );
  if (discard) {
    for (const key of Object.keys(values)) delete values[key];
    Object.assign(values, before);
    return null;
  }
  return editProfileFactSection(ctx, section, values);
}

async function runStructuredProfileFactFlow(ctx: any, save: (patch: ProfilePatch) => Promise<{ text: string }>, loadProfile?: () => Promise<ProfilePatch>) {
  let values: ProfileFactValues = profilePatchToFactValues(loadProfile ? await loadProfile() : undefined);

  while (true) {
    const choice = await ctx.ui.select(
      "Structured facts: choose a category. Percentages include currently stored profile fields.",
      sectionMenuLabels(values),
    );

    if (!choice || choice === "cancel without saving") {
      const ok = await ctx.ui.confirm("Cancel memory wizard?", "Nothing has been saved yet. Choose No to go back and save.");
      if (ok) {
        ctx.ui.notify("Memory not saved", "info");
        return;
      }
      continue;
    }

    if (choice === "preview + save all entered facts") break;

    const section = sectionFromLabel(choice);
    if (!section) continue;
    const edited = await editProfileFactSection(ctx, section, values);
    if (edited) values = { ...values, ...edited };
  }

  const errors = validateProfileFactValues(values);
  if (errors.length) {
    ctx.ui.notify(`Invalid profile facts: ${errors.join("; ")}`, "error");
    return;
  }
  const patch = buildProfilePatch(values);
  const count = Object.values(patch).reduce((sum, fields) => sum + Object.keys(fields).length, 0);
  if (count === 0) {
    ctx.ui.notify("No profile facts entered", "warning");
    return;
  }
  const ok = await ctx.ui.confirm("Save structured profile?", previewProfilePatch(patch));
  if (!ok) {
    ctx.ui.notify("Profile not saved", "info");
    return;
  }
  const result = await save(patch);
  ctx.ui.notify(result.text, "success");
}

async function runTimelineMemoryFlow(ctx: any, save: (params: RememberParams) => Promise<{ text: string }>) {
  const subkind = await ctx.ui.select("Timeline entry type", [...TIMELINE_SUBKINDS]);
  if (!subkind || !isTimelineSubkind(subkind)) return;

  const label = await ctx.ui.input("Label / primary name (optional)", "");
  const fields: Record<string, string> = {};
  const promptField = async (key: string, prompt: string) => {
    const value = await ctx.ui.input(prompt, "");
    if (value?.trim()) fields[key] = value.trim();
  };

  if (subkind === "employment") {
    await promptField("employer", "Employer");
    await promptField("title", "Title / role");
    await promptField("location", "Location (optional)");
  } else if (subkind === "residence") {
    await promptField("city", "City");
    await promptField("region", "State / region (optional)");
    await promptField("country", "Country (optional)");
    await promptField("street", "Street/address line (optional, sensitive)");
  } else if (subkind === "education") {
    await promptField("institution", "Institution");
    await promptField("credential", "Credential / course (optional)");
    await promptField("location", "Location (optional)");
  } else if (subkind === "pet") {
    await promptField("name", "Pet name");
    await promptField("species", "Species");
    await promptField("breed", "Breed (optional)");
    await promptField("status", "Status (current/previous/deceased/unknown)");
  } else {
    await promptField("name", "Name / entity (optional)");
    await promptField("detail", "Detail (optional)");
  }

  const startValue = await ctx.ui.input("Start date (YYYY, YYYY-MM, YYYY-MM-DD, approximate text, or blank)", "");
  const current = await ctx.ui.confirm("Is this current?", "Choose Yes for entries valid through the present.");
  const endValue = current ? "" : await ctx.ui.input("End date (YYYY, YYYY-MM, YYYY-MM-DD, approximate text, or blank)", "");
  const notes = await ctx.ui.input("Notes (optional)", "");
  const sensitivity = await ctx.ui.select("Sensitivity", [...SENSITIVITY_TIERS]);
  if (!sensitivity || !isSensitivity(sensitivity)) return;
  const tagInput = await ctx.ui.input("Extra tags, comma-separated (optional)", "");

  const draft: TimelineEntryDraft = {
    subkind,
    label,
    data: fields,
    interval: {
      start: cleanTimelineDate(startValue),
      end: cleanTimelineDate(endValue),
      current,
    },
    notes,
    sensitivity,
    confidence: 1,
    tags: parseCommaList(tagInput),
  };

  const validation = validateTimelineEntryDraft(draft);
  if (!validation.ok) {
    ctx.ui.notify(`Invalid timeline entry: ${validation.errors.join("; ")}`, "error");
    return;
  }

  const ok = await ctx.ui.confirm("Save timeline memory?", previewTimelineEntryDraft(validation.draft));
  if (!ok) {
    ctx.ui.notify("Timeline memory not saved", "info");
    return;
  }

  const result = await save(convertTimelineDraftToRememberParams(validation.draft));
  ctx.ui.notify(result.text, "success");
}

async function runFreeformMemoryFlow(ctx: any, save: (params: RememberParams) => Promise<{ text: string }>) {
  const category = await ctx.ui.select("Memory category", [...MEMORY_CATEGORIES]);
  if (!category || !isMemoryCategory(category)) return;

  const content = await ctx.ui.editor("Memory content", "");
  if (!content?.trim()) {
    ctx.ui.notify("Memory content is required", "warning");
    return;
  }

  const subcategory = await ctx.ui.input("Subcategory (optional)", "");
  const sensitivity = await ctx.ui.select("Sensitivity", [...SENSITIVITY_TIERS]);
  if (!sensitivity || !isSensitivity(sensitivity)) return;
  const expiry = await ctx.ui.select("Expiry", [...EXPIRY_CHOICES]);
  if (!expiry || !isExpiryChoice(expiry)) return;

  let customExpiresAt: number | undefined;
  if (expiry === "custom") {
    const rawExpiry = await ctx.ui.input("Custom expiry unix-ms timestamp", "");
    customExpiresAt = rawExpiry ? Number(rawExpiry) : undefined;
  }

  const dateRef = await ctx.ui.input("Date reference (optional)", "");
  const tagInput = await ctx.ui.input("Entities/tags, comma-separated (optional)", "");
  const pinnedProfile = await ctx.ui.confirm(
    "Pinned/profile memory?",
    "Only use this for stable profile facts, and include a profile tag such as name, height, weight, dob, birthday, age, measurements, or body.",
  );

  const draft: MemoryWizardDraft = {
    content,
    category,
    subcategory,
    sensitivity,
    expiry,
    customExpiresAt,
    dateRef,
    tags: parseCommaList(tagInput),
    pinnedProfile,
    confidence: 1,
  };

  const validation = validateMemoryWizardDraft(draft);
  if (!validation.ok) {
    ctx.ui.notify(`Invalid memory: ${validation.errors.join("; ")}`, "error");
    return;
  }

  const preview = previewMemoryWizardDraft(validation.draft);
  const ok = await ctx.ui.confirm("Save memory?", preview);
  if (!ok) {
    ctx.ui.notify("Memory not saved", "info");
    return;
  }

  const result = await save(convertDraftToRememberParams(validation.draft));
  ctx.ui.notify(result.text, "success");
}

export function registerMemoryWizardCommand(
  pi: ExtensionAPI,
  saveProfile: (patch: ProfilePatch) => Promise<{ text: string }>,
  saveMemory?: (params: RememberParams) => Promise<{ text: string }>,
  loadProfile?: () => Promise<ProfilePatch>,
) {
  pi.registerCommand("memory-wizard", {
    description: "Interactively edit structured profile, timeline history, or freeform memories",
    handler: async (_args, ctx) => {
      const mode = await ctx.ui.select("Memory wizard mode", ["structured profile facts", "timeline / history entry", "freeform memory"]);
      if (mode === "timeline / history entry" && saveMemory) return runTimelineMemoryFlow(ctx, saveMemory);
      if (mode === "freeform memory" && saveMemory) return runFreeformMemoryFlow(ctx, saveMemory);
      return runStructuredProfileFactFlow(ctx, saveProfile, loadProfile);
    },
  });
}
