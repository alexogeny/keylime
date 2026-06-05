import { tokenize } from "../shared/retrieval";
import type { MemoryCategory } from "./types.js";

export type SensitivityTier = "baseline" | "context_gated" | "temporal_gated" | "general";

const BASELINE_SUBCATS = new Set(["identity","health","neurodivergent","disability"]);
const BASELINE_CONTENT_TOKS = new Set(["antidepressant","antidepressants","adhd","autism","bisexual","gay","lesbian","queer","trans","nonbinary","disability","chronic"]);
const CONTEXT_GATED_SUBCATS = new Set(["financial","infidelity","relationship-secret"]);
const GRIEF_TOKENS = new Set(["died","death","passed","funeral","grief","loss","buried","cremated","miscarriage","stillborn"]);

export const TEMPORAL_GATE_DAYS = 7;

export function inferSensitivityTier(mem: Pick<{ category: MemoryCategory; subcategory?: string; content: string; tags: string[] }, "category" | "subcategory" | "content" | "tags">): SensitivityTier {
  const sub = (mem.subcategory ?? "").toLowerCase();
  const toks = new Set(tokenize(mem.content));
  const tags = new Set(mem.tags.map(t => t.toLowerCase()));
  if (BASELINE_SUBCATS.has(sub)) return "baseline";
  if ([...BASELINE_CONTENT_TOKS].some(t => toks.has(t) || tags.has(t))) return "baseline";
  if (CONTEXT_GATED_SUBCATS.has(sub)) return "context_gated";
  if (mem.category === "fact" && sub === "financial" && /\$[\d,]+|\d+k/.test(mem.content)) return "context_gated";
  if ([...GRIEF_TOKENS].some(t => toks.has(t))) return "temporal_gated";
  return "general";
}
