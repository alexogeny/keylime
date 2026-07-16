import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testables as firecrawlHelpers } from "../extensions/shared/firecrawl-client";
import {
  canonicalizeWebUrl,
  findLatestWebPage,
  loadAllWebPages,
  loadWebPageContent,
  saveWebPage,
  stableContentHash,
} from "../extensions/shared/web-content-store";
import { __testables as searchHelpers } from "../extensions/web-content";

const temporaryDirs: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keylime-web-content-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Firecrawl response and URL helpers", () => {
  test("normalizes hosted and self-hosted API roots", () => {
    expect(firecrawlHelpers.normalizeApiUrl("https://api.firecrawl.dev")).toBe("https://api.firecrawl.dev/v2");
    expect(firecrawlHelpers.normalizeApiUrl("https://firecrawl.internal/v2/")).toBe("https://firecrawl.internal/v2");
  });

  test("normalizes scrape pages and recognizes private addresses", () => {
    const page = firecrawlHelpers.normalizePage({
      markdown: "# Docs",
      links: ["https://example.com/a", 12],
      metadata: { sourceURL: "https://example.com/docs", title: "Docs" },
    });
    expect(page.url).toBe("https://example.com/docs");
    expect(page.links).toEqual(["https://example.com/a"]);
    expect(firecrawlHelpers.isPrivateAddress("127.0.0.1")).toBe(true);
    expect(firecrawlHelpers.isPrivateAddress("192.168.1.2")).toBe(true);
    expect(firecrawlHelpers.isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("web content store", () => {
  test("stores content-addressed Markdown and deduplicates identical snapshots", async () => {
    const dir = await temporaryDir();
    const first = await saveWebPage({
      url: "https://Example.com/docs/?b=2&a=1#intro",
      title: "Example Docs",
      provider: "firecrawl",
      content: "# Example Docs\n\nPersistent content.",
      crawlId: "crawl-1",
    }, dir);
    const second = await saveWebPage({
      url: "https://example.com/docs?a=1&b=2",
      provider: "firecrawl",
      content: "# Example Docs\n\nPersistent content.",
      searchId: "search-1",
    }, dir);

    expect(first.id).toBe(second.id);
    expect(second.crawlIds).toEqual(["crawl-1"]);
    expect(second.searchIds).toEqual(["search-1"]);
    expect(await loadWebPageContent(second)).toContain("Persistent content");
    expect(await loadAllWebPages(dir)).toHaveLength(1);
    expect((await findLatestWebPage("https://example.com/docs?b=2&a=1", dir))?.id).toBe(first.id);
  });

  test("canonicalizes URLs and hashes content stably", () => {
    expect(canonicalizeWebUrl("https://EXAMPLE.com:443/a/?z=2&a=1#x")).toBe("https://example.com/a?a=1&z=2");
    expect(stableContentHash("same")).toBe(stableContentHash("same"));
  });
});

describe("stored content search helpers", () => {
  test("weights title and body terms and creates focused excerpts", () => {
    const page = {
      id: "p1",
      url: "https://example.com/firecrawl",
      canonicalUrl: "https://example.com/firecrawl",
      title: "Firecrawl Guide",
      provider: "firecrawl" as const,
      fetchedAt: 1,
      contentHash: "hash",
      contentPath: "/tmp/hash.md",
      contentLength: 50,
      links: [],
      crawlIds: [],
      searchIds: [],
    };
    const queryTerms = searchHelpers.terms("Firecrawl storage");
    expect(searchHelpers.scorePage(page, "Store Firecrawl content for retrieval.", queryTerms)).toBeGreaterThan(10);
    expect(searchHelpers.excerpt("Before. Firecrawl content storage appears here. After.", queryTerms)).toContain("Firecrawl");
  });
});
