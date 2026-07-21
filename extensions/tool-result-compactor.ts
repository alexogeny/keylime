import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "./shared/json-store";
import { headTail } from "./shared/output-preview";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bypassGenericToolResultReduction, contextObjectKindForTool, reduceToolResultText } from "./shared/tool-result-reducers";
import { cleanupContextObjects, readStoredContextObject, storeContextObject } from "./context-object-store";
import { estimateDeterministicTokens, planRecoverableToolResultReduction, type TokenEstimator } from "./shared/tool-result-economics";

export interface CompactToolResultOptions {
  thresholdChars?: number;
  thresholdTokens?: number;
  previewChars?: number;
  maxSummaryLines?: number;
  estimateTokens?: TokenEstimator;
}

export interface CompactToolResult {
  shouldCompact: boolean;
  originalChars: number;
  originalTokens: number;
  compactedText: string;
  summary: string[];
}

const DEFAULT_THRESHOLD = Number(process.env.PI_TOOL_RESULT_COMPACT_THRESHOLD ?? 3500);
const DEFAULT_TOKEN_THRESHOLD = Number(process.env.PI_TOOL_RESULT_COMPACT_THRESHOLD_TOKENS ?? 900);
const DEFAULT_MINIMUM_TOKEN_SAVING = Number(process.env.PI_TOOL_RESULT_MIN_SAVINGS_TOKENS ?? 256);
const DEFAULT_PREVIEW = Number(process.env.PI_TOOL_RESULT_COMPACT_PREVIEW ?? 1400);
const DEFAULT_SUMMARY_LINES = 12;

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map(part => {
    if (typeof part?.text === "string") return part.text;
    return JSON.stringify(part);
  }).join("\n");
}

export function compactToolResultContent(content: any, options: CompactToolResultOptions = {}): CompactToolResult {
  const text = textFromContent(content);
  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD;
  const thresholdTokens = options.thresholdTokens ?? DEFAULT_TOKEN_THRESHOLD;
  const estimateTokens = options.estimateTokens ?? estimateDeterministicTokens;
  const originalTokens = estimateTokens(text);
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW;
  const maxSummaryLines = options.maxSummaryLines ?? DEFAULT_SUMMARY_LINES;
  const exceedsConfiguredThreshold = options.thresholdChars !== undefined
    ? text.length > threshold
    : text.length > threshold || originalTokens >= thresholdTokens;
  if (!exceedsConfiguredThreshold) {
    return { shouldCompact: false, originalChars: text.length, originalTokens, compactedText: text, summary: [] };
  }

  const interesting: string[] = [];
  const interestingPattern = /fail|error|exception|trace|warning|denied|blocked|changed|created|updated|deleted|match|result/i;
  let lineCount = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const rawEnd = newline === -1 ? text.length : newline;
    const end = rawEnd > lineStart && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    if (interesting.length < maxSummaryLines) {
      const line = text.slice(lineStart, end);
      if (interestingPattern.test(line)) interesting.push(line);
    }
    lineCount++;
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  const summary = [
    `Original output: ${text.length} chars, ${lineCount} lines`,
    ...interesting,
  ];
  return {
    shouldCompact: true,
    originalChars: text.length,
    originalTokens,
    compactedText: headTail(text, previewChars),
    summary,
  };
}

type ToolResultManifestEntry = {
  id: string;
  toolName: string;
  createdAt: string;
  path: string;
  originalChars: number;
  summary: string[];
};

const manifestCache = new Map<string, ToolResultManifestEntry[]>();
const ensuredResultDirs = new Set<string>();
let manifestDiskReads = 0;
let resultDirectoryCreates = 0;

async function readManifest(cwd: string): Promise<ToolResultManifestEntry[]> {
  const cached = manifestCache.get(cwd);
  if (cached) return [...cached];
  manifestDiskReads++;
  const entries = await readJsonFile<ToolResultManifestEntry[]>(join(cwd, ".pi", "tool-results", "index.json"), []);
  manifestCache.set(cwd, entries);
  return [...entries];
}

async function writeManifest(cwd: string, entries: ToolResultManifestEntry[]): Promise<void> {
  manifestCache.set(cwd, [...entries]);
  const path = join(cwd, ".pi", "tool-results", "index.json");
  await writeJsonFile(path, entries);
  await chmod(path, 0o600);
}

export function resetToolResultManifestCacheForTest(): void {
  manifestCache.clear();
  ensuredResultDirs.clear();
  manifestDiskReads = 0;
  resultDirectoryCreates = 0;
}

export function toolResultManifestStatsForTest(): { diskReads: number; directoryCreates: number } {
  return { diskReads: manifestDiskReads, directoryCreates: resultDirectoryCreates };
}

async function pruneMissingManifestEntries(cwd: string, entries: ToolResultManifestEntry[]): Promise<{ entries: ToolResultManifestEntry[]; pruned: number }> {
  const kept = entries.filter(entry => existsSync(join(cwd, entry.path)));
  if (kept.length !== entries.length) await writeManifest(cwd, kept);
  return { entries: kept, pruned: entries.length - kept.length };
}

async function cleanupToolResults(cwd: string, options: { maxAgeDays?: number; maxEntries?: number; maxBytes?: number; now?: string } = {}): Promise<{ kept: ToolResultManifestEntry[]; deleted: number; prunedMissing: number }> {
  const manifest = await readManifest(cwd);
  const existing = await pruneMissingManifestEntries(cwd, manifest);
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  const maxAgeDays = Math.max(0, options.maxAgeDays ?? 30);
  const maxEntries = Math.max(0, options.maxEntries ?? 300);
  const maxBytes = Math.max(0, options.maxBytes ?? 50_000_000);
  const cutoffMs = nowMs - maxAgeDays * 86_400_000;
  const sorted = [...existing.entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const kept: ToolResultManifestEntry[] = [];
  let keptBytes = 0;
  let deleted = 0;

  for (const entry of sorted) {
    const createdMs = Date.parse(entry.createdAt);
    const tooOld = Number.isFinite(createdMs) && createdMs < cutoffMs;
    const overEntries = kept.length >= maxEntries;
    const overBytes = keptBytes + entry.originalChars > maxBytes;
    if (tooOld || overEntries || overBytes) {
      await rm(join(cwd, entry.path), { force: true });
      deleted += 1;
      continue;
    }
    kept.push(entry);
    keptBytes += entry.originalChars;
  }
  await writeManifest(cwd, kept);
  return { kept, deleted, prunedMissing: existing.pruned };
}

async function storeResult(cwd: string, payload: Record<string, unknown>, summary: string[]): Promise<{ id: string; path: string }> {
  const date = new Date().toISOString().slice(0, 10);
  const id = typeof payload.contextObjectId === "string" ? payload.contextObjectId : randomUUID();
  const relDir = join(".pi", "tool-results", date);
  const absDir = join(cwd, relDir);
  if (!ensuredResultDirs.has(absDir)) {
    await mkdir(absDir, { recursive: true, mode: 0o700 });
    ensuredResultDirs.add(absDir);
    resultDirectoryCreates++;
  }
  const relPath = join(relDir, `${id}.json`);
  const createdAt = new Date().toISOString();
  await writeFile(join(cwd, relPath), JSON.stringify({ ...payload, id, createdAt }, null, 2), { encoding: "utf8", mode: 0o600 });
  const manifest = await readManifest(cwd);
  const nextManifest = [{ id, toolName: String(payload.toolName ?? "unknown"), createdAt, path: relPath, originalChars: Number(payload.originalChars ?? 0), summary }, ...manifest.filter(entry => entry.id !== id)];
  const kept = nextManifest.slice(0, 500);
  for (const orphan of nextManifest.slice(500)) await rm(join(cwd, orphan.path), { force: true });
  await writeManifest(cwd, kept);
  return { id, path: relPath };
}

export async function storeResultForTest(cwd: string, text: string): Promise<{ id: string; path: string }> {
  return storeResult(cwd, { toolName: "test", content: [{ type: "text", text }], originalChars: text.length }, []);
}

function compactedContentText(toolName: string, stored: { id: string; path: string }, compacted: CompactToolResult, contextObjectId = stored.id): string {
  return [
    `Tool result compacted for ${toolName}.`,
    `result_id: ${stored.id}`,
    `stored_at: ${stored.path}`,
    `original_chars: ${compacted.originalChars}`,
    "",
    "Summary:",
    ...compacted.summary.map(line => `- ${line}`),
    "",
    "Preview:",
    compacted.compactedText,
    "",
    `Use inspect_context_object(object_id="${contextObjectId}") for verified bounded recovery, or inspect_tool_result(result_id="${stored.id}") for legacy full-result compatibility.`,
  ].join("\n");
}

export default function toolResultCompactor(pi: ExtensionAPI) {
  let currentTaskText = "";
  pi.on("input", async (event) => {
    currentTaskText = (event as any).text ?? "";
  });
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    await cleanupToolResults(cwd).catch(() => undefined);
    await cleanupContextObjects(cwd, { maxAgeDays: 30, maxEntries: 300 }).catch(() => undefined);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (bypassGenericToolResultReduction({
      toolName: (event as any).toolName,
      isError: Boolean((event as any).isError),
    })) return;
    const cwd = ctx.cwd ?? process.cwd();
    const toolName = (event as any).toolName;
    // inspect_lines already enforces a strict line window. Recompacting it makes
    // the caller spend another model/tool round trip to recover the exact range.
    if (toolName === "inspect_lines") return;
    const originalText = textFromContent((event as any).content);
    const kind = contextObjectKindForTool(toolName);
    const reduced = reduceToolResultText(toolName, originalText, { maxChars: DEFAULT_PREVIEW, query: currentTaskText });
    let contextStored: Awaited<ReturnType<typeof storeContextObject>> | undefined;
    if (kind === "file_read") {
      contextStored = await storeContextObject(cwd, {
        id: randomUUID(),
        kind,
        sourceTool: toolName,
        toolCallId: (event as any).toolCallId,
        content: originalText,
        summary: reduced.summary,
        retention: "foldable",
        sections: reduced.sections,
      });
      if (contextStored.deduplicated) {
        return {
          content: [{ type: "text", text: `[context-object: duplicate file read folded — inspect_context_object(object_id="${contextStored.object.id}") for verified recovery]` }],
          details: { ...(event as any).details, folded: true, contextObjectId: contextStored.object.id, originalChars: originalText.length },
          isError: false,
        };
      }
    }
    const compacted = compactToolResultContent((event as any).content);
    if (!compacted.shouldCompact) return;
    const contextObjectId = contextStored?.object.id ?? randomUUID();
    const economics = planRecoverableToolResultReduction({
      originalText,
      reducedText: reduced.activeText,
      recoverableObjectId: contextObjectId,
      expectedFutureUses: 1,
      minimumActiveTokensSaved: DEFAULT_MINIMUM_TOKEN_SAVING,
    });
    if (economics.decision !== "compact") return;

    const typedCompacted: CompactToolResult = {
      ...compacted,
      compactedText: reduced.activeText,
      summary: [reduced.summary],
    };
    contextStored ??= await storeContextObject(cwd, {
      id: contextObjectId,
      kind,
      sourceTool: toolName,
      toolCallId: (event as any).toolCallId,
      content: originalText,
      summary: reduced.summary,
      retention: "foldable",
      sections: reduced.sections,
    });
    const stored = await storeResult(cwd, {
      toolName,
      toolCallId: (event as any).toolCallId,
      contextObjectId: contextStored.object.id,
      originalChars: compacted.originalChars,
      createdAt: new Date().toISOString(),
    }, typedCompacted.summary);

    return {
      content: [{ type: "text", text: compactedContentText(toolName, stored, typedCompacted, contextStored.object.id) }],
      details: {
        ...(event as any).details,
        compacted: true,
        resultId: stored.id,
        contextObjectId: contextStored.object.id,
        resultPath: stored.path,
        originalChars: compacted.originalChars,
        originalTokens: compacted.originalTokens,
        activeTokensSaved: economics.activeTokensSaved,
        uncachedTokensSaved: economics.uncachedTokensSaved,
        auxiliaryModelCalls: economics.auxiliaryModelCalls,
      },
      isError: (event as any).isError,
    };
  });

  pi.registerTool({
    name: "list_tool_results",
    label: "List Tool Results",
    description: "List compacted tool-result metadata without loading full raw payloads.",
    promptSnippet: "List compacted tool outputs",
    promptGuidelines: ["Use to find a compacted result id before inspecting full output."],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Maximum results" })),
      tool_name: Type.Optional(Type.String({ description: "Filter by tool name" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const manifest = await readManifest(cwd);
      const pruned = await pruneMissingManifestEntries(cwd, manifest);
      const entries = pruned.entries
        .filter(entry => !params.tool_name || entry.toolName === params.tool_name)
        .slice(0, Math.min(params.limit ?? 20, 100));
      const text = entries.length
        ? entries.map(entry => `${entry.id} ${entry.toolName} ${entry.originalChars} chars ${entry.createdAt}\n  ${entry.summary.slice(0, 2).join("\n  ")}`).join("\n")
        : "No compacted tool results found.";
      return { content: [{ type: "text", text }], details: { results: entries, prunedMissing: pruned.pruned } };
    },
  });

  pi.registerTool({
    name: "cleanup_tool_results",
    label: "Cleanup Tool Results",
    description: "Prune compacted tool-result payloads and manifest entries by age, count, or approximate stored output size.",
    promptSnippet: "Cleanup compacted tool outputs",
    promptGuidelines: ["Use when .pi/tool-results is stale or too large; reports deletions without loading payloads."],
    parameters: Type.Object({
      max_age_days: Type.Optional(Type.Number({ minimum: 0, description: "Delete entries older than this many days" })),
      max_entries: Type.Optional(Type.Number({ minimum: 0, maximum: 1000, description: "Keep at most this many newest entries" })),
      max_bytes: Type.Optional(Type.Number({ minimum: 0, description: "Approximate maximum original output chars/bytes to keep" })),
      now: Type.Optional(Type.String({ description: "Testing override ISO timestamp" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await cleanupToolResults(ctx?.cwd ?? process.cwd(), {
        maxAgeDays: params.max_age_days,
        maxEntries: params.max_entries,
        maxBytes: params.max_bytes,
        now: params.now,
      });
      const text = `Deleted ${result.deleted} compacted tool result${result.deleted === 1 ? "" : "s"}; pruned ${result.prunedMissing} missing manifest entr${result.prunedMissing === 1 ? "y" : "ies"}; kept ${result.kept.length}.`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "inspect_tool_result",
    label: "Inspect Tool Result",
    description: "Retrieve a full compacted tool result by result_id, with optional character cap.",
    promptSnippet: "Retrieve compacted tool output",
    promptGuidelines: [
      "Use only when the compact summary/preview is insufficient.",
      "Prefer small max_chars windows to avoid re-polluting context.",
    ],
    parameters: Type.Object({
      result_id: Type.String({ description: "Compacted result id" }),
      max_chars: Type.Optional(Type.Number({ minimum: 500, maximum: 50000, description: "Maximum characters to return" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const base = join(ctx?.cwd ?? process.cwd(), ".pi", "tool-results");
      const max = Math.min(params.max_chars ?? 12000, 50000);
      // Result ids are UUIDs; reject path-like input before scanning date dirs.
      if (!/^[0-9a-f-]{20,}$/i.test(params.result_id)) throw new Error("Invalid result_id");
      const dates = existsSync(base) ? await readdir(base) : [];
      for (const date of dates) {
        const candidate = join(base, date, `${params.result_id}.json`);
        if (!existsSync(candidate)) continue;
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw);
        const resolved = parsed.contextObjectId ? JSON.stringify({ ...parsed, content: (await readStoredContextObject(ctx?.cwd ?? process.cwd(), String(parsed.contextObjectId))).content }, null, 2) : raw;
        const text = resolved.length > max ? `${resolved.slice(0, max)}\n…\n[truncated ${resolved.length - max} chars]` : resolved;
        return { content: [{ type: "text", text }], details: { resultId: params.result_id, chars: resolved.length } };
      }
      throw new Error(`No compacted tool result found for id: ${params.result_id}`);
    },
  });
}
