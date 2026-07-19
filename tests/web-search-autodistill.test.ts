import { describe, expect, test } from "bun:test";
import { __testables } from "../extensions/web-search";
import type { SearchEntry } from "../extensions/shared/web-search-types";

describe("web search deterministic auto-distillation", () => {
  test("builds saved knowledge from answer boxes, snippets, tags, categories, and sources", () => {
    const entry: SearchEntry = {
      id: "search-1",
      query: "Playwright browser fetch challenge detection",
      provider: "fixture",
      timestamp: Date.now(),
      raw: {
        answerBox: "Playwright can render pages in a real browser context.",
        results: [
          {
            title: "Playwright BrowserContext Docs",
            url: "https://playwright.dev/docs/api/class-browsercontext",
            snippet: "Browser contexts isolate cookies, local storage, user agent, locale, timezone, viewport, and permissions.",
            position: 1,
          },
          {
            title: "Cloudflare Bot Detection Engines",
            url: "https://developers.cloudflare.com/bots/concepts/bot-detection-engines/",
            snippet: "Cloudflare bot detection evaluates request headers, session characteristics, browser signals, and cookies.",
            position: 2,
          },
        ],
      },
    };

    const distilled = __testables.autoDistillSearchEntry(entry);
    expect(distilled.summary).toContain("Playwright can render pages");
    expect(distilled.keyFacts.length).toBeGreaterThanOrEqual(2);
    expect(distilled.keyFacts.join(" ")).toContain("Browser contexts isolate cookies");
    expect(distilled.sources[0]).toEqual({
      title: "Playwright BrowserContext Docs",
      url: "https://playwright.dev/docs/api/class-browsercontext",
      relevance: "high",
    });
    expect(distilled.tags).toContain("playwright");
    expect(distilled.tags).toContain("browser");
    expect(distilled.categories).toContain("technology");
    expect(distilled.categories).toContain("research");
  });

  test("formats compact claims and source/object references without raw snippets", () => {
    const entry: SearchEntry = {
      id: "search-2",
      query: "bounded research",
      provider: "fixture",
      timestamp: Date.UTC(2026, 6, 19),
      raw: { results: [{ title: "Source", url: "https://example.test/source", snippet: "very large raw page snippet", position: 1 }] },
      distilled: {
        summary: "A bounded summary.", keyFacts: ["A compact claim."], tags: ["bounded"], categories: ["research"],
        sources: [{ title: "Source", url: "https://example.test/source", relevance: "high" }],
      },
    };
    const compact = __testables.formatCompactSearchResult(entry, "object://research-search-2");
    expect(compact).toContain("A compact claim.");
    expect(compact).toContain("https://example.test/source");
    expect(compact).toContain("object://research-search-2");
    expect(compact).toContain("fetched_at: 2026-07-19T00:00:00.000Z");
    expect(compact).not.toContain("very large raw page snippet");
  });
});
