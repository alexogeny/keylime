import { describe, expect, test } from "bun:test";
import { adaptProviderPayloadForProfiling, buildPromptPrefixDiagnostic } from "../../extensions/shared/prompt-prefix-profiler";

const modulePath = "../../extensions/shared/prompt-prefix-profiler";
async function prefixApi(): Promise<any> {
  return import(modulePath);
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  systemPrompt: "You are a coding agent. Preserve user constraints.",
  tools: [
    { name: "inspect", description: "Inspect bounded source", schema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "check", description: "Run checks", schema: { type: "object", properties: { suite: { type: "string" } } } },
  ],
  messages: [
    { role: "user", content: "Implement the task" },
    { role: "assistant", content: "I will inspect it" },
    { role: "user", content: "volatile newest turn" },
  ],
  stableMessageCount: 2,
  ...overrides,
});

describe("RED: prompt-prefix profiling explains cache stability", () => {
  test("ignores the volatile suffix when fingerprinting the reusable prefix", async () => {
    const { fingerprintPromptPrefix } = await prefixApi();
    const first = fingerprintPromptPrefix(payload());
    const second = fingerprintPromptPrefix(payload({
      messages: [
        { role: "user", content: "Implement the task" },
        { role: "assistant", content: "I will inspect it" },
        { role: "user", content: "different newest turn" },
      ],
    }));

    expect(first.hash).toBe(second.hash);
    expect(first.prefixChars).toBeGreaterThan(0);
  });

  test("treats tool ordering as cache-significant even when the active set is unchanged", async () => {
    const { diffPromptPrefixes } = await prefixApi();
    const original = payload();
    const reordered = payload({ tools: [...original.tools].reverse() });
    const diff = diffPromptPrefixes(original, reordered);

    expect(diff.cacheBust).toBe(true);
    expect(diff.changedCategories).toContain("tool_order");
    expect(diff.firstChangedPath).toContain("tools");
  });

  test("detects schema and description changes independently from tool-set changes", async () => {
    const { diffPromptPrefixes } = await prefixApi();
    const changed = payload({
      tools: [
        { name: "inspect", description: "Inspect any amount of source with extensive guidance", schema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } } },
        payload().tools[1],
      ],
    });
    const diff = diffPromptPrefixes(payload(), changed);

    expect(diff.changedCategories).toContain("tool_schema");
    expect(diff.addedTools).toEqual([]);
    expect(diff.removedTools).toEqual([]);
  });

  test("attributes system instructions, tools, history, and suffix separately", async () => {
    const { profilePromptPayload } = await prefixApi();
    const profile = profilePromptPayload(payload());

    expect(profile.categories.system.chars).toBeGreaterThan(0);
    expect(profile.categories.tools.chars).toBeGreaterThan(0);
    expect(profile.categories.stableHistory.chars).toBeGreaterThan(0);
    expect(profile.categories.volatileSuffix.chars).toBeGreaterThan(0);
    expect(profile.totalChars).toBe(
      profile.categories.system.chars
      + profile.categories.tools.chars
      + profile.categories.stableHistory.chars
      + profile.categories.volatileSuffix.chars,
    );
  });

  test("compares static, preactivated, and search-deferred tool exposure without assuming a winner", async () => {
    const { compareToolExposureStrategies } = await prefixApi();
    const comparison = compareToolExposureStrategies([
      { strategy: "static", schemaChars: 20_000, cacheReadTokens: 15_000, extraCalls: 0, taskSucceeded: true, costUsd: 0.12 },
      { strategy: "preactivated", schemaChars: 6_000, cacheReadTokens: 4_000, extraCalls: 0, taskSucceeded: true, costUsd: 0.08 },
      { strategy: "search-deferred", schemaChars: 1_000, cacheReadTokens: 500, extraCalls: 2, taskSucceeded: true, costUsd: 0.11 },
    ]);

    expect(comparison.best.strategy).toBe("preactivated");
    expect(comparison.best.reason).toContain("successful-task cost");
  });

  test("adapts Anthropic-style provider payloads without changing ordered tools", () => {
    const adapted = adaptProviderPayloadForProfiling({
      system: [{ type: "text", text: "stable system" }],
      tools: [{ name: "inspect", description: "bounded", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "stable request" }, { role: "user", content: "volatile newest request" }],
    });

    expect(adapted.systemPrompt).toContain("stable system");
    expect(adapted.tools).toEqual([{ name: "inspect", description: "bounded", schema: { type: "object" } }]);
    expect(adapted.stableMessageCount).toBe(1);
  });

  test("persists hash-and-size diagnostics without provider prompt bodies", () => {
    const diagnostic = buildPromptPrefixDiagnostic(undefined, {
      instructions: "PRIVATE_SYSTEM_BODY",
      tools: [{ type: "function", name: "check", description: "PRIVATE_TOOL_BODY", parameters: { type: "object" } }],
      input: [{ role: "user", content: "PRIVATE_MESSAGE_BODY" }],
    });
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic.current.hash).toHaveLength(64);
    expect(diagnostic.profile.categories.tools.chars).toBeGreaterThan(0);
    expect(serialized).not.toContain("PRIVATE_SYSTEM_BODY");
    expect(serialized).not.toContain("PRIVATE_TOOL_BODY");
    expect(serialized).not.toContain("PRIVATE_MESSAGE_BODY");
  });

  test("attributes cache-significant changes from safe prior diagnostics", () => {
    const first = buildPromptPrefixDiagnostic(undefined, {
      system: "PRIVATE_SYSTEM_STABLE",
      tools: [{ name: "inspect", input_schema: {} }, { name: "check", input_schema: {} }],
      messages: [{ role: "user", content: "PRIVATE_TASK_BODY" }],
    });
    const second = buildPromptPrefixDiagnostic(first, {
      system: "PRIVATE_SYSTEM_STABLE",
      tools: [{ name: "check", input_schema: {} }, { name: "inspect", input_schema: {} }],
      messages: [{ role: "user", content: "PRIVATE_TASK_BODY" }],
    });

    expect(second.diff?.cacheBust).toBe(true);
    expect(second.diff?.changedCategories).toContain("tool_order");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SYSTEM_STABLE");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_TASK_BODY");
  });
});
