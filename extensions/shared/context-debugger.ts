import { selectEvidencePacketsWithStats, type EvidenceCandidate, type EvidenceIntent, type EvidencePacketBudget } from "./evidence-packets";

type DebugInput = {
  intent: EvidenceIntent;
  candidates: Array<EvidenceCandidate & { mandatory?: boolean; category?: string }>;
  budget: EvidencePacketBudget;
  packets?: Array<{ id: string; estimatedTokens?: number }>;
  stats?: Record<string, number>;
};

function components(intent: EvidenceIntent, candidate: EvidenceCandidate) {
  const objective = `${intent.objective} ${intent.failure ?? ""} ${intent.pendingStep ?? ""}`.toLowerCase();
  const text = candidate.text.toLowerCase();
  const symbolMatch = candidate.symbols.some(symbol => intent.symbols.includes(symbol)) ? 1 : 0;
  const pathMatch = intent.paths.includes(candidate.path) ? 1 : 0;
  const failureMatch = intent.failure && text.includes(intent.failure.toLowerCase()) ? 1 : 0;
  const words = objective.split(/\W+/).filter(word => word.length > 3);
  const intentMatch = words.some(word => text.includes(word)) ? 1 : 0;
  const exactness = candidate.representation === "exact_source" ? .55 : candidate.representation === "summary" ? -.45 : 0;
  return {
    lexical: candidate.lexical * .22,
    semantic: candidate.semantic * .24,
    graph: candidate.graph * .18,
    recency: candidate.recency * .04,
    symbol: symbolMatch * .18,
    path: pathMatch * .1,
    failure: Number(failureMatch) * .22,
    intent: intentMatch * .08,
    exactness,
  };
}
const total = (value: Record<string, number>): number => Object.values(value).reduce((sum, item) => sum + item, 0);
const normalizedText = (candidate: EvidenceCandidate): string => candidate.text.replace(/\s+/g, " ").trim();
const overlaps = (a: EvidenceCandidate, b: EvidenceCandidate): boolean => a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;

export function explainContextSelection(input: DebugInput) {
  const limit = Math.max(input.budget.maxPackets, Math.min(input.candidates.length, input.budget.maxCandidatesEvaluated ?? 10_000));
  const admitted = [...input.candidates]
    .sort((a, b) => total(components(input.intent, b)) - total(components(input.intent, a)) || a.id.localeCompare(b.id))
    .slice(0, limit);
  const selectedIds = new Set((input.packets ?? []).map(packet => packet.id));
  const selected = admitted.filter(candidate => selectedIds.has(candidate.id));
  const selectedByRank = [...selected].sort((a, b) => total(components(input.intent, b)) - total(components(input.intent, a)) || a.id.localeCompare(b.id));
  let scoreEvaluations = 0;
  const candidates = admitted.map(candidate => {
    const scoreComponents = components(input.intent, candidate); scoreEvaluations++;
    const totalScore = total(scoreComponents);
    const base = {
      id: candidate.id,
      path: candidate.path,
      lines: `${candidate.startLine}-${candidate.endLine}`,
      objectId: candidate.objectId,
      scoreComponents,
      totalScore,
      evictable: !candidate.mandatory,
    };
    if (candidate.mandatory) return { ...base, decision: "mandatory", reason: `mandatory ${candidate.category ?? "control"} evidence`, evictable: false };
    if (selectedIds.has(candidate.id)) return { ...base, decision: "included", reason: "selected within relevance and diversity budgets" };
    const duplicate = selected.find(item => normalizedText(item) === normalizedText(candidate));
    if (duplicate) return { ...base, decision: "excluded", reason: "duplicate content", displacedBy: duplicate.id };
    const overlap = selected.find(item => overlaps(item, candidate));
    if (overlap) return { ...base, decision: "excluded", reason: "overlap with selected packet", displacedBy: overlap.id };
    if (totalScore < .25) return { ...base, decision: "excluded", reason: "low relevance" };
    const selectedFiles = new Set(selected.map(item => item.path));
    if (!selectedFiles.has(candidate.path) && selectedFiles.size >= input.budget.maxFiles) return { ...base, decision: "excluded", reason: "file limit", displacedBy: selectedByRank.at(-1)?.id };
    const usedTokens = (input.packets ?? []).reduce((sum, packet) => sum + Number(packet.estimatedTokens ?? 0), 0);
    if (usedTokens >= input.budget.maxTokens) return { ...base, decision: "excluded", reason: "token limit", displacedBy: selectedByRank.at(-1)?.id };
    if (selected.length >= input.budget.maxPackets) return { ...base, decision: "excluded", reason: "packet limit; displaced by higher score", displacedBy: selectedByRank[0]?.id };
    return { ...base, decision: "excluded", reason: "retrieval budget" };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    intent: { objective: input.intent.objective.slice(0, 300), symbols: [...input.intent.symbols].sort().slice(0, 100), paths: [...input.intent.paths].sort().slice(0, 100) },
    budget: { ...input.budget },
    candidates,
    selectedIds: [...selectedIds].sort(),
    stats: { candidatesExplained: candidates.length, scoreEvaluations, candidatesSkipped: Math.max(0, input.candidates.length - admitted.length) },
  };
}

export function counterfactualContext(input: {
  intent: EvidenceIntent;
  candidates: EvidenceCandidate[];
  currentBudget: EvidencePacketBudget;
  tokenDeltas: number[];
}) {
  const scenarios = input.tokenDeltas.slice(0, 100).map(delta => {
    const budget = { ...input.currentBudget, maxTokens: Math.max(0, input.currentBudget.maxTokens + delta) };
    const selected = selectEvidencePacketsWithStats(input.intent, input.candidates, budget);
    return { tokenDelta: delta, maxTokens: budget.maxTokens, selectedIds: selected.packets.map(packet => packet.id).sort(), estimatedTokens: selected.packets.reduce((sum, packet) => sum + packet.estimatedTokens, 0) };
  });
  return { modelCalls: 0, scenarios };
}

export function renderContextDebugSummary(explanation: ReturnType<typeof explainContextSelection>, options: { width?: number; maxRows?: number } = {}): string {
  const width = Math.max(20, Math.min(240, Math.floor(options.width ?? 100)));
  const maxRows = Math.max(1, Math.min(1_000, Math.floor(options.maxRows ?? 40)));
  const clip = (text: string): string => text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
  const lines = [
    clip(`Context selection: ${explanation.candidates.length} explained; ${explanation.selectedIds.length} selected`),
    ...explanation.candidates.map(candidate => clip(`${candidate.decision.padEnd(9)} ${candidate.id} score=${candidate.totalScore.toFixed(3)} ${candidate.reason}`)),
  ];
  return lines.slice(0, maxRows).join("\n");
}
