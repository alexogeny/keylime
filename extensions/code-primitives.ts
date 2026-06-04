import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
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
} from "./shared/code-primitives";

async function readTextFileSafely(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const buffer = await readFile(path);
  if (isProbablyBinary(buffer)) throw new Error(`Refusing to read probable binary file: ${path}`);
  return buffer.toString("utf8");
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const rel = relative(root, path).replace(/\\/g, "/");
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
    const rel = relative(cwd, path).replace(/\\/g, "/");
    if (shouldExcludePath(rel, options.exclude_globs)) return false;
    if (options.file_glob && !matchesGlob(rel, options.file_glob)) return false;
    if (!matchesLanguage(rel, options.language)) return false;
    return true;
  });
}

export default function codePrimitivesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "inspect_text_matches",
    label: "Inspect Text Matches",
    description: "Find text or regex matches in one file with line/context output.",
    promptSnippet: "Inspect file text matches",
    promptGuidelines: ["Use before broad replacements."],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      query: Type.String({ description: "Text or regex" }),
      regex: Type.Optional(Type.Boolean({ description: "Regex mode" })),
      case_sensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive" })),
      context_lines: Type.Optional(Type.Number({ description: "Context lines" })),
      max_matches: Type.Optional(Type.Number({ description: "Max matches" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const text = await readTextFileSafely(path);
      const matches = inspectTextMatches(text, {
        query: params.query,
        regex: params.regex,
        caseSensitive: params.case_sensitive,
        contextLines: params.context_lines,
        maxMatches: params.max_matches,
      });

      const lines = matches.flatMap(match => [
        `${params.path}:${match.line}:${match.column} ${match.text}`,
        ...match.before.map(line => `  ${line}`),
        `> ${match.lineText}`,
        ...match.after.map(line => `  ${line}`),
      ]);

      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : `No matches in ${params.path}` }],
        details: { count: matches.length, matches },
      };
    },
  });

  pi.registerTool({
    name: "inspect_code_structure",
    label: "Inspect Code Structure",
    description: "Extract imports and top-level declarations from one file using lightweight language regexes.",
    promptSnippet: "Inspect imports/declarations",
    promptGuidelines: ["Use for quick structure checks before codemods."],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      language: StringEnum(["typescript", "javascript", "python", "rust"] as const),
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
    name: "apply_code_replacements",
    label: "Apply Code Replacements",
    description: "Apply exact or regex replacements across files. Supports globs, languages, dry-run previews, match modes, and count guards.",
    promptSnippet: "Batch text/regex replacements",
    promptGuidelines: ["Prefer exact oldText. Use dry_run before broad regex/glob edits."],
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
      file_glob: Type.Optional(Type.String({ description: "Target glob" })),
      language: Type.Optional(StringEnum(["typescript", "javascript", "python", "rust"] as const)),
      exclude_globs: Type.Optional(Type.Array(Type.String(), { description: "Extra excludes" })),
      edits: Type.Array(Type.Object({
        path: Type.Optional(Type.String({ description: "File path" })),
        oldText: Type.Optional(Type.String({ description: "Exact old text" })),
        regex: Type.Optional(Type.String({ description: "Regex pattern" })),
        flags: Type.Optional(Type.String({ description: "Regex flags" })),
        newText: Type.String({ description: "Replacement text" }),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches" })),
        matchMode: Type.Optional(StringEnum(["exact", "trimmed_lines", "normalized_whitespace"] as const)),
        expectedReplacements: Type.Optional(Type.Number({ description: "Expected replacements" })),
        minReplacements: Type.Optional(Type.Number({ description: "Minimum replacements" })),
        maxReplacements: Type.Optional(Type.Number({ description: "Maximum replacements" })),
      }), { description: "Edits" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dryRun = params.dry_run ?? false;
      const targets = await collectTargetFiles(ctx.cwd, {
        file_glob: params.file_glob,
        language: params.language as Language | undefined,
        exclude_globs: params.exclude_globs,
      });
      const plans = [];

      for (const rawEdit of params.edits as ReplacementEdit[]) {
        const paths = rawEdit.path ? [resolveSafePath(ctx.cwd, rawEdit.path)] : targets;
        if (paths.length === 0) throw new Error(`No target files for edit; provide path, file_glob, or language`);
        for (const path of paths) {
          const edit = { ...rawEdit, path };
          const before = await readTextFileSafely(path);
          plans.push(planReplacement(before, edit));
        }
      }

      if (!dryRun) {
        for (const plan of plans) {
          if (plan.before !== plan.after) await writeFile(plan.path, plan.after, "utf8");
        }
      }

      const summary = plans.map(plan => {
        const preview = formatPlanPreview(plan);
        return preview ? `${summarizePlan(plan)}\n${preview}` : summarizePlan(plan);
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `${dryRun ? "Dry run" : "Applied"}:\n${summary}` }],
        details: { dryRun, plans: plans.map(plan => ({ path: plan.path, replacements: plan.replacements, previews: plan.previews })) },
      };
    },
  });
}
