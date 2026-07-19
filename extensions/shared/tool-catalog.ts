import { buildRetrievalIndex } from "./retrieval/hybrid";
import type { SearchDocument } from "./retrieval/types";
import type { ToolPolicy } from "./tool-policy";

export type RegisteredToolMetadata = {
  name?: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
};

export type ToolCatalogMatch = {
  name: string;
  score: number;
  policy: ToolPolicy;
};

const discoveredThisTurn = new Set<string>();

export function recordDiscoveredToolsForTurn(names: string[]): void {
  for (const name of names) discoveredThisTurn.add(name);
}

export function discoveredToolsForTurn(): string[] {
  return [...discoveredThisTurn].sort();
}

export function clearDiscoveredToolsForTurn(): void {
  discoveredThisTurn.clear();
}

export type ToolLoadMode = "CONVERSATIONAL" | "CODE" | "RESEARCH" | "PERSONAL" | "TDD" | "REVIEW";

export function toolPolicyLoadAllowed(
  policy: ToolPolicy,
  options: { mode: ToolLoadMode; researchEnabled: boolean },
): boolean {
  if (policy.group === "research" && !options.researchEnabled) return false;
  if (options.mode === "REVIEW") {
    return policy.risk === "safe"
      && (!policy.group || ["core", "readonly", "repo", "safety"].includes(policy.group));
  }
  if (options.mode === "RESEARCH") {
    return !policy.group || ["core", "readonly", "research", "fetch", "memory-lite", "safety"].includes(policy.group);
  }
  if (options.mode === "PERSONAL") {
    return !policy.group || ["core", "personal", "memory", "memory-lite", "safety"].includes(policy.group);
  }
  return true;
}

export function estimateRegisteredToolChars(tools: RegisteredToolMetadata[]): number {
  return tools.reduce((total, tool) => total + JSON.stringify({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  }).length, 0);
}

function parameterTerms(parameters: unknown): string {
  if (!parameters || typeof parameters !== "object") return "";
  try {
    return JSON.stringify(parameters);
  } catch {
    return "";
  }
}

function documentFor(tool: RegisteredToolMetadata, policy: ToolPolicy): SearchDocument {
  const name = policy.name;
  return {
    id: name,
    kind: "tool",
    title: tool.label ?? name,
    body: [
      name,
      name.replace(/_/g, " "),
      tool.label ?? "",
      tool.description ?? "",
      tool.promptSnippet ?? "",
      ...(tool.promptGuidelines ?? []),
      parameterTerms(tool.parameters),
      policy.group ?? "always-on",
      policy.risk,
    ].filter(Boolean).join("\n"),
    fields: { group: policy.group ?? "", risk: policy.risk },
  };
}

export function searchToolCatalog(
  tools: RegisteredToolMetadata[],
  policies: ToolPolicy[],
  query: string,
  limit: number,
): ToolCatalogMatch[] {
  const metadata = new Map(tools.map(tool => [tool.name, tool]));
  const docs = policies.map(policy => documentFor(metadata.get(policy.name) ?? { name: policy.name }, policy));
  const index = buildRetrievalIndex(docs);
  const byName = new Map(policies.map(policy => [policy.name, policy]));
  return index.search(query, { topK: limit }).flatMap(result => {
    const policy = byName.get(result.id);
    return policy ? [{ name: result.id, score: result.score, policy }] : [];
  });
}
