/**
 * dynamic-skills — injects a one-line skill hint into the system prompt when
 * the user's prompt strongly matches a skill's domain.
 *
 * Eliminates the friction of manually typing /skill:name by making the agent
 * aware that a relevant skill exists and should be loaded.
 *
 * Detection is three-layered:
 *   1. Project type  — reads cwd for Cargo.toml, package.json, .pi/project.json
 *   2. Prompt intent — keyword matching against domain token sets
 *   3. Dedup gate    — tracks which skills were hinted this session to avoid
 *                      repeating the same hint every turn
 *
 * Only injects when at least two domain signals fire (high precision > recall).
 * Does NOT inject if the user already mentioned "/skill:" in their prompt.
 *
 * All 16 installed skills are mapped. Add new skill → token sets at the bottom.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Skill definitions ────────────────────────────────────────────────────────
//
// Each entry maps a skill name (as used in /skill:name) to:
//   tokens   — strong keyword signals in the prompt
//   files    — presence of these files in cwd boosts signal (adds +2)
//   stackKey — if project.json stack contains this string, boost signal (+2)
//   minScore — minimum combined score to trigger a hint (default 2)

interface SkillSignal {
  description: string;
  tokens:      string[];       // prompt tokens that match
  files?:      string[];       // files in cwd that add signal
  stackKey?:   string[];       // strings in project stack (language/framework/etc)
  minScore:    number;
}

const SKILL_SIGNALS: Record<string, SkillSignal> = {

  // ── Coding & engineering ───────────────────────────────────────────────────

  debug: {
    description: "Systematic debugging workflow",
    tokens:      ["bug", "bugs", "broken", "error", "errors", "crash", "crashes",
                  "failing", "fail", "failed", "why", "unexpected", "wrong",
                  "panic", "exception", "traceback", "stacktrace", "regression",
                  "reproduce", "repro", "flaky"],
    minScore:    2,
  },

  refactor: {
    description: "Structured refactoring workflow",
    tokens:      ["refactor", "refactoring", "clean", "cleanup", "extract",
                  "rename", "tidy", "reorganise", "reorganize", "duplication",
                  "duplicate", "smell", "debt", "technical"],
    minScore:    2,
  },

  "repo-map": {
    description: "Rapid codebase orientation",
    tokens:      ["orient", "orientation", "map", "understand", "overview",
                  "explore", "codebase", "structure", "unfamiliar", "onboard",
                  "how does", "how is", "walk me through", "explain the repo",
                  "explain this project"],
    minScore:    2,
  },

  clarify: {
    description: "Structured requirement clarification",
    tokens:      ["clarify", "requirements", "spec", "specification", "ambiguous",
                  "unclear", "scope", "edge case", "edge cases", "acceptance",
                  "criteria", "what should", "define"],
    minScore:    2,
  },

  "ui-design": {
    description: "Interface and UX design",
    tokens:      ["ui", "ux", "design", "component", "components", "screen",
                  "form", "forms", "layout", "modal", "dialog", "table",
                  "dashboard", "page", "interface", "wireframe", "flow",
                  "interaction", "accessible", "accessibility"],
    stackKey:    ["Next.js", "React", "shadcn", "Tailwind"],
    minScore:    2,
  },

  "rust-systems": {
    description: "Rust systems programming",
    tokens:      ["rust", "ownership", "lifetime", "borrow", "borrowing",
                  "async", "tokio", "unsafe", "trait", "enum", "match",
                  "cargo", "crate", "clippy"],
    files:       ["Cargo.toml", "Cargo.lock"],
    minScore:    1, // file presence alone is enough
  },

  "rust-shell-emulator": {
    description: "Shell emulator / terminal emulator in Rust",
    tokens:      ["shell", "pty", "tty", "terminal", "emulator", "vt100",
                  "ansi", "lex", "parse", "ast", "job control", "signal",
                  "posix"],
    files:       ["Cargo.toml"],
    minScore:    3, // needs rust file + multiple tokens
  },

  // ── Security ──────────────────────────────────────────────────────────────

  "blue-team": {
    description: "Defensive security — SOC, detection, incident response",
    tokens:      ["detect", "detection", "siem", "soc", "alert", "incident",
                  "response", "threat", "hunt", "hunting", "mitre", "att&ck",
                  "defender", "xdr", "soar", "playbook", "triage"],
    minScore:    3,
  },

  "red-team": {
    description: "Adversary simulation and red teaming",
    tokens:      ["red team", "pentest", "penetration", "exploit", "payload",
                  "c2", "command and control", "lateral movement", "privilege",
                  "escalation", "recon", "exfil", "bypass"],
    minScore:    3,
  },

  // ── Running & biomechanics ────────────────────────────────────────────────

  "running-biomechanics": {
    description: "Running form, shoe specs, injury prevention",
    tokens:      ["run", "running", "gait", "pronation", "supination", "drop",
                  "stack", "cushion", "shoe", "shoes", "marathon", "injury",
                  "knee", "hip", "biomechanics", "form", "cadence", "stride"],
    minScore:    2,
  },

  // ── Fiction writing ───────────────────────────────────────────────────────

  "novel-craft": {
    description: "Fiction craft — prose, genre, style",
    tokens:      ["prose", "genre", "fiction", "novel", "scene", "pov",
                  "point of view", "voice", "show don't tell", "filter words",
                  "purple prose", "adverb", "dialogue", "craft"],
    minScore:    3,
  },

  "novel-plan": {
    description: "Novel planning — structure, outline, character arcs",
    tokens:      ["outline", "plot", "structure", "three act", "save the cat",
                  "snowflake", "hero's journey", "protagonist", "antagonist",
                  "character arc", "inciting", "theme", "story beat"],
    minScore:    3,
  },

  "novel-write": {
    description: "Novel drafting — execution, momentum, scene writing",
    tokens:      ["draft", "drafting", "write the scene", "stuck", "mid-draft",
                  "momentum", "word count", "daily writing", "chapter"],
    minScore:    3,
  },

  "novel-review": {
    description: "Fiction revision and editing",
    tokens:      ["revise", "revision", "edit", "manuscript", "critique",
                  "feedback on", "read my", "improve this scene", "proofread"],
    minScore:    3,
  },

  // ── Product & naming ──────────────────────────────────────────────────────

  "saas-naming": {
    description: "SaaS product naming",
    tokens:      ["name", "naming", "brand", "product name", "rename",
                  "what should we call", "domain", "trademark"],
    minScore:    3,
  },

};

// ─── Project stack reader ─────────────────────────────────────────────────────

interface ProjectPlan {
  stack?: {
    language?: string;
    framework?: string;
    uiFramework?: string;
    testFramework?: string;
    other?: string[];
  };
}

function readProjectStack(cwd: string): string {
  // Walk up from cwd looking for .pi/project.json
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".pi", "project.json");
    if (existsSync(candidate)) {
      try {
        const plan: ProjectPlan = JSON.parse(readFileSync(candidate, "utf8"));
        const stack = plan.stack ?? {};
        return [
          stack.language, stack.framework, stack.uiFramework,
          stack.testFramework, ...(stack.other ?? []),
        ].filter(Boolean).join(" ");
      } catch { return ""; }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

// ─── Context helpers ────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Appends `text` as a <system-reminder> to the last user message in the array.
 * Returns a new messages array — ephemeral, never stored in the session.
 */
function appendReminder(messages: any[], text: string): any[] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]?.role !== "user") continue;
    const msg    = result[i];
    const suffix = `\n\n<system-reminder>\n${text}\n</system-reminder>`;
    if (typeof msg.content === "string") {
      result[i] = { ...msg, content: msg.content + suffix };
    } else if (Array.isArray(msg.content)) {
      const blocks  = [...msg.content];
      const lastTxt = blocks.findLastIndex((b: any) => b?.type === "text");
      if (lastTxt >= 0) {
        blocks[lastTxt] = { ...blocks[lastTxt], text: blocks[lastTxt].text + suffix };
      } else {
        blocks.push({ type: "text", text: suffix });
      }
      result[i] = { ...msg, content: blocks };
    }
    return result;
  }
  return result;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenizePrompt(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

// ─── Extension ───────────────────────────────────────────────────────────────
//
// CACHE NOTE: skill hints are 100% volatile (they depend on the prompt text).
// They are injected via the `context` event as an ephemeral system-reminder
// appended to the last user message — NOT into the system prompt.
// This keeps the system prompt stable so it stays in the KV cache.

export default function dynamicSkillsExtension(pi: ExtensionAPI) {
  // Track which skills we've already hinted this session to avoid spamming
  const hintedThisSession = new Set<string>();

  pi.on("session_start", async () => {
    hintedThisSession.clear();
  });

  pi.on("context", async (event, ctx) => {
    // Determine the prompt from the last user message in the context
    const messages = event.messages as any[];
    if (!messages.length) return;

    const lastUserMsg = [...messages].reverse().find((m: any) => m?.role === "user");
    if (!lastUserMsg) return;

    const prompt = extractText(lastUserMsg.content);
    if (!prompt.trim()) return;

    // Don't hint if user already mentioned /skill: — they know what they want
    if (prompt.includes("/skill:")) return;

    const cwd       = ctx.cwd;
    const stackStr  = readProjectStack(cwd);
    const tokens    = tokenizePrompt(prompt);
    const rawPrompt = prompt.toLowerCase();

    const hints: string[] = [];

    for (const [skillName, signal] of Object.entries(SKILL_SIGNALS)) {
      // Already hinted this session — skip
      if (hintedThisSession.has(skillName)) continue;

      let score = 0;

      // Token matching
      for (const tok of signal.tokens) {
        if (tok.includes(" ")) {
          if (rawPrompt.includes(tok)) score++;
        } else {
          if (tokens.has(tok)) score++;
        }
      }

      // File presence in cwd
      if (signal.files) {
        for (const f of signal.files) {
          if (existsSync(join(cwd, f))) {
            score += 2;
            break;
          }
        }
      }

      // Stack match
      if (signal.stackKey && stackStr) {
        for (const key of signal.stackKey) {
          if (stackStr.includes(key)) {
            score += 2;
            break;
          }
        }
      }

      if (score >= signal.minScore) {
        hints.push(`/skill:${skillName} (${signal.description})`);
        hintedThisSession.add(skillName);
      }
    }

    if (hints.length === 0) return;

    const hintLine = hints.length === 1
      ? `Tip: the ${hints[0]} skill may be useful — load it with /skill:${hints[0].split(" ")[0].slice(7)}.`
      : `Tip: these skills may be useful:\n${hints.map(h => `  • ${h}`).join("\n")}`;

    // Append as ephemeral system-reminder to the last user message
    return { messages: appendReminder(messages, hintLine) };
  });

  // ── Command: /skill-hints — show what would fire on a test prompt ──────────


  pi.registerCommand("skill-hints", {
    description: "Show which skills would be hinted for a given prompt: /skill-hints <prompt text>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /skill-hints <prompt text>", "info");
        return;
      }

      const cwd      = ctx.cwd;
      const stackStr = readProjectStack(cwd);
      const tokens   = tokenizePrompt(args);
      const raw      = args.toLowerCase();
      const results: string[] = [];

      for (const [skillName, signal] of Object.entries(SKILL_SIGNALS)) {
        let score = 0;
        const fired: string[] = [];

        for (const tok of signal.tokens) {
          if (tok.includes(" ") ? raw.includes(tok) : tokens.has(tok)) {
            score++;
            fired.push(tok);
          }
        }

        if (signal.files) {
          for (const f of signal.files) {
            if (existsSync(join(cwd, f))) { score += 2; fired.push(`file:${f}`); break; }
          }
        }

        if (signal.stackKey && stackStr) {
          for (const key of signal.stackKey) {
            if (stackStr.includes(key)) { score += 2; fired.push(`stack:${key}`); break; }
          }
        }

        const threshold = signal.minScore;
        const would = score >= threshold;
        results.push(
          `${would ? "✅" : "  "} /skill:${skillName.padEnd(22)} score=${score}/${threshold}  [${fired.slice(0,4).join(", ")}]`
        );
      }

      const triggered = results.filter(r => r.startsWith("✅"));
      const summary   = triggered.length > 0
        ? `${triggered.length} skill(s) would be hinted:\n\n${results.join("\n")}`
        : `No skills would be hinted.\n\n${results.join("\n")}`;

      ctx.ui.notify(summary, "info");
    },
  });
}
