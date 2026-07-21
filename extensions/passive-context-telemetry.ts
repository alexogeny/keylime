import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readContextRuntimeTelemetry } from "./shared/context-runtime-bus";
import { compactionMetricsChannel } from "./shared/compaction-metrics-channel";

export const DEFAULT_CONTEXT_TELEMETRY_DIR = join(homedir(), ".pi", "data", "keylime-context-telemetry");
const DEFAULT_RETENTION_DAYS = 0; // permanent unless explicitly configured
const DEFAULT_MAX_BYTES = 0; // unlimited aggregate archive unless explicitly configured

type ModelVariant = { provider: string; model: string; thinking: string };
type ModelAggregate = {
  provider: string; model: string; thinking: string; turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  context: { samples: number; percentSum: number; maxPercent: number };
  runtime: { maskedObservations: number; retrievalSamples: number; retrievalUtilizationSum: number; folds: number };
  compactions: number;
};

type TelemetrySample = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  maskedObservations?: number;
  retrievalUtilization?: number;
  folded?: boolean;
  modelVariant?: ModelVariant;
};

type CompactionTelemetrySample = {
  model?: ModelVariant;
  durationMs?: number;
  schemaValid?: boolean;
  fallbackUsed?: boolean;
  activeControlsBefore?: number;
  activeControlsAfter?: number;
  relinkingDetected?: boolean;
  prohibitedBackendActions?: number;
  attempts?: number;
  localTimeouts?: number;
  outputTruncations?: number;
};
type CompactionQualityAggregate = {
  attempts: number; valid: number; fallbacks: number; activeControlsBefore: number; activeControlsAfter: number;
  relinkingDetected: number; prohibitedBackendActions: number; fallbackRate: number; schemaValidityRate: number;
  generationAttempts: number; localTimeouts: number; outputTruncations: number;
};
type CompactionLatencyAggregate = { count: number; sumMs: number; maxMs: number; p95Ms: number; buckets: Record<string, number> };

type DailyAggregate = {
  version: 1;
  day: string;
  updatedAt: string;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  context: { samples: number; percentSum: number; maxPercent: number; maxTokens: number; contextWindow: number; pressure: { low: number; medium: number; high: number } };
  runtime: { maskedObservations: number; retrievalSamples: number; retrievalUtilizationSum: number; folds: number };
  compactions: number;
  compactionQuality: CompactionQualityAggregate;
  compactionLatency: CompactionLatencyAggregate;
  models: Record<string, ModelAggregate>;
};

type StoreOptions = { dir?: string; retentionDays?: number; maxBytes?: number; now?: () => Date };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function dayOf(date: Date): string { return date.toISOString().slice(0, 10); }
function blank(day: string, now: Date): DailyAggregate {
  return {
    version: 1, day, updatedAt: now.toISOString(), turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
    context: { samples: 0, percentSum: 0, maxPercent: 0, maxTokens: 0, contextWindow: 0, pressure: { low: 0, medium: 0, high: 0 } },
    runtime: { maskedObservations: 0, retrievalSamples: 0, retrievalUtilizationSum: 0, folds: 0 }, compactions: 0,
    compactionQuality: { attempts: 0, valid: 0, fallbacks: 0, activeControlsBefore: 0, activeControlsAfter: 0, relinkingDetected: 0, prohibitedBackendActions: 0, fallbackRate: 0, schemaValidityRate: 0, generationAttempts: 0, localTimeouts: 0, outputTruncations: 0 },
    compactionLatency: { count: 0, sumMs: 0, maxMs: 0, p95Ms: 0, buckets: {} },
    models: {},
  };
}

async function safeRead(path: string, fallback: DailyAggregate): Promise<DailyAggregate> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.version !== 1) throw new Error("Unsupported telemetry aggregate version");
    parsed.models ??= {};
    parsed.compactionQuality ??= { attempts: parsed.compactions ?? 0, valid: 0, fallbacks: 0, activeControlsBefore: 0, activeControlsAfter: 0, relinkingDetected: 0, prohibitedBackendActions: 0, fallbackRate: 0, schemaValidityRate: 0, generationAttempts: 0, localTimeouts: 0, outputTruncations: 0 };
    parsed.compactionQuality.generationAttempts ??= 0;
    parsed.compactionQuality.localTimeouts ??= 0;
    parsed.compactionQuality.outputTruncations ??= 0;
    parsed.compactionLatency ??= { count: 0, sumMs: 0, maxMs: 0, p95Ms: 0, buckets: {} };
    return parsed as DailyAggregate;
  } catch (error: any) {
    if (error?.code !== "ENOENT") await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`).catch(() => undefined);
    return fallback;
  }
}

async function withTelemetryFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() } as any))).mtimeMs;
      if (age > 30_000) await rm(lock, { recursive: true, force: true });
      else if (Date.now() >= deadline) throw new Error(`Timed out waiting for telemetry lock: ${lock}`);
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

function variantPart(value: string, fallback: string): string {
  const cleaned = String(value || fallback).replace(/[\u0000-\u001f#]/g, "-").trim();
  return (cleaned || fallback).slice(0, 120);
}

function modelBucket(aggregate: DailyAggregate, variant: ModelVariant): ModelAggregate {
  const provider = variantPart(variant.provider, "unknown");
  const model = variantPart(variant.model, "unknown");
  const thinking = variantPart(variant.thinking, "unknown");
  const requested = `${provider}/${model}#${thinking}`;
  const key = aggregate.models[requested] || Object.keys(aggregate.models).length < 15 ? requested : "__other__";
  return aggregate.models[key] ??= {
    provider: key === "__other__" ? "other" : provider,
    model: key === "__other__" ? "other" : model,
    thinking: key === "__other__" ? "other" : thinking,
    turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
    context: { samples: 0, percentSum: 0, maxPercent: 0 },
    runtime: { maskedObservations: 0, retrievalSamples: 0, retrievalUtilizationSum: 0, folds: 0 }, compactions: 0,
  };
}

export function createPassiveTelemetryStore(options: StoreOptions = {}) {
  const dir = options.dir ?? DEFAULT_CONTEXT_TELEMETRY_DIR;
  const requestedRetention = Math.floor(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const requestedMaxBytes = Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES);
  const retentionDays = requestedRetention <= 0 ? 0 : Math.max(1, Math.min(36_500, requestedRetention));
  const maxBytes = requestedMaxBytes <= 0 ? 0 : Math.max(1_024, Math.min(1024 * 1024 * 1024, requestedMaxBytes));
  const now = options.now ?? (() => new Date());
  let queued = Promise.resolve();
  let queuedOperations = 0;

  const atomicWrite = async (path: string, aggregate: DailyAggregate): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(aggregate)}\n`, { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => {});
  };

  const pruneNow = async (): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const names = (await readdir(dir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const remove = new Set(retentionDays > 0 ? names.slice(0, Math.max(0, names.length - retentionDays)) : []);
    for (const name of remove) await rm(join(dir, name), { force: true });
    const kept = names.filter(name => !remove.has(name));
    const entries = await Promise.all(kept.map(async name => ({ name, size: (await stat(join(dir, name))).size })));
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (maxBytes <= 0 || total <= maxBytes) break;
      await rm(join(dir, entry.name), { force: true });
      total -= entry.size;
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    queuedOperations++;
    const result = queued.then(work, work);
    queued = result.then(
      () => { queuedOperations--; },
      () => { queuedOperations--; },
    );
    return result;
  };

  return {
    dir,
    record(sample: TelemetrySample): Promise<void> {
      return enqueue(async () => {
        const timestamp = now();
        const day = dayOf(timestamp);
        const path = join(dir, `${day}.json`);
        await withTelemetryFileLock(path, async () => {
        const aggregate = await safeRead(path, blank(day, timestamp));
        aggregate.updatedAt = timestamp.toISOString();
        aggregate.turns++;
        aggregate.tokens.input += finite(sample.inputTokens);
        aggregate.tokens.output += finite(sample.outputTokens);
        aggregate.tokens.cacheRead += finite(sample.cacheReadTokens);
        aggregate.tokens.cacheWrite += finite(sample.cacheWriteTokens);
        aggregate.costUsd += finite(sample.costUsd);
        const percent = Math.max(0, Math.min(100, finite(sample.contextPercent)));
        if (sample.contextPercent !== undefined) {
          aggregate.context.samples++;
          aggregate.context.percentSum += percent;
          aggregate.context.maxPercent = Math.max(aggregate.context.maxPercent, percent);
          if (percent >= 85) aggregate.context.pressure.high++;
          else if (percent >= 65) aggregate.context.pressure.medium++;
          else aggregate.context.pressure.low++;
        }
        aggregate.context.maxTokens = Math.max(aggregate.context.maxTokens, finite(sample.contextTokens));
        aggregate.context.contextWindow = Math.max(aggregate.context.contextWindow, finite(sample.contextWindow));
        aggregate.runtime.maskedObservations += finite(sample.maskedObservations);
        if (sample.retrievalUtilization !== undefined && Number.isFinite(sample.retrievalUtilization)) {
          aggregate.runtime.retrievalSamples++;
          aggregate.runtime.retrievalUtilizationSum += Math.max(0, Math.min(1, sample.retrievalUtilization));
        }
        if (sample.folded) aggregate.runtime.folds++;
        if (sample.modelVariant) {
          const model = modelBucket(aggregate, sample.modelVariant);
          model.turns++;
          model.tokens.input += finite(sample.inputTokens);
          model.tokens.output += finite(sample.outputTokens);
          model.tokens.cacheRead += finite(sample.cacheReadTokens);
          model.tokens.cacheWrite += finite(sample.cacheWriteTokens);
          model.costUsd += finite(sample.costUsd);
          if (sample.contextPercent !== undefined) { model.context.samples++; model.context.percentSum += percent; model.context.maxPercent = Math.max(model.context.maxPercent, percent); }
          model.runtime.maskedObservations += finite(sample.maskedObservations);
          if (sample.retrievalUtilization !== undefined && Number.isFinite(sample.retrievalUtilization)) { model.runtime.retrievalSamples++; model.runtime.retrievalUtilizationSum += Math.max(0, Math.min(1, sample.retrievalUtilization)); }
          if (sample.folded) model.runtime.folds++;
        }
        await atomicWrite(path, aggregate);
        if ((retentionDays > 0 || maxBytes > 0) && (aggregate.turns === 1 || aggregate.turns % 50 === 0)) await pruneNow();
        });
      });
    },
    recordCompaction(input?: ModelVariant | CompactionTelemetrySample): Promise<void> {
      return enqueue(async () => {
        const timestamp = now(); const day = dayOf(timestamp); const path = join(dir, `${day}.json`);
        const sample: CompactionTelemetrySample = input && "provider" in input
          ? { model: input as ModelVariant }
          : (input as CompactionTelemetrySample | undefined) ?? {};
        await withTelemetryFileLock(path, async () => {
          const aggregate = await safeRead(path, blank(day, timestamp));
          aggregate.updatedAt = timestamp.toISOString(); aggregate.compactions++;
          if (sample.model) modelBucket(aggregate, sample.model).compactions++;
          const quality = aggregate.compactionQuality;
          quality.attempts++;
          if (sample.schemaValid) quality.valid++;
          if (sample.fallbackUsed) quality.fallbacks++;
          quality.activeControlsBefore += Math.max(0, Math.floor(sample.activeControlsBefore ?? 0));
          quality.activeControlsAfter += Math.max(0, Math.floor(sample.activeControlsAfter ?? 0));
          if (sample.relinkingDetected) quality.relinkingDetected++;
          quality.prohibitedBackendActions += Math.max(0, Math.floor(sample.prohibitedBackendActions ?? 0));
          quality.generationAttempts += Math.min(2, Math.max(0, Math.floor(sample.attempts ?? 0)));
          quality.localTimeouts += Math.min(2, Math.max(0, Math.floor(sample.localTimeouts ?? 0)));
          quality.outputTruncations += Math.min(2, Math.max(0, Math.floor(sample.outputTruncations ?? 0)));
          quality.fallbackRate = quality.fallbacks / quality.attempts;
          quality.schemaValidityRate = quality.valid / quality.attempts;
          const durationMs = Math.max(0, Math.round(sample.durationMs ?? 0));
          if (durationMs > 0) {
            const latency = aggregate.compactionLatency;
            const bucket = String(Math.min(60_000, Math.round(durationMs / 100) * 100));
            latency.count++;
            latency.sumMs += durationMs;
            latency.maxMs = Math.max(latency.maxMs, durationMs);
            latency.buckets[bucket] = (latency.buckets[bucket] ?? 0) + 1;
            const threshold = Math.ceil(latency.count * .95);
            let cumulative = 0;
            for (const [value, count] of Object.entries(latency.buckets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
              cumulative += count;
              if (cumulative >= threshold) { latency.p95Ms = Number(value); break; }
            }
          }
          await atomicWrite(path, aggregate);
        });
      });
    },
    prune(): Promise<void> { return enqueue(pruneNow); },
    clear(): Promise<void> { return enqueue(async () => { await rm(dir, { recursive: true, force: true }); }); },
    memoryStats(): { cachedDays: number; queuedOperations: number } { return { cachedDays: 0, queuedOperations }; },
    async aggregates(): Promise<DailyAggregate[]> {
      await queued;
      try {
        const names = (await readdir(dir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
        return (await Promise.all(names.map(async name => {
          try { const value = JSON.parse(await readFile(join(dir, name), "utf8")); return value?.version === 1 ? value as DailyAggregate : undefined; }
          catch { return undefined; }
        }))).filter((value): value is DailyAggregate => Boolean(value));
      } catch { return []; }
    },
    async summary() {
      await queued;
      const empty = { dir, files: 0, bytes: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, averageContextPercent: 0, maxContextPercent: 0, maskedObservations: 0, retrievalUtilization: 0, folds: 0, compactions: 0 };
      try {
        const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
        const sizes = await Promise.all(names.map(async name => (await stat(join(dir, name))).size));
        const aggregates = (await Promise.all(names.map(async name => {
          try { return JSON.parse(await readFile(join(dir, name), "utf8")) as DailyAggregate; } catch { return undefined; }
        }))).filter((value): value is DailyAggregate => Boolean(value?.version === 1));
        const turns = aggregates.reduce((sum, value) => sum + value.turns, 0);
        const contextSamples = aggregates.reduce((sum, value) => sum + value.context.samples, 0);
        const retrievalSamples = aggregates.reduce((sum, value) => sum + value.runtime.retrievalSamples, 0);
        return {
          dir, files: names.length, bytes: sizes.reduce((sum, size) => sum + size, 0), turns,
          inputTokens: aggregates.reduce((sum, value) => sum + value.tokens.input, 0),
          outputTokens: aggregates.reduce((sum, value) => sum + value.tokens.output, 0),
          cacheReadTokens: aggregates.reduce((sum, value) => sum + value.tokens.cacheRead, 0),
          cacheWriteTokens: aggregates.reduce((sum, value) => sum + value.tokens.cacheWrite, 0),
          costUsd: aggregates.reduce((sum, value) => sum + value.costUsd, 0),
          averageContextPercent: contextSamples ? aggregates.reduce((sum, value) => sum + value.context.percentSum, 0) / contextSamples : 0,
          maxContextPercent: Math.max(0, ...aggregates.map(value => value.context.maxPercent)),
          maskedObservations: aggregates.reduce((sum, value) => sum + value.runtime.maskedObservations, 0),
          retrievalUtilization: retrievalSamples ? aggregates.reduce((sum, value) => sum + value.runtime.retrievalUtilizationSum, 0) / retrievalSamples : 0,
          folds: aggregates.reduce((sum, value) => sum + value.runtime.folds, 0),
          compactions: aggregates.reduce((sum, value) => sum + value.compactions, 0),
        };
      } catch { return empty; }
    },
  };
}

function usageNumber(usage: any, ...keys: string[]): number {
  for (const key of keys) if (typeof usage?.[key] === "number") return usage[key];
  return 0;
}

export function formatVariantReport(aggregates: DailyAggregate[]): string {
  const variants = new Map<string, { turns: number; input: number; output: number; cacheRead: number; cost: number }>();
  for (const aggregate of aggregates) for (const [key, model] of Object.entries(aggregate.models ?? {})) {
    const current = variants.get(key) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    current.turns += model.turns ?? 0;
    current.input += model.tokens?.input ?? 0;
    current.output += model.tokens?.output ?? 0;
    current.cacheRead += model.tokens?.cacheRead ?? 0;
    current.cost += model.costUsd ?? 0;
    variants.set(key, current);
  }
  if (!variants.size) return "No model variant telemetry recorded.";
  return [...variants.entries()].sort((a, b) => b[1].turns - a[1].turns || a[0].localeCompare(b[0])).map(([key, value]) => {
    const logical = value.input + value.cacheRead;
    const hit = logical > 0 ? value.cacheRead / logical : 0;
    return `${key} · ${value.turns} turns · cache ${(hit * 100).toFixed(1)}% · in ${value.input} · out ${value.output} · cost ${value.cost.toFixed(4)}`;
  }).join("\n");
}

export default function passiveContextTelemetryExtension(pi: ExtensionAPI, options: StoreOptions = {}) {
  const configured = {
    ...options,
    retentionDays: options.retentionDays ?? Number(process.env.PI_CONTEXT_TELEMETRY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    maxBytes: options.maxBytes ?? Number(process.env.PI_CONTEXT_TELEMETRY_MAX_BYTES || DEFAULT_MAX_BYTES),
  };
  const store = createPassiveTelemetryStore(configured);
  let detachCompactionMetrics: (() => void) | undefined;
  let lastFoldId: string | undefined;
  let selectedProvider = "unknown";
  let selectedModel = "unknown";
  let thinkingLevel = "unknown";
  const currentVariant = (): ModelVariant => ({ provider: selectedProvider, model: selectedModel, thinking: thinkingLevel });
  pi.on("session_start", async (_event: any, ctx: any) => {
    thinkingLevel = String(pi.getThinkingLevel());
    if (!detachCompactionMetrics) detachCompactionMetrics = compactionMetricsChannel.attachStore(store);
    const model = ctx?.model;
    if (model) { selectedProvider = String(model.provider ?? selectedProvider); selectedModel = String(model.id ?? model.model ?? selectedModel); }
    await store.prune();
  });
  pi.on("model_select", async (event: any) => {
    selectedProvider = String(event.model?.provider ?? "unknown");
    selectedModel = String(event.model?.id ?? event.model?.model ?? event.model ?? "unknown");
  });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = String(event.level ?? "unknown"); });
  pi.on("message_end", async (event: any, ctx: any) => {
    if (event.message?.role !== "assistant") return;
    const usage = event.message.usage ?? {};
    const messageModel = event.message.model;
    const messageProvider = event.message.provider;
    if (messageProvider) selectedProvider = String(messageProvider?.id ?? messageProvider);
    if (messageModel) selectedModel = String(messageModel?.id ?? messageModel?.model ?? messageModel);
    const context = ctx.getContextUsage?.();
    const runtime = readContextRuntimeTelemetry();
    const folded = Boolean(runtime?.lastFold?.id && runtime.lastFold.id !== lastFoldId);
    if (runtime?.lastFold?.id) lastFoldId = runtime.lastFold.id;
    await store.record({
      inputTokens: usageNumber(usage, "input", "inputTokens", "input_tokens"),
      outputTokens: usageNumber(usage, "output", "outputTokens", "output_tokens"),
      cacheReadTokens: usageNumber(usage, "cacheRead", "cacheReadTokens", "cache_read_input_tokens"),
      cacheWriteTokens: usageNumber(usage, "cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"),
      costUsd: usage?.cost?.total,
      contextPercent: context?.percent,
      contextTokens: context?.tokens,
      contextWindow: context?.contextWindow,
      maskedObservations: runtime?.maskedObservations,
      retrievalUtilization: runtime?.retrieval.utilization,
      folded,
      modelVariant: currentVariant(),
    });
  });
  pi.on("session_before_compact", async () => { await compactionMetricsChannel.flush(); });
  pi.on("session_shutdown", async () => { await compactionMetricsChannel.flush(); detachCompactionMetrics?.(); detachCompactionMetrics = undefined; });
  pi.registerCommand("context-telemetry", {
    description: "Show, query models, or clear bounded anonymous context telemetry",
    handler: async (args, ctx) => {
      const command = String(args ?? "").trim();
      if (command === "clear") { await store.clear(); ctx.ui.notify("Context telemetry cleared.", "info"); return; }
      if (command === "models" || command.startsWith("models ")) { ctx.ui.notify(formatVariantReport(await store.aggregates()), "info"); return; }
      const summary = await store.summary();
      const logicalInput = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
      const cacheHit = logicalInput > 0 ? summary.cacheReadTokens / logicalInput : 0;
      ctx.ui.notify([
        `Context telemetry: ${summary.files} daily file(s), ${summary.bytes} bytes`,
        `${summary.turns} turn(s) · cache hit ${(cacheHit * 100).toFixed(1)}% · logical input ${logicalInput} (uncached ${summary.inputTokens}, cache write ${summary.cacheWriteTokens}) · output ${summary.outputTokens}`,
        `context avg ${summary.averageContextPercent.toFixed(1)}% max ${summary.maxContextPercent.toFixed(1)}% · masked ${summary.maskedObservations}`,
        `retrieval use ${(summary.retrievalUtilization * 100).toFixed(1)}% · folds ${summary.folds} · compactions ${summary.compactions} · cost ${summary.costUsd.toFixed(4)}`,
        summary.dir,
        `Retention: ${configured.retentionDays && configured.retentionDays > 0 ? `${configured.retentionDays} daily files` : "permanent"}; archive cap: ${configured.maxBytes && configured.maxBytes > 0 ? `${configured.maxBytes} bytes` : "unlimited"}`,
      ].join("\n"), "info");
    },
  });
}
