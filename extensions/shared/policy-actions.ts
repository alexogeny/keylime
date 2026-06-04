import { retrievePolicy, type PolicyDocKind } from "./policy-corpus";

export interface PolicyRetrievalRequest {
  query: string;
  kind?: PolicyDocKind;
  topK?: number;
  paths?: string[];
}

export interface CheckSuggestion {
  id: string;
  score: number;
  title?: string;
  commands: string[];
  paths: string[];
  rationale: string;
}

export interface CodemodPlan {
  selectedPrimitive?: string;
  confidence: number;
  requiredInspections: string[];
  preferredTools: string[];
  checks: string[];
  risks: string[];
  evidence: Array<{ id: string; score: number; title?: string }>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function retrievePolicyEvidence(request: PolicyRetrievalRequest) {
  return retrievePolicy(request.query, { kind: request.kind, topK: request.topK ?? 5, paths: request.paths }).map(hit => ({
    id: hit.id,
    kind: hit.document?.kind,
    title: hit.document?.title,
    score: hit.score,
    scores: hit.scores,
    body: hit.document?.body,
    fields: hit.document?.fields,
    tags: hit.document?.tags ?? [],
  }));
}

export function suggestChecks(query: string, paths: string[] = [], topK = 3): CheckSuggestion[] {
  return retrievePolicy(query || paths.join(" "), { kind: "check", topK, paths }).map(hit => {
    const fields = hit.document?.fields ?? {};
    return {
      id: hit.id,
      score: hit.score,
      title: hit.document?.title,
      commands: stringArray(fields.commands),
      paths: stringArray(fields.paths),
      rationale: hit.document?.body ?? "",
    };
  });
}

export function planCodemod(goal: string, files: string[] = []): CodemodPlan {
  const query = [goal, ...files].join(" ");
  const hits = retrievePolicy(query, { kind: "codemod", topK: 3, paths: files });
  const best = hits[0];
  const fields = best?.document?.fields ?? {};
  const checks = suggestChecks(query, files, 2).flatMap(s => s.commands);

  return {
    selectedPrimitive: best?.id,
    confidence: Math.min(0.95, best?.score ?? 0),
    requiredInspections: best ? ["Inspect relevant files before editing", "Plan exact/count-guarded edits before applying"] : [],
    preferredTools: stringArray(fields.active_tools),
    checks: [...new Set(checks.length ? checks : stringArray(fields.commands))],
    risks: best ? ["High-level codemod planning is advisory; mutation safety remains enforced by guarded file tools."] : ["No matching codemod primitive found; fall back to search-first manual planning."],
    evidence: hits.map(hit => ({ id: hit.id, score: hit.score, title: hit.document?.title })),
  };
}
