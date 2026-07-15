import { describe, expect, test } from "bun:test";
import { __testables } from "../extensions/fetch";

describe("fetch parser and classifier helpers", () => {
  test("extracts title, readable text, and same-domain links", () => {
    const html = `
      <html>
        <head><title>Keylime Docs &amp; Safety</title><style>.x{display:none}</style></head>
        <body>
          <nav>ignore nav</nav>
          <main>
            <h1>Welcome</h1>
            <p>Sharp filling, crisp crust.</p>
            <a href="https://example.com/docs/extensions">Extensions</a>
            <a href="https://other.example/docs">External</a>
          </main>
          <script>window.nope = true</script>
        </body>
      </html>`;

    expect(__testables.extractTitle(html)).toBe("Keylime Docs   Safety");
    expect(__testables.htmlToText(html)).toContain("Welcome");
    expect(__testables.htmlToText(html)).toContain("Sharp filling, crisp crust.");
    expect(__testables.htmlToText(html)).not.toContain("window.nope");
    expect(__testables.extractLinks(html, "https://example.com/start")).toEqual(["https://example.com/docs/extensions"]);
  });

  test("decodes html entities and cloudflare email obfuscation", () => {
    expect(__testables.decodeHtmlEntities("keylime &amp; pi &lt;3" )).toBe("keylime & pi <3");

    const encoded = "0f676a6363604f6a776e627f636a216c6062";
    const decoded = __testables.decodeCloudflareEmailHex(encoded);
    expect(decoded).toBe("hello@example.com");

    const result = __testables.deobfuscateHtml(`<a data-cfemail="${encoded}">[email protected]</a>`);
    expect(result.decodedEmails).toContain("hello@example.com");
    expect(result.html).toContain("hello@example.com");
  });

  test("detects challenge pages and scores content quality", () => {
    const headers = new Headers({ server: "cloudflare" });
    const challenge = __testables.detectChallenge("checking your browser before accessing this site", headers);
    expect(challenge).toContain("checking your browser");

    const weak = __testables.scoreContentQuality("", "too short", "<html>too short</html>");
    expect(weak.score).toBeLessThan(0.5);

    const goodText = "Useful documentation. ".repeat(80);
    const strong = __testables.scoreContentQuality("Docs", goodText, `<article>${goodText}</article>`);
    expect(strong.score).toBeGreaterThan(0.5);
  });

  test("classifies outcomes and extracts search result urls", () => {
    expect(__testables.classifyFromOutcome("ok")).toBe("ok_content");
    expect(__testables.classifyFromOutcome("challenge_detected")).toBe("challenge_page");
    expect(__testables.classifyFromOutcome("timeout")).toBe("timeout");

    const urls = __testables.extractSearchResultUrls(`
      result one
        https://example.com/docs
      result two https://example.com/guide)
      asset https://example.com/file.pdf
    `);

    expect(urls).toContain("https://example.com/docs");
    expect(urls).not.toContain("https://example.com/file.pdf");
  });

  test("formatFetchText defaults to compact deterministic summaries and can print full content", () => {
    const result = {
      outcome: "ok",
      classification: "ok_content",
      title: "Search Distillation",
      content: [
        "The page starts with a broad introduction to search tooling.",
        "BM25 ranks candidate sentences against the user query without requiring a language model.",
        "Maximal marginal relevance keeps the selected summary sentences diverse and less repetitive.",
        "Footer links and legal notes are usually low-value content.",
      ].join(" "),
      links: [],
      url: "https://example.com/search-distillation",
      fetchedAt: "2026-06-14T00:00:00.000Z",
      reasonCodes: [],
      timingsMs: { total: 1, download: 1, extract: 0 },
      redirectCount: 0,
      contentLength: 300,
      confidence: { score: 0.9, reasons: [] },
    } as any;

    const compact = __testables.formatFetchText(result, { query: "BM25 maximal marginal relevance" });
    expect(compact.text).toContain("Deterministic summary");
    expect(compact.text).toContain("BM25 ranks candidate sentences");
    expect(compact.text).toContain("Full extracted content is available in tool details");
    expect(compact.summary?.method).toBe("bm25+mmr");

    const full = __testables.formatFetchText(result, { summarize: false });
    expect(full.text).not.toContain("Deterministic summary");
    expect(full.text).toContain("The page starts with a broad introduction");
  });

  test("user agent and browser profile selection stay coherent", () => {
    const ua = __testables.pickUserAgent("https://example.com/a");
    expect(ua).toBe(__testables.pickUserAgent("https://example.com/a"));
    expect(__testables.BROWSER_UAS).toContain(ua);
    expect(ua).toContain("Chrome/");
    expect(ua).not.toContain("Firefox/");
    expect(ua).not.toContain("Safari/605.1.15");

    const profile = __testables.browserProfileForUrl("https://docs.example.com/path");
    expect(profile.engine).toBe("chromium");
    expect(profile.userAgent).toContain("Chrome/");
    expect(profile.locale).toBe("en-AU");
    expect(profile.timezoneId).toBe("Australia/Brisbane");
  });

  test("browser state path is stable and safely scoped per host", () => {
    const path = __testables.browserStateDirForUrl("https://Sub.Example.com:443/a?b=c");
    expect(path).toContain("browser-state");
    expect(path).toContain("sub.example.com");
    expect(path).not.toContain("?");
    expect(path).not.toContain(":443");
  });

  test("accepts Markdown and plain text content types", () => {
    expect(__testables.isReadableTextContentType("text/markdown; charset=utf-8")).toBe(true);
    expect(__testables.isReadableTextContentType("text/x-markdown")).toBe(true);
    expect(__testables.isReadableTextContentType("text/plain; charset=utf-8")).toBe(true);
    expect(__testables.isReadableTextContentType("application/pdf")).toBe(false);
    expect(__testables.extractTextTitle("# Firecrawl Setup\n\nInstructions", "https://example.com/SKILL.md")).toBe("Firecrawl Setup");
  });

  test("user agent skip rules ignore low-value urls", () => {
    expect(__testables.shouldSkip("https://example.com/file.pdf")).toBe(true);
    expect(__testables.shouldSkip("https://example.com/docs")).toBe(false);
  });
});
