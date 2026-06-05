import { PINNED_PROFILE_TAGS, type MemoryWizardSensitivity } from "./types.js";
import type { MemoryWizardDraft } from "./freeform.js";

export type ProfileFactSection = "identity" | "body" | "appearance" | "health" | "athlete" | "mental" | "life" | "contact" | "work" | "preferences";
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

export type ProfileFactValues = Record<string, string>;
export type ProfilePatchValue = string | number | { value: string | number; unit?: string; measured_at?: string };
export type ProfilePatch = Record<string, Record<string, ProfilePatchValue>>;

export function cleanProfileFactValues(values: ProfileFactValues): ProfileFactValues {
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

export function unitKey(field: ProfileFactField): string {
  return `${field.id}__unit`;
}

export function defaultUnit(field: ProfileFactField): string | undefined {
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

export function sectionCompletenessForFields(fields: ProfileFactField[], values: ProfileFactValues, section: ProfileFactSection): number {
  const sectionFields = fields.filter(field => field.section === section && field.id !== "measurement_datetime");
  if (sectionFields.length === 0) return 0;
  const clean = cleanProfileFactValues(values);
  return Math.round((sectionFields.filter(field => clean[field.id]).length / sectionFields.length) * 100);
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

export function validateProfileFactValuesForFields(fields: ProfileFactField[], values: ProfileFactValues): string[] {
  const errors: string[] = [];
  const clean = cleanProfileFactValues(values);
  const dob = clean.date_of_birth;
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push("date of birth must use YYYY-MM-DD");
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) && !validIsoDate(dob)) errors.push("date of birth is not a valid calendar date");

  const metricTime = clean.measurement_datetime;
  if (metricTime && !validDateTime(metricTime)) errors.push("metric measured at must use YYYY-MM-DD or YYYY-MM-DD HH:mm");

  for (const field of fields) {
    const value = clean[field.id];
    if (value && field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${field.label.toLowerCase()} must use YYYY-MM-DD`);
    if (value && field.kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !validIsoDate(value)) errors.push(`${field.label.toLowerCase()} is not a valid calendar date`);
    if (value && field.kind === "datetime" && !validDateTime(value)) errors.push(`${field.label.toLowerCase()} must use YYYY-MM-DD or YYYY-MM-DD HH:mm`);
    if (value && field.kind === "number" && Number.isNaN(Number(value))) errors.push(`${field.label.toLowerCase()} must be numeric`);
  }

  return [...new Set(errors)];
}

export function buildProfileFactDraftsForFields(fields: ProfileFactField[], values: ProfileFactValues): MemoryWizardDraft[] {
  const clean = cleanProfileFactValues(values);
  const errors = validateProfileFactValuesForFields(fields, clean);
  if (errors.length) throw new Error(errors.join("; "));
  const metricTime = measuredAt(clean);

  return fields
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

export function profilePatchToFactValuesForFields(fields: ProfileFactField[], profile: ProfilePatch | undefined): ProfileFactValues {
  const values: ProfileFactValues = {};
  if (!profile) return values;

  for (const field of fields) {
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

export function buildProfilePatchForFields(fields: ProfileFactField[], values: ProfileFactValues): ProfilePatch {
  const clean = cleanProfileFactValues(values);
  const errors = validateProfileFactValuesForFields(fields, clean);
  if (errors.length) throw new Error(errors.join("; "));
  const metricTime = measuredAt(clean);
  const patch: ProfilePatch = {};

  for (const field of fields) {
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
