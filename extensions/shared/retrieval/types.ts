export interface SearchDocument {
  id: string;
  kind?: string;
  title?: string;
  body: string;
  fields?: Record<string, string | string[] | number | boolean | undefined>;
  tags?: string[];
  source?: string;
  updatedAt?: number;
}

export interface ScoredResult<T = SearchDocument> {
  id: string;
  score: number;
  document?: T;
  scores?: Record<string, number>;
  reasons?: string[];
}

export interface TokenizeOptions {
  stopWords?: Set<string>;
  minLength?: number;
  preserveCodeTokens?: boolean;
}

export interface HybridSearchOptions {
  topK?: number;
  bm25Weight?: number;
  tfidfWeight?: number;
  jmlmWeight?: number;
  heuristicWeight?: number;
  candidateMultiplier?: number;
  heuristic?: (doc: SearchDocument, query: string) => number;
}
