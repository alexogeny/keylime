import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import passiveContextTelemetry, { createPassiveTelemetryStore } from "../extensions/passive-context-telemetry";
import * as telemetryModule from "../extensions/passive-context-telemetry";
import { mockPiFixture } from "./helpers/mock-pi";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function tempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "keylime-telemetry-")); roots.push(root); return root; }

describe("passive context telemetry", () => {
  test("stores aggregate heuristics without prompt tool or repository text", async () => {
    const dir = await tempRoot();
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
    await store.record({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100, costUsd: .02, contextPercent: 72, contextTokens: 7200, contextWindow: 10000, maskedObservations: 3, retrievalUtilization: .6, promptText: "SECRET PROMPT", repositoryPath: "/private/repo" } as any);
    const text = await readFile(join(dir, "2026-07-19.json"), "utf8");
    expect(text).not.toContain("SECRET PROMPT");
    expect(text).not.toContain("/private/repo");
    expect(JSON.parse(text)).toMatchObject({ version: 1, day: "2026-07-19", turns: 1, tokens: { input: 1000, output: 200, cacheRead: 700, cacheWrite: 100 }, context: { maxPercent: 72 }, runtime: { maskedObservations: 3 } });
  });

  test("keeps bounded per-model version and thinking-mode aggregates over time", async () => {
    const dir = await tempRoot();
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
    await store.record({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, modelVariant: { provider: "anthropic", model: "claude-opus-4-6-20260701", thinking: "high" } });
    await store.record({ inputTokens: 80, outputTokens: 10, cacheReadTokens: 120, modelVariant: { provider: "openai", model: "gpt-5.6-terra-2026-07", thinking: "medium" } });
    const aggregate = JSON.parse(await readFile(join(dir, "2026-07-19.json"), "utf8"));
    expect(aggregate.models["anthropic/claude-opus-4-6-20260701#high"]).toMatchObject({ turns: 1, tokens: { input: 100, output: 20, cacheRead: 300 } });
    expect(aggregate.models["openai/gpt-5.6-terra-2026-07#medium"]).toMatchObject({ turns: 1, tokens: { input: 80, output: 10, cacheRead: 120 } });
  });

  test("collapses thousands of turns into one bounded daily aggregate", async () => {
    const dir = await tempRoot();
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
    for (let index = 0; index < 1_000; index++) await store.record({ inputTokens: 10, outputTokens: 2, contextPercent: index % 100 });
    const path = join(dir, "2026-07-19.json");
    expect((await stat(path)).size).toBeLessThan(4_096);
    expect(JSON.parse(await readFile(path, "utf8")).turns).toBe(1_000);
  });

  test("keeps canonical daily aggregates permanently by default", async () => {
    const dir = await tempRoot();
    await mkdir(dir, { recursive: true });
    for (let day = 1; day <= 20; day++) await writeFile(join(dir, `2026-06-${String(day).padStart(2, "0")}.json`), "{}\n");
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-06-21T00:00:00Z") });
    await store.prune();
    expect((await readdir(dir)).filter(name => name.endsWith(".json"))).toHaveLength(20);
  });

  test("supports explicit retention limits when configured", async () => {
    const dir = await tempRoot();
    await mkdir(dir, { recursive: true });
    for (let day = 1; day <= 20; day++) await writeFile(join(dir, `2026-06-${String(day).padStart(2, "0")}.json`), "{}\n");
    const store = createPassiveTelemetryStore({ dir, retentionDays: 14, now: () => new Date("2026-06-21T00:00:00Z") });
    await store.prune();
    const files = (await readdir(dir)).filter(name => name.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(14);
    expect(files).not.toContain("2026-06-01.json");
  });

  test("enforces a hard directory byte budget by deleting oldest files", async () => {
    const dir = await tempRoot();
    await mkdir(dir, { recursive: true });
    for (let day = 1; day <= 8; day++) await writeFile(join(dir, `2026-07-${String(day).padStart(2, "0")}.json`), "x".repeat(1_000));
    const store = createPassiveTelemetryStore({ dir, maxBytes: 3_200, retentionDays: 30, now: () => new Date("2026-07-09T00:00:00Z") });
    await store.prune();
    const sizes = await Promise.all((await readdir(dir)).filter(name => name.endsWith(".json")).map(async name => (await stat(join(dir, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(3_200);
  });

  test("serializes canonical updates across independent Pi processes", async () => {
    const dir = await tempRoot();
    const moduleUrl = new URL("../extensions/passive-context-telemetry.ts", import.meta.url).href;
    const source = `import { createPassiveTelemetryStore } from ${JSON.stringify(moduleUrl)}; const store = createPassiveTelemetryStore({ dir: ${JSON.stringify(dir)}, now: () => new Date("2026-07-19T12:00:00Z") }); for (let i = 0; i < 30; i++) await store.record({ inputTokens: 1 });`;
    const children = [Bun.spawn([process.execPath, "-e", source]), Bun.spawn([process.execPath, "-e", source])];
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
    expect(JSON.parse(await readFile(join(dir, "2026-07-19.json"), "utf8")).turns).toBe(60);
  });

  test("quarantines malformed permanent aggregates instead of silently overwriting them", async () => {
    const dir = await tempRoot();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-07-19.json"), "{broken");
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
    await store.record({ inputTokens: 1 });
    expect((await readdir(dir)).some(name => name.includes("2026-07-19.json.corrupt-"))).toBe(true);
  });

  test("formats model and thinking-level history without reading chat content", () => {
    const format = (telemetryModule as any).formatVariantReport;
    expect(format).toBeFunction();
    const report = format([{ version: 1, day: "2026-07-19", turns: 2, tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 }, costUsd: 0, context: { samples: 0, percentTotal: 0, maxPercent: 0, tokensMax: 0, windowMax: 0 }, runtime: { maskedObservations: 0, folds: 0, compacted: 0, retrievalUtilizationTotal: 0, retrievalSamples: 0 }, models: { "openai/gpt-test#high": { turns: 2, tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 }, costUsd: 0 } } }]);
    expect(report).toContain("openai/gpt-test#high");
    expect(report).toContain("2 turns");
  });

  test("defers thinking-level runtime access until the session has started", async () => {
    const dir = await tempRoot();
    const harness = mockPiFixture();
    let runtimeInitialized = false;
    let thinkingLevelReads = 0;
    (harness.pi as any).getThinkingLevel = () => {
      if (!runtimeInitialized) throw new Error("runtime action called during extension loading");
      thinkingLevelReads++;
      return "high";
    };

    expect(() => passiveContextTelemetry(harness.pi, { dir })).not.toThrow();
    expect(thinkingLevelReads).toBe(0);

    runtimeInitialized = true;
    await harness.handlers.session_start[0]({}, { ...harness.ctx, model: { provider: "test", id: "test-model" } });
    expect(thinkingLevelReads).toBe(1);
  });

  test("Pi extension records assistant usage passively and exposes stats controls", async () => {
    const dir = await tempRoot();
    const harness = mockPiFixture();
    passiveContextTelemetry(harness.pi, { dir, now: () => new Date("2026-07-19T12:00:00Z") });
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining(["message_end", "session_before_compact", "model_select", "thinking_level_select"]));
    expect(harness.commands["context-telemetry"]).toBeDefined();
    await harness.handlers.model_select[0]({ model: { provider: "anthropic", id: "claude-sonnet-4-6-20260701" }, source: "restore" }, harness.ctx);
    await harness.handlers.thinking_level_select[0]({ level: "high" }, harness.ctx);
    await harness.handlers.message_end[0]({ message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6-20260701", usage: { input: 500, output: 100, cacheRead: 300, cacheWrite: 50, cost: { total: .01 } } } }, { ...harness.ctx, getContextUsage: () => ({ percent: 40, tokens: 4_000, contextWindow: 10_000 }) });
    const aggregate = JSON.parse(await readFile(join(dir, "2026-07-19.json"), "utf8"));
    expect(aggregate.turns).toBe(1);
    expect(aggregate.tokens.cacheRead).toBe(300);
    expect(aggregate.models["anthropic/claude-sonnet-4-6-20260701#high"].turns).toBe(1);
    await harness.commands["context-telemetry"].handler("", harness.ctx);
    expect(harness.notifications.join("\n")).toContain("cache hit 35.3%");
    expect(harness.notifications.join("\n")).toContain("logical input 850");
    expect(harness.notifications.join("\n")).toContain("uncached 500");
    expect(harness.notifications.join("\n")).toContain("1 turn");
    expect(harness.notifications.join("\n")).toContain("Retention: permanent");
  });
});
