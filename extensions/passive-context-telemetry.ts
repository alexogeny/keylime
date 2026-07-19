import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { getLastContextRuntimeSnapshot } from "./context-runtime";

export const DEFAULT_CONTEXT_TELEMETRY_DIR = join(homedir(), ".pi", "data", "keylime-context-telemetry");
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_BYTES = 256 * 1024;

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
};

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
  };
}

async function safeRead(path: string, fallback: DailyAggregate): Promise<DailyAggregate> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.version === 1 ? parsed as DailyAggregate : fallback;
  } catch { return fallback; }
}

export function createPassiveTelemetryStore(options: StoreOptions = {}) {
  const dir = options.dir ?? DEFAULT_CONTEXT_TELEMETRY_DIR;
  const retentionDays = Math.max(1, Math.min(90, Math.floor(options.retentionDays ?? DEFAULT_RETENTION_DAYS)));
  const maxBytes = Math.max(1_024, Math.min(10 * 1024 * 1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES)));
  const now = options.now ?? (() => new Date());
  let queued = Promise.resolve();
  const cache = new Map<string, DailyAggregate>();

  const atomicWrite = async (path: string, aggregate: DailyAggregate): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(aggregate)}\n`, { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => {});
  };

  const pruneNow = async (): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const names = (await readdir(dir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const remove = new Set(names.slice(0, Math.max(0, names.length - retentionDays)));
    for (const name of remove) { await rm(join(dir, name), { force: true }); cache.delete(name.slice(0, 10)); }
    const kept = names.filter(name => !remove.has(name));
    const entries = await Promise.all(kept.map(async name => ({ name, size: (await stat(join(dir, name))).size })));
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      await rm(join(dir, entry.name), { force: true });
      cache.delete(entry.name.slice(0, 10));
      total -= entry.size;
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queued.then(work, work);
    queued = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    dir,
    record(sample: TelemetrySample): Promise<void> {
      return enqueue(async () => {
        const timestamp = now();
        const day = dayOf(timestamp);
        const path = join(dir, `${day}.json`);
        const aggregate = cache.get(day) ?? await safeRead(path, blank(day, timestamp));
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
        cache.set(day, aggregate);
        await atomicWrite(path, aggregate);
        if (aggregate.turns === 1 || aggregate.turns % 50 === 0) await pruneNow();
      });
    },
    recordCompaction(): Promise<void> {
      return enqueue(async () => {
        const timestamp = now(); const day = dayOf(timestamp); const path = join(dir, `${day}.json`);
        const aggregate = cache.get(day) ?? await safeRead(path, blank(day, timestamp));
        aggregate.updatedAt = timestamp.toISOString(); aggregate.compactions++; cache.set(day, aggregate);
        await atomicWrite(path, aggregate);
      });
    },
    prune(): Promise<void> { return enqueue(pruneNow); },
    clear(): Promise<void> { return enqueue(async () => { await rm(dir, { recursive: true, force: true }); cache.clear(); }); },
    async summary(): Promise<{ dir: string; files: number; bytes: number }> {
      await queued;
      try {
        const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
        const sizes = await Promise.all(names.map(async name => (await stat(join(dir, name))).size));
        return { dir, files: names.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
      } catch { return { dir, files: 0, bytes: 0 }; }
    },
  };
}

function usageNumber(usage: any, ...keys: string[]): number {
  for (const key of keys) if (typeof usage?.[key] === "number") return usage[key];
  return 0;
}

export default function passiveContextTelemetryExtension(pi: ExtensionAPI, options: StoreOptions = {}) {
  const configured = {
    ...options,
    retentionDays: options.retentionDays ?? Number(process.env.PI_CONTEXT_TELEMETRY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    maxBytes: options.maxBytes ?? Number(process.env.PI_CONTEXT_TELEMETRY_MAX_BYTES || DEFAULT_MAX_BYTES),
  };
  const store = createPassiveTelemetryStore(configured);
  let lastFoldId: string | undefined;
  pi.on("session_start", async () => { await store.prune(); });
  pi.on("message_end", async (event: any, ctx: any) => {
    if (event.message?.role !== "assistant") return;
    const usage = event.message.usage ?? {};
    const context = ctx.getContextUsage?.();
    const runtime = getLastContextRuntimeSnapshot();
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
    });
  });
  pi.on("session_before_compact", async () => { await store.recordCompaction(); });
  pi.registerCommand("context-telemetry", {
    description: "Show or clear bounded anonymous context telemetry",
    handler: async (args, ctx) => {
      if (String(args ?? "").trim() === "clear") { await store.clear(); ctx.ui.notify("Context telemetry cleared.", "info"); return; }
      const summary = await store.summary();
      ctx.ui.notify(`Context telemetry: ${summary.files} daily file(s), ${summary.bytes} bytes\n${summary.dir}\nRetention: ${configured.retentionDays} days; hard cap: ${configured.maxBytes} bytes`, "info");
    },
  });
}
