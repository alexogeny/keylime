import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import * as evidence from "../../extensions/shared/evidence-packets";
import type { EvidenceCandidate, EvidenceIntent } from "../../extensions/shared/evidence-packets";

const selectWithStats = (evidence as any).selectEvidencePacketsWithStats as (
  intent: EvidenceIntent,
  candidates: EvidenceCandidate[],
  budget: Record<string, number>,
) => { packets: Array<{ id: string }>; stats: { scoreEvaluations: number; hashEvaluations: number; candidatesSkipped: number; peakRankedCandidates: number } };

const intent: EvidenceIntent = {
  objective: "fix targetSymbol failure",
  symbols: ["targetSymbol"],
  paths: ["src/target.ts"],
  failure: "target failure",
};

function makeCandidate(index: number, overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    id: `candidate-${index}`,
    path: `src/file-${index}.ts`,
    startLine: 1,
    endLine: 2,
    text: `ordinary candidate ${index}`,
    lexical: .4,
    semantic: .4,
    graph: .2,
    recency: .5,
    symbols: [],
    objectId: `object-${index}`,
    ...overrides,
  };
}

describe("RED: retrieval ranking performs bounded single-pass scoring", () => {
  test("scores each candidate once rather than from inside the sort comparator", () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) => makeCandidate(index));
    candidates[9_999] = makeCandidate(9_999, {
      id: "gold",
      path: "src/target.ts",
      text: "target failure in targetSymbol",
      lexical: 1,
      semantic: 1,
      graph: 1,
      symbols: ["targetSymbol"],
    });

    const started = performance.now();
    const result = selectWithStats(intent, candidates, { maxTokens: 500, maxPackets: 4, maxFiles: 4 });
    const elapsedMs = performance.now() - started;

    expect(result.stats.scoreEvaluations).toBe(candidates.length);
    expect(result.stats.hashEvaluations).toBeLessThanOrEqual(candidates.length);
    expect(result.stats.peakRankedCandidates).toBeLessThanOrEqual(candidates.length);
    expect(result.packets.map(packet => packet.id)).toContain("gold");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("prefilters enormous candidate sets to an explicit evaluation budget without losing obvious gold evidence", () => {
    const candidates = Array.from({ length: 50_000 }, (_, index) => makeCandidate(index));
    candidates[49_999] = makeCandidate(49_999, {
      id: "gold",
      path: "src/target.ts",
      text: "target failure in targetSymbol",
      lexical: 1,
      semantic: 1,
      graph: 1,
      symbols: ["targetSymbol"],
    });

    const result = selectWithStats(intent, candidates, {
      maxTokens: 500,
      maxPackets: 4,
      maxFiles: 4,
      maxCandidatesEvaluated: 5_000,
    });

    expect(result.stats.scoreEvaluations).toBeLessThanOrEqual(5_000);
    expect(result.stats.candidatesSkipped).toBeGreaterThanOrEqual(45_000);
    expect(result.packets.map(packet => packet.id)).toContain("gold");
  });
});
