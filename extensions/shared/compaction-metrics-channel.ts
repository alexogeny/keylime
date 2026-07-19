export type CompactionMetric = {
  model?: { provider: string; model: string; thinking: string };
  durationMs?: number;
  schemaValid?: boolean;
  fallbackUsed?: boolean;
  activeControlsBefore?: number;
  activeControlsAfter?: number;
  relinkingDetected?: boolean;
  prohibitedBackendActions?: number;
};

type CompactionMetricStore = { recordCompaction(metric: CompactionMetric): Promise<void> };

function sanitize(input: CompactionMetric): CompactionMetric {
  return {
    model: input.model ? {
      provider: String(input.model.provider), model: String(input.model.model), thinking: String(input.model.thinking),
    } : undefined,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Number(input.durationMs)) : undefined,
    schemaValid: Boolean(input.schemaValid),
    fallbackUsed: Boolean(input.fallbackUsed),
    activeControlsBefore: Number.isFinite(input.activeControlsBefore) ? Math.max(0, Math.floor(Number(input.activeControlsBefore))) : undefined,
    activeControlsAfter: Number.isFinite(input.activeControlsAfter) ? Math.max(0, Math.floor(Number(input.activeControlsAfter))) : undefined,
    relinkingDetected: Boolean(input.relinkingDetected),
    prohibitedBackendActions: Number.isFinite(input.prohibitedBackendActions) ? Math.max(0, Math.floor(Number(input.prohibitedBackendActions))) : undefined,
  };
}

export function createCompactionMetricsChannel() {
  const stores = new Set<CompactionMetricStore>();
  let queued = Promise.resolve();
  let pendingEvents = 0;
  return {
    attachStore(store: CompactionMetricStore): () => void {
      stores.add(store);
      return () => { stores.delete(store); };
    },
    publish(input: CompactionMetric): void {
      if (!stores.size) return;
      const metric = sanitize(input);
      pendingEvents++;
      const task = queued.then(async () => {
        await Promise.all([...stores].map(store => store.recordCompaction(metric)));
      });
      queued = task.then(
        () => { pendingEvents--; },
        () => { pendingEvents--; },
      );
    },
    async flush(): Promise<void> { await queued; },
    memoryStats(): { pendingEvents: number; attachedStores: number } {
      return { pendingEvents, attachedStores: stores.size };
    },
  };
}

export const compactionMetricsChannel = createCompactionMetricsChannel();
