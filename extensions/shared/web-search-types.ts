export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  position?: number;
}

export type SearchSourceRelevance = "high" | "medium" | "low";

export interface SearchEntry {
  id: string;
  query: string;
  provider: string;
  timestamp: number;
  raw: {
    results: RawSearchResult[];
    answerBox?: string;
    knowledgeGraph?: Record<string, string>;
  };
  distilled?: {
    summary: string;
    keyFacts: string[];
    tags: string[];
    categories: string[];
    sources: Array<{ title: string; url: string; relevance: SearchSourceRelevance | string }>;
  };
}

export interface SearchIndexEntry {
  id: string;
  query: string;
  timestamp: number;
  tags: string[];
  categories: string[];
  summary?: string;
  provider: string;
}

export interface SearchIndex {
  version: 1;
  entries: SearchIndexEntry[];
}

export interface SearchStats {
  total: number;
  withKnowledge: number;
  allTags: string[];
  allCategories: string[];
  newestQuery?: string;
  newestAge?: string;
}
