import { createHash } from "node:crypto";

export type ContextCategory =
  | "system"
  | "tool_schema"
  | "tool_guideline"
  | "turn_provider"
  | "history"
  | "tool_result"
  | "memory"
  | "compaction";

export type ContextTransformKind = "dedupe" | "reduce" | "fold" | "mask" | "prune" | "compact";

export type ContextTransform = {
  id: string;
  kind: ContextTransformKind;
  sourceId?: string;
  beforeChars: number;
  afterChars: number;
  recoverable: boolean;
  reason: string;
};

export type ContextPart = {
  category: ContextCategory;
  text: string;
};

export type ContextCategorySummary = {
  categories: Partial<Record<ContextCategory, { chars: number; tokens?: number }>>;
  totalChars: number;
};

export type ContextLedgerRecord = {
  version: 1;
  ts: number;
  turnIndex?: number;
  modelId?: string;
  provider?: string;
  activeToolFingerprint: string;
  categories: Partial<Record<ContextCategory, { chars: number; tokens?: number }>>;
  totalChars: number;
  transforms: ContextTransform[];
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type BuildContextLedgerRecordInput = {
  ts: number;
  turnIndex?: number;
  modelId?: string;
  provider?: string;
  activeToolNames: string[];
  parts: ContextPart[];
  transforms: ContextTransform[];
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export function contextFingerprint(values: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()))
    .digest("hex");
}

export function summarizeContextCategories(parts: ContextPart[]): ContextCategorySummary {
  const categories: ContextCategorySummary["categories"] = {};
  let totalChars = 0;
  for (const part of parts) {
    const chars = part.text.length;
    totalChars += chars;
    const current = categories[part.category]?.chars ?? 0;
    categories[part.category] = { chars: current + chars };
  }
  return { categories, totalChars };
}

export function buildContextLedgerRecord(input: BuildContextLedgerRecordInput): ContextLedgerRecord {
  const summary = summarizeContextCategories(input.parts);
  return {
    version: 1,
    ts: input.ts,
    turnIndex: input.turnIndex,
    modelId: input.modelId,
    provider: input.provider,
    activeToolFingerprint: contextFingerprint(input.activeToolNames),
    categories: summary.categories,
    totalChars: summary.totalChars,
    transforms: input.transforms.map(transform => ({ ...transform })),
    ...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: input.cacheReadTokens }),
    ...(input.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: input.cacheWriteTokens }),
  };
}

export function summarizeContextLedger(records: ContextLedgerRecord[]): {
  requestCount: number;
  activeChars: number;
  removedChars: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  let activeChars = 0;
  let removedChars = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const record of records) {
    activeChars += record.totalChars;
    cacheReadTokens += record.cacheReadTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    for (const transform of record.transforms) {
      removedChars += Math.max(0, transform.beforeChars - transform.afterChars);
    }
  }
  return { requestCount: records.length, activeChars, removedChars, cacheReadTokens, cacheWriteTokens };
}
