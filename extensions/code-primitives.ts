import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { inspectTextMatches, planReplacement, summarizePlan, type ReplacementEdit } from "./shared/code-primitives";

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
    async execute(_id, params) {
      const text = await readFile(params.path, "utf8");
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
        `> ${match.text}`,
        ...match.after.map(line => `  ${line}`),
      ]);

      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : `No matches in ${params.path}` }],
        details: { count: matches.length, matches },
      };
    },
  });

  pi.registerTool({
    name: "apply_code_replacements",
    label: "Apply Code Replacements",
    description: "Apply exact or regex replacements across files. Dry-run supported.",
    promptSnippet: "Batch text/regex replacements",
    promptGuidelines: ["Prefer exact oldText. Use dry_run before broad regex edits."],
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
      edits: Type.Array(Type.Object({
        path: Type.String({ description: "File path" }),
        oldText: Type.Optional(Type.String({ description: "Exact old text" })),
        regex: Type.Optional(Type.String({ description: "Regex pattern" })),
        flags: Type.Optional(Type.String({ description: "Regex flags" })),
        newText: Type.String({ description: "Replacement text" }),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches" })),
      }), { description: "Edits" }),
    }),
    async execute(_id, params) {
      const dryRun = params.dry_run ?? false;
      const plans = [];

      for (const edit of params.edits as ReplacementEdit[]) {
        const before = await readFile(edit.path, "utf8");
        plans.push(planReplacement(before, edit));
      }

      if (!dryRun) {
        for (const plan of plans) {
          if (plan.before !== plan.after) await writeFile(plan.path, plan.after, "utf8");
        }
      }

      const summary = plans.map(summarizePlan).join("\n");
      return {
        content: [{ type: "text", text: `${dryRun ? "Dry run" : "Applied"}:\n${summary}` }],
        details: { dryRun, plans: plans.map(plan => ({ path: plan.path, replacements: plan.replacements })) },
      };
    },
  });
}
