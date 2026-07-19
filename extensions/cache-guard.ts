/**
 * cache-guard — tracks prompt-cache efficiency without rewriting trajectory history.
 *
 * Large-output reduction and duplicate folding are owned by typed context objects;
 * this extension only accumulates cache-read vs total input tokens and reports the
 * hit rate in the footer alongside context-health.
 *
 * Commands:
 *   /cache-stats   — verbose breakdown of hit rate + reduction activity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCompactNumber } from "./shared/format";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_KEY      = "cache-guard";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  return formatCompactNumber(n);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function cacheGuardExtension(pi: ExtensionAPI) {
  let sessionCacheRead  = 0;
  let sessionInputTotal = 0;

  // ── Session reset + restore ─────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "startup") {
      sessionCacheRead  = 0;
      sessionInputTotal = 0;
    }

    const entries  = ctx.sessionManager.getEntries();
    const saved    = [...entries].reverse().find(
      (e: any) => e.type === "custom" && e.customType === "cache-guard-stats"
    );
    if (saved) {
      const d         = (saved as any).data ?? {};
      sessionCacheRead  = d.cacheRead  ?? 0;
      sessionInputTotal = d.inputTotal ?? 0;
    }

    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "cache: —"));
  });

  // ── Cache hit rate tracking ─────────────────────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const usage     = (event.message as any).usage ?? {};
    const cacheRead = usage.cacheRead ?? 0;
    const input     = usage.input     ?? 0;

    if (input === 0 && cacheRead === 0) return;

    sessionCacheRead  += cacheRead;
    sessionInputTotal += input + cacheRead;

    pi.appendEntry("cache-guard-stats", {
      cacheRead:  sessionCacheRead,
      inputTotal: sessionInputTotal,
    });

    const hitPct = sessionInputTotal > 0
      ? Math.round((sessionCacheRead / sessionInputTotal) * 100)
      : 0;

    const colour = hitPct >= 50 ? "accent" : hitPct >= 20 ? "dim" : "warning";
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg(colour,
        `cache:${hitPct}% (${fmtK(sessionCacheRead)}↩/${fmtK(sessionInputTotal)}in)`
      )
    );
  });

  // ── /cache-stats command ────────────────────────────────────────────────────

  pi.registerCommand("cache-stats", {
    description: "Show prompt-cache hit rate and typed context-object ownership for this session",
    handler: async (_args, ctx) => {
      const hitPct = sessionInputTotal > 0
        ? Math.round((sessionCacheRead / sessionInputTotal) * 100)
        : 0;

      ctx.ui.notify(
        [
          `Cache Guard — Session`,
          ``,
          `  Prompt cache:`,
          `    Cache-read tokens : ${fmtK(sessionCacheRead)}`,
          `    Total input tokens : ${fmtK(sessionInputTotal)}`,
          `    Hit rate          : ${hitPct}%`,
          ``,
          `  Trajectory reduction:`,
          `    Duplicate and large-output reduction: handled by typed context objects`,
          ``,
          `  Tip: high cache hit rate (>50%) means the system prompt is stable.`,
          `  If hit rate is low, check for volatile content in before_agent_start hooks.`,
        ].join("\n"),
        "info",
      );
    },
  });
}
