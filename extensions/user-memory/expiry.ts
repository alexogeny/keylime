import { tokenize } from "../shared/retrieval";

export type ExpiryTier = "2d" | "7d" | "30d" | null;

export const SIGNIFICANT_EVENT_TOKENS = new Set([
  "died", "death", "passed", "funeral", "buried", "cremated", "killed", "lost",
  "diagnosed", "diagnosis", "cancer", "surgery", "hospitalised", "hospitalized",
  "transplant", "stroke", "heart", "overdosed", "collapsed",
  "born", "birth", "pregnant", "miscarriage", "stillborn", "adopted",
  "married", "divorced", "separated", "engaged", "wedding", "graduation",
  "fired", "redundant", "redundancy", "bankrupt", "arrested", "assaulted",
]);

export const ACTIVITY_CLASS_TOKENS = new Set([
  "applying", "applications", "interviewing", "interviews", "headhunter", "recruiter",
  "chemo", "chemotherapy", "radiation", "physio", "physiotherapy", "rehab",
  "treatment", "counselling", "counseling",
  "bloodwork", "biopsy", "scan", "mri", "ultrasound", "xray",
  "appointment", "referral", "followup", "results", "awaiting", "waiting",
  "house", "apartment", "mortgage", "deposit", "auction", "inspection",
  "moving", "relocating", "visa", "immigration",
]);

const TIER_2D_TOKENS  = new Set(["today","tonight","morning","afternoon","evening","rn","atm"]);
const TIER_7D_PHRASES = ["this week","past few days","past couple days","last few days"];
const TIER_7D_TOKENS  = new Set(["recently","yesterday","earlier"]);
const TIER_30D_PHRASES= ["these days","this month","for now","right now","at the moment","at this point","currently"];
const TIER_30D_TOKENS = new Set(["currently","nowadays","lately"]);

export function inferExpiryTier(
  text: string,
  features: string[],
  score: number,
  highSignalThreshold = 5.5,
): ExpiryTier {
  const featureSet = new Set(features);
  const tokens     = new Set(tokenize(text));
  const rawLower   = text.toLowerCase();

  if (featureSet.has("recurrence")) return null;
  if (featureSet.has("preference_strong") && featureSet.has("comparison")) return null;
  if (featureSet.has("preference_strong") && score >= highSignalThreshold) return null;

  if ([...SIGNIFICANT_EVENT_TOKENS].some(t => tokens.has(t))) return null;

  const isActivityClass = [...ACTIVITY_CLASS_TOKENS].some(t => tokens.has(t));
  const recurrenceWords = (rawLower.match(/\b(again|second|third|fourth|fifth|keep|keeps|still|another|twice|times)\b/g) || []).length;
  const hasMildRecurrence = recurrenceWords >= 1;
  const hasStrongRecurrence = recurrenceWords >= 2 || featureSet.has("recurrence");

  const is2d = [...TIER_2D_TOKENS].some(t => tokens.has(t));
  if (is2d && !isActivityClass && !hasMildRecurrence) return "2d";
  if (is2d && hasStrongRecurrence) return "30d";
  if (is2d && hasMildRecurrence) return "7d";

  const is7d = TIER_7D_PHRASES.some(p => rawLower.includes(p)) ||
               [...TIER_7D_TOKENS].some(t => tokens.has(t));
  if (is7d && (isActivityClass || hasMildRecurrence)) return "30d";
  if (is7d) return "7d";

  if (TIER_30D_PHRASES.some(p => rawLower.includes(p))) return "30d";
  if ([...TIER_30D_TOKENS].some(t => tokens.has(t))) return "30d";
  if (isActivityClass) return "30d";

  if (score < highSignalThreshold) return "30d";
  return null;
}

export function tierToMs(tier: ExpiryTier): number | undefined {
  if (!tier) return undefined;
  const days = tier === "2d" ? 2 : tier === "7d" ? 7 : 30;
  return Date.now() + days * 86_400_000;
}
