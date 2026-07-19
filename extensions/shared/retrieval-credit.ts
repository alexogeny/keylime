export type RetrievalInjection = { id: string; objectId: string; path: string; chars: number };
export type RetrievalUsage = { mentionedIds?: string[]; inspectedObjectIds?: string[]; checkpointObjectIds?: string[]; modifiedPaths?: string[]; verificationPassed?: boolean; supersededIds?: string[] };
export type RetrievalCredit = { byId: Record<string, number>; usefulChars: number; injectedChars: number; utilization: number; signals: Record<string, string[]> };

export function assignRetrievalCredit(injections: RetrievalInjection[], usage: RetrievalUsage): RetrievalCredit {
  const mentioned = new Set(usage.mentionedIds ?? []);
  const inspected = new Set(usage.inspectedObjectIds ?? []);
  const checkpointed = new Set(usage.checkpointObjectIds ?? []);
  const modified = new Set(usage.modifiedPaths ?? []);
  const superseded = new Set(usage.supersededIds ?? []);
  const byId: Record<string, number> = {};
  const signals: Record<string, string[]> = {};
  let usefulChars = 0;
  for (const item of injections) {
    const itemSignals: string[] = [];
    let score = 0;
    if (mentioned.has(item.id)) { score += 1; itemSignals.push("mentioned"); }
    if (inspected.has(item.objectId)) { score += 1; itemSignals.push("reinspected"); }
    if (checkpointed.has(item.objectId)) { score += 1; itemSignals.push("checkpointed"); }
    if (modified.has(item.path) && usage.verificationPassed) { score += 2; itemSignals.push("verified_change"); }
    if (superseded.has(item.id)) { score -= 2; itemSignals.push("superseded"); }
    byId[item.id] = score;
    signals[item.id] = itemSignals;
    if (score > 0) usefulChars += item.chars;
  }
  const injectedChars = injections.reduce((sum, item) => sum + item.chars, 0);
  return { byId, usefulChars, injectedChars, utilization: injectedChars ? usefulChars / injectedChars : 0, signals };
}

export function adaptRetrievalBudget(history: number[], current: { maxPackets: number; maxChars: number }, options: { missedRequiredEvidence?: boolean } = {}): { maxPackets: number; maxChars: number } {
  const average = history.length ? history.reduce((sum, value) => sum + value, 0) / history.length : .5;
  if (average < .2) return { maxPackets: Math.max(1, current.maxPackets - 2), maxChars: Math.max(500, Math.round(current.maxChars * .75)) };
  if (average > .8 && options.missedRequiredEvidence) return { maxPackets: current.maxPackets + 1, maxChars: Math.round(current.maxChars * 1.25) };
  return { ...current };
}
