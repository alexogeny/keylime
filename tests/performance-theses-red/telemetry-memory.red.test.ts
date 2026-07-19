import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import { createPassiveTelemetryStore } from "../../extensions/passive-context-telemetry";

describe("RED: permanent telemetry history does not become permanent process memory", () => {
  test("does not retain one in-memory aggregate for every historical day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-telemetry-memory-"));
    let day = 0;
    try {
      const store = createPassiveTelemetryStore({
        dir,
        now: () => new Date(Date.UTC(2026, 0, 1 + day, 12)),
      });
      for (day = 0; day < 120; day++) await store.record({ inputTokens: 10, outputTokens: 2 });

      const stats = (store as any).memoryStats();
      expect(stats.cachedDays).toBe(0);
      expect(stats.queuedOperations).toBeLessThanOrEqual(1);
      expect((await store.aggregates())).toHaveLength(120);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps compaction-latency histogram cardinality fixed under varied inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keylime-telemetry-histogram-"));
    try {
      const store = createPassiveTelemetryStore({ dir, now: () => new Date("2026-07-19T12:00:00Z") });
      const started = performance.now();
      for (let index = 0; index < 1_000; index++) {
        await store.recordCompaction({
          durationMs: index * 137,
          schemaValid: true,
          fallbackUsed: false,
        });
      }
      const elapsedMs = performance.now() - started;
      const aggregate = (await store.aggregates())[0] as any;

      expect(Object.keys(aggregate.compactionLatency.buckets).length).toBeLessThanOrEqual(601);
      expect(aggregate.compactionLatency.count).toBe(999);
      expect(elapsedMs).toBeLessThan(5_000);
      expect((store as any).memoryStats().cachedDays).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
