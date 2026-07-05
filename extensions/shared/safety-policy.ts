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
  const absolute = normalized.startsWith("/");
  normalized = normalized.replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export const PROTECTED_WRITE_PATHS = [
  ".env", ".env.local", ".env.production", ".env.staging", ".env.secret",
  "node_modules/", ".git/",
  "~/.ssh/", "~/.gnupg/", "~/.aws/credentials",
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
];

const GIT_MUTATION_SUBCOMMANDS = new Set(["add", "commit", "reset", "restore", "checkout", "switch", "clean", "rebase", "merge", "push", "stash", "tag", "cherry-pick", "revert"]);
const FILE_MUTATION_COMMANDS = new Set(["touch", "mkdir", "rm", "cp", "mv", "chmod", "chown", "ln", "install", "truncate", "dd"]);
const NATIVE_REPO_INSPECTION_COMMANDS = new Set([
  "ls", "find", "grep", "egrep", "fgrep", "rg", "jq", "cat", "head", "tail", "sed", "awk", "wc", "cut", "sort", "uniq", "tr", "nl", "less", "more", "tree", "stat", "file", "strings", "od", "xxd", "hexdump", "diff", "cmp", "comm", "xargs", "echo", "printf",
]);
const UNSAFE_BASH_FALLBACK_COMMANDS = new Set([
  "true", "false", "pwd", "env", "printenv", "which", "command", "type", "whereis", "readlink", "realpath", "basename", "dirname", "test", "[",
  "git", "curl", "wget", "http", "httpie", "nc", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet",
  "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "lua", "Rscript", "go", "cargo", "make", "npm", "pnpm", "yarn", "npx",
  "vi", "vim", "nvim", "nano", "emacs", "ed", "ex", "tee", "touch", "mkdir", "rm", "cp", "mv", "chmod", "chown", "ln", "install", "truncate", "dd",
]);

const COMMAND_WRAPPER_NAMES = new Set(["sudo", "doas", "pkexec", "command"]);

function shellSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|]/).map(segment => segment.trim()).filter(Boolean);
}

function tokenizeShellSegment(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(token => token.replace(/^['"]|['"]$/g, "")) ?? [];
}

function unwrapCommandTokens(tokens: string[]): string[] {
  let rest = [...tokens];
  if (rest[0] === "env") {
    rest = rest.slice(1);
    while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift();
  } else {
    while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift();
  }

  while (rest.length > 0) {
    const base = rest[0]!.split("/").pop() ?? rest[0]!;
    if (!COMMAND_WRAPPER_NAMES.has(base)) break;
    rest = rest.slice(1);
    while (rest[0]?.startsWith("-")) {
      const option = rest.shift();
      if (option === "-p" || option === "--prompt" || option === "-u" || option === "--user" || option === "-g" || option === "--group") rest.shift();
    }
  }
  return rest;
}

function effectiveCommandSegment(segment: string): string {
  return unwrapCommandTokens(tokenizeShellSegment(segment)).join(" ");
}

function effectiveBaseAndArgs(command: string, args: string[] = []): { base: string; args: string[]; reconstructed: string } {
  const tokens = unwrapCommandTokens([command, ...args]);
  const base = tokens[0]?.split("/").pop() ?? "";
  const rest = tokens.slice(1);
  return { base, args: rest, reconstructed: [base, ...rest].join(" ") };
}

const CODING_MODE_BASH_MUTATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:^|\s)cat\b[\s\S]*(?:^|[^<])>\s*[^\s&|;]+/im, label: "cat redirecting output to a file" },
  { pattern: /<<-?\s*['"]?\w+['"]?/m, label: "heredoc shell input" },
  { pattern: /\btee\b\s+(?:-[a-zA-Z]+\s+)*(?!\/dev\/null\b)[^\s|;&]+/i, label: "tee writing to a file" },
  { pattern: /(?:^|[\s;|&])(?:echo|printf)\b[\s\S]*(?:>>?|&>)\s*(?!\/dev\/null\b)[^\s|;&]+/i, label: "shell output redirection to a file" },
  { pattern: /(?:^|[;|&]\s*)(?:touch|mkdir|rm|cp|mv|chmod|chown|ln|install|truncate|dd)\b/i, label: "shell file mutation command" },
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
  const candidates = [command, ...shellSegments(command).map(effectiveCommandSegment).filter(Boolean)];
  for (const candidate of candidates) {
    for (const { pattern, label } of CODING_MODE_BASH_MUTATION_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(candidate)) return { label };
    }
  }
  return null;
}

export function classifyBashNativeRepoInspection(command: string): BashMutationHit | null {
  for (const segment of shellSegments(command)) {
    const effective = effectiveCommandSegment(segment);
    const base = effective.match(/^([^\s|;&]+)/)?.[1]?.split("/").pop();
    if (base && NATIVE_REPO_INSPECTION_COMMANDS.has(base)) return { label: `${base} repository inspection; use list_files/inspect_text_matches/inspect_lines instead. If a safe tool cannot inspect the needed read-only path, ask the user to update Keylime rather than falling back to shell inspection.` };
    if (base && UNSAFE_BASH_FALLBACK_COMMANDS.has(base)) return { label: `${base} shell fallback; use exposed Keylime tools such as run_checks, fetch_url, git_status/git_diff, or file primitives instead.` };
  }
  return null;
}

export function looksSideEffectfulBash(command: string): boolean {
  const effective = shellSegments(command).map(effectiveCommandSegment).join("; ");
  return classifyBashMutation(command) !== null || /(^|\s)(npm|pnpm|yarn|bun|python|python3|pip|pytest|cargo|make)(\s|$)/.test(effective || command);
}

const MUTATING_CHECK_ARGS = new Set(["--write", "--fix", "--fix-type", "--updateSnapshot", "-u"]);
const MUTATING_CHECK_SUBCOMMANDS = new Set(["fmt", "format", "install", "update", "generate", "gen", "scaffold"]);

export function runChecksCommandBlockReason(command: string, args: string[] = []): string | null {
  if (/\s/.test(command)) return "shell-style custom command strings can bypass coding file-mutation policy; pass command and args separately";
  const { base, args: effectiveArgs, reconstructed } = effectiveBaseAndArgs(command, args);
  const mutation = classifyBashMutation(reconstructed);
  if (mutation) return `${mutation.label} can bypass coding file-mutation policy`;
  if (["sh", "bash", "zsh", "fish"].includes(base) && (effectiveArgs.includes("-c") || effectiveArgs.includes("-lc"))) return `${base} command strings can bypass coding file-mutation policy`;
  if (["python", "python3", "node", "bun", "perl", "ruby"].includes(base) && effectiveArgs.some(arg => arg === "-c" || arg === "-e")) return `${base} inline execution can bypass coding file-mutation policy`;
  if (base === "deno" && effectiveArgs.includes("eval")) return "deno eval can bypass coding file-mutation policy";
  if (base === "git" && GIT_MUTATION_SUBCOMMANDS.has(effectiveArgs[0] ?? "")) return "raw git mutation command can bypass checkpoint policy";
  if (FILE_MUTATION_COMMANDS.has(base)) return "file mutation command can bypass coding file-mutation policy";
  const firstCommandArg = effectiveArgs.find(arg => !arg.startsWith("-")) ?? "";
  if (effectiveArgs.some(arg => MUTATING_CHECK_ARGS.has(arg) || arg.startsWith("--fix=") || arg.startsWith("--write="))) return "mutating check option can bypass verification-only policy";
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

const LINUX_SYSTEM_MUTATION_TOOLS = new Set([
  "apt_install", "pacman_install", "systemd_restart", "systemd_enable", "systemd_disable",
  "backup_system_file", "restore_system_file_backup", "apply_system_file_patch",
  "safe_delete", "archive_path", "apply_permissions_change", "kill_process",
]);
const PROFILING_RUN_TOOLS = new Set(["run_python_profile", "run_typescript_profile", "run_rust_profile"]);

function isSmallTargetedReplacementBatch(edits: any[]): boolean {
  if (edits.length === 0 || edits.length > 8) return false;
  const paths = new Set<string>();
  for (const edit of edits) {
    if (typeof edit?.path !== "string") return false;
    paths.add(edit.path);
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") return false;
    if (edit.regex || edit.replaceAll === true) return false;
    if (edit.oldText.length > 2_000 || edit.newText.length > 2_000) return false;
    const maxReplacements = Number(edit.expectedReplacements ?? edit.maxReplacements ?? 1);
    if (!Number.isFinite(maxReplacements) || maxReplacements > 3) return false;
  }
  return paths.size > 1 && paths.size <= 5;
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
  } else if (["create_file", "finish_file_write", "copy_file", "create_reporter_document", "convert_document", "create_chart"].includes(toolName)) {
    score = 2;
    category = "file_create";
    reasons.push(toolName === "finish_file_write" ? "chunked file creation finalized" : toolName === "copy_file" ? "file copy" : toolName === "convert_document" ? "document conversion" : toolName === "create_reporter_document" ? "reporter document creation" : "file creation");
    matchedPolicies.push("mutation.file-create");
  } else if (["delete_file", "move_file", "replace_file"].includes(toolName)) {
    score = 3;
    category = "file_replace";
    reasons.push(`${toolName} mutates repository files`);
    matchedPolicies.push("mutation.file-replacement");
  } else if (toolName === "apply_code_replacements" && input?.dry_run !== true) {
    category = "file_replace";
    if (input?.language || input?.file_glob) {
      score = 8;
      reasons.push("broad replacement by language or glob");
    } else {
      const edits = Array.isArray(input?.edits) ? input.edits : [];
      const paths = new Set(edits.map((edit: any) => edit?.path).filter(Boolean));
      if (isSmallTargetedReplacementBatch(edits)) {
        score = 3;
        reasons.push(`small targeted replacements across ${paths.size} files`);
      } else {
        score = paths.size > 1 ? 8 : 3;
        reasons.push(paths.size > 1 ? "replacement spans multiple files" : "targeted file replacement");
      }
    }
    matchedPolicies.push("mutation.file-replacement");
  } else if (LINUX_SYSTEM_MUTATION_TOOLS.has(toolName)) {
    score = ["apt_install", "pacman_install", "systemd_restart", "systemd_enable", "systemd_disable", "kill_process"].includes(toolName) ? 8 : 3;
    category = writePaths.length > 0 ? "file_replace" : "shell_mutation";
    reasons.push(`${toolName} mutates the local Linux system`);
    matchedPolicies.push("mutation.linux-system");
  } else if (PROFILING_RUN_TOOLS.has(toolName)) {
    score = 8;
    category = "shell_mutation";
    reasons.push(`${toolName} executes project code for profiling`);
    matchedPolicies.push("mutation.profile-execution");
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

export function classifyToolResultMutation(event: { toolName: string; input?: any; details?: any; isError?: boolean }): MutationClassification {
  if (event.isError || event.details?.skipped === true || event.details?.aborted === true) {
    return classifyToolMutation("readonly", {});
  }
  if (event.toolName === "finish_file_write") {
    return classifyToolMutation("finish_file_write", { path: event.details?.path });
  }
  return classifyToolMutation(event.toolName, event.input ?? {});
}

export function mutationScoreForToolResult(event: { toolName: string; input?: any; details?: any; isError?: boolean }): number {
  return classifyToolResultMutation(event).score;
}

export function writePathsForToolResult(event: { toolName: string; input?: any; details?: any; isError?: boolean }): string[] {
  return classifyToolResultMutation(event).writePaths;
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
  if (["write", "edit", "create_file", "begin_file_write", "finish_file_write", "create_directory", "delete_file", "replace_file", "create_reporter_document", "create_chart", "backup_system_file", "apply_system_file_patch", "safe_delete", "apply_permissions_change"].includes(toolName)) return typeof input?.path === "string" ? [input.path] : [];
  if (toolName === "archive_path") return [input?.path, input?.output].filter((path): path is string => typeof path === "string");
  if (["move_file", "copy_file"].includes(toolName)) return [input?.from_path, input?.to_path].filter((path): path is string => typeof path === "string");
  if (toolName === "restore_system_file_backup") return [input?.backup, input?.destination].filter((path): path is string => typeof path === "string");
  if (toolName === "convert_document") return typeof input?.output_path === "string" ? [input.output_path] : [];
  if (toolName !== "apply_code_replacements" || input?.dry_run === true) return [];

  const paths = new Set<string>();
  if (typeof input?.file_glob === "string") paths.add(input.file_glob);
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
    if (typeof edit?.path === "string") paths.add(edit.path);
  }
  return [...paths];
}
