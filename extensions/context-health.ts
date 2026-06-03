/**
 * context-health — live context window usage and session cost in the footer.
 *
 * After each assistant response, updates a footer status slot showing:
 *   [████████░░] 82% ctx · $0.034
 *
 * The bar fills as the context window fills. Colour shifts:
 *   0–60%  → dim
 *   60–80% → accent
 *   80%+   → warning (time to /compact)
 *
 * Session cost accumulates turn-by-turn and resets on /new or /resume.
 * Cost is only shown if usage data is available from the provider.
 *
 * No configuration needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Constants ────────────────────────────────────────────────────────────────

const BAR_WIDTH  = 10;
const STATUS_KEY = "ctx-health";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBar(pct: number): string {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty  = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function fmtCost(usd: number): string {
  if (usd < 0.001)  return `<$0.001`;
  if (usd < 0.01)   return `$${usd.toFixed(3)}`;
  if (usd < 1)      return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function contextHealthExtension(pi: ExtensionAPI) {
  let sessionCost    = 0;
  let hasCostData    = false;

  // ── Reset on new / resumed session ─────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // Only reset cost on a fresh session, not on reload
    if (event.reason === "new" || event.reason === "startup") {
      sessionCost = 0;
      hasCostData = false;
    }

    // Restore accumulated cost from session entries (survives /reload)
    const entries = ctx.sessionManager.getEntries();
    const costEntries = entries.filter(
      (e: any) => e.type === "custom" && e.customType === "ctx-health-cost"
    );
    if (costEntries.length > 0) {
      const last = costEntries[costEntries.length - 1] as any;
      sessionCost = last.data?.total ?? 0;
      hasCostData = last.data?.hasCostData ?? false;
    }

    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "ctx: —"));
  });

  // ── Update after each assistant response ────────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // Accumulate cost from this turn
    const turnCost = (event.message as any).usage?.cost?.total;
    if (typeof turnCost === "number" && turnCost > 0) {
      sessionCost += turnCost;
      hasCostData  = true;
      // Persist so it survives /reload
      pi.appendEntry("ctx-health-cost", { total: sessionCost, hasCostData });
    }

    // Get current context window usage
    const usage = ctx.getContextUsage();
    if (!usage) {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "ctx: —"));
      return;
    }

    // usage.tokens can be null right after compaction — bail out gracefully
    if (usage.tokens === null) {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "ctx: —"));
      return;
    }
    const pct   = Math.min(100, usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100));
    const bar   = makeBar(pct);
    const used  = fmtTokens(usage.tokens);
    const total = fmtTokens(usage.contextWindow);

    // Colour shifts based on pressure
    const colour = pct >= 80 ? "warning" : pct >= 60 ? "accent" : "dim";
    const theme  = ctx.ui.theme;

    const costPart = hasCostData
      ? theme.fg("dim", ` · ${fmtCost(sessionCost)}`)
      : "";

    const barStr   = theme.fg(colour, `[${bar}]`);
    const pctStr   = theme.fg(colour, `${pct}%`);
    const tokStr   = theme.fg("dim", ` ${used}/${total}`);

    ctx.ui.setStatus(STATUS_KEY, `${barStr} ${pctStr}${tokStr}${costPart}`);
  });

  // ── Warn when approaching compaction ───────────────────────────────────────

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    const pct = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);
    if (pct >= 85) {
      ctx.ui.notify(
        `⚠️  Context at ${pct}% — consider /compact to avoid auto-compaction mid-task.`,
        "warning"
      );
    }
  });

  // ── Command: /ctx-stats — verbose breakdown ────────────────────────────────

  pi.registerCommand("ctx-stats", {
    description: "Show context usage details and session cost breakdown",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const lines: string[] = [];

      if (usage && usage.tokens !== null) {
        const pct   = Math.min(100, usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100));
        const bar   = makeBar(pct);
        lines.push(`Context: [${bar}] ${pct}%`);
        lines.push(`Tokens:  ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)}`);
      } else {
        lines.push("Context: no usage data available");
      }

      if (hasCostData) {
        lines.push(`Session cost: ${fmtCost(sessionCost)}`);
      } else {
        lines.push("Session cost: not available (provider may not report cost)");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
