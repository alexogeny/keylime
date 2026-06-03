// ─── Shared types for the shoe database extension ─────────────────────────────

export type Category = "neutral" | "stability" | "motion-control";
export type CushionLevel = "minimal" | "low" | "moderate" | "high" | "max";
export type UseCase =
  | "daily-trainer"
  | "long-run"
  | "tempo"
  | "race"
  | "recovery"
  | "trail"
  | "walking"
  | "track";
export type Surface = "road" | "trail" | "track" | "treadmill";
export type PlateMaterial = "carbon" | "nylon" | "fiberglass" | "carbon-composite" | "tpu" | "air";

export interface Plate {
  present: boolean;
  material?: PlateMaterial;
  /** e.g. "full-length", "SpeedRoll", "EnergyRods", "PWRPLATE" */
  description?: string;
}

export interface ShoeSpec {
  /** Heel stack height in mm */
  heelStack: number;
  /** Forefoot stack height in mm */
  forefootStack: number;
  /** Heel-to-toe drop in mm */
  drop: number;
  /** Weight in grams (reference size: men's US 9 or women's US 8 depending on context) */
  weightGrams: number;
  /** MSRP in USD */
  msrp: number;
  /** Reference size used for weight measurement */
  refSize?: string;
}

/** Per-gender spec overrides. Only fields that differ from the base spec need to be set. */
export interface GenderSpec {
  weightGrams?: number;
  heelStack?: number;
  forefootStack?: number;
  msrp?: number;
  widths?: string[];
  refSize?: string;
}

export interface ShoeVariant {
  version: string;
  year: number;
  /** Base spec — defaults to men's reference unless genderVariants overrides */
  spec: ShoeSpec;
  /** Per-gender overrides. Merged over base spec. */
  genderVariants?: {
    mens?:   GenderSpec;
    womens?: GenderSpec;
  };
  foam: string;
  plate: Plate;
  /** Primary surfaces this shoe is designed for */
  surfaces: Surface[];
  /** Whether it has a meta-rocker or similar geometry-driven roll */
  rocker: boolean;
  /** Width options available, e.g. ["B","D","2E","4E"] */
  widths?: string[];
  features: string[];
  useCases: UseCase[];
  notes: string;
}

export interface Shoe {
  id: string;
  brand: string;
  model: string;
  category: Category;
  cushion: CushionLevel;
  variants: ShoeVariant[];
}
