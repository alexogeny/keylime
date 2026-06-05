import { BM25Index, TFIDFStore } from "../shared/retrieval";
import { cosineSimilarity } from "../shared/similarity";
import { decayedConfidence, jaccard, type Memory } from "./store.js";
import type { MemoryCategory } from "./types.js";

type SearchDeps = {
  memories: Memory[];
  bm25: BM25Index;
  tfidf: TFIDFStore;
  checkOllama: () => Promise<boolean>;
  cachedQueryEmbedding: (query: string) => Promise<number[] | null>;
};

export async function hybridSearch(
  deps: SearchDeps,
  query: string,
  topK: number,
  filterFn?: (m: Memory) => boolean,
): Promise<Array<{ memory: Memory; score: number }>> {
  const memMap = new Map(deps.memories.map(m => [m.id, m]));
  let pool = deps.memories;
  if (filterFn) pool = pool.filter(filterFn);
  const poolIds = new Set(pool.map(m => m.id));

  const bm25Hits = deps.bm25.search(query, topK * 3).filter(h => poolIds.has(h.id));
  const maxBM25 = bm25Hits[0]?.score ?? 1;
  const bm25Map = new Map(bm25Hits.map(h => [h.id, h.score / maxBM25]));

  const candidateIds = bm25Hits.length >= Math.min(pool.length, topK * 2)
    ? bm25Hits.map(h => h.id)
    : pool.map(m => m.id);

  const useNeural = await deps.checkOllama();
  const qEmbed = useNeural ? await deps.cachedQueryEmbedding(query) : null;
  const cosineMap = new Map<string, number>();

  if (qEmbed) {
    for (const id of candidateIds) {
      const mem = memMap.get(id);
      if (!mem) continue;
      if (mem.embedding) cosineMap.set(id, cosineSimilarity(qEmbed, mem.embedding));
      else cosineMap.set(id, deps.tfidf.search(query, 1, [id])[0]?.score ?? 0);
    }
  } else {
    const tfidfHits = deps.tfidf.search(query, candidateIds.length, candidateIds);
    for (const { id, score } of tfidfHits) cosineMap.set(id, score);
  }

  const maxCos = Math.max(...cosineMap.values(), 0.001);
  const now = Date.now();
  const results: Array<{ memory: Memory; score: number }> = [];
  for (const id of candidateIds) {
    const mem = memMap.get(id);
    if (!mem) continue;
    const bm25s = bm25Map.get(id) ?? 0;
    const cosines = (cosineMap.get(id) ?? 0) / maxCos;
    const conf = decayedConfidence(mem, now);
    const score = 0.40 * bm25s + 0.55 * cosines + 0.05 * conf;
    if (score > 0.01) results.push({ memory: mem, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

type DuplicateDeps = {
  memories: Memory[];
  bm25: BM25Index;
  tfidf: TFIDFStore;
  checkOllama: () => Promise<boolean>;
  embedText: (text: string) => Promise<number[] | null>;
};

export async function findDuplicateMemory(
  deps: DuplicateDeps,
  content: string,
  category: MemoryCategory,
): Promise<Memory | null> {
  if (deps.memories.length === 0) return null;

  const candidates = deps.bm25.search(content, 8).map(h => h.id);
  if (candidates.length === 0) return null;

  const memMap = new Map(deps.memories.map(m => [m.id, m]));
  for (const id of candidates) {
    const mem = memMap.get(id);
    if (!mem) continue;
    if (jaccard(content, mem.content) > 0.55) return mem;
  }

  const cosHits = deps.tfidf.search(content, 5, candidates);
  for (const { id, score } of cosHits) {
    const mem = memMap.get(id);
    if (!mem) continue;
    if (mem.category === category && score > 0.88) return mem;
  }

  if (await deps.checkOllama()) {
    const qEmbed = await deps.embedText(content);
    if (qEmbed) {
      for (const id of candidates) {
        const mem = memMap.get(id);
        if (!mem?.embedding) continue;
        if (mem.category === category && cosineSimilarity(qEmbed, mem.embedding) > 0.92) return mem;
      }
    }
  }

  return null;
}
