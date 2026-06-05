export type OllamaEmbedderOptions = {
  baseUrl?: string;
  model?: string;
  tagsTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type OllamaEmbedder = {
  check(): Promise<boolean>;
  embed(text: string): Promise<number[] | null>;
  model: string;
};

export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): OllamaEmbedder {
  const baseUrl = options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = options.model ?? "nomic-embed-text";
  const tagsTimeoutMs = options.tagsTimeoutMs ?? 1_500;
  const embedTimeoutMs = options.embedTimeoutMs ?? 10_000;
  let available: boolean | null = null;

  async function check(): Promise<boolean> {
    if (available !== null) return available;
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(tagsTimeoutMs) });
      if (!response.ok) { available = false; return false; }
      const data = await response.json() as any;
      available = (data.models ?? []).some((m: any) => m.name?.startsWith(model.split(":")[0]));
    } catch {
      available = false;
    }
    return available;
  }

  async function embed(text: string): Promise<number[] | null> {
    if (!(await check())) return null;
    try {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(embedTimeoutMs),
      });
      if (!response.ok) return null;
      const data = await response.json() as any;
      return data.embeddings?.[0] ?? null;
    } catch {
      return null;
    }
  }

  return { check, embed, model };
}
