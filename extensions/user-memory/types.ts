export const MEMORY_CATEGORIES = ["preference", "fact", "event", "goal", "skill", "context"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export const TIMELINE_SUBKINDS = ["residence", "employment", "education", "pet", "person", "relationship", "life_event", "health", "custom"] as const;
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

export const SENSITIVITY_TIERS = ["auto", "baseline", "general", "context_gated", "temporal_gated"] as const;
export type MemoryWizardSensitivity = typeof SENSITIVITY_TIERS[number];
export type StoredSensitivityTier = Exclude<MemoryWizardSensitivity, "auto">;

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

export type TimelineMemoryPayload = {
  kind: "profile.timeline";
  subkind: TimelineSubkind;
  entity: "user";
  label?: string;
  interval: TimelineInterval;
  data: Record<string, string | boolean>;
  notes?: string;
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
