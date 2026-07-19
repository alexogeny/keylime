import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createPassiveTelemetryStore } from "../../extensions/passive-context-telemetry";

describe("RED: privacy-preserving telemetry measures compaction quality", () => {
  test("records validity, fallback, latency, and control-retention aggregates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-compaction-metrics-"));
    try {
      const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
      await (store.recordCompaction as any)({
        model: { provider: "test-provider", model: "test-model", thinking: "off" },
        durationMs: 1_200,
        schemaValid: true,
        fallbackUsed: false,
        activeControlsBefore: 4,
        activeControlsAfter: 4,
        relinkingDetected: false,
        prohibitedBackendActions: 0,
      });

      const aggregate = (await store.aggregates())[0] as any;
      expect(aggregate.compactionQuality).toEqual(expect.objectContaining({
        attempts: 1,
        valid: 1,
        fallbacks: 0,
        activeControlsBefore: 4,
        activeControlsAfter: 4,
        relinkingDetected: 0,
        prohibitedBackendActions: 0,
      }));
      expect(aggregate.compactionLatency.count).toBe(1);
      expect(aggregate.compactionLatency.maxMs).toBe(1_200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("can derive p95 latency and fallback rate without retaining session content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-compaction-p95-"));
    try {
      const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
      for (let index = 1; index <= 20; index++) {
        await (store.recordCompaction as any)({
          model: { provider: "test-provider", model: "test-model", thinking: "off" },
          durationMs: index * 100,
          schemaValid: index !== 20,
          fallbackUsed: index === 20,
          activeControlsBefore: 3,
          activeControlsAfter: index === 20 ? 2 : 3,
          rawPrompt: "PRIVATE PROMPT MUST NEVER BE STORED",
          rawResponse: "PRIVATE RESPONSE MUST NEVER BE STORED",
          repositoryPath: "/private/repository/path",
        });
      }

      const aggregate = (await store.aggregates())[0] as any;
      expect(aggregate.compactionLatency.p95Ms).toBe(1_900);
      expect(aggregate.compactionQuality.fallbackRate).toBe(.05);
      expect(aggregate.compactionQuality.schemaValidityRate).toBe(.95);
      const serialized = JSON.stringify(aggregate);
      expect(serialized).not.toContain("PRIVATE PROMPT");
      expect(serialized).not.toContain("PRIVATE RESPONSE");
      expect(serialized).not.toContain("/private/repository/path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
