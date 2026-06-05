import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "./shared/json-store";
import { headTail } from "./shared/output-preview";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface CompactToolResultOptions {
  thresholdChars?: number;
  previewChars?: number;
  maxSummaryLines?: number;
}

export interface CompactToolResult {
  shouldCompact: boolean;
  originalChars: number;
  compactedText: string;
  summary: string[];
}

const DEFAULT_THRESHOLD = Number(process.env.PI_TOOL_RESULT_COMPACT_THRESHOLD ?? 3500);
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
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW;
  const maxSummaryLines = options.maxSummaryLines ?? DEFAULT_SUMMARY_LINES;
  if (text.length <= threshold) {
    return { shouldCompact: false, originalChars: text.length, compactedText: text, summary: [] };
  }

  const lines = text.split(/\r?\n/);
  const interesting = lines.filter(line =>
    /fail|error|exception|trace|warning|denied|blocked|changed|created|updated|deleted|match|result/i.test(line)
  ).slice(0, maxSummaryLines);
  const summary = [
    `Original output: ${text.length} chars, ${lines.length} lines`,
    ...interesting,
  ];
  return {
    shouldCompact: true,
    originalChars: text.length,
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

async function readManifest(cwd: string): Promise<ToolResultManifestEntry[]> {
  return readJsonFile(join(cwd, ".pi", "tool-results", "index.json"), []);
}

async function writeManifest(cwd: string, entries: ToolResultManifestEntry[]): Promise<void> {
  await writeJsonFile(join(cwd, ".pi", "tool-results", "index.json"), entries);
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
  const id = randomUUID();
  const relDir = join(".pi", "tool-results", date);
  const absDir = join(cwd, relDir);
  await mkdir(absDir, { recursive: true });
  const relPath = join(relDir, `${id}.json`);
  const createdAt = new Date().toISOString();
  await writeFile(join(cwd, relPath), JSON.stringify({ ...payload, id, createdAt }, null, 2), "utf8");
  const manifest = await readManifest(cwd);
  manifest.unshift({ id, toolName: String(payload.toolName ?? "unknown"), createdAt, path: relPath, originalChars: Number(payload.originalChars ?? 0), summary });
  await writeManifest(cwd, manifest.slice(0, 500));
  return { id, path: relPath };
}

function compactedContentText(toolName: string, stored: { id: string; path: string }, compacted: CompactToolResult): string {
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
    `Use inspect_tool_result(result_id="${stored.id}") to retrieve the full stored result if needed.`,
  ].join("\n");
}

export default function toolResultCompactor(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if ((event as any).toolName === "inspect_tool_result") return;
    const compacted = compactToolResultContent((event as any).content);
    if (!compacted.shouldCompact) return;

    const stored = await storeResult(ctx.cwd ?? process.cwd(), {
      toolName: (event as any).toolName,
      toolCallId: (event as any).toolCallId,
      input: (event as any).input,
      content: (event as any).content,
      details: (event as any).details,
      originalChars: compacted.originalChars,
      createdAt: new Date().toISOString(),
    }, compacted.summary);

    return {
      content: [{ type: "text", text: compactedContentText((event as any).toolName, stored, compacted) }],
      details: {
        ...(event as any).details,
        compacted: true,
        resultId: stored.id,
        resultPath: stored.path,
        originalChars: compacted.originalChars,
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
    async execute(_id, params) {
      const manifest = await readManifest(process.cwd());
      const pruned = await pruneMissingManifestEntries(process.cwd(), manifest);
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
    async execute(_id, params) {
      const result = await cleanupToolResults(process.cwd(), {
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
    async execute(_id, params) {
      const base = join(process.cwd(), ".pi", "tool-results");
      const max = Math.min(params.max_chars ?? 12000, 50000);
      // Result ids are UUIDs; reject path-like input before scanning date dirs.
      if (!/^[0-9a-f-]{20,}$/i.test(params.result_id)) throw new Error("Invalid result_id");
      const dates = existsSync(base) ? await readdir(base) : [];
      for (const date of dates) {
        const candidate = join(base, date, `${params.result_id}.json`);
        if (!existsSync(candidate)) continue;
        const raw = await readFile(candidate, "utf8");
        const text = raw.length > max ? `${raw.slice(0, max)}\n…\n[truncated ${raw.length - max} chars]` : raw;
        return { content: [{ type: "text", text }], details: { resultId: params.result_id, chars: raw.length } };
      }
      throw new Error(`No compacted tool result found for id: ${params.result_id}`);
    },
  });
}
