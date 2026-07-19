import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getFirecrawlCrawl, startFirecrawlCrawl } from "./shared/firecrawl-client";
import {
  cleanupWebContent,
  findLatestWebPage,
  loadAllCrawlManifests,
  loadAllWebPages,
  loadCrawlManifest,
  loadWebPage,
  loadWebPageContent,
  saveCrawlManifest,
  saveWebPage,
  webContentDataDir,
  webContentStats,
} from "./shared/web-content-store";
import type { WebContentPage, WebCrawlManifest } from "./shared/web-content-types";
import { boundedTopK } from "./shared/retrieval/bounded-top-k";

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])];
}

function occurrenceCount(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

function scorePage(page: WebContentPage, content: string, queryTerms: string[]): number {
  const title = page.title.toLowerCase();
  const url = page.canonicalUrl.toLowerCase();
  const body = content.toLowerCase();
  return queryTerms.reduce((score, term) => score
    + occurrenceCount(title, term) * 8
    + occurrenceCount(url, term) * 4
    + Math.min(occurrenceCount(body, term), 12), 0);
}

function scoreIndexedPage(page: WebContentPage, queryTerms: string[]): number {
  const title = page.title.toLowerCase();
  const url = page.canonicalUrl.toLowerCase();
  return queryTerms.reduce((score, term) => {
    const bodyCount = page.bodyTermFrequency && Object.prototype.hasOwnProperty.call(page.bodyTermFrequency, term)
      ? Number(page.bodyTermFrequency[term]) || 0
      : 0;
    return score + occurrenceCount(title, term) * 8 + occurrenceCount(url, term) * 4 + Math.min(bodyCount, 12);
  }, 0);
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}

function excerpt(content: string, queryTerms: string[], maxChars = 500): string {
  const lower = content.toLowerCase();
  const positions = queryTerms.map(term => lower.indexOf(term)).filter(position => position >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 120);
  return content.slice(start, start + maxChars).replace(/\s+/g, " ").trim();
}

export interface StoredWebContentMatch { page: WebContentPage; content: string; score: number }

export async function searchStoredWebContent(
  params: { query: string; topK?: number; domain?: string; crawlId?: string },
  deps: { loadPages: () => Promise<WebContentPage[]>; loadContent: (page: WebContentPage) => Promise<string> } = { loadPages: loadAllWebPages, loadContent: loadWebPageContent },
): Promise<StoredWebContentMatch[]> {
  const queryTerms = terms(params.query);
  if (!queryTerms.length) throw new Error("Search query has no usable terms");
  const domain = params.domain?.toLowerCase();
  const candidates = (await deps.loadPages()).filter(page => {
    if (params.crawlId && !page.crawlIds.includes(params.crawlId)) return false;
    if (domain) {
      try { if (new URL(page.canonicalUrl).hostname !== domain) return false; }
      catch { return false; }
    }
    return true;
  });
  const scored = await mapConcurrent(candidates, 8, async page => {
    if (page.bodyTermFrequency) return { page, content: "", score: scoreIndexedPage(page, queryTerms) };
    const content = await deps.loadContent(page); // Backward compatibility for pre-index metadata.
    return { page, content, score: scorePage(page, content, queryTerms) };
  });
  const winners = boundedTopK(
    scored.filter(match => match.score > 0),
    params.topK ?? 5,
    (a, b) => b.score - a.score || b.page.fetchedAt - a.page.fetchedAt,
  );
  return mapConcurrent(winners, 4, async match => match.content ? match : { ...match, content: await deps.loadContent(match.page) });
}

async function persistCrawlPage(crawlId: string, page: { url: string; title: string; markdown: string; links: string[]; metadata: Record<string, unknown> }) {
  if (!page.url) return null;
  return saveWebPage({
    url: page.url,
    title: page.title,
    provider: "firecrawl",
    content: page.markdown,
    links: page.links,
    crawlId,
    metadata: page.metadata,
  });
}

async function syncCrawl(manifest: WebCrawlManifest, signal: AbortSignal | undefined, waitMs: number): Promise<WebCrawlManifest> {
  const deadline = Date.now() + waitMs;
  let next = manifest.next;
  do {
    const status = await getFirecrawlCrawl(manifest.id, next, signal);
    const pages = await Promise.all(status.pages.map(page => persistCrawlPage(manifest.id, page)));
    manifest.pageIds = [...new Set([...manifest.pageIds, ...pages.filter((page): page is WebContentPage => Boolean(page)).map(page => page.id)])];
    manifest.status = status.status;
    manifest.total = status.total ?? manifest.total;
    manifest.completed = status.completed ?? manifest.completed;
    manifest.creditsUsed = status.creditsUsed ?? manifest.creditsUsed;
    manifest.errors = [...new Set([...manifest.errors, ...status.errors])];
    manifest.next = status.next;
    manifest.updatedAt = Date.now();
    next = status.next;
    if (manifest.status === "completed" && !next) manifest.completedAt = Date.now();
    await saveCrawlManifest(manifest);

    if (next) continue;
    if (manifest.status !== "scraping" || Date.now() >= deadline || waitMs === 0) break;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Crawl sync aborted")); }, { once: true });
    });
  } while (Date.now() <= deadline);
  return manifest;
}

export default function webContentExtension(pi: ExtensionAPI) {
  pi.registerCommand("web-content-stats", {
    description: "Show stored web page, crawl, blob, and byte totals",
    handler: async (_args, ctx) => {
      const stats = await webContentStats(webContentDataDir());
      ctx.ui.notify(`Web content: ${stats.pages} page(s), ${stats.crawls} crawl(s), ${stats.blobs} blob(s), ${stats.bytes} bytes`, "info");
    },
  });
  pi.registerCommand("web-content-cleanup", {
    description: "Keep only the newest N stored web pages and remove orphaned blobs",
    handler: async (args, ctx) => {
      const maxEntries = Number(String(args ?? "").trim());
      if (!Number.isInteger(maxEntries) || maxEntries < 0) { ctx.ui.notify("Usage: /web-content-cleanup <max-pages>", "warning"); return; }
      const result = await cleanupWebContent(webContentDataDir(), { maxEntries });
      ctx.ui.notify(`Web content cleanup: deleted ${result.deletedPages} page(s) and ${result.deletedBlobs} blob(s); ${result.stats.pages} page(s) remain`, "info");
    },
  });
  pi.registerTool({
    name: "crawl_site",
    label: "Crawl Site",
    description: "Crawl a bounded website with Firecrawl and persist normalized Markdown pages locally.",
    promptSnippet: "Crawl and store a website",
    promptGuidelines: ["Use for bounded documentation or site ingestion; set conservative depth and page limits."],
    parameters: Type.Object({
      url: Type.String({ description: "Site URL" }),
      include_paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to include" })),
      exclude_paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to exclude" })),
      max_depth: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "Maximum discovery depth" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Maximum pages (default 100)" })),
      allow_subdomains: Type.Optional(Type.Boolean({ description: "Allow subdomains (default false)" })),
      wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 120, description: "How long to poll and import pages (default 30)" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Starting bounded Firecrawl crawl for ${params.url}…` }], details: {} });
      const id = await startFirecrawlCrawl({
        url: params.url,
        includePaths: params.include_paths,
        excludePaths: params.exclude_paths,
        maxDiscoveryDepth: params.max_depth,
        limit: params.limit,
        allowSubdomains: params.allow_subdomains,
      }, signal);
      let manifest: WebCrawlManifest = {
        id,
        provider: "firecrawl",
        url: params.url,
        status: "scraping",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        pageIds: [],
        errors: [],
      };
      await saveCrawlManifest(manifest);
      manifest = await syncCrawl(manifest, signal, (params.wait_seconds ?? 30) * 1000);
      return {
        content: [{ type: "text", text: [
          `Firecrawl crawl ${manifest.id}: ${manifest.status}`,
          `Stored pages: ${manifest.pageIds.length}${manifest.total !== undefined ? ` / ${manifest.total}` : ""}`,
          manifest.errors.length ? `Errors: ${manifest.errors.length}` : "",
          manifest.status === "scraping" ? `Run sync_site_crawl with crawl_id=${manifest.id} to continue importing.` : "",
          `Storage: ${webContentDataDir()}`,
        ].filter(Boolean).join("\n") }],
        details: manifest,
      };
    },
  });

  pi.registerTool({
    name: "sync_site_crawl",
    label: "Sync Site Crawl",
    description: "Poll an existing Firecrawl crawl and import newly available pages.",
    promptSnippet: "Continue a Firecrawl crawl",
    parameters: Type.Object({
      crawl_id: Type.String({ description: "Firecrawl crawl ID" }),
      wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 120, description: "Polling duration (default 30)" })),
    }),
    async execute(_id, params, signal) {
      const manifest = await loadCrawlManifest(params.crawl_id);
      if (!manifest) throw new Error(`Unknown crawl_id: ${params.crawl_id}`);
      const synced = await syncCrawl(manifest, signal, (params.wait_seconds ?? 30) * 1000);
      return {
        content: [{ type: "text", text: `Crawl ${synced.id}: ${synced.status}; ${synced.pageIds.length} pages stored; ${synced.errors.length} errors.` }],
        details: synced,
      };
    },
  });

  pi.registerTool({
    name: "get_site_page",
    label: "Get Stored Site Page",
    description: "Read a locally stored web page by page ID or URL.",
    promptSnippet: "Read stored site content",
    parameters: Type.Object({
      page_id: Type.Optional(Type.String({ description: "Stored page ID" })),
      url: Type.Optional(Type.String({ description: "URL; retrieves the latest stored snapshot" })),
      max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 30000, description: "Maximum returned characters" })),
    }),
    async execute(_id, params) {
      const page = params.page_id ? await loadWebPage(params.page_id) : params.url ? await findLatestWebPage(params.url) : null;
      if (!page) throw new Error("Stored page not found; provide page_id or url");
      const content = await loadWebPageContent(page);
      const maxChars = params.max_chars ?? 8000;
      return {
        content: [{ type: "text", text: `# ${page.title}\nURL: ${page.url}\nPage ID: ${page.id}\nProvider: ${page.provider}\nFetched: ${new Date(page.fetchedAt).toISOString()}\n\n${content.slice(0, maxChars)}` }],
        details: { ...page, returnedChars: Math.min(content.length, maxChars) },
      };
    },
  });

  pi.registerTool({
    name: "search_site_content",
    label: "Search Stored Site Content",
    description: "Search locally stored site Markdown with optional domain and crawl filters.",
    promptSnippet: "Search stored site content",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
      domain: Type.Optional(Type.String({ description: "Hostname filter" })),
      crawl_id: Type.Optional(Type.String({ description: "Crawl ID filter" })),
      top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Result limit (default 5)" })),
    }),
    async execute(_id, params) {
      const queryTerms = terms(params.query);
      const matches = await searchStoredWebContent({ query: params.query, topK: params.top_k, domain: params.domain, crawlId: params.crawl_id });
      const text = matches.length ? matches.map((match, index) => [
        `${index + 1}) ${match.page.title}`,
        `   ${match.page.url}`,
        `   page_id: ${match.page.id} · fetched_at: ${new Date(match.page.fetchedAt).toISOString()} · score: ${match.score}`,
        `   ${excerpt(match.content, queryTerms)}`,
      ].join("\n")).join("\n\n") : "No stored site content matched.";
      return {
        content: [{ type: "text", text }],
        details: {
          query: params.query,
          resultCount: matches.length,
          pageIds: matches.map(match => match.page.id),
          sourceIds: matches.map(match => match.page.url),
          fetchedAt: matches.map(match => new Date(match.page.fetchedAt).toISOString()),
        },
      };
    },
  });

  pi.registerTool({
    name: "list_site_crawls",
    label: "List Site Crawls",
    description: "List locally tracked Firecrawl crawl manifests.",
    promptSnippet: "List stored site crawls",
    parameters: Type.Object({}),
    async execute() {
      const crawls = (await loadAllCrawlManifests()).sort((a, b) => b.updatedAt - a.updatedAt);
      const text = crawls.length ? crawls.slice(0, 30).map(crawl => `${crawl.id}  ${crawl.status.padEnd(9)}  ${String(crawl.pageIds.length).padStart(4)} pages  ${crawl.url}`).join("\n") : "No site crawls stored.";
      return { content: [{ type: "text", text }], details: { count: crawls.length } };
    },
  });
}

export const __testables = { terms, occurrenceCount, scorePage, excerpt };
