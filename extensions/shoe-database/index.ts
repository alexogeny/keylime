/**
 * Shoe Database Extension
 *
 * A curated catalog of 100+ running shoe variants across 11 brands (2022–2026),
 * broken into per-brand files and backed by research from Doctors of Running,
 * Marathon Sports, RunRepeat, Road Trail Run, RTINGS, Runner's World, The Run
 * Testers, Meta Endurance, and SoleReview.
 *
 * Tools registered:
 *   lookup_shoe          — text search (brand / model / version / year)
 *   find_shoes_by_spec   — structured spec filtering with 15+ parameters
 *   query_shoes          — natural-language query engine ("8mm drop, no carbon plate, 2025-2026")
 *   compare_shoes        — side-by-side comparison of 2–6 shoes
 *   shoe_catalog_stats   — catalog overview and breakdown
 *
 * Catalog:
 *   New Balance · Brooks · ASICS · HOKA · Nike · Saucony
 *   adidas · PUMA · On · Altra · Mizuno
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.js";
import { allVariants, ALL_SHOES } from "./search.js";

export default function shoeDatabase(pi: ExtensionAPI) {
  registerTools(pi);

  // Session status disabled (noise reduction)
}
