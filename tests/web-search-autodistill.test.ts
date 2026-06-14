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
});
