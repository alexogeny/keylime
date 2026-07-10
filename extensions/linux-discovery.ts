import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCapabilityActive } from "./shared/intent";
import { normalizeAbs, preview, riskyFilesystemTarget, runCommand, textResult } from "./shared/linux-safety";

const linuxOpsGuidelines = [
  "Linux ops mode only: use these for read-only system discovery when repo-scoped tools are insufficient.",
  "Prefer narrow roots, globs, and max_results; avoid broad scans of /, /home, /usr, or package caches.",
  "These tools are read-only and never mutate files, package state, or services.",
];

const packageGuidelines = [
  "Read-only package metadata inspection; safe in programming mode when debugging installed tools/dependencies.",
  "Keep package names exact and bounded.",
];

const DEFAULT_EXCLUDES = [
  ".git", "node_modules", ".cache", "Cache", "CachedData", "CachedProfilesData", "klipper", "target", "dist", "build",
];
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._:@/-]*$/;

type CommandError = Error & { stdout?: string; stderr?: string; code?: number | null };

function requireLinuxOpsCapability(): void {
  if (!isCapabilityActive("linux")) throw new Error("This system discovery tool is only available under linux_ops/linux capability routing.");
}

function safeRoot(input: string): string {
  const root = normalizeAbs(input);
  const reason = riskyFilesystemTarget(root);
  if (reason) throw new Error(reason);
  return root;
}

function validateLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function validateDepth(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 20) throw new Error("max_depth must be between 0 and 20");
  return Math.floor(n);
}

function validatePattern(pattern: string, label: string): string {
  const value = String(pattern ?? "");
  if (!value || value.length > 500 || /[\0\r\n]/.test(value) || value.startsWith("-")) throw new Error(`Invalid ${label}`);
  return value;
}

function validatePackageName(pkg: string): string {
  const value = String(pkg ?? "").trim();
  if (!PACKAGE_NAME_RE.test(value) || value.startsWith("-")) throw new Error(`Invalid package name: ${pkg}`);
  return value;
}

function excludeFindArgs(excludes?: string[]): string[] {
  const values = [...DEFAULT_EXCLUDES, ...(excludes ?? [])].filter(Boolean).slice(0, 50);
  const args: string[] = [];
  for (const value of values) {
    const name = validatePattern(String(value), "exclude pattern");
    args.push("-name", name, "-prune", "-o");
  }
  return args;
}

function fileTypeArgs(type?: string): string[] {
  if (!type || type === "any") return [];
  if (type === "file") return ["-type", "f"];
  if (type === "directory") return ["-type", "d"];
  if (type === "symlink") return ["-type", "l"];
  throw new Error(`Unsupported file type: ${type}`);
}

function findBaseArgs(params: any): { root: string; args: string[]; maxResults: number } {
  const root = safeRoot(params.root ?? params.path ?? ".");
  const maxResults = validateLimit(params.max_results, 100, 1000);
  const args = [root];
  const depth = validateDepth(params.max_depth);
  if (depth !== undefined) args.push("-maxdepth", String(depth));
  args.push(...excludeFindArgs(params.exclude_names));
  return { root, args, maxResults };
}

async function runAllowNoMatches(command: string, args: string[], timeoutMs = 30_000) {
  try {
    return await runCommand({ command, args }, { timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const e = error as CommandError;
    if (e.code === 1) return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    throw error;
  }
}

function capLines(text: string, maxResults: number): { text: string; count: number; truncated: boolean } {
  const lines = text.split("\n").filter(Boolean);
  const kept = lines.slice(0, maxResults);
  const truncated = lines.length > kept.length;
  return { text: kept.join("\n") || "No matches", count: lines.length, truncated };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep_paths",
    label: "Grep Paths",
    description: "Linux ops only: read-only recursive grep over system/user paths with binary skips, excludes, and result caps.",
    promptGuidelines: linuxOpsGuidelines,
    parameters: Type.Object({
      root: Type.String(),
      query: Type.String(),
      regex: Type.Optional(Type.Boolean()),
      case_sensitive: Type.Optional(Type.Boolean()),
      file_glob: Type.Optional(Type.String()),
      exclude_names: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      max_chars: Type.Optional(Type.Number({ minimum: 500, maximum: 50000 })),
    }),
    async execute(_id: string, params: any) {
      requireLinuxOpsCapability();
      const root = safeRoot(params.root);
      const query = validatePattern(params.query, "grep query");
      const maxResults = validateLimit(params.max_results, 100, 1000);
      const args = ["-RIn", "--binary-files=without-match"];
      if (!params.regex) args.push("-F");
      if (!params.case_sensitive) args.push("-i");
      for (const ex of [...DEFAULT_EXCLUDES, ...(params.exclude_names ?? [])].slice(0, 50)) args.push("--exclude-dir", validatePattern(ex, "exclude pattern"));
      if (params.file_glob) args.push("--include", validatePattern(params.file_glob, "file_glob"));
      args.push("--", query, root);
      const r = await runAllowNoMatches("grep", args);
      const capped = capLines(r.stdout, maxResults);
      return textResult(preview(capped.text, validateLimit(params.max_chars, 12000, 50000)), { root, query, count: capped.count, truncated: capped.truncated });
    },
  });

  pi.registerTool({
    name: "find_paths",
    label: "Find Paths",
    description: "Linux ops only: read-only find wrapper for names/globs/types under one bounded root.",
    promptGuidelines: linuxOpsGuidelines,
    parameters: Type.Object({
      root: Type.String(),
      name_glob: Type.Optional(Type.String()),
      path_glob: Type.Optional(Type.String()),
      type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink"), Type.Literal("any")])),
      max_depth: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      exclude_names: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id: string, params: any) {
      requireLinuxOpsCapability();
      const { root, args, maxResults } = findBaseArgs(params);
      args.push(...fileTypeArgs(params.type));
      if (params.name_glob) args.push("-name", validatePattern(params.name_glob, "name_glob"));
      if (params.path_glob) args.push("-path", validatePattern(params.path_glob, "path_glob"));
      args.push("-print");
      const r = await runCommand({ command: "find", args }, { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
      const capped = capLines(r.stdout, maxResults);
      return textResult(capped.text, { root, count: capped.count, truncated: capped.truncated });
    },
  });

  pi.registerTool({
    name: "file_tree_matches",
    label: "File Tree Matches",
    description: "Linux ops only: combine find + grep to locate files by path/name and optional content query; path-only output by default.",
    promptGuidelines: linuxOpsGuidelines,
    parameters: Type.Object({
      root: Type.String(),
      query: Type.Optional(Type.String()),
      name_glob: Type.Optional(Type.String()),
      max_depth: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      exclude_names: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
      paths_only: Type.Optional(Type.Boolean()),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id: string, params: any) {
      requireLinuxOpsCapability();
      const { root, args, maxResults } = findBaseArgs(params);
      args.push("-type", "f");
      if (params.name_glob) args.push("-name", validatePattern(params.name_glob, "name_glob"));
      if (!params.query) {
        args.push("-print");
        const r = await runCommand({ command: "find", args }, { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
        const capped = capLines(r.stdout, maxResults);
        return textResult(capped.text, { root, count: capped.count, truncated: capped.truncated, content_query: false });
      }
      args.push("-exec", "grep", params.paths_only === false ? "-InH" : "-Il", "--binary-files=without-match", "-F", "--", validatePattern(params.query, "content query"), "{}", "+");
      const r = await runAllowNoMatches("find", args, 45_000);
      const capped = capLines(r.stdout, maxResults);
      return textResult(capped.text, { root, count: capped.count, truncated: capped.truncated, content_query: true });
    },
  });

  pi.registerTool({
    name: "inspect_package_metadata",
    label: "Inspect Package Metadata",
    description: "Read-only package metadata for OS and developer package managers (auto-detects apt/dpkg, pacman, npm, pip when available).",
    promptGuidelines: packageGuidelines,
    parameters: Type.Object({
      packages: Type.Array(Type.String(), { minItems: 1, maxItems: 30 }),
      manager: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("apt"), Type.Literal("dpkg"), Type.Literal("pacman"), Type.Literal("npm"), Type.Literal("pip")])),
    }),
    async execute(_id: string, params: any) {
      const packages = (params.packages ?? []).map(validatePackageName);
      const manager = params.manager ?? "auto";
      const sections: string[] = [];
      async function add(label: string, command: string, args: string[]) {
        try {
          const r = await runAllowNoMatches(command, args, 20_000);
          if ((r.stdout || r.stderr).trim()) sections.push(`## ${label}\n${r.stdout || r.stderr}`);
        } catch (error) {
          sections.push(`## ${label}\n${(error as Error).message}`);
        }
      }
      if (manager === "auto" || manager === "apt" || manager === "dpkg") await add("dpkg-query", "dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${Status}\n", ...packages]);
      if (manager === "auto" || manager === "pacman") await add("pacman", "pacman", ["-Qi", ...packages]);
      if (manager === "auto" || manager === "npm") {
        for (const pkg of packages) await add(`npm view ${pkg}`, "npm", ["view", pkg, "name", "version", "description", "repository", "--json"]);
      }
      if (manager === "auto" || manager === "pip") {
        for (const pkg of packages) await add(`pip show ${pkg}`, "python", ["-m", "pip", "show", pkg]);
      }
      return textResult(preview(sections.join("\n\n") || "No package metadata found", 30000), { packages, manager });
    },
  });
}
