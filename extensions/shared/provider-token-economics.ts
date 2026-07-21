function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ProviderUsageEconomics = {
  logicalInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export function normalizeProviderUsage(provider: string, raw: Record<string, any>): ProviderUsageEconomics {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic")) {
    const uncached = numberOrNull(raw.input_tokens);
    const read = numberOrNull(raw.cache_read_input_tokens);
    const write = numberOrNull(raw.cache_creation_input_tokens);
    const pieces = [uncached, read, write].filter((value): value is number => value !== null);
    return { logicalInputTokens: pieces.length ? pieces.reduce((sum, value) => sum + value, 0) : null, uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: numberOrNull(raw.output_tokens), costUsd: numberOrNull(raw.cost?.total ?? raw.cost) };
  }
  if (normalized.includes("openai")) {
    const logical = numberOrNull(raw.prompt_tokens);
    const read = numberOrNull(raw.prompt_tokens_details?.cached_tokens);
    return { logicalInputTokens: logical, uncachedInputTokens: logical === null ? null : Math.max(0, logical - (read ?? 0)), cacheReadTokens: read, cacheWriteTokens: numberOrNull(raw.prompt_tokens_details?.cache_write_tokens), outputTokens: numberOrNull(raw.completion_tokens), costUsd: numberOrNull(raw.cost?.total ?? raw.cost) };
  }
  if (normalized.includes("google") || normalized.includes("gemini")) {
    const logical = numberOrNull(raw.promptTokenCount);
    const read = numberOrNull(raw.cachedContentTokenCount);
    return { logicalInputTokens: logical, uncachedInputTokens: logical === null ? null : Math.max(0, logical - (read ?? 0)), cacheReadTokens: read, cacheWriteTokens: null, outputTokens: numberOrNull(raw.candidatesTokenCount), costUsd: numberOrNull(raw.cost?.total ?? raw.cost) };
  }
  const input = numberOrNull(raw.input ?? raw.input_tokens);
  return { logicalInputTokens: input, uncachedInputTokens: input, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: numberOrNull(raw.output ?? raw.output_tokens), costUsd: numberOrNull(raw.cost?.total ?? raw.cost) };
}

export function planProviderCacheControls(provider: string, payload: Record<string, any>, options: { ttl?: string; implicitCaching?: boolean }) {
  const normalized = provider.toLowerCase();
  if ((normalized.includes("google") || normalized.includes("gemini")) && options.implicitCaching) return { changed: false, reason: "provider-managed-implicit-cache", payload, changedPaths: [] };
  if (normalized.includes("anthropic")) return { changed: true, reason: "explicit-cache-control", payload: { ...payload, cache_control: { type: "ephemeral", ttl: options.ttl ?? "5m" } }, changedPaths: ["cache_control"] };
  return { changed: false, reason: "unsupported-or-provider-managed", payload, changedPaths: [] };
}

export function evaluateToolExposureEconomics<T extends { strategy: string; totalCostUsd: number; taskSucceeded: boolean; schemaTokens: number; cacheReadTokens: number; discoveryCalls: number }>(samples: T[]) {
  const ranked = samples.filter(sample => sample.taskSucceeded).sort((left, right) => left.totalCostUsd - right.totalCostUsd || left.strategy.localeCompare(right.strategy));
  return { best: ranked[0] ?? null, ranked, explanation: "Ranked successful strategies by total cost after schema size, cache reuse, and discovery-call overhead." };
}
