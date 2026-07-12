import { BM25Index } from "./bm25";
import { JMLMIndex } from "./jmlm";
import { TFIDFStore } from "./tfidf";
import { documentText } from "./tokenize";
import type { HybridSearchOptions, ScoredResult, SearchDocument } from "./types";

function normalizeScores(results: Array<{ id: string; score: number }>): Map<string, number> {
  const max = Math.max(0, ...results.map(r => r.score));
  const out = new Map<string, number>();
  for (const r of results) out.set(r.id, max > 0 ? r.score / max : 0);
  return out;
}

export class RetrievalIndex {
  private docs = new Map<string, SearchDocument>();
  private bm25 = new BM25Index();
  private tfidf = new TFIDFStore();
  private jmlm = new JMLMIndex();

  add(doc: SearchDocument): void {
    this.docs.set(doc.id, doc);
    const text = documentText(doc);
    this.bm25.add(doc.id, text);
    this.tfidf.add(doc.id, text);
    this.jmlm.add(doc.id, text);
  }

  remove(id: string): void {
    this.docs.delete(id);
    this.bm25.remove(id);
    this.tfidf.remove(id);
    this.jmlm.remove(id);
  }

  search(query: string, options: HybridSearchOptions = {}): ScoredResult[] {
    const topK = options.topK ?? 10;
    if (topK <= 0 || this.docs.size === 0) return [];
    const candidateK = Math.max(topK, topK * (options.candidateMultiplier ?? 4));
    const allowedIds = options.filter
      ? new Set([...this.docs.values()]
          .filter(doc => (!options.allowedIds || options.allowedIds.has(doc.id)) && options.filter!(doc))
          .map(doc => doc.id))
      : options.allowedIds;
    if (allowedIds?.size === 0) return [];
    const bm25 = this.bm25.search(query, candidateK, allowedIds);
    const seedIds = bm25.length > 0 ? bm25.map(r => r.id) : [...(allowedIds ?? this.docs.keys())];
    const tfidf = this.tfidf.search(query, candidateK, seedIds);
    const jmlm = this.jmlm.search(query, candidateK, seedIds);
    const bm25n = normalizeScores(bm25);
    const tfidfn = normalizeScores(tfidf);
    const jmlmn = normalizeScores(jmlm);
    const ids = new Set([...bm25n.keys(), ...tfidfn.keys(), ...jmlmn.keys()]);
    const weights = {
      bm25: options.bm25Weight ?? 0.45,
      tfidf: options.tfidfWeight ?? 0.25,
      jmlm: options.jmlmWeight ?? 0.20,
      heuristic: options.heuristicWeight ?? 0.10,
    };
    const out: ScoredResult[] = [];
    for (const id of ids) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      const heuristic = Math.max(0, Math.min(1, options.heuristic?.(doc, query) ?? 0));
      const parts = {
        bm25: bm25n.get(id) ?? 0,
        tfidf: tfidfn.get(id) ?? 0,
        jmlm: jmlmn.get(id) ?? 0,
        heuristic,
      };
      const score = parts.bm25 * weights.bm25 + parts.tfidf * weights.tfidf + parts.jmlm * weights.jmlm + parts.heuristic * weights.heuristic;
      if (score > 0) out.push({ id, score, document: doc, scores: parts });
    }
    return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topK);
  }

  get(id: string): SearchDocument | undefined { return this.docs.get(id); }
  get size(): number { return this.docs.size; }
}

export function buildRetrievalIndex(docs: SearchDocument[]): RetrievalIndex {
  const index = new RetrievalIndex();
  for (const doc of docs) index.add(doc);
  return index;
}
