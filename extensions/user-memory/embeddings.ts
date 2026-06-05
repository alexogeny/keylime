import { createOllamaEmbedder } from "../shared/ollama-embeddings";

const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL ?? "nomic-embed-text";
const QUERY_EMBED_CACHE_LIMIT = 256;
const ollama = createOllamaEmbedder({ model: EMBED_MODEL, tagsTimeoutMs: 1200, embedTimeoutMs: 8000 });
const queryEmbeddingCache = new Map<string, number[]>();

export async function checkOllama(): Promise<boolean> {
  return ollama.check();
}

export async function embedText(text: string): Promise<number[] | null> {
  return ollama.embed(text);
}

export async function cachedQueryEmbedding(query: string): Promise<number[] | null> {
  const key = `${EMBED_MODEL}:query:${query}`;
  const cached = queryEmbeddingCache.get(key);
  if (cached) {
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, cached);
    return cached;
  }
  const embedding = await embedText(query);
  if (!embedding) return null;
  queryEmbeddingCache.set(key, embedding);
  while (queryEmbeddingCache.size > QUERY_EMBED_CACHE_LIMIT) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (!oldest) break;
    queryEmbeddingCache.delete(oldest);
  }
  return embedding;
}
