import type { TokenizeOptions } from "./types";
import { tokenize } from "./tokenize";

export class TFIDFStore {
  private vectors = new Map<string, Record<string, number>>();
  private df = new Map<string, number>();
  private N = 0;
  private revision = 0;
  private idfRevision = -1;
  private idfCache = new Map<string, number>();
  private normCache = new Map<string, { revision: number; norm: number }>();
  private tokenOptions: TokenizeOptions;

  constructor(options: TokenizeOptions = {}) {
    this.tokenOptions = options;
  }

  private idf(): Map<string, number> {
    if (this.idfRevision === this.revision) return this.idfCache;
    this.idfCache = new Map();
    for (const [term, freq] of this.df) this.idfCache.set(term, Math.log((this.N + 1) / (freq + 1)) + 1);
    this.idfRevision = this.revision;
    this.normCache.clear();
    return this.idfCache;
  }

  private documentNorm(id: string, doc: Record<string, number>, idf: Map<string, number>): number {
    const cached = this.normCache.get(id);
    if (cached?.revision === this.revision) return cached.norm;
    let magnitudeSquared = 0;
    for (const term of Object.keys(doc)) {
      const weight = idf.get(term) ?? 1;
      magnitudeSquared += weight * weight;
    }
    const norm = Math.sqrt(magnitudeSquared);
    this.normCache.set(id, { revision: this.revision, norm });
    return norm;
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
    this.revision++;
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
    this.revision++;
  }

  cosine(queryVec: Record<string, number>, docId: string, queryNorm?: number, cachedIdf?: Map<string, number>): number {
    const docVec = this.vectors.get(docId);
    if (!docVec) return 0;
    const idf = cachedIdf ?? this.idf();
    let dot = 0;
    let qMagnitudeSquared = 0;
    for (const [term, queryWeight] of Object.entries(queryVec)) {
      const docWeight = (docVec[term] ?? 0) * (idf.get(term) ?? 1);
      dot += queryWeight * docWeight;
      if (queryNorm === undefined) qMagnitudeSquared += queryWeight * queryWeight;
    }
    const qNorm = queryNorm ?? Math.sqrt(qMagnitudeSquared);
    const dNorm = this.documentNorm(docId, docVec, idf);
    return qNorm > 0 && dNorm > 0 ? dot / (qNorm * dNorm) : 0;
  }

  search(queryText: string, topK = 10, candidateIds?: string[]): Array<{ id: string; score: number }> {
    if (this.vectors.size === 0 || topK <= 0) return [];
    const qVec = this.buildVector(queryText);
    if (Object.keys(qVec).length === 0) return [];
    const ids = candidateIds ?? [...this.vectors.keys()];
    const idf = this.idf();
    const queryNorm = Math.sqrt(Object.values(qVec).reduce((sum, weight) => sum + weight * weight, 0));
    return ids
      .map(id => ({ id, score: this.cosine(qVec, id, queryNorm, idf) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  get size(): number { return this.vectors.size; }
}
