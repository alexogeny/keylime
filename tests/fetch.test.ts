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

  test("user agent selection is deterministic and skip rules ignore low-value urls", () => {
    expect(__testables.pickUserAgent("https://example.com/a")).toBe(__testables.pickUserAgent("https://example.com/a"));
    expect(__testables.BROWSER_UAS).toContain(__testables.pickUserAgent("https://example.com/a"));

    expect(__testables.shouldSkip("https://example.com/file.pdf")).toBe(true);
    expect(__testables.shouldSkip("https://example.com/docs")).toBe(false);
  });
});
