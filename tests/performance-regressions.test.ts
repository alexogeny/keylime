import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCheckpointSnapshot } from "../extensions/git-checkpoint";
import { renderPdfPagesForOcr } from "../extensions/document-primitives";
import { resetToolResultManifestCacheForTest, storeResultForTest, toolResultManifestStatsForTest } from "../extensions/tool-result-compactor";
import { BM25Index } from "../extensions/shared/retrieval";
import { ensureContentBlob } from "../extensions/shared/web-content-store";
import { queryEntitiesWithStats } from "../extensions/user-memory/entity";
import { searchStoredWebContent } from "../extensions/web-content";

const tempDirs: string[] = [];
afterEach(async () => {
  resetToolResultManifestCacheForTest();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("performance regression invariants", () => {
  test("stored-content search reads bodies only for top-k indexed matches", async () => {
    const pages = Array.from({ length: 100 }, (_, i) => ({
      id: `page-${i}`,
      url: `https://example.com/${i}`,
      canonicalUrl: `https://example.com/${i}`,
      title: `Page ${i}`,
      provider: "direct" as const,
      fetchedAt: i,
      contentHash: `hash-${i}`,
      contentPath: `/content/${i}.md`,
      contentLength: 100,
      links: [], crawlIds: [], searchIds: [],
      bodyTermFrequency: { needle: i + 1 },
    }));
    let contentReads = 0;
    const matches = await searchStoredWebContent({ query: "needle", topK: 5 }, {
      loadPages: async () => pages,
      loadContent: async page => { contentReads++; return `needle content ${page.id}`; },
    });
    expect(matches).toHaveLength(5);
    expect(matches[0].page.id).toBe("page-99");
    expect(contentReads).toBe(5);
  });

  test("OCR renders a page range with one pdftoppm process", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const images = await renderPdfPagesForOcr("scan.pdf", "/tmp/ocr", [2, 3, 4], {
      exec: async (command, args) => { calls.push({ command, args }); return { stdout: "", stderr: "" }; },
      readdir: async () => ["render-2.png", "render-3.png", "render-4.png"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "pdftoppm" });
    expect(calls[0].args).toContain("2");
    expect(calls[0].args).toContain("4");
    expect(images.size).toBe(3);
  });

  test("entity recall comparisons are additive rather than entity-times-words", () => {
    const entities = Array.from({ length: 100 }, (_, i) => ({
      id: `e-${i}`, type: "system", name: `service${i}`, aliases: [`alias${i}`], memory_ids: [], created_at: 0, updated_at: 0,
    }));
    const result = queryEntitiesWithStats({ version: 1, entities } as any, "please inspect service42 and unrelated words");
    expect(result.entities.map(entity => entity.id)).toEqual(["e-42"]);
    expect(result.stats.normalizations).toBeLessThanOrEqual(205);
  });

  test("retrieval retains at most top-k results while scanning common terms", () => {
    const index = new BM25Index();
    for (let i = 0; i < 1_000; i++) index.add(`doc-${i}`, `common token ${i}`);
    expect(index.search("common", 7)).toHaveLength(7);
    expect(index.lastSearchResultsRetained).toBeLessThanOrEqual(7);
  });

  test("repeated tool-result writes read the manifest from disk once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-manifest-cache-"));
    tempDirs.push(cwd);
    await storeResultForTest(cwd, "first");
    await storeResultForTest(cwd, "second");
    expect(toolResultManifestStatsForTest()).toEqual({ diskReads: 1, directoryCreates: 1 });
  });

  test("checkpoint snapshot uses one git process for branch, dirtiness, and paths", () => {
    let calls = 0;
    const snapshot = collectCheckpointSnapshot("/repo", (_cwd, args) => {
      calls++;
      expect(args).toEqual(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
      return Buffer.from("## main\0 M tracked.ts\0?? new.ts\0");
    });
    expect(calls).toBe(1);
    expect(snapshot).toMatchObject({ branch: "main", changed: true, paths: ["tracked.ts", "new.ts"] });
  });

  test("content-addressed blob existence uses metadata access, not a content read", async () => {
    let accessCalls = 0;
    let writeCalls = 0;
    await ensureContentBlob("/blobs/hash.md", "large content", {
      access: async () => { accessCalls++; },
      writeAtomic: async () => { writeCalls++; },
    });
    expect(accessCalls).toBe(1);
    expect(writeCalls).toBe(0);
  });
});
