export type EvidenceCandidate = {
  id: string; path: string; startLine: number; endLine: number; text: string;
  lexical: number; semantic: number; graph: number; recency: number;
  symbols: string[]; objectId: string;
};
export type EvidenceIntent = { objective: string; symbols: string[]; paths: string[]; failure?: string; pendingStep?: string };
export type EvidencePacketBudget = { maxTokens: number; maxPackets: number; maxFiles: number };
export type EvidencePacket = { id: string; path: string; lines: string; reason: string; confidence: number; objectId: string; estimatedTokens: number };

function overlap(a: EvidenceCandidate, b: EvidenceCandidate): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function score(intent: EvidenceIntent, candidate: EvidenceCandidate): number {
  const objective = `${intent.objective} ${intent.failure ?? ""} ${intent.pendingStep ?? ""}`.toLowerCase();
  const text = candidate.text.toLowerCase();
  const symbolMatch = candidate.symbols.some(symbol => intent.symbols.includes(symbol)) ? 1 : 0;
  const pathMatch = intent.paths.includes(candidate.path) ? 1 : 0;
  const failureMatch = intent.failure && text.includes(intent.failure.toLowerCase()) ? 1 : 0;
  const words = objective.split(/\W+/).filter(word => word.length > 3);
  const intentMatch = words.some(word => text.includes(word)) ? 1 : 0;
  return candidate.lexical * .22 + candidate.semantic * .24 + candidate.graph * .18 + candidate.recency * .04
    + symbolMatch * .18 + pathMatch * .1 + Number(failureMatch) * .22 + intentMatch * .08;
}

export function selectEvidencePackets(intent: EvidenceIntent, candidates: EvidenceCandidate[], budget: EvidencePacketBudget): EvidencePacket[] {
  const ranked = [...candidates].sort((a, b) => score(intent, b) - score(intent, a) || a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id));
  const selected: EvidenceCandidate[] = [];
  const files = new Set<string>();
  let tokens = 0;
  for (const candidate of ranked) {
    if (selected.length >= budget.maxPackets) break;
    if (selected.some(existing => overlap(existing, candidate))) continue;
    if (!files.has(candidate.path) && files.size >= budget.maxFiles) continue;
    const estimatedTokens = Math.max(1, Math.ceil((candidate.text.length + 80) / 4));
    if (tokens + estimatedTokens > budget.maxTokens) continue;
    if (score(intent, candidate) < .25) continue;
    selected.push(candidate);
    files.add(candidate.path);
    tokens += estimatedTokens;
  }
  return selected.map(candidate => {
    const confidence = Math.max(0, Math.min(1, score(intent, candidate)));
    return {
      id: candidate.id,
      path: candidate.path,
      lines: `${candidate.startLine}-${candidate.endLine}`,
      reason: `Selected for objective relevance, symbol/path overlap, and retrieval signals (score ${confidence.toFixed(2)})`,
      confidence,
      objectId: candidate.objectId,
      estimatedTokens: Math.max(1, Math.ceil((candidate.text.length + 80) / 4)),
    };
  });
}
