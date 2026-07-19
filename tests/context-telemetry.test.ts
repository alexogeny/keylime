import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import passiveContextTelemetry, { createPassiveTelemetryStore } from "../extensions/passive-context-telemetry";
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

  test("collapses thousands of turns into one bounded daily aggregate", async () => {
    const dir = await tempRoot();
    const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
    for (let index = 0; index < 1_000; index++) await store.record({ inputTokens: 10, outputTokens: 2, contextPercent: index % 100 });
    const path = join(dir, "2026-07-19.json");
    expect((await stat(path)).size).toBeLessThan(4_096);
    expect(JSON.parse(await readFile(path, "utf8")).turns).toBe(1_000);
  });

  test("retains at most fourteen daily files", async () => {
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

  test("Pi extension records assistant usage passively and exposes stats controls", async () => {
    const dir = await tempRoot();
    const harness = mockPiFixture();
    passiveContextTelemetry(harness.pi, { dir, now: () => new Date("2026-07-19T12:00:00Z") });
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining(["message_end", "session_before_compact"]));
    expect(harness.commands["context-telemetry"]).toBeDefined();
    await harness.handlers.message_end[0]({ message: { role: "assistant", usage: { input: 500, output: 100, cacheRead: 300, cacheWrite: 50, cost: { total: .01 } } } }, { ...harness.ctx, getContextUsage: () => ({ percent: 40, tokens: 4_000, contextWindow: 10_000 }) });
    const aggregate = JSON.parse(await readFile(join(dir, "2026-07-19.json"), "utf8"));
    expect(aggregate.turns).toBe(1);
    expect(aggregate.tokens.cacheRead).toBe(300);
  });
});
