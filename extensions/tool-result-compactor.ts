import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

const DEFAULT_THRESHOLD = Number(process.env.PI_TOOL_RESULT_COMPACT_THRESHOLD ?? 6000);
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

function headTail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const head = Math.ceil(chars * 0.65);
  const tail = Math.floor(chars * 0.35);
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
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

async function storeResult(cwd: string, payload: Record<string, unknown>): Promise<{ id: string; path: string }> {
  const date = new Date().toISOString().slice(0, 10);
  const id = randomUUID();
  const relDir = join(".pi", "tool-results", date);
  const absDir = join(cwd, relDir);
  await mkdir(absDir, { recursive: true });
  const relPath = join(relDir, `${id}.json`);
  await writeFile(join(cwd, relPath), JSON.stringify({ ...payload, id }, null, 2), "utf8");
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
    if ((event as any).isError || (event as any).toolName === "inspect_tool_result") return;
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
    });

    return {
      content: [{ type: "text", text: compactedContentText((event as any).toolName, stored, compacted) }],
      details: {
        ...(event as any).details,
        compacted: true,
        resultId: stored.id,
        resultPath: stored.path,
        originalChars: compacted.originalChars,
      },
    };
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
