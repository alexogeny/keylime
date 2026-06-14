import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "./shared/schema";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

export function resetFileWriteSessionsForTests(): void {
  fileWriteSessions.clear();
}

function fileWriteSessionDir(cwd: string): string {
  return resolve(cwd, ".pi", "tmp", "file-writes");
}

function fileWriteSessionMetaPath(cwd: string, handle: string): string {
  return resolve(fileWriteSessionDir(cwd), `${handle}.json`);
}

async function saveFileWriteSession(handle: string, session: FileWriteSession): Promise<void> {
  fileWriteSessions.set(handle, session);
  await mkdir(dirname(fileWriteSessionMetaPath(session.cwd, handle)), { recursive: true });
  await writeFile(fileWriteSessionMetaPath(session.cwd, handle), JSON.stringify(session), "utf8");
}

async function loadFileWriteSession(cwd: string, handle: string): Promise<FileWriteSession | undefined> {
  const cached = fileWriteSessions.get(handle);
  if (cached) return cached;
  try {
    const session = JSON.parse(await readFile(fileWriteSessionMetaPath(cwd, handle), "utf8")) as FileWriteSession;
    fileWriteSessions.set(handle, session);
    return session;
  } catch {
    return undefined;
  }
}

async function deleteFileWriteSession(handle: string, session: FileWriteSession): Promise<void> {
  fileWriteSessions.delete(handle);
  await rm(fileWriteSessionMetaPath(session.cwd, handle), { force: true });
}

async function pruneExpiredFileWriteSessions(now = Date.now(), cwd = process.cwd()): Promise<void> {
  const sessions = new Map(fileWriteSessions);
  try {
    for (const entry of await readdir(fileWriteSessionDir(cwd))) {
      if (entry.endsWith(".json")) {
        const handle = entry.slice(0, -5);
        const session = await loadFileWriteSession(cwd, handle);
        if (session) sessions.set(handle, session);
      }
    }
  } catch {
    // No persisted sessions yet.
  }
  await Promise.all([...sessions.entries()].map(async ([handle, session]) => {
    if (now - session.createdAt <= FILE_WRITE_SESSION_TTL_MS) return;
    await rm(session.tmpPath, { force: true });
    await deleteFileWriteSession(handle, session);
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

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function bool(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function unifiedDiffPreview(a: string, b: string, maxLines = 120): string {
  const left = a.split("\n");
  const right = b.split("\n");
  const lines: string[] = [];
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max && lines.length < maxLines; i += 1) {
    if (left[i] === right[i]) continue;
    if (left[i] !== undefined) lines.push(`-${i + 1} | ${left[i]}`);
    if (right[i] !== undefined) lines.push(`+${i + 1} | ${right[i]}`);
  }
  if (lines.length === 0) return "No text differences.";
  if (lines.length >= maxLines) lines.push("… diff truncated");
  return lines.join("\n");
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
  allow_outside_cwd?: boolean;
}): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const root = options.allow_outside_cwd
    ? (isAbsolute(options.path ?? ".") ? resolve(options.path ?? ".") : resolve(cwd, options.path ?? "."))
    : resolveSafePath(cwd, options.path ?? ".");
  const displayRoot = options.allow_outside_cwd ? root : cwd;
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
      const rel = repoRelativePath(displayRoot, fsPath);
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
      "Narrow with file_glob/language/exclude_globs before inspecting content.",
      "Set allow_outside_cwd=true only for explicit read-only listing outside cwd.",
      "If blocked, ask to update Keylime; never fall back to head/tail/grep/cat/sed.",
      "Keep max_results bounded; follow with search/match/lines tools.",
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
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only directory listing outside cwd when explicitly requested" })),
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
        allow_outside_cwd: params.allow_outside_cwd,
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
      "Set allow_outside_cwd=true only for explicit read-only file inspection outside cwd.",
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
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only text matching outside cwd when explicitly requested" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const targets = params.path
        ? [params.allow_outside_cwd
          ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
          : resolveSafePath(ctx.cwd, params.path)]
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
      "Set allow_outside_cwd=true only for explicit read-only file inspection outside cwd.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      language: stringEnum(["typescript", "javascript", "python", "rust"] as const),
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only structure inspection outside cwd when explicitly requested" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = params.allow_outside_cwd
        ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
        : resolveSafePath(ctx.cwd, params.path);
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
      "Use after search/match/structure when context is insufficient.",
      "Request the smallest useful line window; never dump whole files.",
      "inspect_lines is capped at 200 lines; request a focused window.",
      "Set allow_outside_cwd=true only for explicit read-only file inspection outside cwd.",
      "If blocked, ask to update Keylime; never fall back to head/tail/grep/cat/sed.",
      "Do not use read for source files; use inspect_lines as the bounded fallback.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      start: Type.Number({ description: "Start line, 1-indexed" }),
      end: Type.Optional(Type.Number({ description: "End line, inclusive" })),
      context: Type.Optional(Type.Number({ description: "Context lines around start/end" })),
      max_lines: Type.Optional(Type.Number({ description: "Maximum lines allowed (default 80)" })),
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only inspection outside cwd when explicitly requested" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = params.allow_outside_cwd
        ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
        : resolveSafePath(ctx.cwd, params.path);
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
      await pruneExpiredFileWriteSessions(Date.now(), ctx.cwd);
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
      const tmpDir = fileWriteSessionDir(ctx.cwd);
      const tmpPath = resolve(tmpDir, `${handle}.tmp`);
      await mkdir(tmpDir, { recursive: true });
      await writeFile(tmpPath, "", { encoding: "utf8", flag: "wx" });
      await saveFileWriteSession(handle, { cwd: ctx.cwd, path, rel, tmpPath, nextIndex: 0, bytes: 0, newline: params.newline ?? "ensure_final", createdAt: Date.now() });

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
      const session = await loadFileWriteSession(ctx.cwd, params.handle);
      if (!session || session.cwd !== ctx.cwd) throw new Error(`Unknown file write handle: ${params.handle}`);
      if (params.index !== session.nextIndex) throw new Error(`Expected chunk index ${session.nextIndex} for ${session.rel}, got ${params.index}`);
      const bytes = Buffer.byteLength(params.content, "utf8");
      if (bytes > FILE_WRITE_MAX_CHUNK_BYTES) throw new Error(`Chunk too large (${bytes} bytes > ${FILE_WRITE_MAX_CHUNK_BYTES} max)`);
      await appendFile(session.tmpPath, params.content, "utf8");
      session.nextIndex += 1;
      session.bytes += bytes;
      await saveFileWriteSession(params.handle, session);
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
      const session = await loadFileWriteSession(ctx.cwd, params.handle);
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
      await deleteFileWriteSession(params.handle, session);

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
      const session = await loadFileWriteSession(ctx.cwd, params.handle);
      if (!session || session.cwd !== ctx.cwd) throw new Error(`Unknown file write handle: ${params.handle}`);
      await rm(session.tmpPath, { force: true });
      await deleteFileWriteSession(params.handle, session);
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
    name: "inspect_file_metadata",
    label: "Inspect File Metadata",
    description: "Inspect bounded file/directory metadata safely. Use instead of stat/file/wc/checksum shell commands.",
    promptSnippet: "Inspect file metadata",
    promptGuidelines: [
      "Use instead of bash stat/file/wc/sha commands.",
      "Returns metadata only; use inspect_lines or inspect_text_matches for content.",
      "Set allow_outside_cwd=true only for explicit read-only inspection outside cwd.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File or directory path" }),
      include_sha256: Type.Optional(Type.Boolean({ description: "Include SHA-256 for files" })),
      allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only inspection outside cwd when explicitly requested" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = params.allow_outside_cwd
        ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
        : resolveSafePath(ctx.cwd, params.path);
      const rel = repoRelativePath(ctx.cwd, path);
      const info = await stat(path);
      const details: any = {
        path: rel,
        type: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
        bytes: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString(),
        mode: `0${(info.mode & 0o777).toString(8)}`,
        is_file: info.isFile(),
        is_directory: info.isDirectory(),
      };
      if (info.isFile()) {
        const buffer = await readFile(path);
        details.probably_binary = isProbablyBinary(buffer);
        details.line_count = details.probably_binary ? null : buffer.toString("utf8").split("\n").length - (buffer.toString("utf8").endsWith("\n") ? 1 : 0);
        if (params.include_sha256) details.sha256 = sha256(buffer);
      }
      return { content: [{ type: "text", text: Object.entries(details).map(([key, value]) => `${key}: ${value}`).join("\n") }], details };
    },
  });

  pi.registerTool({
    name: "compare_files",
    label: "Compare Files",
    description: "Compare two repository files safely with bounded text diff or binary summary. Use instead of diff/cmp/comm.",
    promptSnippet: "Compare two files",
    promptGuidelines: [
      "Use instead of bash diff/cmp/comm.",
      "Output is bounded; ask for narrower context if truncated.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      left_path: Type.String({ description: "Left/base file path" }),
      right_path: Type.String({ description: "Right/compare file path" }),
      max_lines: Type.Optional(Type.Number({ description: "Maximum diff lines, default 120, max 500" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const leftPath = resolveSafePath(ctx.cwd, params.left_path);
      const rightPath = resolveSafePath(ctx.cwd, params.right_path);
      const left = await readFile(leftPath);
      const right = await readFile(rightPath);
      const leftRel = repoRelativePath(ctx.cwd, leftPath);
      const rightRel = repoRelativePath(ctx.cwd, rightPath);
      const leftBinary = isProbablyBinary(left);
      const rightBinary = isProbablyBinary(right);
      const same = left.equals(right);
      if (leftBinary || rightBinary) {
        const text = [
          `Compared ${leftRel} ↔ ${rightRel}`,
          `same: ${bool(same)}`,
          `${leftRel}: ${left.byteLength} bytes sha256=${sha256(left)} binary=${bool(leftBinary)}`,
          `${rightRel}: ${right.byteLength} bytes sha256=${sha256(right)} binary=${bool(rightBinary)}`,
        ].join("\n");
        return { content: [{ type: "text", text }], details: { left_path: leftRel, right_path: rightRel, same, binary: true } };
      }
      const maxLines = Math.min(Math.max(Number(params.max_lines ?? 120), 1), 500);
      const diff = unifiedDiffPreview(left.toString("utf8"), right.toString("utf8"), maxLines);
      return { content: [{ type: "text", text: `Compared ${leftRel} ↔ ${rightRel}\nsame: ${bool(same)}\n${diff}` }], details: { left_path: leftRel, right_path: rightRel, same, binary: false } };
    },
  });

  pi.registerTool({
    name: "delete_file",
    label: "Delete File",
    description: "Delete one repository file with protected-path guards. Use instead of rm.",
    promptSnippet: "Delete a file",
    promptGuidelines: ["Use instead of bash rm. Deletes files only, not directories.", ...SOURCE_MUTATION_GUIDELINES],
    parameters: Type.Object({ path: Type.String({ description: "File path to delete" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("delete_file", params);
      if (!classification.allowed) throw new Error(`delete_file blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = repoRelativePath(ctx.cwd, path);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`delete_file refuses non-file path: ${rel}`);
      await rm(path);
      return { content: [{ type: "text", text: `Deleted ${rel}` }], details: { path: rel } };
    },
  });

  pi.registerTool({
    name: "move_file",
    label: "Move File",
    description: "Move/rename one repository file with protected-path guards. Use instead of mv.",
    promptSnippet: "Move or rename a file",
    promptGuidelines: ["Use instead of bash mv. Refuses overwriting unless if_exists=overwrite.", ...SOURCE_MUTATION_GUIDELINES],
    parameters: Type.Object({
      from_path: Type.String({ description: "Existing file path" }),
      to_path: Type.String({ description: "Destination file path" }),
      if_exists: Type.Optional(stringEnum(["error", "overwrite"] as const, { description: "Behavior if destination exists" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("move_file", params);
      if (!classification.allowed) throw new Error(`move_file blocked by safety policy: ${classification.reasons.join(", ")}`);
      const from = resolveSafePath(ctx.cwd, params.from_path);
      const to = resolveSafePath(ctx.cwd, params.to_path);
      const fromRel = repoRelativePath(ctx.cwd, from);
      const toRel = repoRelativePath(ctx.cwd, to);
      const info = await stat(from);
      if (!info.isFile()) throw new Error(`move_file refuses non-file source: ${fromRel}`);
      if (await fileExists(to)) {
        if (params.if_exists !== "overwrite") throw new Error(`Destination already exists: ${toRel}`);
        await rm(to);
      }
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return { content: [{ type: "text", text: `Moved ${fromRel} -> ${toRel}` }], details: { from_path: fromRel, to_path: toRel } };
    },
  });

  pi.registerTool({
    name: "copy_file",
    label: "Copy File",
    description: "Copy one repository file with protected-path guards. Use instead of cp.",
    promptSnippet: "Copy a file",
    promptGuidelines: ["Use instead of bash cp. Refuses overwriting unless if_exists=overwrite.", ...SOURCE_MUTATION_GUIDELINES],
    parameters: Type.Object({
      from_path: Type.String({ description: "Existing file path" }),
      to_path: Type.String({ description: "Destination file path" }),
      if_exists: Type.Optional(stringEnum(["error", "overwrite"] as const, { description: "Behavior if destination exists" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("copy_file", params);
      if (!classification.allowed) throw new Error(`copy_file blocked by safety policy: ${classification.reasons.join(", ")}`);
      const from = resolveSafePath(ctx.cwd, params.from_path);
      const to = resolveSafePath(ctx.cwd, params.to_path);
      const fromRel = repoRelativePath(ctx.cwd, from);
      const toRel = repoRelativePath(ctx.cwd, to);
      const info = await stat(from);
      if (!info.isFile()) throw new Error(`copy_file refuses non-file source: ${fromRel}`);
      if (await fileExists(to) && params.if_exists !== "overwrite") throw new Error(`Destination already exists: ${toRel}`);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      return { content: [{ type: "text", text: `Copied ${fromRel} -> ${toRel}` }], details: { from_path: fromRel, to_path: toRel } };
    },
  });

  pi.registerTool({
    name: "replace_file",
    label: "Replace File",
    description: "Replace an existing text file with checksum guard and compact preview. Use instead of tee/truncate/cat > file.",
    promptSnippet: "Replace a file with checksum guard",
    promptGuidelines: [
      "Use only when apply_code_replacements is awkward for a whole-file replacement.",
      "Provide expected_sha256 from inspect_file_metadata to guard against stale overwrites.",
      ...SOURCE_MUTATION_GUIDELINES,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Existing file path" }),
      content: Type.String({ description: "Replacement text content" }),
      expected_sha256: Type.String({ description: "SHA-256 of current file content" }),
      newline: Type.Optional(stringEnum(["preserve", "ensure_final"] as const, { description: "Final newline handling" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("replace_file", params);
      if (!classification.allowed) throw new Error(`replace_file blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = repoRelativePath(ctx.cwd, path);
      const current = await readFile(path);
      if (sha256(current) !== params.expected_sha256) throw new Error(`Checksum mismatch for ${rel}`);
      if (isProbablyBinary(current)) throw new Error(`Refusing to replace probable binary file: ${rel}`);
      const content = normalizeCreatedContent(params.content, params.newline ?? "ensure_final");
      const buffer = Buffer.from(content, "utf8");
      if (buffer.byteLength > CREATE_FILE_MAX_BYTES) throw new Error(`Content too large for replace_file (${buffer.byteLength} bytes > ${CREATE_FILE_MAX_BYTES}). Use targeted replacements or chunked creation plus move if appropriate.`);
      if (isProbablyBinary(buffer)) throw new Error(`Refusing to write probable binary file: ${rel}`);
      await writeFile(path, content, "utf8");
      const lineCount = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      return { content: [{ type: "text", text: `Replaced ${rel} (${buffer.byteLength} bytes, ${lineCount} lines)\n${compactFilePreview(content)}` }], details: { path: rel, bytes: buffer.byteLength, lines: lineCount } };
    },
  });

  pi.registerTool({
    name: "inspect_runtime_environment",
    label: "Inspect Runtime Environment",
    description: "Inspect bounded runtime/project environment facts safely. Use instead of pwd/env/which/type shell commands.",
    promptSnippet: "Inspect runtime environment",
    promptGuidelines: ["Use instead of bash pwd/env/which/type for project/runtime facts.", "Never exposes full environment variables or secrets."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const packageJson = resolve(ctx.cwd, "package.json");
      const details = {
        cwd: ctx.cwd,
        repo_root_name: ctx.cwd.split("/").filter(Boolean).at(-1) ?? ctx.cwd,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        bun: typeof (globalThis as any).Bun?.version === "string" ? (globalThis as any).Bun.version : null,
        has_package_json: await fileExists(packageJson),
        relative_to_process_cwd: relative(process.cwd(), ctx.cwd) || ".",
      };
      return { content: [{ type: "text", text: Object.entries(details).map(([key, value]) => `${key}: ${value}`).join("\n") }], details };
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
