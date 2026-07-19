export type RepositoryExperience = { id: string; repository: string; revision: string; problemSignature: string; symbols: string[]; approach: string; outcome: "success" | "failure"; verification: string[]; confidence: number; createdAt: number; expiresAt?: number };
export type ExperienceQuery = { repository: string; revision: string; problemSignature: string; symbols: string[]; now: number };
export type ExperienceMatch = { id: string; score: number; reasons: string[]; experience: RepositoryExperience };

function terms(text: string): Set<string> { return new Set(text.toLowerCase().split(/\W+/).filter(word => word.length > 3)); }
function signatureOverlap(a: string, b: string): number {
  const left = terms(a); const right = terms(b);
  const matches = [...left].filter(term => right.has(term)).length;
  return matches / Math.max(1, Math.min(left.size, right.size));
}

export function retrieveRepositoryExperiences(query: ExperienceQuery, experiences: RepositoryExperience[], options: { maxResults?: number; minConfidence?: number } = {}): ExperienceMatch[] {
  const minConfidence = options.minConfidence ?? 0;
  return experiences
    .filter(item => Boolean(item.repository) && item.repository === query.repository)
    .filter(item => item.confidence >= minConfidence && (!item.expiresAt || item.expiresAt > query.now))
    .filter(item => item.outcome === "failure" || item.verification.length > 0)
    .map(experience => {
      const signature = signatureOverlap(query.problemSignature, experience.problemSignature);
      const symbolMatches = experience.symbols.filter(symbol => query.symbols.includes(symbol)).length;
      const revision = experience.revision === query.revision ? 1 : 0;
      const reasons = ["repository_match"];
      if (signature > 0) reasons.push("problem_signature");
      if (symbolMatches > 0) reasons.push("symbol_overlap");
      if (revision) reasons.push("revision_match");
      const score = signature * .4 + (symbolMatches / Math.max(1, query.symbols.length)) * .3 + revision * .15 + experience.confidence * .1 + (experience.outcome === "success" ? .05 : 0);
      return { id: experience.id, score, reasons, experience };
    })
    .sort((a, b) => b.score - a.score || b.experience.createdAt - a.experience.createdAt || a.id.localeCompare(b.id))
    .slice(0, options.maxResults ?? 5);
}
