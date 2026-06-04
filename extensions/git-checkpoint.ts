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
import { autoCheckpointMode, looksSideEffectfulBash, mutationScoreForTool, shouldAutoCheckpointTurn } from "./shared/safety-policy";
export { autoCheckpointMode, looksSideEffectfulBash, mutationScoreForTool, shouldAutoCheckpointTurn } from "./shared/safety-policy";

const CHECKPOINT_EXCLUDED_PATHS = [".pi"];

export function checkpointAddCommand(): string {
  const excludes = CHECKPOINT_EXCLUDED_PATHS.map(path => ` ':!${path}'`).join("");
  return `git add -A -- .${excludes}`;
}

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
      execSync(checkpointAddCommand(), { cwd });
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

export function shouldCheckpointTool(toolName: string, input: any): boolean {
  return mutationScoreForTool(toolName, input) > 0;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track the most recent checkpoint in memory (also in session for danger-guard)
  let latestCheckpoint: Checkpoint | null = null;
  let mutationScoreThisTurn = 0;
  let lastAutoCheckpointAt = 0;

  function recordCheckpoint(cp: Checkpoint, ctx: any): void {
    latestCheckpoint = cp;
    pi.appendEntry("git-checkpoint", cp);
    const label = cp.hadChanges
      ? `📍 ${cp.hash.slice(0, 7)} (committed ${cp.branch})`
      : `📍 ${cp.hash.slice(0, 7)} (clean)`;
    ctx.ui.setStatus("checkpoint", label);
  }

  // ── Low-noise auto-checkpoint at end of agent turn ───────────────────────

  pi.on("input", async () => {
    mutationScoreThisTurn = 0;
  });

  pi.on("tool_result", async (event: any) => {
    if (event.isError) return;
    mutationScoreThisTurn += mutationScoreForTool(event.toolName, event.input);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const now = Date.now();
    if (!shouldAutoCheckpointTurn(mutationScoreThisTurn, lastAutoCheckpointAt, now, autoCheckpointMode())) return;

    const cwd = ctx.cwd;
    mutationScoreThisTurn = 0;
    if (!isGitRepo(cwd) || !hasChanges(cwd)) return;

    const cp = makeCheckpoint(cwd);
    if (!cp?.hadChanges) return;
    lastAutoCheckpointAt = now;
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
        lastAutoCheckpointAt = Date.parse(latestCheckpoint.ts) || 0;
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
