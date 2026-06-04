/**
 * repo-index — structural code search and session-level repo skeleton.
 *
 * Solves the #1 hidden token cost in agentic coding: 60–87% of tokens
 * going to file navigation (grep → full read → repeat) rather than
 * reasoning. Provides two mechanisms:
 *
 * 1. Repo skeleton (system prompt injection, once per session):
 *    Builds a compact symbol map of the codebase at session start using
 *    ripgrep declaration patterns. Injected as STATIC content so it
 *    lands in the cached system prompt prefix and is never re-processed.
 *
 * 2. code_search tool (tiered search, token-budgeted):
 *    - lexical   → ripgrep text search, file:line + 2 lines context
 *    - structural → ripgrep declaration patterns (functions, types, classes)
 *    - auto       → tries structural first, falls back to lexical
 *    Returns compressed results: never dumps full file content.
 *
 * The skeleton is invalidated and rebuilt after any write/edit tool call
 * touches a source file, keeping it fresh without per-turn cost.
 *
 * Supported languages: TypeScript/JavaScript, Rust, Python, Go.
 * Falls back gracefully in repos with no recognised source files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, relative, dirname, extname, delimiter } from "node:path";

const execFileAsync = promisify(execFile);

function stringEnum<const T extends readonly string[]>(values: T, options?: Record<string, unknown>) {
  return Type.Union(values.map(value => Type.Literal(value)), options);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RG_PATH          = process.env.PI_RG_PATH ?? "rg";
const SKELETON_MAX_CHARS = 3_500;   // max chars for the system-prompt skeleton
const SEARCH_MAX_CHARS   = 4_000;   // max chars returned by code_search
const SKELETON_TIMEOUT   = 8_000;   // ms before we give up on skeleton build
const SEARCH_TIMEOUT     = 6_000;   // ms for a search query
const IGNORED_DIRS       = ["node_modules", "dist", ".git", ".next", "build", "target", "coverage", "__pycache__", ".turbo"];

function shouldIncludeHidden(fileGlob?: string): boolean {
  if (!fileGlob) return false;
  return fileGlob.startsWith(".") || fileGlob.includes("/.") || fileGlob.includes("**/.");
}

// ─── Language patterns ────────────────────────────────────────────────────────

interface LangConfig {
  rgType:   string;
  exts:     string[];
  /** Ripgrep pattern to match top-level declarations */
  declPattern: string;
  /** Detect if cwd is this language's project */
  markerFiles: string[];
}

const LANGS: LangConfig[] = [
  {
    rgType: "ts",
    exts:   [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
    markerFiles: ["package.json", "tsconfig.json"],
    declPattern: [
      // exported functions
      `^(export\\s+)?(default\\s+)?(async\\s+)?function\\s+(\\w+)`,
      // exported classes
      `^(export\\s+)?(abstract\\s+)?class\\s+(\\w+)`,
      // exported types / interfaces
      `^(export\\s+)?(type|interface)\\s+(\\w+)`,
      // exported arrow functions / consts
      `^export\\s+(const|let)\\s+(\\w+)\\s*[=:]`,
    ].join("|"),
  },
  {
    rgType: "rust",
    exts:   [".rs"],
    markerFiles: ["Cargo.toml"],
    declPattern: [
      `^(pub\\s+)?(async\\s+)?fn\\s+(\\w+)`,
      `^(pub\\s+)?(struct|enum|trait|type)\\s+(\\w+)`,
      `^(pub\\s+)?impl\\b`,
      `^(pub\\s+)?mod\\s+(\\w+)`,
    ].join("|"),
  },
  {
    rgType: "py",
    exts:   [".py"],
    markerFiles: ["pyproject.toml", "setup.py", "requirements.txt"],
    declPattern: `^(async\\s+)?def\\s+(\\w+)|^class\\s+(\\w+)`,
  },
  {
    rgType: "go",
    exts:   [".go"],
    markerFiles: ["go.mod"],
    declPattern: `^func\\s+(\\(\\w[^)]*\\)\\s+)?(\\w+)|^type\\s+(\\w+)`,
  },
];

// ─── Ripgrep wrapper ──────────────────────────────────────────────────────────

function resolveRgPath(): string {
  if (existsSync(RG_PATH)) return RG_PATH;

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, RG_PATH);
    if (existsSync(candidate)) return candidate;
  }

  for (const dir of ["/home/alex/.pi/agent/bin", "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]) {
    const candidate = join(dir, RG_PATH);
    if (existsSync(candidate)) return candidate;
  }

  return RG_PATH;
}

const RG = resolveRgPath();

function ignoredDirArgs(): string[] {
  return IGNORED_DIRS.flatMap(d => ["--glob", `!${d}`]);
}

async function rgRun(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(RG, [...args, "."], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 768, // 768 KB
    });
    return stdout;
  } catch (err: any) {
    // rg exits 1 when no matches — that's fine
    if (err.code === 1) return err.stdout ?? "";
    if (err.killed)     return ""; // timeout
    return "";
  }
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

interface Symbol {
  name:    string;
  line:    number;
  kind:    string; // "fn" | "class" | "type" | "const" | "interface" | "struct" | ...
}

interface FileSymbols {
  relPath: string;
  symbols: Symbol[];
}

function parseSymbolLine(raw: string, lang: LangConfig): Symbol | null {
  // Format from rg: path:line:text
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) return null;
  const rest       = raw.slice(colonIdx + 1);
  const lineColIdx = rest.indexOf(":");
  if (lineColIdx === -1) return null;
  const lineStr    = rest.slice(0, lineColIdx);
  const text       = rest.slice(lineColIdx + 1).trim();
  const lineNum    = parseInt(lineStr, 10);
  if (isNaN(lineNum)) return null;

  // Extract the identifier and kind from the matched text
  // TypeScript
  let m: RegExpMatchArray | null;

  if (lang.rgType === "ts") {
    m = text.match(/\bfunction\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "fn" };

    m = text.match(/\bclass\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "class" };

    m = text.match(/\binterface\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "interface" };

    m = text.match(/\btype\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "type" };

    m = text.match(/\bconst\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "const" };

    m = text.match(/\blet\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "let" };
  }

  if (lang.rgType === "rust") {
    m = text.match(/\bfn\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "fn" };

    m = text.match(/\b(struct|enum|trait|type)\s+(\w+)/);
    if (m) return { name: m[2], line: lineNum, kind: m[1] };

    m = text.match(/\bmod\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "mod" };

    if (text.match(/\bimpl\b/)) {
      m = text.match(/impl\s+(?:<[^>]*>\s+)?(?:\w+\s+for\s+)?(\w+)/);
      if (m) return { name: `impl ${m[1]}`, line: lineNum, kind: "impl" };
    }
  }

  if (lang.rgType === "py") {
    m = text.match(/\bdef\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "def" };

    m = text.match(/\bclass\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "class" };
  }

  if (lang.rgType === "go") {
    m = text.match(/\bfunc\s+(?:\([^)]*\)\s+)?(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "func" };

    m = text.match(/\btype\s+(\w+)/);
    if (m) return { name: m[1], line: lineNum, kind: "type" };
  }

  return null;
}

async function extractSymbols(
  cwd: string,
  lang: LangConfig,
): Promise<FileSymbols[]> {
  const output = await rgRun(
    [
      "--no-heading",
      "--line-number",
      "--type", lang.rgType,
      "-e", lang.declPattern,
      ...ignoredDirArgs(),
    ],
    cwd,
    SKELETON_TIMEOUT,
  );

  if (!output.trim()) return [];

  // Group by file
  const byFile = new Map<string, Symbol[]>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Extract the relative file path (first segment before first colon on non-Windows)
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const rawPath = line.slice(0, colonIdx);
    const relPath = relative(cwd, rawPath).replace(/\\/g, "/");

    const sym = parseSymbolLine(line, lang);
    if (!sym) continue;

    if (!byFile.has(relPath)) byFile.set(relPath, []);
    byFile.get(relPath)!.push(sym);
  }

  return Array.from(byFile.entries())
    .map(([relPath, symbols]) => ({ relPath, symbols }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ─── Skeleton formatter ───────────────────────────────────────────────────────

function formatSkeleton(allFiles: FileSymbols[], maxChars: number): string {
  if (allFiles.length === 0) return "";

  // Group by directory
  const byDir = new Map<string, FileSymbols[]>();
  for (const fs of allFiles) {
    const dir = dirname(fs.relPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(fs);
  }

  const lines: string[] = ["## Repo Map (session snapshot)"];
  let chars = lines[0].length + 1;

  const SYMBOL_LIMIT = 8; // max symbols to list per file before collapsing

  for (const [dir, files] of byDir) {
    const dirLine = `${dir === "." ? "(root)" : dir}/`;
    lines.push(dirLine);
    chars += dirLine.length + 1;

    for (const f of files) {
      const fname = f.relPath.slice(dir === "." ? 0 : dir.length + 1);
      if (f.symbols.length === 0) continue;

      const shown  = f.symbols.slice(0, SYMBOL_LIMIT);
      const hidden = f.symbols.length - shown.length;
      const symStr = shown.map(s => s.name).join(", ") + (hidden > 0 ? ` [+${hidden}]` : "");
      const fileLine = `  ${fname} → ${symStr}`;

      if (chars + fileLine.length > maxChars) {
        lines.push("  … (truncated — use code_search to explore further)");
        return lines.join("\n");
      }

      lines.push(fileLine);
      chars += fileLine.length + 1;
    }
  }

  return lines.join("\n");
}

// ─── Index state ─────────────────────────────────────────────────────────────

interface IndexState {
  cwd:      string;
  skeleton: string;
  dirty:    boolean;
}

const state: IndexState = { cwd: "", skeleton: "", dirty: true };

async function rebuildIndex(cwd: string): Promise<void> {
  if (cwd !== state.cwd) {
    state.cwd   = cwd;
    state.dirty = true;
  }
  if (!state.dirty) return;

  // Detect which language this project primarily uses
  const allFiles: FileSymbols[] = [];

  for (const lang of LANGS) {
    const hasMarker = lang.markerFiles.some(f => existsSync(join(cwd, f)));
    // Always attempt extraction if marker found; skip if no marker (avoid scanning foreign repos)
    if (!hasMarker) continue;

    const files = await extractSymbols(cwd, lang);
    allFiles.push(...files);
  }

  state.skeleton = formatSkeleton(allFiles, SKELETON_MAX_CHARS);
  state.dirty    = false;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default async function repoIndexExtension(pi: ExtensionAPI) {

  // ── Build index on session start ────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("repo-index", ctx.ui.theme.fg("dim", "idx: building…"));
    await rebuildIndex(ctx.cwd);

    if (state.skeleton) {
      const lines = state.skeleton.split("\n").length;
      ctx.ui.setStatus("repo-index", ctx.ui.theme.fg("dim", `idx:${lines}L`));
    } else {
      ctx.ui.setStatus("repo-index", "");
    }
  });

  // ── Inject skeleton into system prompt (STATIC — cached prefix) ─────────────
  // Runs once per agent turn but the content is stable, so it contributes to
  // the cached system prompt prefix. We skip re-injection if the skeleton hasn't
  // changed to avoid marking the system prompt as dirty unnecessarily.

  let lastInjectedSkeleton = "";

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.cwd !== state.cwd || state.dirty) await rebuildIndex(ctx.cwd);
    if (!state.skeleton)       return;
    if (state.skeleton === lastInjectedSkeleton) {
      // Content is identical — inject anyway (system prompt is rebuilt every turn
      // by pi, so we must always append; but since the text is the same, the
      // assembled system prompt string will be identical → cache hit)
    }
    lastInjectedSkeleton = state.skeleton;
    return { systemPrompt: event.systemPrompt + "\n\n" + state.skeleton };
  });

  // ── Invalidate index after source file writes ──────────────────────────────

  pi.on("tool_result", async (event) => {
    const input = (event as any).input ?? {};

    if (["write", "edit"].includes(event.toolName)) {
      const ext = extname(input.path ?? "");
      if (LANGS.some(l => l.exts.includes(ext))) state.dirty = true;
      return;
    }

    if (event.toolName !== "apply_code_replacements" || input.dry_run === true) return;
    if (input.language || input.file_glob) {
      state.dirty = true;
      return;
    }

    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (edits.some((edit: any) => LANGS.some(l => l.exts.includes(extname(edit?.path ?? ""))))) {
      state.dirty = true;
    }
  });

  // ── code_search tool ────────────────────────────────────────────────────────

  pi.registerTool({
    name:  "code_search",
    label: "Code Search",
    description: [
      "Tiered structural code search over the current repository.",
      "Returns file:line + context — never dumps full file content.",
      "Much cheaper than reading files: use this first.",
      "Modes: auto (structural first, fall back to lexical), lexical (text match), structural (declarations only).",
    ].join(" "),
    promptSnippet: "Search code by symbol, declaration, or text",
    promptGuidelines: [
      "Use before reading files; returns file:line context, not full files.",
      "mode='structural' for declarations; mode='lexical' for text; mode='auto' when unsure.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Symbol name, text snippet, or pattern to search for",
      }),
      mode: Type.Optional(stringEnum(["auto", "lexical", "structural"] as const, {
        description: "Search mode (default: auto). structural=declarations only, lexical=full text, auto=structural first then lexical.",
      })),
      file_glob: Type.Optional(Type.String({
        description: "Ripgrep glob to restrict files, e.g. 'src/auth/**' or '*.ts'",
      })),
      max_results: Type.Optional(Type.Number({
        description: "Max result lines to return (default 30, max 100)",
        minimum: 1,
        maximum: 100,
      })),
      include_hidden: Type.Optional(Type.Boolean({
        description: "Include hidden files/directories (e.g. .pi/**). Default false; auto-enabled for hidden file_glob paths.",
      })),
    }),

    async execute(_id, params, _signal, onUpdate, ctx) {
      const cwd        = ctx.cwd;
      const mode       = params.mode ?? "auto";
      const maxResults = Math.min(params.max_results ?? 30, 100);
      const globArgs   = params.file_glob
        ? ["--glob", params.file_glob]
        : [];
      const includeHidden = params.include_hidden ?? shouldIncludeHidden(params.file_glob);
      const hiddenArgs = includeHidden ? ["--hidden"] : [];

      onUpdate?.({ content: [{ type: "text", text: `Searching (${mode}): "${params.query}"…` }] });

      // ── Structural search ─────────────────────────────────────────────────
      const tryStructural = async (): Promise<string> => {
        // Build a pattern that matches the query as a symbol name in a declaration
        const escapedQuery = params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const structPattern = [
          // TS: export function foo / class Foo / type Foo / interface Foo
          `(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${escapedQuery}\\b`,
          `(export\\s+)?(abstract\\s+)?class\\s+${escapedQuery}\\b`,
          `(export\\s+)?(type|interface)\\s+${escapedQuery}\\b`,
          `export\\s+(const|let)\\s+${escapedQuery}\\b`,
          // Rust: fn foo / struct Foo / enum Foo
          `(pub\\s+)?(async\\s+)?fn\\s+${escapedQuery}\\b`,
          `(pub\\s+)?(struct|enum|trait|type)\\s+${escapedQuery}\\b`,
          // Python/Go
          `def\\s+${escapedQuery}\\b`,
          `func\\s+([^)]*\\)\\s+)?${escapedQuery}\\b`,
        ].join("|");

        return rgRun(
          [
            "--no-heading",
            "--line-number",
            "--context", "2",
            "-e", structPattern,
            ...ignoredDirArgs(),
            ...hiddenArgs,
            ...globArgs,
          ],
          cwd,
          SEARCH_TIMEOUT,
        );
      };

      // ── Lexical search ────────────────────────────────────────────────────
      const tryLexical = async (): Promise<string> => {
        return rgRun(
          [
            "--no-heading",
            "--line-number",
            "--context", "2",
            "--smart-case",
            "--fixed-strings",
            params.query,
            ...ignoredDirArgs(),
            ...hiddenArgs,
            ...globArgs,
          ],
          cwd,
          SEARCH_TIMEOUT,
        );
      };

      let output = "";
      let usedMode = mode;

      if (mode === "structural") {
        output = await tryStructural();
      } else if (mode === "lexical") {
        output = await tryLexical();
      } else {
        // auto: structural first
        output = await tryStructural();
        if (!output.trim()) {
          output   = await tryLexical();
          usedMode = "lexical";
        }
      }

      if (!output.trim()) {
        return {
          content: [{
            type: "text",
            text: `No matches for "${params.query}" (mode: ${usedMode}).\n` +
              `Tried in: ${cwd}${includeHidden ? " (including hidden files)" : ""}\n` +
              `Tip: try mode='lexical' for text-only matches, add include_hidden=true for dot-directories, or check the repo map for nearby symbols.`,
          }],
          details: { query: params.query, mode: usedMode, matches: 0 },
        };
      }

      // Limit results
      const lines = output.split("\n").filter(l => l.trim());
      const limited = lines.slice(0, maxResults * 4); // ~4 lines per match (line + 2 context + separator)
      const truncatedCount = Math.max(0, lines.length - limited.length);

      let result = limited.join("\n");
      if (result.length > SEARCH_MAX_CHARS) {
        result = result.slice(0, SEARCH_MAX_CHARS) +
          `\n… [truncated — narrow with file_glob or a more specific query]`;
      }

      const header = `code_search "${params.query}" (${usedMode}) — ${limited.length} lines` +
        (truncatedCount > 0 ? `, ${truncatedCount} more omitted` : "");

      return {
        content: [{ type: "text", text: `${header}\n\n${result}` }],
        details: { query: params.query, mode: usedMode, lines: limited.length },
      };
    },
  });

  // ── /repo-map command ───────────────────────────────────────────────────────

  pi.registerCommand("repo-map", {
    description: "Show the current repo symbol map (rebuilds if stale)",
    handler: async (_args, ctx) => {
      state.dirty = true;
      await rebuildIndex(ctx.cwd);

      if (!state.skeleton) {
        ctx.ui.notify(
          "No recognised source files found.\n" +
          "Supported: TypeScript/JS (package.json), Rust (Cargo.toml), Python (pyproject.toml/setup.py), Go (go.mod).",
          "warning",
        );
        return;
      }

      ctx.ui.notify(state.skeleton, "info");
      const lines = state.skeleton.split("\n").length;
      ctx.ui.setStatus("repo-index", ctx.ui.theme.fg("dim", `idx:${lines}L`));
    },
  });
}
