import { describe, expect, test } from "bun:test";
import {
  extractMainContent,
  splitSentences,
  summarizeText,
  mmrSelect,
} from "../extensions/shared/content-distill";

describe("content distillation", () => {
  test("extractMainContent prefers dense article content over nav and footer boilerplate", () => {
    const html = `
      <html><head><title>Ignored wrapper</title></head><body>
        <nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/login">Login</a></nav>
        <aside>Subscribe share follow related links.</aside>
        <article>
          <h1>Reliable Extraction</h1>
          <p>Deterministic extraction keeps the useful article body while dropping repeated menus and decorative chrome.</p>
          <p>The scoring favours text-heavy blocks with punctuation, sentence structure, and enough unique words to be useful.</p>
        </article>
        <footer>Privacy terms copyright social links.</footer>
      </body></html>`;

    const extracted = extractMainContent(html, { maxChars: 1000 });
    expect(extracted.text).toContain("Reliable Extraction");
    expect(extracted.text).toContain("Deterministic extraction keeps the useful article body");
    expect(extracted.text).not.toContain("Pricing");
    expect(extracted.text).not.toContain("Privacy terms");
    expect(extracted.confidence).toBeGreaterThan(0.5);
  });

  test("splitSentences keeps common abbreviations from fragmenting obvious sentences", () => {
    expect(splitSentences("Dr. Smith built it. It works well! Does it scale? Yes."))
      .toEqual(["Dr. Smith built it.", "It works well!", "Does it scale?", "Yes."]);
  });

  test("summarizeText ranks query-relevant sentences with BM25", () => {
    const text = [
      "The page introduces a generic project overview.",
      "BM25 ranks candidate sentences by lexical overlap with the search query.",
      "Maximal marginal relevance removes redundant sentences from the final summary.",
      "Installation instructions are listed at the end of the page.",
    ].join(" ");

    const summary = summarizeText(text, { query: "BM25 sentence ranking maximal marginal relevance redundancy", maxSentences: 2, maxChars: 400 });
    expect(summary.text).toContain("BM25 ranks candidate sentences");
    expect(summary.text).toContain("Maximal marginal relevance");
    expect(summary.method).toBe("bm25+mmr");
  });

  test("mmrSelect balances relevance against near-duplicate redundancy", () => {
    const candidates = [
      { id: "a", text: "BM25 ranks sentences for a search query using lexical matching.", relevance: 10 },
      { id: "b", text: "BM25 ranks search query sentences with lexical overlap.", relevance: 9 },
      { id: "c", text: "MMR selects diverse summary sentences to reduce redundancy.", relevance: 8 },
    ];

    const selected = mmrSelect(candidates, { limit: 2, lambda: 0.55 }).map(c => c.id);
    expect(selected).toEqual(["a", "c"]);
  });

  test("summarizeText falls back to lead-biased generic extraction without a query", () => {
    const text = [
      "This opening sentence defines the topic and should be retained.",
      "A tiny aside.",
      "The implementation then explains deterministic summarization using sentence scoring and diversity filtering.",
      "Related links and footer content are not useful.",
    ].join(" ");

    const summary = summarizeText(text, { maxSentences: 2, maxChars: 300 });
    expect(summary.sentences[0]).toContain("opening sentence defines the topic");
    expect(summary.sentences.length).toBeLessThanOrEqual(2);
    expect(summary.method).toBe("generic+mmr");
  });
});
