/**
 * danger-guard — intercepts destructive operations and asks for confirmation.
 * Integrates with git-checkpoint: if a checkpoint exists this session, the
 * confirmation dialog says so, making it easier to allow risky ops safely.
 *
 * Configure extra rules in:
 *   ~/.config/pi-agent-extensions/danger-guard/rules.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Pattern definitions ────────────────────────────────────────────────────

interface DangerPattern {
  pattern: RegExp;
  label: string;
  severity: "warn" | "block"; // "block" = never allow without confirmation
}

const BUILTIN_PATTERNS: DangerPattern[] = [
  // Recursive deletes
  { pattern: /\brm\b[\s\S]*\s-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i, label: "rm -rf (recursive force delete)", severity: "block" },
  { pattern: /\brm\b.*--no-preserve-root/i, label: "rm --no-preserve-root", severity: "block" },
  // Git danger
  { pattern: /git\s+push\s+(.*\s)?-f\b/, label: "git push -f (force push)", severity: "warn" },
  { pattern: /git\s+push\s+.*--force(?!-with-lease)/, label: "git push --force", severity: "warn" },
  { pattern: /git\s+reset\s+--hard/, label: "git reset --hard", severity: "warn" },
  { pattern: /git\s+clean\s+.*-f/, label: "git clean -f", severity: "warn" },
  { pattern: /git\s+stash\s+drop/, label: "git stash drop", severity: "warn" },
  // Privileged execution
  { pattern: /\bsudo\b/, label: "sudo", severity: "warn" },
  { pattern: /\bsu\s+-\b/, label: "su - (switch to root)", severity: "block" },
  // Database danger
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i, label: "SQL DROP statement", severity: "block" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, label: "SQL TRUNCATE TABLE", severity: "block" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*;/i, label: "unbounded SQL DELETE (no WHERE clause)", severity: "warn" },
  // Disk danger
  { pattern: /\bdd\b.*of=\/dev\//i, label: "dd writing to block device", severity: "block" },
  { pattern: /\bmkfs\./i, label: "mkfs (format filesystem)", severity: "block" },
  { pattern: />\s*\/dev\/sd[a-z]\b/i, label: "redirect to block device", severity: "block" },
  // Process danger
  { pattern: /\bkillall\b|\bpkill\b.*-9/i, label: "killall / pkill -9", severity: "warn" },
  // NPM/Cargo publish
  { pattern: /\bnpm\s+publish\b/, label: "npm publish", severity: "warn" },
  { pattern: /\bcargo\s+publish\b/, label: "cargo publish", severity: "warn" },
];

const PROTECTED_WRITE_PATHS: string[] = [
  ".env", ".env.local", ".env.production", ".env.staging", ".env.secret",
  "node_modules/", ".git/",
  "~/.ssh/", "~/.gnupg/", "~/.aws/credentials",
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
];

// ─── Rules file ─────────────────────────────────────────────────────────────

const RULES_DIR  = path.join(os.homedir(), ".config", "pi-agent-extensions", "danger-guard");
const RULES_FILE = path.join(RULES_DIR, "rules.json");

interface Rules {
  extraPatterns?: Array<{ pattern: string; label: string; severity?: "warn" | "block" }>;
  extraProtectedPaths?: string[];
  alwaysAllow?: string[];   // substrings — skip guard entirely
  disabled?: boolean;
}

function loadRules(): Rules {
  try {
    if (fs.existsSync(RULES_FILE)) return JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
  } catch { /* ignore */ }
  return {};
}

function ensureRulesDir() {
  try { fs.mkdirSync(RULES_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ─── Detection helpers ───────────────────────────────────────────────────────

function checkCommand(cmd: string, rules: Rules): { flagged: boolean; label: string; severity: "warn" | "block" } | null {
  if (rules.disabled) return null;
  for (const allow of rules.alwaysAllow ?? []) {
    if (cmd.includes(allow)) return null;
  }
  for (const { pattern, label, severity } of BUILTIN_PATTERNS) {
    if (pattern.test(cmd)) return { flagged: true, label, severity };
  }
  for (const { pattern, label, severity } of rules.extraPatterns ?? []) {
    if (new RegExp(pattern, "i").test(cmd)) {
      return { flagged: true, label, severity: severity ?? "warn" };
    }
  }
  return null;
}

function checkPath(filePath: string, rules: Rules): boolean {
  if (rules.disabled) return false;
  const allProtected = [...PROTECTED_WRITE_PATHS, ...(rules.extraProtectedPaths ?? [])];
  const expanded = filePath.replace(/^~/, os.homedir());
  return allProtected.some(p => expanded.includes(p.replace(/^~/, os.homedir())));
}

function writePathsForTool(toolName: string, input: any): string[] {
  if (["write", "edit"].includes(toolName)) return typeof input?.path === "string" ? [input.path] : [];
  if (toolName !== "apply_code_replacements" || input?.dry_run === true) return [];

  const paths = new Set<string>();
  if (typeof input?.file_glob === "string") paths.add(input.file_glob);
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
    if (typeof edit?.path === "string") paths.add(edit.path);
  }
  return [...paths];
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  ensureRulesDir();
  const rules = loadRules();

  pi.on("tool_call", async (event, ctx) => {
    // ── Bash: pattern matching ──────────────────────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command ?? "";
      const hit = checkCommand(cmd, rules);
      if (!hit) return;

      // Check if git-checkpoint extension has created a checkpoint this session
      const hasCheckpoint = ctx.sessionManager
        .getEntries()
        .some((e: any) => e.type === "custom" && e.customType === "git-checkpoint");

      const safetyNote = hasCheckpoint
        ? "✅ A git checkpoint exists — /undo is available if this goes wrong."
        : "⚠️  No git checkpoint — consider /checkpoint first so you can /undo.";

      const ok = await ctx.ui.confirm(
        `⛔ Dangerous: ${hit.label}`,
        `Command:\n\`${cmd.slice(0, 200)}\`\n\n${safetyNote}\n\nProceed?`
      );
      if (!ok) return { block: true, reason: `danger-guard blocked: ${hit.label}` };
    }

    // ── File-writing tools: protected path check ────────────────────────────
    const protectedPaths = writePathsForTool(event.toolName, (event as any).input).filter(p => checkPath(p, rules));
    if (protectedPaths.length > 0) {
      const label = protectedPaths.slice(0, 5).join(", ");
      const ok = await ctx.ui.confirm(
        `⛔ Protected path: ${label}`,
        `Writing to this path may be sensitive.\n\nProceed?`
      );
      if (!ok) return { block: true, reason: `danger-guard blocked write to protected path: ${label}` };
    }
  });

  // ── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("danger-rules", {
    description: "Show danger-guard active patterns and protected paths",
    handler: async (_args, ctx) => {
      const lines = [
        `Built-in patterns: ${BUILTIN_PATTERNS.length}`,
        `Protected paths: ${PROTECTED_WRITE_PATHS.length}`,
        `Rules file: ${RULES_FILE}`,
        `Status: ${rules.disabled ? "DISABLED" : "active"}`,
        rules.alwaysAllow?.length ? `Always allow: ${rules.alwaysAllow.join(", ")}` : "",
        rules.extraPatterns?.length ? `Extra patterns: ${rules.extraPatterns.length}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
