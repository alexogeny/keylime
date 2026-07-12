import { createOllamaEmbedder } from "../shared/ollama-embeddings";
import { LruCache } from "../shared/lru-cache";

const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL ?? "nomic-embed-text";
const QUERY_EMBED_CACHE_LIMIT = 256;
const ollama = createOllamaEmbedder({ model: EMBED_MODEL, tagsTimeoutMs: 1200, embedTimeoutMs: 8000 });
const queryEmbeddingCache = new LruCache<string, number[]>({ maxEntries: QUERY_EMBED_CACHE_LIMIT });

export async function checkOllama(): Promise<boolean> {
  return ollama.check();
}

export async function embedText(text: string): Promise<number[] | null> {
  return ollama.embed(text);
}

export async function cachedQueryEmbedding(query: string): Promise<number[] | null> {
  const key = `${EMBED_MODEL}:query:${query}`;
  const cached = queryEmbeddingCache.get(key);
  if (cached) return cached;
  const embedding = await embedText(query);
  if (!embedding) return null;
  queryEmbeddingCache.set(key, embedding);
  return embedding;
}
