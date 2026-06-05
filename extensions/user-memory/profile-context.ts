import type { ProfileMetric, UserProfile } from "./types.js";

export function profileValueText(value: string | number | ProfileMetric | ProfileMetric[] | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(profileValueText).filter(Boolean).join("; ");
  if (typeof value === "object") return `${value.value}${value.unit ? ` ${value.unit}` : ""}${value.measured_at ? ` measured at ${value.measured_at}` : ""}`;
  return String(value);
}

export function profileContextLines(profile: UserProfile): string[] {
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

export function profileSearchLines(profile: UserProfile, query: string, limit: number): string[] {
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
