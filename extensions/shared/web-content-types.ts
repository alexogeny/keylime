export type WebContentProvider = "direct" | "firecrawl";

export interface WebContentPage {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  provider: WebContentProvider;
  fetchedAt: number;
  contentHash: string;
  contentPath: string;
  contentLength: number;
  links: string[];
  crawlIds: string[];
  searchIds: string[];
  metadata?: Record<string, unknown>;
}

export interface WebCrawlManifest {
  id: string;
  provider: "firecrawl";
  url: string;
  status: "scraping" | "completed" | "failed" | "cancelled";
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  next?: string;
  pageIds: string[];
  errors: string[];
}

export interface StoreWebPageInput {
  url: string;
  title?: string;
  provider: WebContentProvider;
  content: string;
  fetchedAt?: number;
  links?: string[];
  crawlId?: string;
  searchId?: string;
  metadata?: Record<string, unknown>;
}
