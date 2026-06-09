import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "./shared/schema";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { repoRelativePath } from "./shared/path-policy";
import {
  formatPlanPreview,
  inspectCodeStructure,
  inspectTextMatches,
  isProbablyBinary,
  matchesGlob,
  matchesLanguage,
  planReplacement,
  resolveSafePath,
  shouldExcludePath,
  summarizePlan,
  type Language,
  type ReplacementEdit,
  type ReplacementPlan,
} from "./shared/code-primitives";
import { classifyToolMutation } from "./shared/safety-policy";
import { SOURCE_MUTATION_GUIDELINES } from "./shared/coding-contract";

const CREATE_FILE_MAX_BYTES = 32 * 1024;
const FILE_WRITE_MAX_CHUNK_BYTES = 16 * 1024;
const FILE_WRITE_SESSION_TTL_MS = 60 * 60 * 1000;

type FileWriteSession = {
  cwd: string;
  path: string;
  rel: string;
  tmpPath: string;
  nextIndex: number;
  bytes: number;
  newline: "preserve" | "ensure_final";
  createdAt: number;
};

const fileWriteSessions = new Map<string, FileWriteSession>();

async function pruneExpiredFileWriteSessions(now = Date.now()): Promise<void> {
  await Promise.all([...fileWriteSessions.entries()].map(async ([handle, session]) => {
    if (now - session.createdAt <= FILE_WRITE_SESSION_TTL_MS) return;
    await rm(session.tmpPath, { force: true });
    fileWriteSessions.delete(handle);
  }));
}

async function readTextFileSafely(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const buffer = await readFile(path);
  if (isProbablyBinary(buffer)) throw new Error(`Refusing to read probable binary file: ${path}`);
  return buffer.toString("utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function normalizeCreatedContent(content: string, newline: "preserve" | "ensure_final"): string {
  if (newline === "preserve" || content.endsWith("\n")) return content;
  return `${content}\n`;
}

function compactFilePreview(content: string): string {
  const lines = content.split("\n");
  const preview = lines.length <= 8
    ? lines
    : [...lines.slice(0, 4), "…", ...lines.slice(-3)];
  return preview.map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`).join("\n");
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const rel = repoRelativePath(root, path);
    if (shouldExcludePath(rel)) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function collectTargetFiles(cwd: string, options: { file_glob?: string; language?: Language; exclude_globs?: string[] }): Promise<string[]> {
  if (!options.file_glob && !options.language) return [];
  const all = await walkFiles(cwd);
  return all.filter(path => {
    const rel = repoRelativePath(cwd, path);
    if (shouldExcludePath(rel, options.exclude_globs)) return false;
    if (options.file_glob && !matchesGlob(rel, options.file_glob)) return false;
    if (!matchesLanguage(rel, options.language)) return false;
    return true;
  });
}

type ListedEntry = { path: string; type: "file" | "dir"; bytes?: number };

async function listEntries(cwd: string, options: {
  path?: string;
  recursive?: boolean;
  include_dirs?: boolean;
  file_glob?: string;
  language?: Language;
  exclude_globs?: string[];
  max_results?: number;
}): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const root = resolveSafePath(cwd, options.path ?? ".");
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Not a directory: ${options.path ?? "."}`);
  const maxResults = Math.min(Math.max(1, options.max_results ?? 200), 1000);
  const recursive = options.recursive ?? true;
  const includeDirs = options.include_dirs ?? false;
  const entries: ListedEntry[] = [];
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    const dirents = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirents) {
      if (truncated) return;
      const fsPath = `${dir}/${entry.name}`;
      const rel = repoRelativePath(cwd, fsPath);
      if (shouldExcludePath(rel, options.exclude_globs)) continue;
      if (entry.isDirectory()) {
        if (includeDirs && (!options.file_glob || matchesGlob(rel, options.file_glob))) entries.push({ path: rel, type: "dir" });
        if (entries.length >= maxResults) { truncated = true; return; }
        if (recursive) await visit(fsPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.file_glob && !matchesGlob(rel, options.file_glob)) continue;
      if (!matchesLanguage(rel, options.language)) continue;
      entries.push({ path: rel, type: "file", bytes: (await stat(fsPath)).size });
      if (entries.length >= maxResults) { truncated = true; return; }
    }
  }

  await visit(root);
  return { entries, truncated };
}

function inspectJsonValue(value: unknown, pathExpression?: string): unknown {
  if (!pathExpression || pathExpression === "$" || pathExpression === ".") return value;
  const parts = pathExpression.replace(/^\$?\.?/, "").split(".").filter(Boolean);
  let current: unknown = value;
  for (const rawPart of parts) {
    const match = /^(?<key>[^\[\]]+)?(?:\[(?<index>\d+|\*)\])?$/.exec(rawPart);
    if (!match?.groups) throw new Error(`Unsupported json_path segment: ${rawPart}`);
    const key = match.groups.key;
    const index = match.groups.index;
    if (key) {
      if (Array.isArray(current)) current = current.map(item => item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined);
      else current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    }
    if (index === "*") {
      if (!Array.isArray(current)) throw new Error(`json_path segment ${rawPart} expected an array`);
    } else if (index !== undefined) {
      if (!Array.isArray(current)) throw new Error(`json_path segment ${rawPart} expected an array`);
      current = current[Number(index)];
    }
  }
  return current;
}

function omitJsonKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => omitJsonKeys(item, keys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !keys.has(key))
    .map(([key, child]) => [key, omitJsonKeys(child, keys)]));
}

function compactJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [truncated to ${maxChars} chars]`;
}

type PlannedReplacement = {
  fsPath: string;
  plan: ReplacementPlan;
};

function relativePath(cwd: string, path: string): string {
  return repoRelativePath(cwd, path);
}

async function planCodeReplacements(cwd: string, edits: ReplacementEdit[], targets: string[]): Promise<PlannedReplacement[]> {
  const plannedByPath = new Map<string, PlannedReplacement>();

  for (const [index, rawEdit] of edits.entries()) {
    const paths = rawEdit.path ? [resolveSafePath(cwd, rawEdit.path)] : targets;
    if (paths.length === 0) throw new Error(`Edit ${index + 1}: no target files; provide path, file_glob, or language`);
    for (const fsPath of paths) {
      const relPath = relativePath(cwd, fsPath);
      try {
        const existing = plannedByPath.get(fsPath);
        const before = existing?.plan.before ?? await readTextFileSafely(fsPath);
        const current = existing?.plan.after ?? before;
        const step = planReplacement(current, { ...rawEdit, path: relPath });
        plannedByPath.set(fsPath, {
          fsPath,
          plan: {
            path: relPath,
            before,
            after: step.after,
            replacements: (existing?.plan.replacements ?? 0) + step.replacements,
            previews: [...(existing?.plan.previews ?? []), ...step.previews].slice(0, 5),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Edit ${index + 1} failed for ${relPath}: ${message}`);
      }
    }
  }

  return [...plannedByPath.values()];
}

export default function codePrimitivesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_files",
    label: "List Files",
    description: "List repository files/directories with glob, language, recursion, exclude, and result caps. Use instead of ls/find.",
    promptSnippet: "List files/directories",
    promptGuidelines: [
      "Use instead of bash ls/find for repository file discovery.",
      "Use file_glob/language/exclude_globs to narrow results before inspecting content.",
      "Keep max_results bounded; follow with code_search, inspect_text_matches, or inspect_lines as needed.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path" })),
      recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories" })),
      include_dirs: Type.Optional(Type.Boolean({ description: "Include directories" })),
      file_glob: Type.Optional(Type.String({ description: "Only paths matching glob(s)" })),
      language: Type.Optional(stringEnum(["typescript", "javascript", "python", "rust"] as const)),
      exclude_globs: Type.Optional(Type.Array(Type.String(), { description: "Extra excludes" })),
      max_results: Type.Optional(Type.Number({ description: "Result cap, max 1000" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { entries, truncated } = await listEntries(ctx.cwd, {
        path: params.path,
        recursive: params.recursive,
        include_dirs: params.include_dirs,
        file_glob: params.file_glob,
        language: params.language as Language | undefined,
        exclude_globs: params.exclude_globs,
        max_results: params.max_results,
      });
      const lines = entries.map(entry => entry.type === "dir" ? `${entry.path}/` : `${entry.path}${entry.bytes === undefined ? "" : ` (${entry.bytes} bytes)`}`);
      const header = `list_files: ${entries.length}${truncated ? "+" : ""} result${entries.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`;
      return { content: [{ type: "text", text: [header, ...lines].join("\n") }], details: { entries, truncated } };
    },
  });

  pi.registerTool({
    name: "inspect_json",
    label: "Inspect JSON",
    description: "Inspect/project a JSON file safely. Supports simple dot paths, array indexes, wildcard array projection, omitted keys, output caps, and explicit read-only absolute-path inspection outside cwd.",
    promptSnippet: "Inspect/query JSON",
    promptGuidelines: [
      "Use instead of jq, cat, or read when inspecting JSON files.",
      "Use json_path to project small subtrees and omit_keys for bulky fields like embeddings.",
      "Keep max_chars bounded; ask for a narrower json_path if output is truncated.",
      "Set allow_outside_cwd=true only for explicit read-only JSON inspection outside cwd.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "JSON file path" }),
      json_path: Type.Optional(Type.String({ description: "Simple path, e.g. profile.body or memories[0].content or memories.* via memories[*]" })),
      omit_keys: Type.Optional(Type.Array(Type.String(), { description: "Keys to omit recursively" })),
      max_chars: Type.Optional(Type.Number({ description: "Output character cap" })),
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only inspection of absolute/outside-cwd JSON paths only when explicitly requested" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = params.allow_outside_cwd
        ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
        : resolveSafePath(ctx.cwd, params.path);
      const raw = await readTextFileSafely(path);
      const parsed = JSON.parse(raw);
      const projected = inspectJsonValue(parsed, params.json_path);
      const omitted = omitJsonKeys(projected, new Set(params.omit_keys ?? ["embedding"]));
      const maxChars = Math.min(Math.max(200, params.max_chars ?? 12000), 50000);
      return {
        content: [{ type: "text", text: compactJson(omitted, maxChars) }],
        details: { path: relativePath(ctx.cwd, path), json_path: params.json_path ?? "$", omittedKeys: params.omit_keys ?? ["embedding"] },
      };
    },
  });

  pi.registerTool({
    name: "inspect_text_matches",
    label: "Inspect Text Matches",
    description: "Find text or regex matches in one or more files with line/context output.",
    promptSnippet: "Inspect file text matches",
    promptGuidelines: [
      "Use instead of bash grep/rg.",
      "Use before broad replacements.",
      "Use to locate exact oldText before applying source-code edits.",
      "Prefer this over read when locating code context.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "File path" })),
      file_glob: Type.Optional(Type.String({ description: "Target glob" })),
      language: Type.Optional(stringEnum(["typescript", "javascript", "python", "rust"] as const)),
      exclude_globs: Type.Optional(Type.Array(Type.String(), { description: "Extra excludes" })),
      query: Type.String({ description: "Text or regex" }),
      regex: Type.Optional(Type.Boolean({ description: "Regex mode" })),
      case_sensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive" })),
      context_lines: Type.Optional(Type.Number({ description: "Context lines" })),
      max_matches: Type.Optional(Type.Number({ description: "Max matches" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const targets = params.path
        ? [resolveSafePath(ctx.cwd, params.path)]
        : await collectTargetFiles(ctx.cwd, {
          file_glob: params.file_glob,
          language: params.language as Language | undefined,
          exclude_globs: params.exclude_globs,
        });
      if (targets.length === 0) throw new Error(`No target files; provide path, file_glob, or language`);

      const blocks = [];
      const details = [];
      for (const path of targets) {
        const rel = repoRelativePath(ctx.cwd, path);
        const text = await readTextFileSafely(path);
        const matches = inspectTextMatches(text, {
          query: params.query,
          regex: params.regex,
          caseSensitive: params.case_sensitive,
          contextLines: params.context_lines,
          maxMatches: params.max_matches,
        });
        details.push({ path: rel, count: matches.length, matches });
        blocks.push(...matches.flatMap(match => [
          `${rel}:${match.line}:${match.column} ${match.text}`,
          ...match.before.map(line => `  ${line}`),
          `> ${match.lineText}`,
          ...match.after.map(line => `  ${line}`),
        ]));
      }

      const count = details.reduce((total, file) => total + file.count, 0);
      return {
        content: [{ type: "text", text: blocks.length ? blocks.join("\n") : `No matches in ${targets.length} file${targets.length === 1 ? "" : "s"}` }],
        details: { count, files: details },
      };
    },
  });

  pi.registerTool({
    name: "inspect_code_structure",
    label: "Inspect Code Structure",
    description: "Extract imports and top-level declarations from one file using lightweight language regexes.",
    promptSnippet: "Inspect imports/declarations",
    promptGuidelines: [
      "Use for quick structure checks before codemods.",
      "Prefer this over read when imports/declarations are enough.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      language: stringEnum(["typescript", "javascript", "python", "rust"] as const),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const text = await readTextFileSafely(path);
      const structure = inspectCodeStructure(text, params.language as Language);
      const lines = [
        `Imports (${structure.imports.length}):`,
        ...structure.imports.map(i => `- ${i}`),
        `Declarations (${structure.declarations.length}):`,
        ...structure.declarations.map(d => `- ${d.line}: ${d.kind} ${d.name}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: structure };
    },
  });

  pi.registerTool({
    name: "inspect_lines",
    label: "Inspect Lines",
    description: "Inspect a bounded numbered line window from one text file. Use only when search/context tools are insufficient.",
    promptSnippet: "Inspect specific file lines",
    promptGuidelines: [
      "Use only after code_search or inspect_text_matches fails to provide enough local context.",
      "Prefer code_search, inspect_text_matches, and inspect_code_structure before inspecting lines.",
      "Request the smallest useful line window; never dump whole files.",
      "inspect_lines is capped at 200 lines; use a focused search radius from code_search/inspect_text_matches before requesting a window.",
      "Do not use read for source files; use inspect_lines as the bounded fallback.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      start: Type.Number({ description: "Start line, 1-indexed" }),
      end: Type.Optional(Type.Number({ description: "End line, inclusive" })),
      context: Type.Optional(Type.Number({ description: "Context lines around start/end" })),
      max_lines: Type.Optional(Type.Number({ description: "Maximum lines allowed (default 80)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const text = await readTextFileSafely(path);
      const lines = text.split("\n");
      const context = Math.max(0, params.context ?? 0);
      const maxLines = Math.max(1, Math.min(params.max_lines ?? 80, 200));
      const start = Math.max(1, Math.floor(params.start) - context);
      const end = Math.min(lines.length, Math.floor(params.end ?? params.start) + context);
      const requested = end - start + 1;
      if (requested > maxLines) throw new Error(`Requested line window exceeds max_lines (${requested} > ${maxLines})`);

      const rel = relativePath(ctx.cwd, path);
      const body = lines.slice(start - 1, end).map((line, index) => `${start + index} | ${line}`).join("\n");
      return {
        content: [{ type: "text", text: `${rel}:${start}-${end}\n${body}` }],
        details: { path: rel, start, end, lines: requested },
      };
    },
  });

  pi.registerTool({
    name: "create_directory",
    label: "Create Directory",
    description: "Create a new directory. Refuses existing paths unless skip is requested; supports recursive parent creation.",
    promptSnippet: "Create a directory",
    promptGuidelines: [
      "Use create_directory instead of mkdir for repository directories.",
      "Set recursive=true only when parent directories may not exist.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "New directory path" }),
      recursive: Type.Optional(Type.Boolean({ description: "Create parent directories" })),
      if_exists: Type.Optional(stringEnum(["error", "skip"] as const, { description: "Behavior if directory exists" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("create_directory", params);
      if (!classification.allowed) throw new Error(`create_directory blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = relativePath(ctx.cwd, path);
      if (await directoryExists(path)) {
        if (params.if_exists === "skip") {
          return { content: [{ type: "text", text: `Skipped existing directory ${rel}` }], details: { path: rel, skipped: true } };
        }
        throw new Error(`Directory already exists: ${rel}`);
      }
      if (await fileExists(path)) throw new Error(`Path exists and is a file: ${rel}`);

      await mkdir(path, { recursive: params.recursive ?? false });
      return { content: [{ type: "text", text: `Created directory ${rel}` }], details: { path: rel, skipped: false } };
    },
  });

  pi.registerTool({
    name: "begin_file_write",
    label: "Begin Chunked File Write",
    description: "Validate a large new file write before accepting content. Returns a temporary handle for bounded chunks.",
    promptSnippet: "Begin chunked file write",
    promptGuidelines: [
      "Use begin_file_write, append_file_chunk, and finish_file_write for larger files instead of putting large content in create_file.",
      "Call begin_file_write with path metadata only; do not include file content in this call.",
      "The final repository mutation happens atomically at finish_file_write.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "New file path" }),
      create_dirs: Type.Optional(Type.Boolean({ description: "Create parent directories" })),
      if_exists: Type.Optional(stringEnum(["error", "skip"] as const, { description: "Behavior if file exists" })),
      newline: Type.Optional(stringEnum(["preserve", "ensure_final"] as const, { description: "Final newline handling" })),
      estimated_bytes: Type.Optional(Type.Number({ description: "Estimated final byte size" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await pruneExpiredFileWriteSessions();
      const classification = classifyToolMutation("create_file", params);
      if (!classification.allowed) throw new Error(`begin_file_write blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = relativePath(ctx.cwd, path);
      if (await fileExists(path)) {
        if (params.if_exists === "skip") {
          return { content: [{ type: "text", text: `Skipped existing file ${rel}` }], details: { path: rel, skipped: true } };
        }
        throw new Error(`File already exists: ${rel}`);
      }
      if (await directoryExists(path)) throw new Error(`Path exists and is a directory: ${rel}`);
      if (params.create_dirs) await mkdir(dirname(path), { recursive: true });
      else if (!(await directoryExists(dirname(path)))) throw new Error(`Parent directory does not exist for ${rel}; set create_dirs=true to create it`);

      const handle = randomUUID();
      const tmpDir = resolve(ctx.cwd, ".pi", "tmp", "file-writes");
      const tmpPath = resolve(tmpDir, `${handle}.tmp`);
      await mkdir(tmpDir, { recursive: true });
      await writeFile(tmpPath, "", { encoding: "utf8", flag: "wx" });
      fileWriteSessions.set(handle, { cwd: ctx.cwd, path, rel, tmpPath, nextIndex: 0, bytes: 0, newline: params.newline ?? "ensure_final", createdAt: Date.now() });

      return {
        content: [{ type: "text", text: `Started chunked file write for ${rel}. Append chunks up to ${FILE_WRITE_MAX_CHUNK_BYTES} bytes, then finish_file_write.` }],
        details: { handle, path: rel, max_chunk_bytes: FILE_WRITE_MAX_CHUNK_BYTES, skipped: false },
      };
    },
  });

  pi.registerTool({
    name: "append_file_chunk",
    label: "Append File Chunk",
    description: "Append one bounded, ordered text chunk to a staged chunked file write.",
    promptSnippet: "Append file chunk",
    promptGuidelines: [
      "Use after begin_file_write for larger files; send chunks in ascending index order starting at 0.",
      "Keep each chunk at or below the returned max_chunk_bytes.",
    ],
    parameters: Type.Object({
      handle: Type.String({ description: "Handle returned by begin_file_write" }),
      index: Type.Number({ description: "Zero-based chunk index" }),
      content: Type.String({ description: "Chunk text" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = fileWriteSessions.get(params.handle);
      if (!session || session.cwd !== ctx.cwd) throw new Error(`Unknown file write handle: ${params.handle}`);
      if (params.index !== session.nextIndex) throw new Error(`Expected chunk index ${session.nextIndex} for ${session.rel}, got ${params.index}`);
      const bytes = Buffer.byteLength(params.content, "utf8");
      if (bytes > FILE_WRITE_MAX_CHUNK_BYTES) throw new Error(`Chunk too large (${bytes} bytes > ${FILE_WRITE_MAX_CHUNK_BYTES} max)`);
      await appendFile(session.tmpPath, params.content, "utf8");
      session.nextIndex += 1;
      session.bytes += bytes;
      return { content: [{ type: "text", text: `Accepted chunk ${params.index} for ${session.rel} (${bytes} bytes)` }], details: { handle: params.handle, index: params.index, bytes, total_bytes: session.bytes } };
    },
  });

  pi.registerTool({
    name: "finish_file_write",
    label: "Finish Chunked File Write",
    description: "Finalize a staged chunked file write atomically and return a compact preview.",
    promptSnippet: "Finish chunked file write",
    promptGuidelines: [
      "Use after all append_file_chunk calls to atomically create the target file.",
      "If the write should not continue, use abort_file_write instead.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      handle: Type.String({ description: "Handle returned by begin_file_write" }),
      expected_chunks: Type.Optional(Type.Number({ description: "Expected number of chunks" })),
      sha256: Type.Optional(Type.String({ description: "Expected SHA-256 checksum of the final content" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = fileWriteSessions.get(params.handle);
      if (!session || session.cwd !== ctx.cwd) throw new Error(`Unknown file write handle: ${params.handle}`);
      if (params.expected_chunks !== undefined && params.expected_chunks !== session.nextIndex) throw new Error(`Expected ${params.expected_chunks} chunks, received ${session.nextIndex}`);
      const classification = classifyToolMutation("create_file", { path: session.rel });
      if (!classification.allowed) throw new Error(`finish_file_write blocked by safety policy: ${classification.reasons.join(", ")}`);
      if (await fileExists(session.path)) throw new Error(`File already exists: ${session.rel}`);

      const staged = await readFile(session.tmpPath, "utf8");
      const content = normalizeCreatedContent(staged, session.newline);
      const buffer = Buffer.from(content, "utf8");
      if (params.sha256) {
        const actualSha256 = createHash("sha256").update(content).digest("hex");
        if (actualSha256 !== params.sha256) throw new Error(`Checksum mismatch for ${session.rel}: expected ${params.sha256}, got ${actualSha256}`);
      }
      if (isProbablyBinary(buffer)) throw new Error(`Refusing to create probable binary file: ${session.rel}`);
      if (content !== staged) await writeFile(session.tmpPath, content, "utf8");
      await rename(session.tmpPath, session.path);
      fileWriteSessions.delete(params.handle);

      const lineCount = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      return {
        content: [{ type: "text", text: `Created ${session.rel} (${buffer.byteLength} bytes, ${lineCount} lines)\n${compactFilePreview(content)}` }],
        details: { path: session.rel, bytes: buffer.byteLength, lines: lineCount, chunks: session.nextIndex, skipped: false },
      };
    },
  });

  pi.registerTool({
    name: "abort_file_write",
    label: "Abort Chunked File Write",
    description: "Abort a staged chunked file write and delete its temporary content.",
    promptSnippet: "Abort chunked file write",
    promptGuidelines: ["Use to clean up a chunked file write that should not be finalized."],
    parameters: Type.Object({
      handle: Type.String({ description: "Handle returned by begin_file_write" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = fileWriteSessions.get(params.handle);
      if (!session || session.cwd !== ctx.cwd) throw new Error(`Unknown file write handle: ${params.handle}`);
      await rm(session.tmpPath, { force: true });
      fileWriteSessions.delete(params.handle);
      return { content: [{ type: "text", text: `Aborted chunked file write for ${session.rel}` }], details: { handle: params.handle, path: session.rel, aborted: true } };
    },
  });

  pi.registerTool({
    name: "create_file",
    label: "Create File",
    description: "Create a new text/source file. Refuses overwrites, supports parent directory creation, and returns a compact preview. Large content is capped; use chunked file write tools for larger files.",
    promptSnippet: "Create a new file",
    promptGuidelines: [
      `Use create_file for new source, config, test, markdown, and fixture files up to ${CREATE_FILE_MAX_BYTES} bytes.`,
      "Use begin_file_write/append_file_chunk/finish_file_write for larger files instead of streaming huge content into create_file.",
      "Never use read/write/edit, bash, node, python, sed, awk, tee, heredocs, or shell redirection to create repository files.",
      "Use apply_code_replacements for existing files; do not overwrite existing files with create_file.",
      "Set create_dirs=true only when the parent directory does not already exist.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "New file path" }),
      content: Type.String({ description: "Text content" }),
      create_dirs: Type.Optional(Type.Boolean({ description: "Create parent directories" })),
      if_exists: Type.Optional(stringEnum(["error", "skip"] as const, { description: "Behavior if file exists" })),
      newline: Type.Optional(stringEnum(["preserve", "ensure_final"] as const, { description: "Final newline handling" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("create_file", params);
      if (!classification.allowed) throw new Error(`create_file blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = relativePath(ctx.cwd, path);
      if (await fileExists(path)) {
        if (params.if_exists === "skip") {
          return { content: [{ type: "text", text: `Skipped existing file ${rel}` }], details: { path: rel, skipped: true } };
        }
        throw new Error(`File already exists: ${rel}`);
      }

      const content = normalizeCreatedContent(params.content, params.newline ?? "ensure_final");
      const buffer = Buffer.from(content, "utf8");
      if (buffer.byteLength > CREATE_FILE_MAX_BYTES) throw new Error(`Content too large for create_file (${buffer.byteLength} bytes > ${CREATE_FILE_MAX_BYTES}). Use begin_file_write, append_file_chunk, and finish_file_write for larger files.`);
      if (isProbablyBinary(buffer)) throw new Error(`Refusing to create probable binary file: ${rel}`);
      if (params.create_dirs) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });

      const lineCount = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      return {
        content: [{ type: "text", text: `Created ${rel} (${buffer.byteLength} bytes, ${lineCount} lines)\n${compactFilePreview(content)}` }],
        details: { path: rel, bytes: buffer.byteLength, lines: lineCount, skipped: false },
      };
    },
  });

  pi.registerTool({
    name: "plan_code_replacements",
    label: "Plan Code Replacements",
    description: "Dry-run exact or regex replacements across files without writing changes.",
    promptSnippet: "Plan batch replacements",
    promptGuidelines: [
      "Use before apply_code_replacements for broad edits.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      file_glob: Type.Optional(Type.String({ description: "Target glob" })),
      language: Type.Optional(stringEnum(["typescript", "javascript", "python", "rust"] as const)),
      exclude_globs: Type.Optional(Type.Array(Type.String(), { description: "Extra excludes" })),
      edits: Type.Array(Type.Object({
        path: Type.Optional(Type.String({ description: "File path" })),
        oldText: Type.Optional(Type.String({ description: "Exact old text" })),
        regex: Type.Optional(Type.String({ description: "Regex pattern" })),
        flags: Type.Optional(Type.String({ description: "Regex flags" })),
        newText: Type.String({ description: "Replacement text" }),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches" })),
        matchMode: Type.Optional(stringEnum(["exact", "trimmed_lines"] as const)),
        expectedReplacements: Type.Optional(Type.Number({ description: "Expected replacements" })),
        minReplacements: Type.Optional(Type.Number({ description: "Minimum replacements" })),
        maxReplacements: Type.Optional(Type.Number({ description: "Maximum replacements" })),
      }), { description: "Edits" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const targets = await collectTargetFiles(ctx.cwd, {
        file_glob: params.file_glob,
        language: params.language as Language | undefined,
        exclude_globs: params.exclude_globs,
      });
      const planned = await planCodeReplacements(ctx.cwd, params.edits as ReplacementEdit[], targets);

      const summary = planned.map(({ plan }) => {
        const preview = formatPlanPreview(plan);
        return preview ? `${summarizePlan(plan)}\n${preview}` : summarizePlan(plan);
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `Plan:\n${summary}` }],
        details: { dryRun: true, plans: planned.map(({ plan }) => ({ path: plan.path, replacements: plan.replacements, previews: plan.previews })) },
      };
    },
  });

  pi.registerTool({
    name: "apply_code_replacements",
    label: "Apply Code Replacements",
    description: "Apply exact or regex replacements across files. Supports globs, languages, dry-run previews, match modes, and count guards.",
    promptSnippet: "Batch text/regex replacements",
    promptGuidelines: [
      "Prefer exact oldText. Use dry_run before broad regex/glob edits.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
      file_glob: Type.Optional(Type.String({ description: "Target glob" })),
      language: Type.Optional(stringEnum(["typescript", "javascript", "python", "rust"] as const)),
      exclude_globs: Type.Optional(Type.Array(Type.String(), { description: "Extra excludes" })),
      edits: Type.Array(Type.Object({
        path: Type.Optional(Type.String({ description: "File path" })),
        oldText: Type.Optional(Type.String({ description: "Exact old text" })),
        regex: Type.Optional(Type.String({ description: "Regex pattern" })),
        flags: Type.Optional(Type.String({ description: "Regex flags" })),
        newText: Type.String({ description: "Replacement text" }),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches" })),
        matchMode: Type.Optional(stringEnum(["exact", "trimmed_lines"] as const)),
        expectedReplacements: Type.Optional(Type.Number({ description: "Expected replacements" })),
        minReplacements: Type.Optional(Type.Number({ description: "Minimum replacements" })),
        maxReplacements: Type.Optional(Type.Number({ description: "Maximum replacements" })),
      }), { description: "Edits" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("apply_code_replacements", params);
      if (!classification.allowed) throw new Error(`apply_code_replacements blocked by safety policy: ${classification.reasons.join(", ")}`);
      const dryRun = params.dry_run ?? false;
      const targets = await collectTargetFiles(ctx.cwd, {
        file_glob: params.file_glob,
        language: params.language as Language | undefined,
        exclude_globs: params.exclude_globs,
      });
      const planned = await planCodeReplacements(ctx.cwd, params.edits as ReplacementEdit[], targets);

      if (!dryRun) {
        for (const { fsPath, plan } of planned) {
          if (plan.before !== plan.after) await writeFile(fsPath, plan.after, "utf8");
        }
      }

      const summary = planned.map(({ plan }) => {
        const preview = formatPlanPreview(plan, { color: true });
        return preview ? `${summarizePlan(plan)}\n${preview}` : summarizePlan(plan);
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `${dryRun ? "Dry run" : "Applied"}:\n${summary}` }],
        details: { dryRun, plans: planned.map(({ plan }) => ({ path: plan.path, replacements: plan.replacements, previews: plan.previews })) },
      };
    },
  });
}
