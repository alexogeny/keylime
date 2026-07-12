import type { TokenizeOptions } from "./types";
import { tokenize } from "./tokenize";

interface BM25Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

export interface BM25Options extends TokenizeOptions {
  k1?: number;
  b?: number;
}

export class BM25Index {
  private docs = new Map<string, BM25Doc>();
  private postings = new Map<string, Set<string>>();
  private idf: Map<string, number> = new Map();
  lastSearchStats = { documentsVisited: 0, documentsScored: 0 };
  private avgLen = 0;
  private dirty = false;
  private k1: number;
  private b: number;
  private tokenOptions: TokenizeOptions;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.tokenOptions = options;
  }

  add(id: string, text: string): void {
    this.addTokens(id, tokenize(text, this.tokenOptions));
  }

  addTokens(id: string, tokens: readonly string[]): void {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    this.docs.set(id, { id, tf, len: tokens.length });
    for (const term of tf.keys()) {
      let ids = this.postings.get(term);
      if (!ids) this.postings.set(term, ids = new Set());
      ids.add(id);
    }
    this.dirty = true;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.tf.keys()) {
      const ids = this.postings.get(term);
      ids?.delete(id);
      if (ids?.size === 0) this.postings.delete(term);
    }
    this.docs.delete(id);
    this.dirty = true;
  }

  private recompute(): void {
    if (!this.dirty) return;
    const N = this.docs.size;
    this.idf.clear();
    if (N === 0) {
      this.avgLen = 0;
      this.dirty = false;
      return;
    }
    const df = new Map<string, number>();
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.len;
      for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.avgLen = total / N;
    for (const [term, freq] of df) {
      this.idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }
    this.dirty = false;
  }

  search(query: string, topK = 10, candidateIds?: ReadonlySet<string>): Array<{ id: string; score: number }> {
    this.recompute();
    this.lastSearchStats = { documentsVisited: 0, documentsScored: 0 };
    if (this.docs.size === 0 || topK <= 0 || candidateIds?.size === 0) return [];
    const queryTokens = tokenize(query, this.tokenOptions);
    if (queryTokens.length === 0) return [];
    const uniqueTerms = new Set(queryTokens);
    const postingWork = [...uniqueTerms].reduce((sum, term) => sum + (this.postings.get(term)?.size ?? 0), 0);
    const matchingIds = new Set<string>();
    if (postingWork <= this.docs.size / 2) {
      for (const term of uniqueTerms) {
        for (const id of this.postings.get(term) ?? []) {
          if (!candidateIds || candidateIds.has(id)) matchingIds.add(id);
        }
      }
    } else {
      for (const id of candidateIds ?? this.docs.keys()) matchingIds.add(id);
    }
    this.lastSearchStats.documentsVisited = matchingIds.size;
    const scores = new Map<string, number>();
    for (const id of matchingIds) {
      const doc = this.docs.get(id)!;
      if (doc.len === 0) continue;
      this.lastSearchStats.documentsScored++;
      let score = 0;
      for (const t of queryTokens) {
        const idf = this.idf.get(t) ?? 0;
        const tf = doc.tf.get(t) ?? 0;
        score += idf * (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * doc.len / (this.avgLen || 1)));
      }
      if (score > 0) scores.set(doc.id, score);
    }
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topK)
      .map(([id, score]) => ({ id, score }));
  }

  get size(): number { return this.docs.size; }
}
