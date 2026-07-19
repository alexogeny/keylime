export type CodeRegionCandidate = {
  path: string;
  startLine: number;
  lines: string[];
  score: number;
  reasons: string[];
};

export type RankedCodeRegion = {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
  score: number;
  reasons: string[];
  estimatedChars: number;
};

export type CodeRegionBudget = {
  maxLines: number;
  maxChars: number;
  maxFiles: number;
};

export function parseRipgrepCodeRegions(output: string): CodeRegionCandidate[] {
  const candidates: CodeRegionCandidate[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line === "--") continue;
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    const context = match ? undefined : line.match(/^(.+?)-(\d+)-(.*)$/);
    const parsed = match ?? context;
    if (!parsed) continue;
    candidates.push({
      path: parsed[1].replace(/\\/g, "/").replace(/^\.\//, ""),
      startLine: Number(parsed[2]),
      lines: [parsed[3]],
      score: match ? 1 : 0.6,
      reasons: [match ? "lexical_match" : "context_line"],
    });
  }
  return candidates;
}

function normalize(candidate: CodeRegionCandidate): RankedCodeRegion {
  if (!candidate.path || !Number.isInteger(candidate.startLine) || candidate.startLine < 1 || candidate.lines.length === 0) {
    throw new Error("Code region candidates require a path, positive start line, and content lines");
  }
  return {
    path: candidate.path.replace(/\\/g, "/").replace(/^\.\//, ""),
    startLine: candidate.startLine,
    endLine: candidate.startLine + candidate.lines.length - 1,
    lines: [...candidate.lines],
    score: candidate.score,
    reasons: [...new Set(candidate.reasons)],
    estimatedChars: candidate.lines.join("\n").length,
  };
}

function mergeRegions(candidates: CodeRegionCandidate[]): RankedCodeRegion[] {
  const byPath = new Map<string, RankedCodeRegion[]>();
  for (const candidate of candidates) {
    const region = normalize(candidate);
    const list = byPath.get(region.path) ?? [];
    list.push(region);
    byPath.set(region.path, list);
  }
  const merged: RankedCodeRegion[] = [];
  for (const [path, regions] of byPath) {
    regions.sort((a, b) => a.startLine - b.startLine || b.score - a.score);
    let current: RankedCodeRegion | undefined;
    for (const region of regions) {
      if (!current || region.startLine > current.endLine + 1) {
        if (current) merged.push(current);
        current = { ...region, lines: [...region.lines], reasons: [...region.reasons] };
        continue;
      }
      const lineMap = new Map<number, string>();
      current.lines.forEach((line, index) => lineMap.set(current!.startLine + index, line));
      region.lines.forEach((line, index) => lineMap.set(region.startLine + index, line));
      const startLine = Math.min(current.startLine, region.startLine);
      const endLine = Math.max(current.endLine, region.endLine);
      current = {
        path,
        startLine,
        endLine,
        lines: Array.from({ length: endLine - startLine + 1 }, (_, index) => lineMap.get(startLine + index) ?? ""),
        score: Math.max(current.score, region.score),
        reasons: [...new Set([...current.reasons, ...region.reasons])],
        estimatedChars: 0,
      };
      current.estimatedChars = current.lines.join("\n").length;
    }
    if (current) merged.push(current);
  }
  return merged;
}

export function rankCodeRegions(candidates: CodeRegionCandidate[], budget: CodeRegionBudget): {
  regions: RankedCodeRegion[];
  metrics: {
    candidates: number;
    mergedCandidates: number;
    returnedRegions: number;
    returnedLines: number;
    returnedChars: number;
    returnedFiles: number;
    omittedCandidates: number;
  };
} {
  const merged = mergeRegions(candidates).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const maxLines = Math.max(0, Math.floor(budget.maxLines));
  const maxChars = Math.max(0, Math.floor(budget.maxChars));
  const maxFiles = Math.max(0, Math.floor(budget.maxFiles));
  const regions: RankedCodeRegion[] = [];
  const files = new Set<string>();
  let returnedLines = 0;
  let returnedChars = 0;
  for (const region of merged) {
    const lineCount = region.endLine - region.startLine + 1;
    const isNewFile = !files.has(region.path);
    if (isNewFile && files.size >= maxFiles) continue;
    if (returnedLines + lineCount > maxLines || returnedChars + region.estimatedChars > maxChars) continue;
    regions.push(region);
    files.add(region.path);
    returnedLines += lineCount;
    returnedChars += region.estimatedChars;
  }
  return {
    regions,
    metrics: {
      candidates: candidates.length,
      mergedCandidates: merged.length,
      returnedRegions: regions.length,
      returnedLines,
      returnedChars,
      returnedFiles: files.size,
      omittedCandidates: merged.length - regions.length,
    },
  };
}
