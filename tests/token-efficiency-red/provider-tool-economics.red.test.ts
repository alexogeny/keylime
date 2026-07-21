import { describe, expect, test } from "bun:test";

const providerPath = "../../extensions/shared/provider-token-economics";
const prefixPath = "../../extensions/shared/prompt-prefix-profiler";
async function providerApi(): Promise<any> { return import(providerPath); }
async function prefixApi(): Promise<any> { return import(prefixPath); }

describe("RED: provider-aware caching and tool-exposure economics", () => {
  test("TE-080 normalizes Anthropic cache creation and cache read usage", async () => {
    const { normalizeProviderUsage } = await providerApi();
    const usage = normalizeProviderUsage("anthropic", { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 });
    expect(usage).toMatchObject({ uncachedInputTokens: 50, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100 });
  });

  test("TE-081 normalizes OpenAI cached-token details without double-counting logical input", async () => {
    const { normalizeProviderUsage } = await providerApi();
    const usage = normalizeProviderUsage("openai", { prompt_tokens: 1_000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } });
    expect(usage).toMatchObject({ logicalInputTokens: 1_000, uncachedInputTokens: 200, cacheReadTokens: 800, outputTokens: 20 });
  });

  test("TE-082 normalizes Gemini prompt and cached-content usage", async () => {
    const { normalizeProviderUsage } = await providerApi();
    const usage = normalizeProviderUsage("google", { promptTokenCount: 1_000, candidatesTokenCount: 30, cachedContentTokenCount: 700 });
    expect(usage).toMatchObject({ logicalInputTokens: 1_000, uncachedInputTokens: 300, cacheReadTokens: 700, outputTokens: 30 });
  });

  test("TE-083 keeps unknown provider accounting fields unknown", async () => {
    const { normalizeProviderUsage } = await providerApi();
    const usage = normalizeProviderUsage("custom", { input: 10 });
    expect(usage.cacheReadTokens).toBeNull();
    expect(usage.cacheWriteTokens).toBeNull();
    expect(usage.costUsd).toBeNull();
  });

  test("TE-084 plans provider cache controls without rewriting stable prompt content", async () => {
    const { planProviderCacheControls } = await providerApi();
    const payload = { system: "stable", tools: [{ name: "inspect" }], messages: [{ role: "user", content: "task" }] };
    const plan = planProviderCacheControls("anthropic", payload, { ttl: "5m" });
    expect(plan.payload.system).toBe(payload.system);
    expect(plan.payload.tools).toEqual(payload.tools);
    expect(plan.changedPaths.every((path: string) => path.includes("cache"))).toBe(true);
  });

  test("TE-085 does not inject cache controls when the provider manages caching implicitly", async () => {
    const { planProviderCacheControls } = await providerApi();
    const plan = planProviderCacheControls("google", { systemInstruction: "stable" }, { implicitCaching: true });
    expect(plan).toMatchObject({ changed: false, reason: "provider-managed-implicit-cache" });
  });

  test("TE-086 stabilizes active tool order independently from intent discovery order", async () => {
    const { stabilizeToolOrder } = await prefixApi();
    const canonical = ["inspect", "check", "research", "mutate"];
    expect(stabilizeToolOrder(["research", "inspect"], canonical)).toEqual(["inspect", "research"]);
    expect(stabilizeToolOrder(["inspect", "research"], canonical)).toEqual(["inspect", "research"]);
  });

  test("TE-087 compares schema savings against cache loss and discovery-call cost", async () => {
    const { evaluateToolExposureEconomics } = await providerApi();
    const result = evaluateToolExposureEconomics([
      { strategy: "static", schemaTokens: 5_000, cacheReadTokens: 20_000, discoveryCalls: 0, totalCostUsd: 0.10, taskSucceeded: true },
      { strategy: "deferred", schemaTokens: 500, cacheReadTokens: 1_000, discoveryCalls: 2, totalCostUsd: 0.13, taskSucceeded: true },
    ]);
    expect(result.best.strategy).toBe("static");
    expect(result.explanation).toContain("cache");
    expect(result.explanation).toContain("discovery");
  });
});
