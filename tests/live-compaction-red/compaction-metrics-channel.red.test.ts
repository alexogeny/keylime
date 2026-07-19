import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createPassiveTelemetryStore } from "../../extensions/passive-context-telemetry";

const moduleUrl = new URL("../../extensions/shared/compaction-metrics-channel.ts", import.meta.url).href;
async function production(): Promise<any> { return import(moduleUrl); }

describe("RED: live compaction outcomes reach aggregate telemetry", () => {
  test("publishes real success and fallback outcomes into the telemetry store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-live-metrics-"));
    try {
      const { createCompactionMetricsChannel } = await production();
      const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
      const channel = createCompactionMetricsChannel();
      channel.attachStore(store);
      channel.publish({
        durationMs: 1_200, schemaValid: true, fallbackUsed: false,
        activeControlsBefore: 4, activeControlsAfter: 4, relinkingDetected: false, prohibitedBackendActions: 0,
      });
      channel.publish({
        durationMs: 3_000, schemaValid: false, fallbackUsed: true,
        activeControlsBefore: 4, activeControlsAfter: 3, relinkingDetected: true, prohibitedBackendActions: 1,
      });
      await channel.flush();

      const aggregate = (await store.aggregates())[0] as any;
      expect(aggregate.compactionQuality).toEqual(expect.objectContaining({
        attempts: 2, valid: 1, fallbacks: 1,
        activeControlsBefore: 8, activeControlsAfter: 7,
        relinkingDetected: 1, prohibitedBackendActions: 1,
      }));
      expect(aggregate.compactionLatency.maxMs).toBe(3_000);
      expect(channel.memoryStats()).toEqual({ pendingEvents: 0, attachedStores: 1 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("drops raw content fields before persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-live-metrics-private-"));
    try {
      const { createCompactionMetricsChannel } = await production();
      const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
      const channel = createCompactionMetricsChannel();
      channel.attachStore(store);
      channel.publish({
        durationMs: 10, schemaValid: true, fallbackUsed: false,
        rawPrompt: "PRIVATE PROMPT", rawResponse: "PRIVATE RESPONSE", repositoryPath: "/private/repo",
      });
      await channel.flush();

      const persisted = await readFile(join(dir, "2026-07-19.json"), "utf8");
      expect(persisted).not.toContain("PRIVATE PROMPT");
      expect(persisted).not.toContain("PRIVATE RESPONSE");
      expect(persisted).not.toContain("/private/repo");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
