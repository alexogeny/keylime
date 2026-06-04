export type BashMutationHit = {
  label: string;
};

export type AutoCheckpointMode = "off" | "major" | "any";

export const PROTECTED_WRITE_PATHS = [
  ".env", ".env.local", ".env.production", ".env.staging", ".env.secret",
  "node_modules/", ".git/",
  "~/.ssh/", "~/.gnupg/", "~/.aws/credentials",
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
];

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
];

export function classifyBashMutation(command: string): BashMutationHit | null {
  for (const { pattern, label } of CODING_MODE_BASH_MUTATION_PATTERNS) {
    if (pattern.test(command)) return { label };
  }
  return null;
}

export function looksSideEffectfulBash(command: string): boolean {
  return classifyBashMutation(command) !== null || /(^|\s)(npm|pnpm|yarn|python|python3|pip|pytest|cargo|make)(\s|$)/.test(command);
}

export function runChecksCommandBlockReason(command: string, args: string[] = []): string | null {
  if (/\s/.test(command)) return "shell-style custom command strings can bypass coding file-mutation policy; pass command and args separately";
  const base = command.split("/").pop() ?? command;
  if (["sh", "bash", "zsh", "fish"].includes(base) && (args.includes("-c") || args.includes("-lc"))) return `${base} command strings can bypass coding file-mutation policy`;
  if (["python", "python3", "node", "bun", "perl", "ruby"].includes(base) && args.some(arg => arg === "-c" || arg === "-e")) return `${base} inline execution can bypass coding file-mutation policy`;
  if (base === "deno" && args.includes("eval")) return "deno eval can bypass coding file-mutation policy";
  return null;
}

export function mutationScoreForTool(toolName: string, input: any): number {
  if (["write", "edit"].includes(toolName)) return 8;
  if (toolName === "bash") return looksSideEffectfulBash(typeof input?.command === "string" ? input.command : "") ? 8 : 0;
  if (toolName === "create_directory") return 1;
  if (toolName === "create_file") return 2;
  if (toolName !== "apply_code_replacements" || input?.dry_run === true) return 0;
  if (input?.language || input?.file_glob) return 8;
  const edits = Array.isArray(input?.edits) ? input.edits : [];
  const paths = new Set(edits.map((edit: any) => edit?.path).filter(Boolean));
  return paths.size > 1 ? 8 : 3;
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
  if (["write", "edit", "create_file", "create_directory"].includes(toolName)) return typeof input?.path === "string" ? [input.path] : [];
  if (toolName !== "apply_code_replacements" || input?.dry_run === true) return [];

  const paths = new Set<string>();
  if (typeof input?.file_glob === "string") paths.add(input.file_glob);
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
    if (typeof edit?.path === "string") paths.add(edit.path);
  }
  return [...paths];
}
