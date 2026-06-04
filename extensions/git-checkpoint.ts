/**
 * git-checkpoint — creates rollback commits before side-effectful tool calls.
 * Works in any git repo.
 *
 * Commands:
 *   /checkpoint        — manual checkpoint
 *   /undo              — hard-reset to the last checkpoint
 *   /checkpoint-log    — list checkpoints created this session
 *
 * Integrates with danger-guard: that extension checks for "git-checkpoint"
 * custom session entries to show a safety note in its confirmation dialogs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// ─── Git helpers ─────────────────────────────────────────────────────────────

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function getCurrentHash(cwd: string): string | null {
  try { return execSync("git rev-parse HEAD", { cwd }).toString().trim(); }
  catch { return null; }
}

function getCurrentBranch(cwd: string): string {
  try { return execSync("git branch --show-current", { cwd }).toString().trim() || "HEAD"; }
  catch { return "unknown"; }
}

function hasChanges(cwd: string): boolean {
  try { return execSync("git status --porcelain", { cwd }).toString().trim().length > 0; }
  catch { return false; }
}

interface Checkpoint {
  hash: string;
  branch: string;
  cwd: string;
  ts: string;
  hadChanges: boolean;
}

function makeCheckpoint(cwd: string): Checkpoint | null {
  if (!isGitRepo(cwd)) return null;

  const branch   = getCurrentBranch(cwd);
  const changed  = hasChanges(cwd);

  if (changed) {
    try {
      execSync("git add -A", { cwd });
      const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      execSync(`git commit -m "pi: checkpoint ${ts}" --no-verify --quiet`, { cwd });
    } catch { return null; }
  }

  const hash = getCurrentHash(cwd);
  if (!hash) return null;

  return {
    hash,
    branch,
    cwd,
    ts: new Date().toISOString(),
    hadChanges: changed,
  };
}

export function looksSideEffectfulBash(command: string): boolean {
  return /(^|\s)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|git\s+(commit|reset|checkout|switch|merge|rebase|clean|add)|npm|pnpm|yarn|bun|pip|python|pytest|cargo|make)(\s|$)/.test(command);
}

export function shouldCheckpointTool(toolName: string, input: any): boolean {
  if (["write", "edit", "create_file"].includes(toolName)) return true;
  if (toolName === "apply_code_replacements") return input?.dry_run !== true;
  if (toolName !== "bash") return false;
  const command = typeof input?.command === "string" ? input.command : "";
  return looksSideEffectfulBash(command);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track the most recent checkpoint in memory (also in session for danger-guard)
  let latestCheckpoint: Checkpoint | null = null;

  function recordCheckpoint(cp: Checkpoint, ctx: any): void {
    latestCheckpoint = cp;
    pi.appendEntry("git-checkpoint", cp);
    const label = cp.hadChanges
      ? `📍 ${cp.hash.slice(0, 7)} (committed ${cp.branch})`
      : `📍 ${cp.hash.slice(0, 7)} (clean)`;
    ctx.ui.setStatus("checkpoint", label);
  }

  // ── Auto-checkpoint before side-effectful tools ─────────────────────────

  pi.on("tool_call", async (event: any, ctx) => {
    if (!shouldCheckpointTool(event.toolName, event.input)) return;
    const cwd = ctx.cwd;
    if (!isGitRepo(cwd) || !hasChanges(cwd)) return;

    const cp = makeCheckpoint(cwd);
    if (!cp?.hadChanges) return;
    recordCheckpoint(cp, ctx);
  });

  // ── Restore checkpoint state across session restarts ────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const cpEntries = entries.filter(
      (e: any) => e.type === "custom" && e.customType === "git-checkpoint"
    );
    if (cpEntries.length > 0) {
      latestCheckpoint = (cpEntries[cpEntries.length - 1] as any).data as Checkpoint;
      if (latestCheckpoint) {
        ctx.ui.setStatus("checkpoint", `📍 ${latestCheckpoint.hash.slice(0, 7)}`);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    latestCheckpoint = null;
  });

  // ── /checkpoint ─────────────────────────────────────────────────────────

  pi.registerCommand("checkpoint", {
    description: "Create a git checkpoint — commit current state for easy rollback with /undo",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("Not a git repository — nothing to checkpoint.", "error");
        return;
      }
      const cp = makeCheckpoint(cwd);
      if (!cp) {
        ctx.ui.notify("Failed to create checkpoint.", "error");
        return;
      }
      recordCheckpoint(cp, ctx);
      ctx.ui.notify(
        `Checkpoint created: ${cp.hash.slice(0, 7)} on ${cp.branch}${cp.hadChanges ? " (changes committed)" : " (already clean)"}`,
        "info"
      );
    },
  });

  // ── /undo ────────────────────────────────────────────────────────────────

  pi.registerCommand("undo", {
    description: "Hard-reset to the last git checkpoint created this session",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (!latestCheckpoint) {
        ctx.ui.notify("No checkpoint in this session. Run /checkpoint first.", "error");
        return;
      }

      const { hash, branch, cwd, ts } = latestCheckpoint;
      const ok = await ctx.ui.confirm(
        "↩ Restore checkpoint?",
        `Reset to ${hash.slice(0, 7)} on ${branch}\nCreated: ${ts}\n\nAll uncommitted changes since then will be lost.`
      );
      if (!ok) return;

      try {
        execSync(`git reset --hard ${hash}`, { cwd });
        ctx.ui.notify(`Restored to checkpoint ${hash.slice(0, 7)} (${branch})`, "info");
        ctx.ui.setStatus("checkpoint", `↩ restored ${hash.slice(0, 7)}`);
        latestCheckpoint = null; // consumed
      } catch (e) {
        ctx.ui.notify(`Failed to restore: ${String(e)}`, "error");
      }
    },
  });

  // ── /checkpoint-log ──────────────────────────────────────────────────────

  pi.registerCommand("checkpoint-log", {
    description: "List all git checkpoints created in this session",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().filter(
        (e: any) => e.type === "custom" && e.customType === "git-checkpoint"
      );
      if (entries.length === 0) {
        ctx.ui.notify("No checkpoints in this session.", "info");
        return;
      }
      const lines = entries.map((e: any, i: number) => {
        const cp = e.data as Checkpoint;
        return `${i + 1}. ${cp.hash.slice(0, 7)} @ ${cp.branch} — ${cp.ts}`;
      });
      ctx.ui.notify(`Checkpoints this session:\n${lines.join("\n")}`, "info");
    },
  });
}
