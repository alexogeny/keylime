import { toPosixPath } from "./path-policy";

export type BashMutationHit = {
  label: string;
};

export type AutoCheckpointMode = "off" | "major" | "any";
export type MutationSeverity = "none" | "low" | "medium" | "high" | "critical";
export type MutationCategory =
  | "readonly"
  | "file_create"
  | "file_replace"
  | "directory_create"
  | "shell_mutation"
  | "runtime_eval"
  | "git_mutation"
  | "protected_path";

export interface MutationClassification {
  mutates: boolean;
  category: MutationCategory;
  severity: MutationSeverity;
  score: number;
  allowed: boolean;
  requiresConfirmation: boolean;
  checkpointScore: "none" | "minor" | "major";
  reasons: string[];
  matchedPolicies: string[];
  writePaths: string[];
}

function normalizeWritePathForPolicy(path: string): string {
  let normalized = toPosixPath(path);
  normalized = normalized.replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export const PROTECTED_WRITE_PATHS = [
  ".env", ".env.local", ".env.production", ".env.staging", ".env.secret",
  "node_modules/", ".git/",
  "~/.ssh/", "~/.gnupg/", "~/.aws/credentials",
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
];

const GIT_MUTATION_SUBCOMMANDS = new Set(["add", "commit", "reset", "restore", "checkout", "switch", "clean", "rebase", "merge", "push", "stash", "tag", "cherry-pick", "revert"]);
const FILE_MUTATION_COMMANDS = new Set(["touch", "mkdir", "rm", "cp", "mv", "chmod", "chown"]);
const NATIVE_REPO_INSPECTION_COMMANDS = new Set(["ls", "find", "grep", "egrep", "fgrep", "rg", "jq", "cat", "head", "tail", "sed", "wc"]);

const CODING_MODE_BASH_MUTATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:^|\s)cat\b[\s\S]*(?:^|[^<])>\s*[^\s&|;]+/im, label: "cat redirecting output to a file" },
  { pattern: /<<-?\s*['"]?\w+['"]?/m, label: "heredoc shell input" },
  { pattern: /\btee\b\s+(?:-[a-zA-Z]+\s+)*(?!\/dev\/null\b)[^\s|;&]+/i, label: "tee writing to a file" },
  { pattern: /(?:^|[\s;|&])(?:echo|printf)\b[\s\S]*(?:>>?|&>)\s*(?!\/dev\/null\b)[^\s|;&]+/i, label: "shell output redirection to a file" },
  { pattern: /(?:^|[\s;|&])(?:touch|mkdir|rm|cp|mv|chmod|chown)\b/i, label: "shell file mutation command" },
  { pattern: /\b(?:sh|bash|zsh|fish)\b\s+-c\b/i, label: "shell command string" },
  { pattern: /\bsed\b\s+(?:[^\n;&|]*\s)?(?:-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/i, label: "sed in-place edit" },
  { pattern: /\bperl\b[\s\S]*(?:\s-pi\b|\s-[a-zA-Z]*i[a-zA-Z]*\b|\s-e\s+['"][\s\S]*(?:open|write))/i, label: "perl file mutation" },
  { pattern: /\bruby\b[\s\S]*(?:\s-pi\b|\s-e\s+['"][\s\S]*(?:File\.(?:write|open)|\.write))/i, label: "ruby file mutation" },
  { pattern: /\bpython(?:3(?:\.\d+)?)?\b[\s\S]*\s-c\s+['"][\s\S]*(?:open\s*\([\s\S]*[,)]\s*['"](?:w|a|x|\+)|\.write\s*\()/i, label: "python inline file write" },
  { pattern: /\b(?:node|bun)\b[\s\S]*\s-e\s+['"][\s\S]*(?:writeFileSync|appendFileSync|createWriteStream|fs\.promises\.(?:writeFile|appendFile))/i, label: "javascript runtime inline file write" },
  { pattern: /\bdeno\b[\s\S]*\beval\b[\s\S]*(?:writeTextFile|writeFile)/i, label: "deno inline file write" },
  { pattern: /\bgit\s+(?:add|commit|reset|restore|checkout|switch|clean|rebase|merge|push|stash|tag|cherry-pick|revert)\b/i, label: "raw git mutation command" },
  { pattern: /(?:^|[\s;|&])(?:[^\s|;&]+\s+)*\d?>{1,2}\s*(?!\/dev\/null\b)[^\s|;&]+/i, label: "shell output redirection to a file" },
  { pattern: /(?:^|[\s;|&])(?:[^\s|;&]+\s+)*&>\s*(?!\/dev\/null\b)[^\s|;&]+/i, label: "shell output redirection to a file" },
];

export function classifyBashMutation(command: string): BashMutationHit | null {
  for (const { pattern, label } of CODING_MODE_BASH_MUTATION_PATTERNS) {
    if (pattern.test(command)) return { label };
  }
  return null;
}

export function classifyBashNativeRepoInspection(command: string): BashMutationHit | null {
  const segments = command.split(/&&|\|\||[;|]/).map(segment => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const withoutEnv = segment.replace(/^(?:env\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*/, "");
    const base = withoutEnv.match(/^([\w.-]+)/)?.[1]?.split("/").pop();
    if (base && NATIVE_REPO_INSPECTION_COMMANDS.has(base)) return { label: `${base} repository inspection; use list_files/inspect_text_matches/inspect_lines instead. If a safe tool cannot inspect the needed read-only path, ask the user to update Keylime rather than falling back to shell inspection.` };
  }
  return null;
}

export function looksSideEffectfulBash(command: string): boolean {
  return classifyBashMutation(command) !== null || /(^|\s)(npm|pnpm|yarn|bun|python|python3|pip|pytest|cargo|make)(\s|$)/.test(command);
}

const MUTATING_CHECK_ARGS = new Set(["--write", "--fix", "--fix-type", "--updateSnapshot", "-u"]);
const MUTATING_CHECK_SUBCOMMANDS = new Set(["fmt", "format", "install", "update", "generate", "gen", "scaffold"]);

export function runChecksCommandBlockReason(command: string, args: string[] = []): string | null {
  if (/\s/.test(command)) return "shell-style custom command strings can bypass coding file-mutation policy; pass command and args separately";
  const base = command.split("/").pop() ?? command;
  const reconstructed = [base, ...args].join(" ");
  const mutation = classifyBashMutation(reconstructed);
  if (mutation) return `${mutation.label} can bypass coding file-mutation policy`;
  if (["sh", "bash", "zsh", "fish"].includes(base) && (args.includes("-c") || args.includes("-lc"))) return `${base} command strings can bypass coding file-mutation policy`;
  if (["python", "python3", "node", "bun", "perl", "ruby"].includes(base) && args.some(arg => arg === "-c" || arg === "-e")) return `${base} inline execution can bypass coding file-mutation policy`;
  if (base === "deno" && args.includes("eval")) return "deno eval can bypass coding file-mutation policy";
  if (base === "git" && GIT_MUTATION_SUBCOMMANDS.has(args[0] ?? "")) return "raw git mutation command can bypass checkpoint policy";
  if (FILE_MUTATION_COMMANDS.has(base)) return "file mutation command can bypass coding file-mutation policy";
  const firstCommandArg = args.find(arg => !arg.startsWith("-")) ?? "";
  if (args.some(arg => MUTATING_CHECK_ARGS.has(arg) || arg.startsWith("--fix=") || arg.startsWith("--write="))) return "mutating check option can bypass verification-only policy";
  if (MUTATING_CHECK_SUBCOMMANDS.has(firstCommandArg)) return "mutating check subcommand can bypass verification-only policy";
  if (base === "cargo" && firstCommandArg === "fmt") return "cargo fmt can mutate repository files; use formatting tools explicitly, not run_checks";
  return null;
}

function checkpointScore(score: number): "none" | "minor" | "major" {
  if (score >= 8) return "major";
  if (score > 0) return "minor";
  return "none";
}

function severityForScore(score: number): MutationSeverity {
  if (score >= 10) return "critical";
  if (score >= 8) return "high";
  if (score >= 3) return "medium";
  if (score > 0) return "low";
  return "none";
}

function bashCategory(label: string): MutationCategory {
  if (/git mutation/i.test(label)) return "git_mutation";
  if (/inline|command string|eval|runtime/i.test(label)) return "runtime_eval";
  return "shell_mutation";
}

export function classifyToolMutation(toolName: string, input: any): MutationClassification {
  const writePaths = writePathsForTool(toolName, input);
  let score = 0;
  let category: MutationCategory = "readonly";
  const reasons: string[] = [];
  const matchedPolicies: string[] = [];

  if (["write", "edit"].includes(toolName)) {
    score = 8;
    category = "file_replace";
    reasons.push(`${toolName} can mutate repository files directly`);
    matchedPolicies.push("mutation.file-replacement");
  } else if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    const hit = classifyBashMutation(command);
    if (hit) {
      score = 8;
      category = bashCategory(hit.label);
      reasons.push(hit.label);
      matchedPolicies.push(category === "runtime_eval" ? "mutation.runtime-eval" : category === "git_mutation" ? "mutation.git-mutation" : "mutation.shell-mutation");
    } else if (looksSideEffectfulBash(command)) {
      score = 8;
      category = "shell_mutation";
      reasons.push("shell command may have side effects");
      matchedPolicies.push("mutation.shell-mutation");
    }
  } else if (toolName === "create_directory") {
    score = 1;
    category = "directory_create";
    reasons.push("directory creation");
    matchedPolicies.push("mutation.file-create");
  } else if (toolName === "create_file" || toolName === "begin_file_write") {
    score = 2;
    category = "file_create";
    reasons.push(toolName === "begin_file_write" ? "chunked file creation" : "file creation");
    matchedPolicies.push("mutation.file-create");
  } else if (toolName === "apply_code_replacements" && input?.dry_run !== true) {
    category = "file_replace";
    if (input?.language || input?.file_glob) {
      score = 8;
      reasons.push("broad replacement by language or glob");
    } else {
      const edits = Array.isArray(input?.edits) ? input.edits : [];
      const paths = new Set(edits.map((edit: any) => edit?.path).filter(Boolean));
      score = paths.size > 1 ? 8 : 3;
      reasons.push(paths.size > 1 ? "replacement spans multiple files" : "targeted file replacement");
    }
    matchedPolicies.push("mutation.file-replacement");
  }

  const protectedPath = writePaths.some(path => {
    const normalized = normalizeWritePathForPolicy(path);
    return PROTECTED_WRITE_PATHS.some(prefix => normalized === prefix || normalized.startsWith(prefix));
  });
  if (protectedPath) {
    score = Math.max(score, 10);
    category = "protected_path";
    reasons.push("writes protected path");
    matchedPolicies.push("mutation.protected-path");
  }

  return {
    mutates: score > 0,
    category,
    severity: severityForScore(score),
    score,
    allowed: category !== "protected_path",
    requiresConfirmation: score >= 8,
    checkpointScore: checkpointScore(score),
    reasons,
    matchedPolicies,
    writePaths,
  };
}

export function mutationScoreForTool(toolName: string, input: any): number {
  return classifyToolMutation(toolName, input).score;
}

export function autoCheckpointMode(value = process.env.KEYLIME_AUTO_CHECKPOINT): AutoCheckpointMode {
  if (value === "off" || value === "any" || value === "major") return value;
  return "major";
}

export function shouldAutoCheckpointTurn(score: number, lastCheckpointAt: number, now: number, mode: AutoCheckpointMode): boolean {
  const majorMutationScore = 8;
  const longIntervalMs = 45 * 60 * 1000;
  if (mode === "off" || score <= 0) return false;
  if (mode === "any") return true;
  return score >= majorMutationScore || now - lastCheckpointAt >= longIntervalMs;
}

export function writePathsForTool(toolName: string, input: any): string[] {
  if (["write", "edit", "create_file", "begin_file_write", "create_directory"].includes(toolName)) return typeof input?.path === "string" ? [input.path] : [];
  if (toolName !== "apply_code_replacements" || input?.dry_run === true) return [];

  const paths = new Set<string>();
  if (typeof input?.file_glob === "string") paths.add(input.file_glob);
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
    if (typeof edit?.path === "string") paths.add(edit.path);
  }
  return [...paths];
}
