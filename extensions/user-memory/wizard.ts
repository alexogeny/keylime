import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_CATEGORIES,
  PINNED_PROFILE_TAGS,
  SENSITIVITY_TIERS,
  TIMELINE_SUBKINDS,
  type MemoryCategory,
  type MemoryWizardSensitivity,
  type RememberParams,
  type StoredSensitivityTier,
  type TimelineDatePoint,
  type TimelineDatePrecision,
  type TimelineEntryDraft,
  type TimelineInterval,
  type TimelineMemoryPayload,
  type TimelineSubkind,
} from "./types.js";
export { fitTuiLine } from "../shared/tui-form";
import { parseCommaList, uniqueCleanTags } from "./normalize.js";
import {
  convertDraftToRememberParams,
  previewMemoryWizardDraft,
  validateMemoryWizardDraft,
  EXPIRY_CHOICES,
  isExpiryChoice,
  isMemoryCategory,
  isSensitivity,
  type MemoryWizardDraft,
} from "./freeform.js";
import {
  cleanTimelineDate,
  isTimelineSubkind,
  convertTimelineDraftToRememberParams,
  inferTimelineSubkindFromQuery,
  previewTimelineEntryDraft,
  validateTimelineEntryDraft,
} from "./timeline.js";
import {
  buildProfileFactDraftsForFields,
  buildProfilePatchForFields,
  cleanProfileFactValues,
  convertedUnitHint,
  defaultUnit,
  previewProfileFactDrafts,
  previewProfilePatch,
  profilePatchToFactValuesForFields,
  sectionCompletenessForFields,
  unitKey,
  validateProfileFactValuesForFields,
  type ProfileFactField,
  type ProfileFactFieldKind,
  type ProfileFactSection,
  type ProfileFactValues,
  type ProfilePatch,
  type ProfilePatchValue,
} from "./profile-facts.js";
import { editProfileFactSection, sectionFromLabel, sectionMenuLabels } from "./profile-form.js";
export { MEMORY_CATEGORIES, PINNED_PROFILE_TAGS, SENSITIVITY_TIERS, TIMELINE_SUBKINDS } from "./types.js";
export { convertedUnitHint, defaultUnit, previewProfileFactDrafts, previewProfilePatch, unitKey } from "./profile-facts.js";
export { parseCommaList } from "./normalize.js";
export {
  convertDraftToRememberParams,
  previewMemoryWizardDraft,
  validateMemoryWizardDraft,
  type MemoryWizardDraft,
  type MemoryWizardExpiryChoice,
  type MemoryWizardValidationResult,
} from "./freeform.js";
export {
  convertTimelineDraftToRememberParams,
  inferTimelineSubkindFromQuery,
  previewTimelineEntryDraft,
  validateTimelineEntryDraft,
} from "./timeline.js";
export type {
  MemoryCategory,
  MemoryWizardSensitivity,
  RememberParams,
  StoredSensitivityTier,
  TimelineDatePoint,
  TimelineDatePrecision,
  TimelineEntryDraft,
  TimelineInterval,
  TimelineMemoryPayload,
  TimelineSubkind,
} from "./types.js";
export type { ProfileFactField, ProfileFactFieldKind, ProfileFactSection, ProfileFactValues, ProfilePatch, ProfilePatchValue } from "./profile-facts.js";

export const PROFILE_FACT_SECTIONS = [
  "identity", "body", "appearance", "health", "genetics", "athlete", "mental", "life", "contact", "work", "preferences",
] as const;
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

  // Appearance / physical description
  { id: "hair_color", label: "Hair color", section: "appearance", kind: "text", placeholder: "brown, black, blonde, auburn, dyed blue", tags: ["profile", "appearance", "hair", "hair-color"], sensitivity: "general" },
  { id: "hair_style", label: "Hair style", section: "appearance", kind: "text", placeholder: "bob, pixie, ponytail, curly, shaved sides", tags: ["profile", "appearance", "hair", "hair-style"], sensitivity: "general" },
  { id: "hair_length", label: "Hair length", section: "appearance", kind: "select", options: ["", "shaved", "buzzed", "short", "chin-length", "shoulder-length", "medium", "long", "very long", "other / custom"], tags: ["profile", "appearance", "hair", "hair-length"], sensitivity: "general" },
  { id: "eye_color", label: "Eye color", section: "appearance", kind: "text", placeholder: "brown, blue, green, hazel, grey", tags: ["profile", "appearance", "eyes", "eye-color"], sensitivity: "general" },
  { id: "skin_tone", label: "Skin tone / complexion", section: "appearance", kind: "text", placeholder: "optional self-described complexion", tags: ["profile", "appearance", "skin", "complexion"], sensitivity: "context_gated" },
  { id: "face_shape", label: "Face shape", section: "appearance", kind: "text", placeholder: "oval, round, heart-shaped, angular", tags: ["profile", "appearance", "face"], sensitivity: "general" },
  { id: "build", label: "Build / frame", section: "appearance", kind: "text", placeholder: "slim, athletic, curvy, broad-shouldered", tags: ["profile", "appearance", "build", "body"], sensitivity: "general" },
  { id: "distinguishing_features", label: "Distinguishing features", section: "appearance", kind: "text", placeholder: "freckles, dimples, birthmark, scar", tags: ["profile", "appearance", "features"], sensitivity: "context_gated" },
  { id: "tattoos", label: "Tattoos", section: "appearance", kind: "text", placeholder: "locations/styles, or none", tags: ["profile", "appearance", "tattoos"], sensitivity: "context_gated" },
  { id: "piercings", label: "Piercings", section: "appearance", kind: "text", placeholder: "ears, nose, etc., or none", tags: ["profile", "appearance", "piercings"], sensitivity: "context_gated" },
  { id: "glasses", label: "Glasses / contacts", section: "appearance", kind: "select", options: ["", "none", "glasses", "contacts", "both", "sometimes", "other / custom"], tags: ["profile", "appearance", "glasses", "vision"], sensitivity: "general" },
  { id: "style_aesthetic", label: "Style aesthetic", section: "appearance", kind: "text", placeholder: "minimal, sporty, goth, corporate, colourful", tags: ["profile", "appearance", "style", "clothing"], sensitivity: "general" },
  { id: "usual_makeup", label: "Usual makeup", section: "appearance", kind: "text", placeholder: "none, natural, winged liner, bold lip", tags: ["profile", "appearance", "makeup"], sensitivity: "general" },

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

  // Genetics / genotype notes
  { id: "drd4_vntr", label: "DRD4 VNTR", section: "genetics", kind: "select", options: ["", "2R", "3R", "4R", "5R", "6R", "7R", "8R", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "DRD4", "dopamine"], sensitivity: "context_gated", contentLabel: "DRD4 VNTR genotype" },
  { id: "slc6a4_5httlpr", label: "5-HTTLPR / SLC6A4", section: "genetics", kind: "select", options: ["", "L/L", "L/S", "S/S", "LA/LA", "LA/LG", "LA/S", "LG/LG", "LG/S", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "5-HTTLPR", "SLC6A4", "serotonin"], sensitivity: "context_gated", contentLabel: "5-HTTLPR / SLC6A4 genotype" },
  { id: "maoa_uvntr", label: "MAOA-uVNTR", section: "genetics", kind: "select", options: ["", "2R", "3R", "3.5R", "4R", "5R", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "MAOA"], sensitivity: "context_gated", contentLabel: "MAOA-uVNTR genotype" },
  { id: "trpc2_variant", label: "TRPC2 variant", section: "genetics", kind: "text", placeholder: "variant / rsID / note", tags: ["profile", "genetics", "genotype", "TRPC2"], sensitivity: "context_gated", contentLabel: "TRPC2 genetic note" },
  { id: "comt_rs4680", label: "COMT rs4680 (Val158Met)", section: "genetics", kind: "select", options: ["", "Val/Val (G/G)", "Val/Met (G/A)", "Met/Met (A/A)", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "COMT", "rs4680", "dopamine"], sensitivity: "context_gated", contentLabel: "COMT rs4680 genotype" },
  { id: "bdnf_rs6265", label: "BDNF rs6265 (Val66Met)", section: "genetics", kind: "select", options: ["", "Val/Val (G/G)", "Val/Met (G/A)", "Met/Met (A/A)", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "BDNF", "rs6265"], sensitivity: "context_gated", contentLabel: "BDNF rs6265 genotype" },
  { id: "mthfr_c677t", label: "MTHFR C677T / rs1801133", section: "genetics", kind: "select", options: ["", "C/C", "C/T", "T/T", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "MTHFR", "rs1801133", "methylation"], sensitivity: "context_gated", contentLabel: "MTHFR C677T genotype" },
  { id: "mthfr_a1298c", label: "MTHFR A1298C / rs1801131", section: "genetics", kind: "select", options: ["", "A/A", "A/C", "C/C", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "MTHFR", "rs1801131", "methylation"], sensitivity: "context_gated", contentLabel: "MTHFR A1298C genotype" },
  { id: "apoe_genotype", label: "APOE genotype", section: "genetics", kind: "select", options: ["", "ε2/ε2", "ε2/ε3", "ε2/ε4", "ε3/ε3", "ε3/ε4", "ε4/ε4", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "APOE"], sensitivity: "context_gated", contentLabel: "APOE genotype" },
  { id: "cyp1a2_rs762551", label: "CYP1A2 rs762551", section: "genetics", kind: "select", options: ["", "A/A", "A/C", "C/C", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "CYP1A2", "rs762551", "caffeine"], sensitivity: "context_gated", contentLabel: "CYP1A2 rs762551 genotype" },
  { id: "cyp2d6_phenotype", label: "CYP2D6 metabolizer", section: "genetics", kind: "select", options: ["", "poor", "intermediate", "normal / extensive", "rapid", "ultrarapid", "other / custom", "unknown"], tags: ["profile", "genetics", "pharmacogenomics", "CYP2D6"], sensitivity: "context_gated", contentLabel: "CYP2D6 metabolizer status" },
  { id: "cyp2c19_phenotype", label: "CYP2C19 metabolizer", section: "genetics", kind: "select", options: ["", "poor", "intermediate", "normal / extensive", "rapid", "ultrarapid", "other / custom", "unknown"], tags: ["profile", "genetics", "pharmacogenomics", "CYP2C19"], sensitivity: "context_gated", contentLabel: "CYP2C19 metabolizer status" },
  { id: "actn3_rs1815739", label: "ACTN3 rs1815739", section: "genetics", kind: "select", options: ["", "C/C", "C/T", "T/T", "R/R", "R/X", "X/X", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "ACTN3", "rs1815739", "athlete"], sensitivity: "context_gated", contentLabel: "ACTN3 rs1815739 genotype" },
  { id: "ace_indel", label: "ACE I/D", section: "genetics", kind: "select", options: ["", "I/I", "I/D", "D/D", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "ACE", "athlete"], sensitivity: "context_gated", contentLabel: "ACE I/D genotype" },
  { id: "lct_rs4988235", label: "LCT rs4988235", section: "genetics", kind: "select", options: ["", "C/C", "C/T", "T/T", "other / custom", "unknown"], tags: ["profile", "genetics", "genotype", "LCT", "rs4988235", "lactose"], sensitivity: "context_gated", contentLabel: "LCT rs4988235 genotype" },
  { id: "hla_b", label: "HLA-B risk alleles", section: "genetics", kind: "text", placeholder: "e.g. HLA-B*57:01, HLA-B*15:02, or none known", tags: ["profile", "genetics", "genotype", "HLA", "pharmacogenomics"], sensitivity: "context_gated", contentLabel: "HLA-B genetic note" },
  { id: "other_genetic_variants", label: "Other genetic variants", section: "genetics", kind: "text", placeholder: "gene, rsID, genotype, and source", tags: ["profile", "genetics", "genotype"], sensitivity: "context_gated", contentLabel: "other genetic variants" },

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

export function sectionCompleteness(values: ProfileFactValues, section: ProfileFactSection): number {
  return sectionCompletenessForFields(PROFILE_FACT_FIELDS, values, section);
}

export function validateProfileFactValues(values: ProfileFactValues): string[] {
  return validateProfileFactValuesForFields(PROFILE_FACT_FIELDS, values);
}

export function buildProfileFactDrafts(values: ProfileFactValues): MemoryWizardDraft[] {
  return buildProfileFactDraftsForFields(PROFILE_FACT_FIELDS, values);
}

export function profilePatchToFactValues(profile: ProfilePatch | undefined): ProfileFactValues {
  return profilePatchToFactValuesForFields(PROFILE_FACT_FIELDS, profile);
}

export function buildProfilePatch(values: ProfileFactValues): ProfilePatch {
  return buildProfilePatchForFields(PROFILE_FACT_FIELDS, values);
}

async function runStructuredProfileFactFlow(ctx: any, save: (patch: ProfilePatch) => Promise<{ text: string }>, loadProfile?: () => Promise<ProfilePatch>) {
  let values: ProfileFactValues = profilePatchToFactValues(loadProfile ? await loadProfile() : undefined);

  while (true) {
    const choice = await ctx.ui.select(
      "Structured facts: choose a category. Percentages include currently stored profile fields.",
      sectionMenuLabels(PROFILE_FACT_SECTIONS, values, sectionCompleteness),
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

    const section = sectionFromLabel(PROFILE_FACT_SECTIONS, choice);
    if (!section) continue;
    const edited = await editProfileFactSection(ctx, {
      section,
      fields: PROFILE_FACT_FIELDS.filter(field => field.section === section),
      values,
      completeness: sectionCompleteness,
    });
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
  } else if (subkind === "person") {
    await promptField("name", "Person name");
    await promptField("relationship", "Relationship / role (family, friend, colleague, etc.)");
    await promptField("place", "Associated place (optional)");
    await promptField("status", "Status / context (current, estranged, deceased, etc.; optional)");
  } else if (subkind === "life_event") {
    await promptField("event", "Event name / summary");
    await promptField("people", "People involved, comma-separated (optional)");
    await promptField("places", "Places involved, comma-separated (optional)");
    await promptField("type", "Event type (move, birth, death, graduation, wedding, etc.; optional)");
  } else {
    await promptField("name", "Name / entity (optional)");
    await promptField("people", "People involved, comma-separated (optional)");
    await promptField("places", "Places involved, comma-separated (optional)");
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
