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

export const PROFILE_FACT_SECTIONS = ["identity", "body", "life", "contact", "work"] as const;
export type ProfileFactSection = typeof PROFILE_FACT_SECTIONS[number];

export type ProfileFactFieldKind = "text" | "date" | "select";

export type ProfileFactField = {
  id: string;
  label: string;
  section: ProfileFactSection;
  kind: ProfileFactFieldKind;
  placeholder?: string;
  tags: string[];
  options?: string[];
};

export const PROFILE_FACT_FIELDS: ProfileFactField[] = [
  { id: "preferred_name", label: "Preferred name", section: "identity", kind: "text", placeholder: "Alex", tags: ["profile", "name"] },
  { id: "legal_name", label: "Legal name", section: "identity", kind: "text", tags: ["profile", "name"] },
  { id: "pronouns", label: "Pronouns", section: "identity", kind: "select", options: ["", "he/him", "she/her", "they/them", "he/they", "she/they", "other"], tags: ["profile", "identity"] },
  { id: "date_of_birth", label: "Date of birth", section: "identity", kind: "date", placeholder: "YYYY-MM-DD", tags: ["profile", "dob", "birthday", "age"] },
  { id: "height", label: "Height", section: "body", kind: "text", placeholder: "183 cm / 6 ft", tags: ["profile", "height", "measurements", "body"] },
  { id: "weight", label: "Weight", section: "body", kind: "text", placeholder: "75 kg / 165 lb", tags: ["profile", "weight", "measurements", "body"] },
  { id: "shoe_size", label: "Shoe size", section: "body", kind: "text", placeholder: "US 10 / EU 44", tags: ["profile", "measurements", "body", "shoe"] },
  { id: "city", label: "City / region", section: "life", kind: "text", tags: ["profile", "location"] },
  { id: "timezone", label: "Timezone", section: "life", kind: "text", placeholder: "Europe/London", tags: ["profile", "location"] },
  { id: "email", label: "Email", section: "contact", kind: "text", tags: ["profile", "contact"] },
  { id: "phone", label: "Phone", section: "contact", kind: "text", tags: ["profile", "contact"] },
  { id: "employer", label: "Employer", section: "work", kind: "text", tags: ["profile", "work"] },
  { id: "role", label: "Role / title", section: "work", kind: "text", tags: ["profile", "work"] },
];

export type ProfileFactValues = Record<string, string>;

function cleanProfileFactValues(values: ProfileFactValues): ProfileFactValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
}

function labelForField(field: ProfileFactField): string {
  return field.label.toLowerCase();
}

export function validateProfileFactValues(values: ProfileFactValues): string[] {
  const errors: string[] = [];
  const clean = cleanProfileFactValues(values);
  const dob = clean.date_of_birth;
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push("date of birth must use YYYY-MM-DD");
  if (dob) {
    const date = new Date(`${dob}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dob) errors.push("date of birth is not a valid calendar date");
  }
  return errors;
}

export function buildProfileFactDrafts(values: ProfileFactValues): MemoryWizardDraft[] {
  const clean = cleanProfileFactValues(values);
  const errors = validateProfileFactValues(clean);
  if (errors.length) throw new Error(errors.join("; "));

  return PROFILE_FACT_FIELDS
    .filter(field => clean[field.id])
    .map(field => ({
      content: `User's ${labelForField(field)} is ${clean[field.id]}.`,
      category: "fact" as const,
      subcategory: field.section,
      sensitivity: "baseline" as const,
      expiry: "permanent" as const,
      tags: field.tags,
      pinnedProfile: field.tags.some(tag => PINNED_PROFILE_TAGS.has(tag)),
      dateRef: field.id === "date_of_birth" ? clean[field.id] : undefined,
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
      const picker = field.kind === "date" && active ? ` (${this.datePart})` : "";
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
    if (field.kind === "date" && (data === "\x1b[C" || data === "\x1b[D")) {
      if (data === "\x1b[C") this.datePart = this.datePart === "year" ? "month" : this.datePart === "month" ? "day" : "year";
      else this.datePart = this.datePart === "year" ? "day" : this.datePart === "month" ? "year" : "month";
      return;
    }
    if (field.kind === "date" && (data === "+" || data === "=" || data === "-")) {
      this.values[field.id] = shiftIsoDate(this.values[field.id] ?? "", this.datePart, data === "-" ? -1 : 1);
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
