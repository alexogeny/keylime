import type { TokenizeOptions } from "./types";
import { tokenize } from "./tokenize";

interface BM25Doc {
  id: string;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

export interface BM25Options extends TokenizeOptions {
  k1?: number;
  b?: number;
}

export class BM25Index {
  private docs = new Map<string, BM25Doc>();
  private idf: Map<string, number> = new Map();
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
    this.remove(id);
    const tokens = tokenize(text, this.tokenOptions);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, { id, tokens, tf, len: tokens.length });
    this.dirty = true;
  }

  remove(id: string): void {
    if (this.docs.delete(id)) this.dirty = true;
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
    if (this.docs.size === 0 || topK <= 0 || candidateIds?.size === 0) return [];
    const queryTokens = tokenize(query, this.tokenOptions);
    if (queryTokens.length === 0) return [];
    const scores = new Map<string, number>();
    for (const doc of this.docs.values()) {
      if ((candidateIds && !candidateIds.has(doc.id)) || doc.len === 0) continue;
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
