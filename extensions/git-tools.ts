import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 12_000;

function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Math.floor(n ?? fallback)));
}

function truncate(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n… [truncated]`;
}

export function resolveGitSafePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const rel = relative(root, candidate).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside cwd: ${inputPath}`);
  return rel;
}

export function validateGitRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(ref)) throw new Error(`Unsafe git ref: ${ref}`);
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) throw new Error(`Unsafe git ref: ${ref}`);
  return ref;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 });
  return String(result.stdout ?? "");
}

export default function gitToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "commit_history",
    label: "Commit History",
    description: "Inspect recent git commit history without mutating repository state.",
    promptSnippet: "Inspect git commit history",
    promptGuidelines: [
      "Use instead of raw git log for repository history inspection.",
      "Never use raw git commit/add/reset/restore/clean/rebase/merge/push/stash; checkpoints are the only commit path.",
    ],
    parameters: Type.Object({
      max_count: Type.Optional(Type.Number({ description: "Maximum commits to show" })),
      path: Type.Optional(Type.String({ description: "Optional file/path scope" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const max = clamp(params.max_count, 1, 100, 20);
      const args = ["log", "--oneline", "--decorate", `--max-count=${max}`];
      if (params.path) args.push("--", resolveGitSafePath(ctx.cwd, params.path));
      const out = truncate(await git(ctx.cwd, args));
      return { content: [{ type: "text", text: out || "No commits found." }], details: { max_count: max, path: params.path } };
    },
  });

  pi.registerTool({
    name: "see_file_commit_history",
    label: "File Commit History",
    description: "Inspect git history for one file without mutating repository state.",
    promptSnippet: "Inspect file commit history",
    promptGuidelines: [
      "Use instead of raw git log --follow for file history.",
      "Never use raw git commit/add/reset/restore/clean/rebase/merge/push/stash; checkpoints are the only commit path.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      max_count: Type.Optional(Type.Number({ description: "Maximum commits to show" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const max = clamp(params.max_count, 1, 100, 20);
      const rel = resolveGitSafePath(ctx.cwd, params.path);
      const out = truncate(await git(ctx.cwd, ["log", "--follow", "--oneline", "--decorate", `--max-count=${max}`, "--", rel]));
      return { content: [{ type: "text", text: out || `No commits found for ${rel}.` }], details: { path: rel, max_count: max } };
    },
  });

  pi.registerTool({
    name: "inspect_at_checkpoint",
    label: "Inspect At Checkpoint",
    description: "Inspect a file as it existed at a commit/ref/checkpoint. Read-only and bounded.",
    promptSnippet: "Inspect file at git ref",
    promptGuidelines: [
      "Use instead of raw git show for historical file inspection.",
      "Pass a commit hash/ref and path; output is bounded and read-only.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "Commit hash, branch, tag, or checkpoint ref" }),
      path: Type.String({ description: "File path" }),
      max_chars: Type.Optional(Type.Number({ description: "Maximum output characters" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ref = validateGitRef(params.ref);
      const rel = resolveGitSafePath(ctx.cwd, params.path);
      const maxChars = clamp(params.max_chars, 500, 50_000, MAX_OUTPUT_CHARS);
      const out = truncate(await git(ctx.cwd, ["show", `${ref}:${rel}`]), maxChars);
      return { content: [{ type: "text", text: `${ref}:${rel}\n${out}` }], details: { ref, path: rel, max_chars: maxChars } };
    },
  });
}
