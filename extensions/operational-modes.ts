/**
 * operational-modes — cycle through six working modes, each injecting
 * targeted instructions into the system prompt for that turn.
 *
 * Enforces discipline at the keystroke level: TDD mode won't let the agent
 * touch files before writing a failing test; PLAN mode blocks file edits
 * entirely; REVIEW locks to read-only analysis.
 *
 * Shortcut:  Alt+M            — cycle forward through modes
 * Commands:  /mode [name]     — show current mode, or switch by name
 *            /modes           — list all modes with descriptions
 *
 * Note: Shift+Tab is reserved by pi for thinking-level cycling (app.thinking.cycle).
 *       Alt+M is used here instead.
 *
 * Modes (cycle order):
 *   CODE     — default, no extra constraints
 *   PLAN     — discuss and outline only, no file writes
 *   TDD      — write failing test first, show RED before GREEN
 *   REVIEW   — read-only analysis: correctness, security, principles
 *   REFACTOR — behaviour must not change; clean only
 *   ARCH     — data models, API design, ADRs
 *
 * Mode persists across compaction via session entries and is restored
 * on session_start / reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Mode definitions ─────────────────────────────────────────────────────────

const MODES = ["CONVERSATIONAL", "CODE", "RESEARCH", "PERSONAL", "TDD", "REVIEW"] as const;
type Mode = (typeof MODES)[number];

interface ModeConfig {
  icon:        string;
  label:       string;
  description: string;
  /** Injected at the end of the system prompt each turn. null = no injection (default CODE). */
  injection:   string | null;
}

const MODE_CONFIG: Record<Mode, ModeConfig> = {
  CONVERSATIONAL: {
    icon:        "💬",
    label:       "CONVERSATIONAL",
    description: "General chat and planning. Prefer no tools unless user asks.",
    injection: [
      "## CONVERSATIONAL MODE ACTIVE",
      "Default to discussion-first responses.",
      "Only use tools when explicitly requested or clearly necessary.",
      "Prefer concise, direct answers and questions.",
    ].join("\n"),
  },
  CODE: {
    icon:        "💻",
    label:       "CODE",
    description: "Coding assistance with normal tool usage.",
    injection:   null,
  },
  RESEARCH: {
    icon:        "🔬",
    label:       "RESEARCH",
    description: "Research-first mode. Prioritise recall/web search and synthesis.",
    injection: [
      "## RESEARCH MODE ACTIVE",
      "Prioritise evidence-backed answers and source synthesis.",
      "Use recall_web_knowledge before fresh web_search when relevant.",
      "Summarise findings clearly and cite sources.",
    ].join("\n"),
  },
  PERSONAL: {
    icon:        "🧍",
    label:       "PERSONAL",
    description: "Personal assistant mode: life/admin/coaching focus.",
    injection: [
      "## PERSONAL MODE ACTIVE",
      "Prioritise practical personal support: planning, habits, decisions, life admin.",
      "Use memory tools when useful for continuity.",
      "Keep tone direct and supportive.",
    ].join("\n"),
  },
  TDD: {
    icon:        "🧪",
    label:       "TDD",
    description: "Write a failing test first. Show RED before GREEN.",
    injection: [
      "## TDD MODE ACTIVE",
      "You are in TDD mode. Follow the strict red→green→refactor cycle:",
      "1. Write the failing test FIRST. Show the test file content before any implementation.",
      "2. Run the test suite and confirm RED (failing output) before writing any implementation code.",
      "3. Write the MINIMAL implementation to make the test pass — no extra code.",
      "4. Show the GREEN (passing) test output.",
      "5. Only then clean up (refactor). Behaviour must not change after refactor.",
      "If you find yourself writing implementation code before a failing test exists, stop and write the test first.",
    ].join("\n"),
  },
  REVIEW: {
    icon:        "🔍",
    label:       "REVIEW",
    description: "Read-only analysis: correctness, security, principles.",
    injection: [
      "## REVIEW MODE ACTIVE",
      "You are in REVIEW mode. Do NOT make changes to files unless explicitly asked.",
      "Your job is to analyse, not implement. For each issue found, explain:",
      "  - What is wrong or could be improved",
      "  - Why it matters (correctness, security, performance, maintainability)",
      "  - What a fix would look like (describe it, don't apply it)",
      "Check against the project principles: functional core, railway-oriented errors, immutable data, no premature abstraction.",
      "Flag any security concerns, missing tests, or violations of the explicit-over-implicit principle.",
    ].join("\n"),
  },
};

// ─── Extension ────────────────────────────────────────────────────────────────

export default function operationalModesExtension(pi: ExtensionAPI) {
  let currentMode: Mode = "CONVERSATIONAL";
  let modeLocked = false;

  // ── Status helpers ──────────────────────────────────────────────────────────

  function applyStatus(ctx: ExtensionContext): void {
    const cfg   = MODE_CONFIG[currentMode];
    const label = currentMode === "CONVERSATIONAL"
      ? ctx.ui.theme.fg("dim", `${cfg.icon} ${cfg.label}`)
      : ctx.ui.theme.fg("accent", `${cfg.icon} ${cfg.label}`);
    ctx.ui.setStatus("mode", label);
  }

  function setMode(mode: Mode, ctx: ExtensionContext): boolean {
    if (modeLocked) {
      ctx.ui.notify("Mode is locked for this chat. Start a new chat to change modes.", "warning");
      return false;
    }
    currentMode = mode;
    pi.appendEntry("operational-mode", { mode, ts: Date.now() });
    applyStatus(ctx);
    return true;
  }

  // ── Restore mode from session on startup / reload ──────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    modeLocked = false;
    const entries = ctx.sessionManager.getEntries();
    // Find the most recent mode entry
    const modeEntries = entries
      .filter((e: any) => e.type === "custom" && e.customType === "operational-mode")
      .map((e: any) => e.data as { mode: Mode; ts: number });

    if (modeEntries.length > 0) {
      const last = modeEntries[modeEntries.length - 1];
      if (MODES.includes(last.mode)) {
        currentMode = last.mode;
      }
    }

    applyStatus(ctx);
  });

  // ── System prompt injection ─────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    modeLocked = true;
    const injection = MODE_CONFIG[currentMode].injection;
    if (!injection) return; // unconstrained mode
    return { systemPrompt: event.systemPrompt + `\n\n${injection}` };
  });

  // ── Shortcut: Alt+M to cycle ────────────────────────────────────────────────

  pi.registerShortcut("alt+m", {
    description: "Cycle operational mode",
    handler: async (ctx) => {
      const idx     = MODES.indexOf(currentMode);
      const nextIdx = (idx + 1) % MODES.length;
      const next    = MODES[nextIdx];
      if (!setMode(next, ctx)) return;
      ctx.ui.notify(`Mode: ${MODE_CONFIG[next].icon} ${MODE_CONFIG[next].label} — ${MODE_CONFIG[next].description}`, "info");
    },
  });

  // ── Command: /mode [name] ───────────────────────────────────────────────────

  pi.registerCommand("mode", {
    description: "Show current mode, or switch: /mode conversational | code | research | personal | tdd | review",
    getArgumentCompletions: (prefix) => {
      const items = MODES.map(m => ({ value: m.toLowerCase(), label: `${MODE_CONFIG[m].icon} ${m} — ${MODE_CONFIG[m].description}` }));
      const filtered = items.filter(i => i.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toUpperCase() as Mode;

      if (!arg) {
        const cfg = MODE_CONFIG[currentMode];
        ctx.ui.notify(
          `Current mode: ${cfg.icon} ${currentMode}\n${cfg.description}\n\nAll modes:\n${MODES.map(m => `  ${MODE_CONFIG[m].icon} ${m} — ${MODE_CONFIG[m].description}`).join("\n")}`,
          "info"
        );
        return;
      }

      if (!MODES.includes(arg)) {
        ctx.ui.notify(
          `Unknown mode: "${args.trim()}"\nAvailable: ${MODES.map(m => m.toLowerCase()).join(" | ")}`,
          "error"
        );
        return;
      }

      if (!setMode(arg, ctx)) return;
      ctx.ui.notify(`${MODE_CONFIG[arg].icon} ${arg} — ${MODE_CONFIG[arg].description}`, "info");
    },
  });

  // ── Command: /modes — list all with descriptions ────────────────────────────

  pi.registerCommand("modes", {
    description: "List all operational modes",
    handler: async (_args, ctx) => {
      const lines = MODES.map(m => {
        const cfg    = MODE_CONFIG[m];
        const active = m === currentMode ? " ◀ active" : "";
        return `  ${cfg.icon} ${m}${active}\n     ${cfg.description}`;
      });
      ctx.ui.notify(`Operational modes (Alt+M to cycle):\n\n${lines.join("\n\n")}`, "info");
    },
  });
}
