import { describe, expect, test } from "bun:test";
import searchOrchestratorExtension from "../extensions/search-orchestrator";
import { mockPiFixture } from "./helpers/mock-pi";

describe("search orchestrator", () => {
  test("research_topic builds a filtered synthesis plan without throwing", async () => {
    const fixture = mockPiFixture({ active: ["web_search", "save_search_knowledge", "research_topic"] });
    searchOrchestratorExtension(fixture.pi);

    const result = await fixture.tools.research_topic.execute("id", {
      topic: "local coding models",
      depth: "standard",
      recency_required: true,
      focus_tags: ["benchmarks"],
    });

    expect(result.content[0].text).toContain("## Step 4 — Synthesise");
    expect(result.content[0].text).toContain("web_search(query=");
    expect(result.content[0].text).not.toContain("\n\n\n");
    expect(result.details.numSearches).toBe(3);
  });
});
