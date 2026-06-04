import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const MEMORY_CATEGORIES = ["preference", "fact", "event", "goal", "skill", "context"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export const SENSITIVITY_TIERS = ["auto", "baseline", "general", "context_gated", "temporal_gated"] as const;
export type MemoryWizardSensitivity = typeof SENSITIVITY_TIERS[number];
export type StoredSensitivityTier = Exclude<MemoryWizardSensitivity, "auto">;

const EXPIRY_CHOICES = ["permanent", "2d", "7d", "30d", "custom"] as const;
export type MemoryWizardExpiryChoice = typeof EXPIRY_CHOICES[number];

const PINNED_PROFILE_TAGS = new Set(["name", "height", "weight", "measurements", "body", "dob", "birthday", "age"]);

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
};

export type MemoryWizardValidationResult =
  | { ok: true; draft: MemoryWizardDraft }
  | { ok: false; errors: string[] };

function uniqueCleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? [])
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

export function parseCommaList(input: string | undefined): string[] {
  return uniqueCleanTags(input?.split(","));
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
  contentLabel?: string;
};

export const PROFILE_FACT_FIELDS: ProfileFactField[] = [
  // Identity / demographics
  { id: "preferred_name", label: "Preferred name", section: "identity", kind: "text", placeholder: "Alex", tags: ["profile", "name"], sensitivity: "baseline" },
  { id: "legal_name", label: "Legal name", section: "identity", kind: "text", tags: ["profile", "name"], sensitivity: "context_gated" },
  { id: "pronouns", label: "Pronouns", section: "identity", kind: "select", options: ["", "he/him", "she/her", "they/them", "he/they", "she/they", "other"], tags: ["profile", "identity"], sensitivity: "baseline" },
  { id: "gender", label: "Gender", section: "identity", kind: "text", tags: ["profile", "identity"], sensitivity: "context_gated" },
  { id: "date_of_birth", label: "Date of birth", section: "identity", kind: "date", placeholder: "YYYY-MM-DD", tags: ["profile", "dob", "birthday", "age"], sensitivity: "baseline" },
  { id: "languages", label: "Languages", section: "identity", kind: "text", placeholder: "English, Spanish", tags: ["profile", "identity", "language"], sensitivity: "general" },

  // Physical stat sheet
  { id: "height", label: "Height", section: "body", kind: "text", placeholder: "183 cm / 6 ft", tags: ["profile", "height", "measurements", "body"], sensitivity: "baseline" },
  { id: "weight", label: "Weight", section: "body", kind: "text", placeholder: "75 kg / 165 lb", tags: ["profile", "weight", "measurements", "body"], sensitivity: "baseline", measured: true, includeMeasurementTime: true },
  { id: "body_fat_percent", label: "Body fat %", section: "body", kind: "number", placeholder: "15", tags: ["profile", "measurements", "body", "body-composition"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true, unit: "%" },
  { id: "lean_mass", label: "Lean mass", section: "body", kind: "text", placeholder: "63 kg", tags: ["profile", "measurements", "body", "body-composition"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "waist", label: "Waist", section: "body", kind: "text", placeholder: "82 cm", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "chest", label: "Chest", section: "body", kind: "text", placeholder: "100 cm", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "hips", label: "Hips", section: "body", kind: "text", placeholder: "96 cm", tags: ["profile", "measurements", "body"], sensitivity: "context_gated", measured: true, includeMeasurementTime: true },
  { id: "inseam", label: "Inseam", section: "body", kind: "text", placeholder: "82 cm", tags: ["profile", "measurements", "body", "clothing"], sensitivity: "general" },
  { id: "shoe_size", label: "Shoe size", section: "body", kind: "text", placeholder: "US 10 / EU 44", tags: ["profile", "measurements", "body", "shoe"], sensitivity: "baseline" },
  { id: "dominant_hand", label: "Dominant hand", section: "body", kind: "select", options: ["", "right", "left", "ambidextrous"], tags: ["profile", "body"], sensitivity: "general" },
  { id: "dominant_foot", label: "Dominant foot", section: "body", kind: "select", options: ["", "right", "left", "ambidextrous"], tags: ["profile", "body", "sport"], sensitivity: "general" },

  // Health / biometrics
  { id: "blood_type", label: "Blood type", section: "health", kind: "select", options: ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"], tags: ["profile", "health"], sensitivity: "context_gated" },
  { id: "allergies", label: "Allergies", section: "health", kind: "text", tags: ["profile", "health", "allergy"], sensitivity: "context_gated" },
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
  { id: "focus_style", label: "Focus style", section: "mental", kind: "text", placeholder: "deep work in morning", tags: ["profile", "mental", "work-style"], sensitivity: "general" },
  { id: "learning_style", label: "Learning style", section: "mental", kind: "text", tags: ["profile", "mental", "learning"], sensitivity: "general" },
  { id: "communication_style", label: "Communication style", section: "mental", kind: "text", tags: ["profile", "mental", "communication"], sensitivity: "general" },
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
  { id: "diet", label: "Diet", section: "preferences", kind: "text", tags: ["profile", "preference", "food"], sensitivity: "general" },
  { id: "caffeine", label: "Caffeine", section: "preferences", kind: "text", placeholder: "coffee before noon", tags: ["profile", "preference", "food"], sensitivity: "general" },
  { id: "accessibility", label: "Accessibility needs", section: "preferences", kind: "text", tags: ["profile", "preference", "accessibility"], sensitivity: "context_gated" },
];

export type ProfileFactValues = Record<string, string>;

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

function formatProfileValue(field: ProfileFactField, value: string): string {
  if (field.unit && /^-?\d+(?:\.\d+)?$/.test(value)) return `${value} ${field.unit}`;
  return value;
}

function profileFactContent(field: ProfileFactField, value: string, measuredAtValue: string | undefined): string {
  const formatted = formatProfileValue(field, value);
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
      content: profileFactContent(field, clean[field.id], metricTime),
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

class ProfileFactForm implements Component {
  private selected = 0;
  private datePart: "year" | "month" | "day" = "year";
  private values: ProfileFactValues = {};

  constructor(
    private readonly theme: { fg: (name: string, text: string) => string; bold: (text: string) => string },
    private readonly done: (result: ProfileFactValues | null) => void,
  ) {}

  render(width: number): string[] {
    const lines = [
      this.theme.fg("accent", this.theme.bold("Structured profile facts")),
      this.theme.fg("dim", "tab/↑↓ field · type to edit · ←/→ picker/date · enter preview · esc cancel"),
      "",
    ];
    let section: ProfileFactSection | undefined;
    PROFILE_FACT_FIELDS.forEach((field, index) => {
      if (field.section !== section) {
        section = field.section;
        lines.push(this.theme.fg("muted", section.toUpperCase()));
      }
      const active = index === this.selected;
      const value = this.values[field.id] || "";
      const shown = value || this.theme.fg("dim", field.placeholder ?? "optional");
      const picker = (field.kind === "date" || field.kind === "datetime") && active ? ` (${this.datePart})` : "";
      const prefix = active ? this.theme.fg("accent", "›") : " ";
      lines.push(`${prefix} ${field.label}${picker}: ${shown}`.slice(0, Math.max(10, width - 1)));
    });
    lines.push("");
    lines.push(this.theme.fg("dim", "Profile facts save as baseline fact memories using the existing user-memory store."));
    return lines;
  }

  invalidate() {}

  handleInput(data: string) {
    const field = PROFILE_FACT_FIELDS[this.selected];
    if (data === "\x1b") return this.done(null);
    if (data === "\r" || data === "\n") return this.done(cleanProfileFactValues(this.values));
    if (data === "\t" || data === "\x1b[B") {
      this.selected = (this.selected + 1) % PROFILE_FACT_FIELDS.length;
      return;
    }
    if (data === "\x1b[Z" || data === "\x1b[A") {
      this.selected = (this.selected - 1 + PROFILE_FACT_FIELDS.length) % PROFILE_FACT_FIELDS.length;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.values[field.id] = (this.values[field.id] ?? "").slice(0, -1);
      return;
    }
    if (field.kind === "select" && (data === "\x1b[C" || data === "\x1b[D")) {
      const options = field.options ?? [""];
      const current = Math.max(0, options.indexOf(this.values[field.id] ?? ""));
      const delta = data === "\x1b[C" ? 1 : -1;
      this.values[field.id] = options[(current + delta + options.length) % options.length];
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
      return;
    }
    if (/^[\x20-\x7E]$/.test(data)) {
      this.values[field.id] = `${this.values[field.id] ?? ""}${data}`;
    }
  }
}

async function runStructuredProfileFactFlow(ctx: any, save: (params: RememberParams) => Promise<{ text: string }>) {
  const values = await ctx.ui.custom<ProfileFactValues | null>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: (result: ProfileFactValues | null) => void) => {
    const form = new ProfileFactForm(theme, done);
    return {
      render: (width: number) => form.render(width),
      invalidate: () => form.invalidate(),
      handleInput: (data: string) => {
        form.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!values) {
    ctx.ui.notify("Memory not saved", "info");
    return;
  }

  const errors = validateProfileFactValues(values);
  if (errors.length) {
    ctx.ui.notify(`Invalid profile facts: ${errors.join("; ")}`, "error");
    return;
  }
  const drafts = buildProfileFactDrafts(values);
  if (drafts.length === 0) {
    ctx.ui.notify("No profile facts entered", "warning");
    return;
  }
  const ok = await ctx.ui.confirm("Save profile facts?", previewProfileFactDrafts(drafts));
  if (!ok) {
    ctx.ui.notify("Memory not saved", "info");
    return;
  }
  const results = [];
  for (const draft of drafts) {
    results.push(await save(convertDraftToRememberParams(draft)));
  }
  ctx.ui.notify(`Saved ${results.length} profile fact memories`, "success");
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
  save: (params: RememberParams) => Promise<{ text: string }>,
) {
  pi.registerCommand("memory-wizard", {
    description: "Interactively create structured user memories",
    handler: async (_args, ctx) => {
      const mode = await ctx.ui.select("Memory wizard", ["structured profile facts", "freeform memory"]);
      if (mode === "structured profile facts") {
        await runStructuredProfileFactFlow(ctx, save);
        return;
      }
      if (mode === "freeform memory") {
        await runFreeformMemoryFlow(ctx, save);
      }
    },
  });
}
