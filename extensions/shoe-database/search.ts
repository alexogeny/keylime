/**
 * Search and filter engine for the shoe database.
 * Supports BM25-style text search, structured spec filtering,
 * and natural-language query parsing.
 */

import type { Shoe, ShoeVariant, UseCase, Surface, CushionLevel, Category, PlateMaterial, ShoeSpec, GenderSpec } from "./types.js";
import { NEW_BALANCE, BROOKS, ASICS, HOKA, NIKE, SAUCONY, ADIDAS, PUMA, ON_RUNNING, ALTRA, MIZUNO, UNDER_ARMOUR, SALOMON, REEBOK, CUSTOM } from "./catalog/index.js";

// ── Gender spec resolution ───────────────────────────────────────────────────

export type Gender = "mens" | "womens";

/** Merge gender overrides onto a base spec. Returns a new object. */
export function resolveSpec(variant: ShoeVariant, gender?: Gender): ShoeSpec {
  const base = { ...variant.spec };
  if (!gender || !variant.genderVariants) return base;
  const override: GenderSpec | undefined = variant.genderVariants[gender];
  if (!override) return base;
  return { ...base, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)) } as ShoeSpec;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export const ALL_SHOES: Shoe[] = [
  ...NEW_BALANCE,
  ...BROOKS,
  ...ASICS,
  ...HOKA,
  ...NIKE,
  ...SAUCONY,
  ...ADIDAS,
  ...PUMA,
  ...ON_RUNNING,
  ...ALTRA,
  ...MIZUNO,
  ...UNDER_ARMOUR,
  ...SALOMON,
  ...REEBOK,
  ...CUSTOM,
];

export interface Hit {
  shoe: Shoe;
  variant: ShoeVariant;
}

export function allVariants(): Hit[] {
  return ALL_SHOES.flatMap((shoe) => shoe.variants.map((variant) => ({ shoe, variant })));
}

// ── Text search ───────────────────────────────────────────────────────────────

const STOP = new Set(["a","an","the","and","or","in","on","for","of","with","is","are","has","the","vs","to"]);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

function docText(hit: Hit): string {
  const { shoe, variant } = hit;
  return [
    shoe.brand, shoe.model, shoe.category, shoe.cushion,
    variant.version, String(variant.year), variant.foam,
    variant.plate.present ? (variant.plate.material ?? "plate") : "no-plate plateless unplated",
    variant.surfaces.join(" "),
    variant.rocker ? "rocker" : "",
    variant.useCases.join(" "),
    variant.features.join(" "),
    variant.notes,
  ].join(" ");
}

export function textSearch(query: string, pool: Hit[], topK = 10): Hit[] {
  const qt = tokens(query);
  if (qt.length === 0) return pool.slice(0, topK);

  const scored = pool.map((hit) => {
    const text = docText(hit).toLowerCase();
    let score = 0;
    for (const t of qt) {
      if (text.includes(t)) score += 1;
      if (hit.shoe.brand.toLowerCase().includes(t)) score += 2;
      if (hit.shoe.model.toLowerCase().includes(t)) score += 2;
      if (hit.variant.version.toLowerCase() === t || hit.variant.version.toLowerCase().includes(t)) score += 3;
      if (String(hit.variant.year) === t) score += 2;
      if (hit.shoe.id === t) score += 4;
    }
    return { hit, score };
  });

  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK).map((x) => x.hit);
}

// ── Spec filter ───────────────────────────────────────────────────────────────

export interface SpecFilter {
  brand?: string;
  category?: Category;
  cushion?: CushionLevel;
  min_drop?: number;
  max_drop?: number;
  drop?: number;               // exact match (±0.5mm)
  min_heel_stack?: number;
  max_heel_stack?: number;
  max_weight_grams?: number;
  max_msrp?: number;
  use_case?: string;
  surface?: string;
  year_min?: number;
  year_max?: number;
  no_plate?: boolean;          // exclude all plated shoes
  plate_required?: boolean;    // require a plate
  plate_material?: PlateMaterial | PlateMaterial[];  // require specific plate material(s)
  rocker?: boolean;
  natural_query?: string;      // parsed below
}

/** Parse natural-language phrases and merge into a SpecFilter */
export function parseNaturalQuery(q: string): Partial<SpecFilter> {
  const out: Partial<SpecFilter> = {};
  const s = q.toLowerCase();

  // Drop
  const dropExact = s.match(/\b(\d+)\s*mm\s*drop\b/);
  if (dropExact) out.drop = Number(dropExact[1]);

  const dropRange = s.match(/(\d+)\s*[-–to]+\s*(\d+)\s*mm\s*drop/);
  if (dropRange) { out.min_drop = Number(dropRange[1]); out.max_drop = Number(dropRange[2]); }

  const dropUnder = s.match(/(?:under|less than|max|below)\s*(\d+)\s*mm\s*drop/);
  if (dropUnder) out.max_drop = Number(dropUnder[1]);

  const dropOver = s.match(/(?:over|more than|above|min|at least)\s*(\d+)\s*mm\s*drop/);
  if (dropOver) out.min_drop = Number(dropOver[1]);

  // Zero drop
  if (/\bzero.?drop\b/.test(s)) out.drop = 0;

  // Low drop
  if (/\blow.?drop\b/.test(s) && out.drop == null && out.max_drop == null) out.max_drop = 6;

  // High drop
  if (/\bhigh.?drop\b/.test(s) && out.drop == null && out.min_drop == null) out.min_drop = 10;

  // Weight
  const weightUnder = s.match(/(?:under|less than|below)\s*(\d+)\s*g\b/);
  if (weightUnder) out.max_weight_grams = Number(weightUnder[1]);
  const weightOz = s.match(/(?:under|less than|below)\s*([\d.]+)\s*oz\b/);
  if (weightOz) out.max_weight_grams = Math.round(Number(weightOz[1]) * 28.35);

  // Price (require $ sign or 'under $NNN' — avoid matching weight like 'under 200g')
  const priceUnder = s.match(/(?:under|less than|below|cheap|budget)\s*\$(\d+)|(?:under|below)\s+(\d+)\s*(?:dollar|usd|aud)/i);
  if (priceUnder) out.max_msrp = Number(priceUnder[1] ?? priceUnder[2]);

  // Plate
  // Plate — check 'no plate' patterns first; don't set plate_required if no_plate
  if (/\bno.?plate\b|\bplateless\b|\bunplated\b|\bwithout.?(?:a\s+)?(?:carbon|plate)\b/.test(s)) out.no_plate = true;
  if (!out.no_plate && /(?:^|\s)(?:carbon.?plate|with.?(?:carbon|plate)|\bplated\b)/.test(s)) out.plate_required = true;
  if (/\bnylon.?plate\b/.test(s)) out.plate_material = "nylon";
  if (/\bfiberglass.?plate\b|\benergyrods\b/.test(s)) out.plate_material = "fiberglass";

  // Category
  if (/\bstability\b/.test(s)) out.category = "stability";
  if (/\bneutral\b/.test(s)) out.category = "neutral";
  if (/\bmotion.?control\b/.test(s)) out.category = "motion-control";

  // Cushion
  if (/\bmax(?:imum)?.?cushion\b|\bmaximalist\b/.test(s)) out.cushion = "max";
  if (/\bmoderate.?cushion\b/.test(s)) out.cushion = "moderate";
  if (/\bminimal(?:ist)?\b/.test(s)) out.cushion = "minimal";

  // Surface
  if (/\btrail\b/.test(s)) out.surface = "trail";
  if (/\btrack\b/.test(s)) out.surface = "track";
  if (/\broad\b/.test(s)) out.surface = "road";

  // Use case
  if (/\brace\b|\bracing\b/.test(s) && !/\bno.?race\b/.test(s)) out.use_case = "race";
  if (/\brecovery\b/.test(s)) out.use_case = "recovery";
  if (/\btempo\b/.test(s)) out.use_case = "tempo";
  if (/\bwalk(?:ing)?\b/.test(s)) out.use_case = "walking";

  // Year
  const years = s.match(/\b(202[2-9]|2030)\b/g);
  if (years) {
    const nums = years.map(Number);
    out.year_min = Math.min(...nums);
    out.year_max = Math.max(...nums);
  }

  // Rocker
  if (/\brocker\b/.test(s)) out.rocker = true;
  if (/\bno.?rocker\b/.test(s)) out.rocker = false;

  return out;
}

export function applyFilter(hits: Hit[], f: SpecFilter): Hit[] {
  // Merge natural_query if present
  let merged: SpecFilter = { ...f };
  if (f.natural_query) {
    const parsed = parseNaturalQuery(f.natural_query);
    // parsed values only fill in if not already specified
    for (const [k, v] of Object.entries(parsed)) {
      if (merged[k as keyof SpecFilter] == null) (merged as any)[k] = v;
    }
  }

  return hits.filter(({ shoe, variant }) => {
    const s = variant.spec;

    if (merged.brand) {
      if (!shoe.brand.toLowerCase().includes(merged.brand.toLowerCase())) return false;
    }
    if (merged.category && shoe.category !== merged.category) return false;
    if (merged.cushion && shoe.cushion !== merged.cushion) return false;
    if (merged.drop != null && Math.abs(s.drop - merged.drop) > 0.5) return false;
    if (merged.min_drop != null && s.drop < merged.min_drop) return false;
    if (merged.max_drop != null && s.drop > merged.max_drop) return false;
    if (merged.min_heel_stack != null && s.heelStack < merged.min_heel_stack) return false;
    if (merged.max_heel_stack != null && s.heelStack > merged.max_heel_stack) return false;
    if (merged.max_weight_grams != null && s.weightGrams > merged.max_weight_grams) return false;
    if (merged.max_msrp != null && s.msrp > merged.max_msrp) return false;
    if (merged.year_min != null && variant.year < merged.year_min) return false;
    if (merged.year_max != null && variant.year > merged.year_max) return false;
    if (merged.no_plate === true && variant.plate.present) return false;
    if (merged.plate_required === true && !variant.plate.present) return false;
    if (merged.rocker != null && variant.rocker !== merged.rocker) return false;

    if (merged.plate_material != null) {
      if (!variant.plate.present) return false;
      const mats = Array.isArray(merged.plate_material) ? merged.plate_material : [merged.plate_material];
      if (!mats.includes(variant.plate.material as PlateMaterial)) return false;
    }

    if (merged.use_case) {
      if (!variant.useCases.includes(merged.use_case as UseCase)) return false;
    }
    if (merged.surface) {
      if (!variant.surfaces.includes(merged.surface as Surface)) return false;
    }

    return true;
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatHit(hit: Hit, detail = false, gender?: Gender): string {
  const { shoe, variant } = hit;
  const s = resolveSpec(variant, gender);
  const widths = (gender === "womens" && variant.genderVariants?.womens?.widths)
    ? variant.genderVariants.womens.widths
    : (gender === "mens" && variant.genderVariants?.mens?.widths)
    ? variant.genderVariants.mens.widths
    : variant.widths;
  const plateStr = variant.plate.present
    ? `${variant.plate.material ?? "plated"} plate${variant.plate.description ? ` (${variant.plate.description})` : ""}`
    : "no plate";
  const genderLabel = gender ? ` · ${gender}` : " · men's ref";
  const refSize = s.refSize ?? (gender === "womens" ? "women's US 8" : "men's US 9");
  const lines = [
    `## ${shoe.brand} ${shoe.model} ${variant.version} (${variant.year})${genderLabel}`,
    `Category: ${shoe.category} | Cushion: ${shoe.cushion} | Surfaces: ${variant.surfaces.join(", ")}`,
    `Stack:  ${s.heelStack}mm heel / ${s.forefootStack}mm forefoot | Drop: ${s.drop}mm`,
    `Weight: ${s.weightGrams}g (${(s.weightGrams / 28.35).toFixed(1)} oz) ref: ${refSize} | MSRP: $${s.msrp}`,
    `Foam:   ${variant.foam}`,
    `Plate:  ${plateStr}${variant.rocker ? " | Rocker: yes" : ""}`,
    `Use:    ${variant.useCases.join(", ")}`,
  ];
  if (widths?.length) lines.push(`Widths: ${widths.join(", ")}`);
  if (detail) {
    lines.push("", "Features:");
    variant.features.forEach((f) => lines.push(`  • ${f}`));
    lines.push("", `Notes: ${variant.notes}`);
  }
  return lines.join("\n");
}

export function formatDiff(a: Hit, b: Hit): string[] {
  const diffs: string[] = [];
  const sa = a.variant.spec, sb = b.variant.spec;
  const dropDiff = Math.abs(sa.drop - sb.drop);
  if (dropDiff > 0) diffs.push(`Drop: ${a.shoe.model} ${a.variant.version} is ${sa.drop}mm vs ${sb.drop}mm (${dropDiff}mm difference)`);
  const stackDiff = Math.abs(sa.heelStack - sb.heelStack);
  if (stackDiff > 0) diffs.push(`Heel stack: ${a.shoe.model} ${a.variant.version} is ${sa.heelStack}mm vs ${sb.heelStack}mm (${stackDiff}mm difference)`);
  const wDiff = Math.abs(sa.weightGrams - sb.weightGrams);
  if (wDiff > 5) diffs.push(`Weight: ${a.shoe.model} ${a.variant.version} is ${sa.weightGrams}g vs ${sb.weightGrams}g (${wDiff}g difference)`);
  const priceDiff = Math.abs(sa.msrp - sb.msrp);
  if (priceDiff > 0) diffs.push(`Price: $${sa.msrp} vs $${sb.msrp} ($${priceDiff} difference)`);
  if (a.variant.plate.present !== b.variant.plate.present) {
    diffs.push(`Plate: ${a.shoe.model} ${a.variant.version} has ${a.variant.plate.present ? a.variant.plate.material : "no"} plate; ${b.shoe.model} ${b.variant.version} has ${b.variant.plate.present ? b.variant.plate.material : "no"} plate`);
  }
  if (a.variant.rocker !== b.variant.rocker) {
    diffs.push(`Rocker: ${a.shoe.model} ${a.variant.version} ${a.variant.rocker ? "has" : "lacks"} rocker geometry`);
  }
  return diffs;
}
