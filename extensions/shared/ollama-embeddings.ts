export type OllamaEmbedderOptions = {
  baseUrl?: string;
  model?: string;
  tagsTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type OllamaEmbedder = {
  check(): Promise<boolean>;
  embed(text: string): Promise<number[] | null>;
  embedMany(texts: readonly string[]): Promise<Array<number[] | null>>;
  model: string;
};

export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): OllamaEmbedder {
  const baseUrl = options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = options.model ?? "nomic-embed-text";
  const tagsTimeoutMs = options.tagsTimeoutMs ?? 1_500;
  const embedTimeoutMs = options.embedTimeoutMs ?? 10_000;
  let availability: { value: boolean; checkedAt: number } | null = null;
  let availabilityRequest: Promise<boolean> | null = null;
  const inFlightEmbeddings = new Map<string, Promise<number[] | null>>();
  const positiveTtlMs = 60_000;
  const negativeTtlMs = 5_000;

  async function check(): Promise<boolean> {
    const now = Date.now();
    if (availability && now - availability.checkedAt < (availability.value ? positiveTtlMs : negativeTtlMs)) return availability.value;
    if (availabilityRequest) return availabilityRequest;
    availabilityRequest = (async () => {
      let value = false;
      try {
        const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(tagsTimeoutMs) });
        if (response.ok) {
          const data = await response.json() as any;
          value = (data.models ?? []).some((m: any) => m.name?.startsWith(model.split(":")[0]));
        }
      } catch { /* retry after the negative TTL */ }
      availability = { value, checkedAt: Date.now() };
      return value;
    })();
    try { return await availabilityRequest; }
    finally { availabilityRequest = null; }
  }

  async function embedMany(texts: readonly string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    if (!(await check())) return texts.map(() => null);
    try {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: [...texts] }),
        signal: AbortSignal.timeout(embedTimeoutMs),
      });
      if (!response.ok) return texts.map(() => null);
      const data = await response.json() as any;
      const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
      return texts.map((_, index) => embeddings[index] ?? null);
    } catch {
      availability = null;
      return texts.map(() => null);
    }
  }

  async function embed(text: string): Promise<number[] | null> {
    const existing = inFlightEmbeddings.get(text);
    if (existing) return existing;
    const request = embedMany([text]).then(results => results[0] ?? null);
    inFlightEmbeddings.set(text, request);
    try { return await request; }
    finally { inFlightEmbeddings.delete(text); }
  }

  return { check, embed, embedMany, model };
}
