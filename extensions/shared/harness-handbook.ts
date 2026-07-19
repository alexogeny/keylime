import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type HarnessSourceLocation = {
  path: string;
  contentHash: string;
  symbols: string[];
  chars: number;
  verifiedAgainstCurrentSource?: boolean;
};
export type HarnessBehavior = { id: string; summary: string; keywords: string[]; sourceLocations: HarnessSourceLocation[] };
export type HarnessHandbook = { version: 1; generatedAt: string; behaviors: HarnessBehavior[] };

type BehaviorDefinition = { id: string; summary: string; keywords: string[]; paths: string[] };

const DEFINITIONS: BehaviorDefinition[] = [
  {
    id: "structured-compaction",
    summary: "Generate, validate, audit, render, and safely fall back from structured compaction checkpoints.",
    keywords: ["compaction", "checkpoint", "schema", "validation", "fallback"],
    paths: ["extensions/structured-compaction.ts", "extensions/shared/compaction-schema.ts"],
  },
  {
    id: "context-runtime",
    summary: "Manage bounded observations, durable control state, trajectory folding, retrieval, and provider compaction.",
    keywords: ["context", "runtime", "trajectory", "observation", "retrieval"],
    paths: ["extensions/context-runtime.ts", "extensions/shared/context-value-allocator.ts", "extensions/shared/evidence-packets.ts"],
  },
  {
    id: "danger-guard",
    summary: "Classify and block unsafe inspection, mutation, and execution behavior.",
    keywords: ["danger", "safety", "guard", "mutation", "policy"],
    paths: ["extensions/danger-guard.ts", "extensions/shared/safety-policy.ts"],
  },
  {
    id: "passive-telemetry",
    summary: "Persist privacy-preserving aggregate context and compaction metrics.",
    keywords: ["telemetry", "metrics", "latency", "compaction", "privacy"],
    paths: ["extensions/passive-context-telemetry.ts"],
  },
  {
    id: "intent-routing",
    summary: "Route user intent to bounded capability and tool sets.",
    keywords: ["intent", "routing", "tools", "capability"],
    paths: ["extensions/intent-router.ts", "extensions/shared/intent.ts"],
  },
];

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function symbols(text: string): string[] {
  const found = [...text.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|type|interface|const)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  return [...new Set(found)].sort();
}
async function inspectLocation(cwd: string, path: string): Promise<HarnessSourceLocation> {
  const text = await readFile(resolve(cwd, path), "utf8");
  return { path, contentHash: hash(text), symbols: symbols(text), chars: text.length };
}
function terms(text: string): Set<string> { return new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter(term => term.length > 2)); }

export async function buildHarnessHandbook(cwd: string): Promise<HarnessHandbook> {
  const behaviors = await Promise.all(DEFINITIONS.map(async definition => ({
    id: definition.id,
    summary: definition.summary,
    keywords: definition.keywords,
    sourceLocations: await Promise.all(definition.paths.map(path => inspectLocation(cwd, path))),
  })));
  return { version: 1, generatedAt: new Date().toISOString(), behaviors };
}

export async function verifyHarnessHandbook(handbook: HarnessHandbook, cwd: string): Promise<{ ok: boolean; staleLocations: HarnessSourceLocation[] }> {
  const staleLocations: HarnessSourceLocation[] = [];
  for (const location of handbook.behaviors.flatMap(behavior => behavior.sourceLocations)) {
    try {
      const current = await inspectLocation(cwd, location.path);
      if (current.contentHash !== location.contentHash) staleLocations.push(location);
    } catch {
      staleLocations.push(location);
    }
  }
  return { ok: staleLocations.length === 0, staleLocations };
}

export async function discloseHarnessBehavior(
  handbook: HarnessHandbook,
  query: string,
  options: { level: "summary" | "implementation-locators"; cwd: string },
): Promise<{ behaviorId?: string; summary?: string; locations: HarnessSourceLocation[]; estimatedTokens: number }> {
  const queryTerms = terms(query);
  const ranked = handbook.behaviors.map(behavior => {
    const searchable = terms(`${behavior.id} ${behavior.summary} ${behavior.keywords.join(" ")}`);
    const matches = [...queryTerms].filter(term => searchable.has(term)).length;
    return { behavior, matches };
  }).sort((a, b) => b.matches - a.matches || a.behavior.id.localeCompare(b.behavior.id));
  const behavior = ranked[0]?.matches ? ranked[0].behavior : undefined;
  if (!behavior) return { locations: [], estimatedTokens: 0 };
  if (options.level === "summary") {
    return { behaviorId: behavior.id, summary: behavior.summary, locations: [], estimatedTokens: Math.ceil(behavior.summary.length / 4) };
  }
  const locations = await Promise.all(behavior.sourceLocations.map(async location => {
    const current = await inspectLocation(options.cwd, location.path);
    return { ...location, verifiedAgainstCurrentSource: current.contentHash === location.contentHash };
  }));
  const estimatedChars = behavior.summary.length + locations.reduce((sum, location) => sum + location.path.length + location.symbols.join(",").length + 80, 0);
  return { behaviorId: behavior.id, summary: behavior.summary, locations, estimatedTokens: Math.ceil(estimatedChars / 4) };
}
