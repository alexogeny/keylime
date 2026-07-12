import { afterEach, describe, expect, test } from "bun:test";
import { createOllamaEmbedder } from "../extensions/shared/ollama-embeddings";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Ollama embedder", () => {
  test("batches embeddings while preserving input order", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "test-model:latest" }] });
      return Response.json({ embeddings: [[1, 0], [0, 1]] });
    }) as typeof fetch;
    const embedder = createOllamaEmbedder({ model: "test-model" });
    expect(await embedder.embedMany(["first", "second"])).toEqual([[1, 0], [0, 1]]);
  });

  test("coalesces concurrent requests for identical text", async () => {
    let embedRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "test-model:latest" }] });
      embedRequests++;
      await Promise.resolve();
      return Response.json({ embeddings: [[1, 2]] });
    }) as typeof fetch;
    const embedder = createOllamaEmbedder({ model: "test-model" });
    expect(await Promise.all([embedder.embed("same"), embedder.embed("same")])).toEqual([[1, 2], [1, 2]]);
    expect(embedRequests).toBe(1);
  });
});
