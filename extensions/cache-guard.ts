/**
 * cache-guard — reduces token spend on every agentic turn.
 *
 * Two mechanisms:
 *
 * 1. Trajectory reduction (AgentDiet-inspired, via `context` event):
 *    - Truncates tool outputs that exceed TRUNCATE_CHARS to a
 *      head + tail digest — preserves signal at both ends.
 *    - Deduplicates file reads: if the same path was read multiple times
 *      with identical content, replaces older copies with a stub.
 *    - Skips the last PRESERVE_RECENT messages so fresh context is untouched.
 *
 * 2. Cache-hit tracking (via message_end):
 *    - Accumulates cache-read vs total input tokens per session.
 *    - Displays hit rate in the footer alongside context-health.
 *
 * Commands:
 *   /cache-stats   — verbose breakdown of hit rate + reduction activity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTextFromContent } from "./shared/message-content";
import { formatCompactNumber } from "./shared/format";
import { headTailWithMarker } from "./shared/output-preview";

// ─── Constants ────────────────────────────────────────────────────────────────

const TRUNCATE_CHARS  = 8_000;  // chars above which a tool output is compressed
const KEEP_HEAD       = 2_500;  // chars to keep at start of large output
const KEEP_TAIL       = 1_200;  // chars to keep at end of large output
const PRESERVE_RECENT = 8;      // never touch the last N messages
const STATUS_KEY      = "cache-guard";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  return formatCompactNumber(n);
}

function estimateChars(content: unknown): number {
  return rawTextFromContent(content).length;
}

function truncateContent(content: unknown, label: string): unknown {
  const compress = (text: string): string => headTailWithMarker(text, {
    thresholdChars: TRUNCATE_CHARS,
    headChars: KEEP_HEAD,
    tailChars: KEEP_TAIL,
    marker: removed =>
      `\n\n… [cache-guard: ${removed.toLocaleString()} chars removed from ${label} output — ` +
      `use a more targeted query or read with offset/limit to see more] …\n\n`,
  });

  if (typeof content === "string") return compress(content);
  if (Array.isArray(content)) {
    return (content as any[]).map((block: any) => {
      if (block?.type === "text" && typeof block.text === "string") {
        return { ...block, text: compress(block.text) };
      }
      return block;
    });
  }
  return content;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function cacheGuardExtension(pi: ExtensionAPI) {
  let sessionCacheRead  = 0;
  let sessionInputTotal = 0;
  let sessionPruned     = 0;
  let sessionTruncated  = 0;

  // ── Session reset + restore ─────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "startup") {
      sessionCacheRead  = 0;
      sessionInputTotal = 0;
      sessionPruned     = 0;
      sessionTruncated  = 0;
    }

    const entries  = ctx.sessionManager.getEntries();
    const saved    = [...entries].reverse().find(
      (e: any) => e.type === "custom" && e.customType === "cache-guard-stats"
    );
    if (saved) {
      const d         = (saved as any).data ?? {};
      sessionCacheRead  = d.cacheRead  ?? 0;
      sessionInputTotal = d.inputTotal ?? 0;
      sessionPruned     = d.pruned     ?? 0;
      sessionTruncated  = d.truncated  ?? 0;
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
      pruned:     sessionPruned,
      truncated:  sessionTruncated,
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

  // ── Trajectory reduction ────────────────────────────────────────────────────

  pi.on("context", async (event) => {
    const messages = event.messages as any[];
    if (messages.length <= PRESERVE_RECENT * 2) return;

    const cutoff   = messages.length - PRESERVE_RECENT;
    const prunable  = messages.slice(0, cutoff);
    const preserved = messages.slice(cutoff);

    // ── Build dedup index for file reads ──────────────────────────────────────
    // Maps file path → { latestIdx, latestContent }
    const readIndex = new Map<string, { latestIdx: number; latestContent: string }>();

    for (let i = 0; i < prunable.length; i++) {
      const msg = prunable[i] as any;
      if (!isToolResult(msg, "read")) continue;

      const path = extractReadPath(msg);
      if (!path) continue;

      readIndex.set(path, {
        latestIdx:     i,
        latestContent: rawTextFromContent(msg.content),
      });
    }

    // ── Apply reduction rules ─────────────────────────────────────────────────
    let localPruned    = 0;
    let localTruncated = 0;

    const filtered = prunable.map((msg: any, i: number) => {
      if (!msg) return msg;

      // Rule 1 — drop superseded identical file reads
      if (isToolResult(msg, "read")) {
        const path = extractReadPath(msg);
        if (path) {
          const entry = readIndex.get(path);
          if (entry && entry.latestIdx !== i) {
            // This is an older read of the same path
            const thisContent = rawTextFromContent(msg.content);
            if (thisContent === entry.latestContent) {
              localPruned++;
              return {
                ...msg,
                content: [{ type: "text", text: `[cache-guard: duplicate read of ${path} suppressed — content identical to later read at message ${entry.latestIdx}]` }],
              };
            }
          }
        }
      }

      // Rule 2 — truncate large outputs
      if (msg.role === "toolResult" || msg.role === "tool") {
        const chars = estimateChars(msg.content);
        if (chars > TRUNCATE_CHARS) {
          localTruncated++;
          return { ...msg, content: truncateContent(msg.content, msg.toolName ?? "tool") };
        }
      }

      return msg;
    });

    if (localPruned === 0 && localTruncated === 0) return;

    sessionPruned    += localPruned;
    sessionTruncated += localTruncated;

    return { messages: [...filtered, ...preserved] };
  });

  // ── /cache-stats command ────────────────────────────────────────────────────

  pi.registerCommand("cache-stats", {
    description: "Show prompt-cache hit rate and trajectory reduction stats for this session",
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
          `    Duplicate reads pruned  : ${sessionPruned}`,
          `    Large outputs truncated : ${sessionTruncated}`,
          `    Truncate threshold      : ${(TRUNCATE_CHARS / 1000).toFixed(0)}k chars`,
          `    Preserved tail          : last ${PRESERVE_RECENT} messages untouched`,
          ``,
          `  Tip: high cache hit rate (>50%) means the system prompt is stable.`,
          `  If hit rate is low, check for volatile content in before_agent_start hooks.`,
        ].join("\n"),
        "info",
      );
    },
  });
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function isToolResult(msg: any, toolName: string): boolean {
  if (!msg) return false;
  // pi internal format
  if (msg.role === "toolResult" && msg.toolName === toolName) return true;
  // pi may also use "tool" role
  if (msg.role === "tool" && (msg.name === toolName || msg.toolName === toolName)) return true;
  return false;
}

function extractReadPath(msg: any): string | null {
  // Try common locations for the file path in a read tool result
  return (
    msg?.input?.path ??
    msg?.toolInput?.path ??
    msg?.details?.path ??
    msg?.args?.path ??
    null
  );
}
