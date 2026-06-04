import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export function registerMemoryWizardCommand(
  pi: ExtensionAPI,
  save: (params: RememberParams) => Promise<{ text: string }>,
) {
  pi.registerCommand("memory-wizard", {
    description: "Interactively create a structured user memory",
    handler: async (_args, ctx) => {
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
    },
  });
}
