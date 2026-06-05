/**
 * Tool registrations for the shoe database extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "../shared/schema";
import { allVariants, textSearch, applyFilter, formatHit, formatDiff, ALL_SHOES, parseNaturalQuery, type Gender } from "./search.js";
import { writeFile } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../shared/json-store";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Shoe, ShoeVariant } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CUSTOM_JSON = join(__dir, "catalog", "custom-data.json");
const CUSTOM_TS   = join(__dir, "catalog", "custom.ts");

// ── custom catalog helpers ───────────────────────────────────────────────────

function tsVal(v: unknown, depth = 0): string {
  const pad  = "  ".repeat(depth);
  const next = "  ".repeat(depth + 1);
  if (v === null || v === undefined) return "undefined";
  if (typeof v === "string")  return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => typeof x !== "object" || x === null))
      return `[${v.map((x) => tsVal(x, depth)).join(", ")}]`;
    return `[\n${v.map((x) => `${next}${tsVal(x, depth + 1)}`).join(",\n")},\n${pad}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, val]) => `${next}${k}: ${tsVal(val, depth + 1)}`).join(",\n")},\n${pad}}`;
  }
  return String(v);
}

async function readCustom(): Promise<Shoe[]> {
  return readJsonFile<Shoe[]>(CUSTOM_JSON, []);
}

async function writeCustom(shoes: Shoe[]): Promise<void> {
  await writeJsonFile(CUSTOM_JSON, shoes, { finalNewline: true });
  const entries = shoes.map((s) => `  ${tsVal(s, 1)}`).join(",\n");
  const ts = [
    "// ── AUTO-GENERATED — do not edit by hand ─────────────────────────────────────",
    "// Source of truth: catalog/custom-data.json",
    "// Updated by the add_shoe tool.",
    "// ─────────────────────────────────────────────────────────────────────────────",
    'import type { Shoe } from "../types.js";',
    "",
    `export const CUSTOM: Shoe[] = [${shoes.length === 0 ? "" : "\n" + entries + ",\n"}];`,
    "",
  ].join("\n");
  await writeFile(CUSTOM_TS, ts, "utf8");
}

export function registerTools(pi: ExtensionAPI): void {

  // ── lookup_shoe ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "lookup_shoe",
    label: "Look Up Shoe",
    description: "Search running shoes by brand/model/version/year.",
    promptSnippet: "Search shoe catalog",
    promptGuidelines: ["Use for specific shoe specs."],
    parameters: Type.Object({
      query:  Type.String({ description: 'Query' }),
      top_k:  Type.Optional(Type.Number({ description: "Limit", minimum: 1, maximum: 20 })),
      detail: Type.Optional(Type.Boolean({ description: "Details" })),
      gender: Type.Optional(stringEnum(["mens", "womens"] as const, { description: "Gender" })),
    }),
    async execute(_id, params) {
      const gender = params.gender as Gender | undefined;
      const hits = textSearch(params.query, allVariants(), params.top_k ?? 5);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No shoes found for "${params.query}". Try brand names or model names.` }], details: { count: 0 } };
      }
      const lines = [`Found ${hits.length} match${hits.length !== 1 ? "es" : ""} for "${params.query}":`, ""];
      for (const h of hits) lines.push(formatHit(h, params.detail ?? false, gender), "");
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: hits.length } };
    },
  });

  // ── find_shoes_by_spec ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "find_shoes_by_spec",
    label: "Find Shoes by Spec",
    description: "Filter shoes by specs.",
    promptSnippet: "Filter shoes by spec",
    promptGuidelines: ["Use natural_query or structured filters."],
    parameters: Type.Object({
      natural_query: Type.Optional(Type.String({
        description: "Natural query",
      })),
      brand:            Type.Optional(Type.String({ description: "Brand" })),
      category:         Type.Optional(stringEnum(["neutral", "stability", "motion-control"] as const, { description: "Category" })),
      cushion:          Type.Optional(stringEnum(["minimal", "low", "moderate", "high", "max"] as const, { description: "Cushion" })),
      drop:             Type.Optional(Type.Number({ description: "Drop mm" })),
      min_drop:         Type.Optional(Type.Number({ description: "Min drop" })),
      max_drop:         Type.Optional(Type.Number({ description: "Max drop" })),
      min_heel_stack:   Type.Optional(Type.Number({ description: "Min heel stack" })),
      max_heel_stack:   Type.Optional(Type.Number({ description: "Max heel stack" })),
      max_weight_grams: Type.Optional(Type.Number({ description: "Max weight" })),
      max_msrp:         Type.Optional(Type.Number({ description: "Max MSRP" })),
      use_case:         Type.Optional(Type.String({ description: "daily-trainer | long-run | tempo | race | recovery | trail | walking | track" })),
      surface:          Type.Optional(Type.String({ description: "road | trail | track | treadmill" })),
      year_min:         Type.Optional(Type.Number({ description: "Minimum release year" })),
      year_max:         Type.Optional(Type.Number({ description: "Maximum release year" })),
      no_plate:         Type.Optional(Type.Boolean({ description: "Exclude plates" })),
      plate_required:   Type.Optional(Type.Boolean({ description: "Require plate" })),
      plate_material:   Type.Optional(Type.String({ description: "carbon | nylon | fiberglass | carbon-composite | air" })),
      rocker:           Type.Optional(Type.Boolean({ description: "Rocker" })),
      sort_by:          Type.Optional(stringEnum(["year", "drop", "stack", "weight", "price"] as const, { description: "Sort" })),
      detail:           Type.Optional(Type.Boolean({ description: "Details" })),
      gender:           Type.Optional(stringEnum(["mens", "womens"] as const, { description: "Gender" })),
    }),

    async execute(_id, params) {
      const gender = params.gender as Gender | undefined;
      let pool = allVariants();
      pool = applyFilter(pool, params as any);

      // Sort — use gender-resolved weight if sorting by weight
      const sortBy = params.sort_by ?? "year";
      pool.sort((a, b) => {
        switch (sortBy) {
          case "drop":    return a.variant.spec.drop - b.variant.spec.drop;
          case "stack":   return b.variant.spec.heelStack - a.variant.spec.heelStack;
          case "weight":  return a.variant.spec.weightGrams - b.variant.spec.weightGrams;
          case "price":   return a.variant.spec.msrp - b.variant.spec.msrp;
          default:        return b.variant.year !== a.variant.year
                            ? b.variant.year - a.variant.year
                            : b.variant.spec.heelStack - a.variant.spec.heelStack;
        }
      });

      if (pool.length === 0) {
        return { content: [{ type: "text", text: "No shoes match the given criteria. Try relaxing the filters." }], details: { count: 0 } };
      }

      const detail = params.detail ?? true;
      const lines = [`Found ${pool.length} shoe${pool.length !== 1 ? "s" : ""} matching criteria:`, ""];
      for (const h of pool) lines.push(formatHit(h, detail, gender), "");

      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: pool.length } };
    },
  });

  // ── compare_shoes ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "compare_shoes",
    label: "Compare Shoes",
    description: "Compare 2-6 shoes.",
    promptSnippet: "Compare shoe specs",
    parameters: Type.Object({
      shoes: Type.Array(Type.String({ description: 'Shoe name' }), {
        minItems: 2, maxItems: 6, description: "Shoe names",
      }),
    }),

    async execute(_id, params) {
      const found = params.shoes.map((q) => {
        const hits = textSearch(q, allVariants(), 1);
        return hits.length > 0 ? { query: q, ...hits[0] } : null;
      });

      const missing = params.shoes.filter((_, i) => !found[i]);
      const hits = found.filter(Boolean) as Array<{ query: string; shoe: import("./types.js").Shoe; variant: import("./types.js").ShoeVariant }>;

      if (hits.length === 0) {
        return { content: [{ type: "text", text: "None of the specified shoes were found in the catalog." }], details: {} };
      }

      const ROWS: Array<[string, (h: typeof hits[0]) => string]> = [
        ["Shoe",       (h) => `${h.shoe.brand} ${h.shoe.model} ${h.variant.version} (${h.variant.year})`],
        ["Category",   (h) => h.shoe.category],
        ["Cushion",    (h) => h.shoe.cushion],
        ["Heel stack", (h) => `${h.variant.spec.heelStack}mm`],
        ["Ffoot stk",  (h) => `${h.variant.spec.forefootStack}mm`],
        ["Drop",       (h) => `${h.variant.spec.drop}mm`],
        ["Weight",     (h) => `${h.variant.spec.weightGrams}g / ${(h.variant.spec.weightGrams / 28.35).toFixed(1)}oz`],
        ["MSRP",       (h) => `$${h.variant.spec.msrp}`],
        ["Foam",       (h) => h.variant.foam],
        ["Plate",      (h) => h.variant.plate.present ? (h.variant.plate.material ?? "plated") : "none"],
        ["Rocker",     (h) => h.variant.rocker ? "yes" : "no"],
        ["Surfaces",   (h) => h.variant.surfaces.join(", ")],
        ["Best for",   (h) => h.variant.useCases.join(", ")],
      ];

      const lines: string[] = ["## Side-by-Side Comparison", ""];
      for (const [label, fn] of ROWS) {
        lines.push(`**${label.padEnd(12)}** | ${hits.map(fn).join(" | ")}`);
      }

      lines.push("", "## Notes");
      for (const h of hits) {
        lines.push(``, `**${h.shoe.brand} ${h.shoe.model} ${h.variant.version}:** ${h.variant.notes}`);
      }

      if (hits.length === 2) {
        const diffs = formatDiff({ shoe: hits[0].shoe, variant: hits[0].variant }, { shoe: hits[1].shoe, variant: hits[1].variant });
        if (diffs.length) {
          lines.push("", "## Key Differences");
          diffs.forEach((d) => lines.push(`  • ${d}`));
        }
      }

      if (missing.length > 0) lines.push("", `⚠ Not found in catalog: ${missing.join(", ")}`);

      return { content: [{ type: "text", text: lines.join("\n") }], details: { found: hits.length, missing: missing.length } };
    },
  });

  // ── shoe_catalog_stats ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "shoe_catalog_stats",
    label: "Shoe Catalog Stats",
    description: "Shoe catalog statistics.",
    promptSnippet: "Overview of the shoe catalog",
    parameters: Type.Object({}),

    async execute() {
      const all = allVariants();
      const brands   = new Set(all.map((x) => x.shoe.brand));
      const models   = new Set(all.map((x) => x.shoe.id));
      const yearMin  = Math.min(...all.map((x) => x.variant.year));
      const yearMax  = Math.max(...all.map((x) => x.variant.year));
      const plated   = all.filter((x) => x.variant.plate.present).length;
      const plateless = all.length - plated;

      const byBrand    = new Map<string, number>();
      const byCat      = new Map<string, number>();
      const byCushion  = new Map<string, number>();
      const bySurface  = new Map<string, number>();
      const byDrop     = new Map<number, number>();
      const byPlateMat = new Map<string, number>();

      for (const { shoe, variant } of all) {
        byBrand.set(shoe.brand, (byBrand.get(shoe.brand) ?? 0) + 1);
        byCat.set(shoe.category, (byCat.get(shoe.category) ?? 0) + 1);
        byCushion.set(shoe.cushion, (byCushion.get(shoe.cushion) ?? 0) + 1);
        const dropKey = variant.spec.drop;
        byDrop.set(dropKey, (byDrop.get(dropKey) ?? 0) + 1);
        for (const surf of variant.surfaces) bySurface.set(surf, (bySurface.get(surf) ?? 0) + 1);
        if (variant.plate.present) {
          const mat = variant.plate.material ?? "unknown";
          byPlateMat.set(mat, (byPlateMat.get(mat) ?? 0) + 1);
        }
      }

      const lines = [
        `## Shoe Database Catalog`,
        ``,
        `Variants: ${all.length} across ${models.size} models from ${brands.size} brands`,
        `Years:    ${yearMin}–${yearMax}`,
        `Plated:   ${plated} variants (${byPlateMat.size > 0 ? [...byPlateMat.entries()].map(([m,n]) => `${m}:${n}`).join(", ") : "none"})`,
        `Plateless: ${plateless} variants`,
        ``,
        `### By Brand`,
        ...[...byBrand.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => `  ${b}: ${n}`),
        ``,
        `### By Category`,
        ...[...byCat.entries()].map(([c, n]) => `  ${c}: ${n}`),
        ``,
        `### By Cushion`,
        ...[...byCushion.entries()].map(([c, n]) => `  ${c}: ${n}`),
        ``,
        `### By Drop`,
        ...[...byDrop.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `  ${d}mm: ${n}`),
        ``,
        `### By Surface`,
        ...[...bySurface.entries()].map(([s, n]) => `  ${s}: ${n}`),
        ``,
        `### All Models (${models.size})`,
        ...ALL_SHOES.map((s) => `  ${s.brand} ${s.model} — ${s.variants.map((v) => `${v.version} (${v.year})`).join(", ")}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { totalVariants: all.length, totalModels: models.size, totalBrands: brands.size, plated, plateless, yearRange: [yearMin, yearMax] },
      };
    },
  });

  // ── add_shoe ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "add_shoe",
    label: "Add Shoe to Catalog",
    description: [
      "Add a new shoe or variant to the custom shoe catalog.",
      "If the shoe ID already exists, a new variant is appended to it.",
      "If not, a new shoe entry is created. Writes to catalog/custom-data.json and regenerates catalog/custom.ts.",
    ].join(" "),
    promptSnippet: "Add a shoe or variant",
    promptGuidelines: ["Use after research finds specs missing from the catalog."],
    parameters: Type.Object({
      // Shoe-level fields (ignored if id already exists in custom catalog)
      id:          Type.String({ description: 'Kebab-case ID, e.g. "saucony-hurricane"' }),
      brand:       Type.String({ description: 'Brand name, e.g. "Saucony"' }),
      model:       Type.String({ description: 'Model name, e.g. "Hurricane"' }),
      category:    stringEnum(["neutral", "stability", "motion-control"] as const),
      cushion:     stringEnum(["minimal", "low", "moderate", "high", "max"] as const),
      // Variant fields
      version:     Type.String({ description: 'Version string, e.g. "25"' }),
      year:        Type.Number({ description: "Release year" }),
      heelStack:   Type.Number({ description: "Heel stack height in mm" }),
      forefootStack: Type.Number({ description: "Forefoot stack height in mm" }),
      drop:        Type.Number({ description: "Heel-to-toe drop in mm" }),
      weightGrams: Type.Number({ description: "Weight in grams (men's US 9 or women's US 8 reference)" }),
      refSize:     Type.Optional(Type.String({ description: 'e.g. "men\'s US 9" or "women\'s US 8"' })),
      msrp:        Type.Number({ description: "MSRP in USD" }),
      foam:        Type.String({ description: "Midsole foam name/description" }),
      platePresent: Type.Boolean({ description: "Whether a plate is present" }),
      plateMaterial: Type.Optional(stringEnum(["carbon", "nylon", "fiberglass", "carbon-composite", "tpu", "air"] as const)),
      plateDescription: Type.Optional(Type.String({ description: 'e.g. "full-length carbon plate"' })),
      surfaces:    Type.Array(stringEnum(["road", "trail", "track", "treadmill"] as const)),
      rocker:      Type.Boolean(),
      widths:      Type.Optional(Type.Array(Type.String({ description: 'e.g. "B", "D", "2E", "4E"' }))),
      features:    Type.Array(Type.String()),
      useCases:    Type.Array(stringEnum(["daily-trainer", "long-run", "tempo", "race", "recovery", "trail", "walking", "track"] as const)),
      notes:       Type.String(),
      womensWeightGrams: Type.Optional(Type.Number({ description: "Women's weight in grams if different" })),
      womensRefSize:     Type.Optional(Type.String({ description: "Women's reference size" })),
      womensWidths:      Type.Optional(Type.Array(Type.String())),
    }),

    async execute(_id, p) {
      const shoes = await readCustom();

      const variant: ShoeVariant = {
        version: p.version,
        year: p.year,
        spec: {
          heelStack: p.heelStack,
          forefootStack: p.forefootStack,
          drop: p.drop,
          weightGrams: p.weightGrams,
          msrp: p.msrp,
          ...(p.refSize ? { refSize: p.refSize } : {}),
        },
        foam: p.foam,
        plate: {
          present: p.platePresent,
          ...(p.plateMaterial ? { material: p.plateMaterial } : {}),
          ...(p.plateDescription ? { description: p.plateDescription } : {}),
        },
        surfaces: p.surfaces,
        rocker: p.rocker,
        features: p.features,
        useCases: p.useCases,
        notes: p.notes,
        ...(p.widths ? { widths: p.widths } : {}),
        ...((p.womensWeightGrams || p.womensWidths) ? {
          genderVariants: {
            ...(p.womensWeightGrams ? {
              womens: {
                weightGrams: p.womensWeightGrams,
                ...(p.womensRefSize ? { refSize: p.womensRefSize } : {}),
                ...(p.womensWidths  ? { widths: p.womensWidths }  : {}),
              },
            } : {}),
          },
        } : {}),
      };

      const existing = shoes.find((s) => s.id === p.id);
      let action: string;

      if (existing) {
        const dupe = existing.variants.find((v) => v.version === p.version && v.year === p.year);
        if (dupe) {
          return {
            content: [{ type: "text", text: `⚠ ${p.brand} ${p.model} v${p.version} (${p.year}) already exists in the custom catalog. No changes made.` }],
            details: { action: "skipped" },
          };
        }
        existing.variants.push(variant);
        action = `appended variant ${p.version} (${p.year}) to existing shoe "${p.id}"`;
      } else {
        shoes.push({
          id: p.id,
          brand: p.brand,
          model: p.model,
          category: p.category,
          cushion: p.cushion,
          variants: [variant],
        });
        action = `added new shoe "${p.id}" with variant ${p.version} (${p.year})`;
      }

      await writeCustom(shoes);

      return {
        content: [{ type: "text", text: `✓ Catalog updated: ${action}\n\nCustom catalog now has ${shoes.length} shoe(s) with ${shoes.reduce((n, s) => n + s.variants.length, 0)} total variant(s). Restart pi to surface in all tools.` }],
        details: { action, shoeCount: shoes.length },
      };
    },
  });

  // ── query_shoes (natural language convenience) ──────────────────────────────
  pi.registerTool({
    name: "query_shoes",
    label: "Query Shoes",
    description: [
      "Natural-language shoe query engine. Parse a plain-English request like:",
      "'2025 2026 neutral daily trainers under 8mm drop without a carbon plate',",
      "'lightweight race shoes under 200g with carbon plate',",
      "'stability max cushion shoes under $170'.",
      "Combines text search + spec filtering in one call.",
    ].join(" "),
    promptSnippet: "Natural-language shoe query",
    promptGuidelines: ["Use for conversational shoe searches."],
    parameters: Type.Object({
      query:   Type.String({ description: "Plain-English query describing the shoes you want" }),
      top_k:   Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 30 })),
      detail:  Type.Optional(Type.Boolean({ description: "Include notes" })),
      sort_by: Type.Optional(stringEnum(["relevance", "year", "drop", "stack", "weight", "price"] as const, { description: "Sort" })),
      gender:  Type.Optional(stringEnum(["mens", "womens"] as const, { description: "Gender" })),
    }),

    async execute(_id, params) {
      const gender = params.gender as Gender | undefined;
      // Parse spec constraints from the query
      const specFilter = parseNaturalQuery(params.query);

      // Apply spec filter first (hard constraints)
      let pool = applyFilter(allVariants(), specFilter);

      // Then rank by text relevance
      const sortBy = params.sort_by ?? "relevance";
      if (sortBy === "relevance") {
        pool = textSearch(params.query, pool, params.top_k ?? 10);
        // if text search returned nothing (no meaningful text tokens), keep the spec-filtered results
        if (pool.length === 0) {
          pool = applyFilter(allVariants(), specFilter);
          pool.sort((a, b) => b.variant.year - a.variant.year);
          pool = pool.slice(0, params.top_k ?? 10);
        }
      } else {
        pool = pool.slice(0, params.top_k ?? 10);
        pool.sort((a, b) => {
          switch (sortBy) {
            case "year":   return b.variant.year - a.variant.year;
            case "drop":   return a.variant.spec.drop - b.variant.spec.drop;
            case "stack":  return b.variant.spec.heelStack - a.variant.spec.heelStack;
            case "weight": return a.variant.spec.weightGrams - b.variant.spec.weightGrams;
            case "price":  return a.variant.spec.msrp - b.variant.spec.msrp;
            default:       return 0;
          }
        });
      }

      if (pool.length === 0) {
        return {
          content: [{ type: "text", text: `No shoes found for: "${params.query}"\n\nParsed constraints: ${JSON.stringify(specFilter, null, 2)}\n\nTry relaxing the query.` }],
          details: { count: 0, parsedConstraints: specFilter },
        };
      }

      const lines = [
        `Found ${pool.length} shoe${pool.length !== 1 ? "s" : ""} for: "${params.query}"`,
        `Parsed constraints: ${JSON.stringify(specFilter)}`,
        "",
      ];
      for (const h of pool) lines.push(formatHit(h, params.detail ?? true, gender), "");

      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: pool.length, parsedConstraints: specFilter } };
    },
  });
}
