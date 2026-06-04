import type { TokenizeOptions } from "./types";
import { tokenize } from "./tokenize";

export class TFIDFStore {
  private vectors: Map<string, Record<string, number>> = new Map();
  private df: Map<string, number> = new Map();
  private N = 0;
  private tokenOptions: TokenizeOptions;

  constructor(options: TokenizeOptions = {}) {
    this.tokenOptions = options;
  }

  private idf(): Map<string, number> {
    const idf = new Map<string, number>();
    for (const [term, freq] of this.df) idf.set(term, Math.log((this.N + 1) / (freq + 1)) + 1);
    return idf;
  }

  buildVector(text: string): Record<string, number> {
    const tokens = tokenize(text, this.tokenOptions);
    if (tokens.length === 0) return {};
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const idf = this.idf();
    const vec: Record<string, number> = {};
    for (const [term, count] of tf) vec[term] = (count / tokens.length) * (idf.get(term) ?? 1);
    return vec;
  }

  add(id: string, text: string): void {
    this.remove(id);
    const unique = new Set(tokenize(text, this.tokenOptions));
    for (const t of unique) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.N++;
    const raw: Record<string, number> = {};
    for (const t of unique) raw[t] = 1;
    this.vectors.set(id, raw);
  }

  remove(id: string): void {
    const vec = this.vectors.get(id);
    if (!vec) return;
    for (const t of Object.keys(vec)) {
      const cur = this.df.get(t) ?? 0;
      if (cur <= 1) this.df.delete(t);
      else this.df.set(t, cur - 1);
    }
    this.vectors.delete(id);
    this.N = Math.max(0, this.N - 1);
  }

  cosine(queryVec: Record<string, number>, docId: string): number {
    const docVec = this.vectors.get(docId);
    if (!docVec) return 0;
    const idf = this.idf();
    let dot = 0, qMag = 0, dMag = 0;
    for (const [term, qw] of Object.entries(queryVec)) {
      const dw = (docVec[term] ?? 0) * (idf.get(term) ?? 1);
      dot += qw * dw;
      qMag += qw * qw;
    }
    for (const [term, dw] of Object.entries(docVec)) {
      const w = dw * (idf.get(term) ?? 1);
      dMag += w * w;
    }
    return qMag > 0 && dMag > 0 ? dot / (Math.sqrt(qMag) * Math.sqrt(dMag)) : 0;
  }

  search(queryText: string, topK = 10, candidateIds?: string[]): Array<{ id: string; score: number }> {
    if (this.vectors.size === 0 || topK <= 0) return [];
    const qVec = this.buildVector(queryText);
    if (Object.keys(qVec).length === 0) return [];
    const ids = candidateIds ?? [...this.vectors.keys()];
    return ids
      .map(id => ({ id, score: this.cosine(qVec, id) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  get size(): number { return this.vectors.size; }
}
