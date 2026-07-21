import { createHash } from "node:crypto";

export type ContextObjectKind =
  | "file_read"
  | "repo_search"
  | "test_run"
  | "diagnostic_run"
  | "mutation"
  | "research"
  | "memory_recall"
  | "table"
  | "generic";

export type ContextObjectRetention = "pinned" | "foldable" | "maskable" | "reconstructable";

export type ContextObjectSection = {
  startLine: number;
  endLine: number;
};

export type ContextObject = {
  version: 1;
  id: string;
  kind: ContextObjectKind;
  sourceTool: string;
  toolCallId?: string;
  createdAt: string;
  originalChars: number;
  contentHash: string;
  retention: ContextObjectRetention;
  summary: string;
  sections: Record<string, ContextObjectSection>;
  dependencies: string[];
};

export type CreateContextObjectInput = {
  id: string;
  kind: ContextObjectKind;
  sourceTool: string;
  toolCallId?: string;
  content: string;
  summary: string;
  retention: ContextObjectRetention;
  sections?: Record<string, ContextObjectSection>;
  dependencies?: string[];
  createdAt?: string;
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateSection(section: ContextObjectSection): void {
  if (!Number.isInteger(section.startLine) || !Number.isInteger(section.endLine)
    || section.startLine < 1 || section.endLine < section.startLine) {
    throw new Error("Line range must use positive, ordered line numbers");
  }
}

export function createContextObject(input: CreateContextObjectInput): ContextObject {
  for (const section of Object.values(input.sections ?? {})) validateSection(section);
  return {
    version: 1,
    id: input.id,
    kind: input.kind,
    sourceTool: input.sourceTool,
    toolCallId: input.toolCallId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    originalChars: input.content.length,
    contentHash: contentHash(input.content),
    retention: input.retention,
    summary: input.summary,
    sections: { ...(input.sections ?? {}) },
    dependencies: [...(input.dependencies ?? [])],
  };
}

export function verifyContextObjectContent(object: ContextObject, content: string): boolean {
  return object.originalChars === content.length && object.contentHash === contentHash(content);
}

export function selectContextObjectText(
  object: ContextObject,
  content: string,
  selector: { section?: string; lines?: { start: number; end: number } },
): string {
  if (!verifyContextObjectContent(object, content)) throw new Error(`Context object ${object.id} hash mismatch`);
  let range: ContextObjectSection | undefined;
  if (selector.section) {
    range = object.sections[selector.section];
    if (!range) throw new Error(`Unknown context object section: ${selector.section}`);
  } else if (selector.lines) {
    range = { startLine: selector.lines.start, endLine: selector.lines.end };
  }
  if (!range) return content;
  validateSection(range);
  const lines = content.split("\n");
  if (range.startLine > lines.length) return `[requested start line ${range.startLine}; context object has ${lines.length} lines]`;
  const endLine = Math.min(range.endLine, lines.length);
  return lines
    .slice(range.startLine - 1, endLine)
    .map((line, index) => `${range!.startLine + index} | ${line}`)
    .join("\n");
}
