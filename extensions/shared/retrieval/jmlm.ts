import type { TokenizeOptions } from "./types";
import { tokenize } from "./tokenize";

export class JMLMIndex {
  private docTf: Map<string, Map<string, number>> = new Map();
  private docLens: Map<string, number> = new Map();
  private collectionTf: Map<string, number> = new Map();
  private collectionLen = 0;
  private tokenOptions: TokenizeOptions;
  private lambda: number;

  constructor(options: TokenizeOptions & { lambda?: number } = {}) {
    this.tokenOptions = options;
    this.lambda = options.lambda ?? 0.2;
  }

  add(id: string, text: string): void {
    this.addTokens(id, tokenize(text, this.tokenOptions));
  }

  addTokens(id: string, tokens: readonly string[]): void {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      this.collectionTf.set(t, (this.collectionTf.get(t) ?? 0) + 1);
    }
    this.docTf.set(id, tf);
    this.docLens.set(id, tokens.length);
    this.collectionLen += tokens.length;
  }

  remove(id: string): void {
    const tf = this.docTf.get(id);
    const len = this.docLens.get(id) ?? 0;
    if (!tf) return;
    for (const [term, count] of tf) {
      const cur = this.collectionTf.get(term) ?? 0;
      if (cur <= count) this.collectionTf.delete(term);
      else this.collectionTf.set(term, cur - count);
    }
    this.collectionLen = Math.max(0, this.collectionLen - len);
    this.docTf.delete(id);
    this.docLens.delete(id);
  }

  score(query: string, id: string): number {
    return this.scoreTokens(tokenize(query, this.tokenOptions), id);
  }

  private scoreTokens(queryTokens: readonly string[], id: string): number {
    const tf = this.docTf.get(id);
    const len = this.docLens.get(id) ?? 0;
    if (!tf || len === 0 || queryTokens.length === 0 || this.collectionLen === 0) return 0;
    let logLikelihood = 0;
    let matched = 0;
    for (const term of queryTokens) {
      const docProb = (tf.get(term) ?? 0) / len;
      const collectionProb = (this.collectionTf.get(term) ?? 0) / this.collectionLen;
      const prob = (1 - this.lambda) * docProb + this.lambda * collectionProb;
      if (prob > 0) {
        logLikelihood += Math.log(prob);
        if ((tf.get(term) ?? 0) > 0) matched++;
      }
    }
    if (matched === 0) return 0;
    return Math.exp(logLikelihood / queryTokens.length) * matched;
  }

  search(query: string, topK = 10, candidateIds?: Iterable<string>): Array<{ id: string; score: number }> {
    if (topK <= 0) return [];
    const ids = candidateIds ? [...candidateIds] : [...this.docTf.keys()];
    const queryTokens = tokenize(query, this.tokenOptions);
    if (queryTokens.length === 0) return [];
    return ids
      .map(id => ({ id, score: this.scoreTokens(queryTokens, id) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  get size(): number { return this.docTf.size; }
}
