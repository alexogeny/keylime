import { createHash } from "node:crypto";

export type EvidenceCandidate = {
  id: string; path: string; startLine: number; endLine: number; text: string;
  lexical: number; semantic: number; graph: number; recency: number;
  symbols: string[]; objectId: string;
  representation?: "exact_source" | "summary" | "diagnostic" | "generic";
};
export type EvidenceIntent = { objective: string; symbols: string[]; paths: string[]; failure?: string; pendingStep?: string };
export type EvidencePacketBudget = { maxTokens: number; maxPackets: number; maxFiles: number };
export type EvidencePacket = {
  id: string; path: string; lines: string; reason: string; confidence: number; objectId: string; estimatedTokens: number;
  exactText: string; hydratedText: string; contentHash: string; truncated: boolean;
};

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
  const representation = candidate.representation === "exact_source" ? .55 : candidate.representation === "summary" ? -.45 : 0;
  return candidate.lexical * .22 + candidate.semantic * .24 + candidate.graph * .18 + candidate.recency * .04
    + symbolMatch * .18 + pathMatch * .1 + Number(failureMatch) * .22 + intentMatch * .08 + representation;
}

export function evidenceCandidatesFromRegions(regions: Array<{ path: string; startLine: number; endLine: number; lines: string[]; score: number; reasons: string[] }>, query: string): EvidenceCandidate[] {
  return regions.map(region => ({
    id: `${region.path}:${region.startLine}-${region.endLine}`,
    path: region.path,
    startLine: region.startLine,
    endLine: region.endLine,
    text: region.lines.join("\n"),
    lexical: Math.max(0, Math.min(1, region.score)),
    semantic: region.reasons.includes("declaration_match") ? .8 : .5,
    graph: region.reasons.includes("import_neighbor") ? .8 : .2,
    recency: .5,
    symbols: region.lines.join("\n").includes(query) ? [query] : [],
    objectId: `region:${region.path}:${region.startLine}-${region.endLine}`,
  }));
}

type SelectedEvidence = { candidate: EvidenceCandidate; exactText: string; contentHash: string; truncated: boolean; estimatedTokens: number };

function hashText(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function clipEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[bounded evidence; recover full context object]\n";
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - marker.length) * .7);
  return `${text.slice(0, head)}${marker}${text.slice(-(maxChars - marker.length - head))}`;
}

export function selectEvidencePackets(intent: EvidenceIntent, candidates: EvidenceCandidate[], budget: EvidencePacketBudget): EvidencePacket[] {
  const ranked = [...candidates].sort((a, b) => score(intent, b) - score(intent, a) || a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id));
  const selected: SelectedEvidence[] = [];
  const files = new Set<string>();
  const contentHashes = new Set<string>();
  let tokens = 0;
  for (const candidate of ranked) {
    if (selected.length >= budget.maxPackets) break;
    if (selected.some(item => overlap(item.candidate, candidate))) continue;
    if (!files.has(candidate.path) && files.size >= budget.maxFiles) continue;
    if (score(intent, candidate) < .25) continue;
    const contentHash = hashText(candidate.text);
    const deduplicationHash = hashText(candidate.text.replace(/\s+/g, " ").trim());
    if (contentHashes.has(deduplicationHash)) continue;
    const remainingTokens = budget.maxTokens - tokens;
    let exactText = candidate.text;
    let estimatedTokens = Math.max(1, Math.ceil((exactText.length + 80) / 4));
    let truncated = false;
    if (estimatedTokens > remainingTokens) {
      const failureCritical = Boolean(intent.failure && candidate.text.toLowerCase().includes(intent.failure.toLowerCase()));
      if (!failureCritical || remainingTokens <= 20) continue;
      exactText = clipEvidence(candidate.text, Math.max(1, remainingTokens * 4 - 80));
      estimatedTokens = Math.max(1, Math.ceil((exactText.length + 80) / 4));
      truncated = true;
    }
    selected.push({ candidate, exactText, contentHash, truncated, estimatedTokens });
    contentHashes.add(deduplicationHash);
    files.add(candidate.path);
    tokens += estimatedTokens;
  }
  return selected.map(({ candidate, exactText, contentHash, truncated, estimatedTokens }) => {
    const confidence = Math.max(0, Math.min(1, score(intent, candidate)));
    const packet: EvidencePacket = {
      id: candidate.id,
      path: candidate.path,
      lines: `${candidate.startLine}-${candidate.endLine}`,
      reason: `Selected for objective relevance, symbol/path overlap, exactness, diversity, and retrieval signals (score ${confidence.toFixed(2)})`,
      confidence,
      objectId: candidate.objectId,
      estimatedTokens,
      exactText,
      hydratedText: candidate.text,
      contentHash,
      truncated,
    };
    Object.defineProperty(packet, "hydratedText", { value: candidate.text, enumerable: false, writable: false });
    return packet;
  });
}
