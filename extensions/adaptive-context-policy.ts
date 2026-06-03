import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "./shared/turn-context";

type PolicyLevel = "low" | "medium" | "high";

type PolicySnapshot = {
  ts: number;
  level: PolicyLevel;
  contextPercent: number;
  pinned: string[];
  adaptiveRules: string[];
  reason: string;
};

const STATUS_KEY = "ace";

function calcLevel(percent: number): PolicyLevel {
  if (percent >= 85) return "high";
  if (percent >= 65) return "medium";
  return "low";
}

function buildPinnedConstraints(): string[] {
  return [
    "Respect explicit user constraints and preferences stated in this session.",
    "Do not drop unresolved open questions or blockers.",
    "Preserve acceptance criteria when implementing features.",
    "Prefer evidence from code_search/read/fetch before conclusions.",
  ];
}

function inferAdaptiveRules(level: PolicyLevel, recentBadLabels: string[]): string[] {
  const rules: string[] = [];

  if (level === "medium" || level === "high") {
    rules.push("Summarize prior context in <=8 bullets before taking action.");
    rules.push("Use code_search first; avoid full-file reads unless needed.");
  }
  if (level === "high") {
    rules.push("Use minimal context pack: current goal, active files, failing output, constraints only.");
    rules.push("Before each tool call, state one-line purpose and expected evidence.");
  }

  if (recentBadLabels.includes("low_evidence")) {
    rules.push("Require at least one evidence-backed citation (file path or URL) before decisive claims.");
  }
  if (recentBadLabels.includes("tool_errors")) {
    rules.push("Add preflight checks before side-effect tools (bash/write/edit). ");
  }
  if (recentBadLabels.includes("long_trajectory")) {
    rules.push("Decompose into smaller milestones and confirm completion criteria at each milestone.");
  }

  return rules;
}

function buildInjection(snapshot: PolicySnapshot): string {
  const lines = [
    `Context policy: ${snapshot.contextPercent}% ${snapshot.level}.`,
  ];

  if (snapshot.adaptiveRules.length > 0) {
    lines.push(...snapshot.adaptiveRules.slice(0, 3).map(r => `- ${r}`));
  }

  if (snapshot.level !== "low") {
    lines.push("Keep only goal, active files, blockers, and evidence in working context.");
  }

  return lines.join("\n");
}

export default function adaptiveContextPolicyExtension(pi: ExtensionAPI) {
  let lastSnapshot: PolicySnapshot | null = null;

  function readRecentTrajectorySignals(ctx: any): { issues: string[]; badCount: number } {
    const entries = ctx.sessionManager.getEntries().filter(
      (e: any) => e.type === "custom" && e.customType === "trajectory-eval"
    );
    const recent = entries.slice(-12).map((e: any) => e.data ?? {});
    const issues = [...new Set(recent.map((d: any) => d.issues ?? []).flat())] as string[];
    const badCount = recent.filter((d: any) => d.humanGrade === "bad").length;
    return { issues, badCount };
  }

  function setStatus(ctx: any, snapshot: PolicySnapshot) {
    const icon = snapshot.level === "high" ? "🔴" : snapshot.level === "medium" ? "🟡" : "🟢";
    const color = snapshot.level === "high" ? "warning" : snapshot.level === "medium" ? "accent" : "dim";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `${icon} ace:${snapshot.contextPercent}%`));
  }

  pi.on("session_start", async (_event, ctx) => {
    const usage = ctx.getContextUsage?.();
    const percent = usage?.percent ?? 0;
    const level = calcLevel(percent);
    lastSnapshot = {
      ts: Date.now(),
      level,
      contextPercent: percent,
      pinned: buildPinnedConstraints(),
      adaptiveRules: [],
      reason: "session_start",
    };
    setStatus(ctx, lastSnapshot);
  });

  registerContextProvider({
    id: "adaptive-context-policy",
    priority: 90,
    maxChars: 420,
    build: async ({ ctx }) => {
      const usage = ctx.getContextUsage?.();
      const percent = usage?.percent ?? (usage?.tokens && usage?.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0);
      const level = calcLevel(percent || 0);
      const { issues, badCount } = readRecentTrajectorySignals(ctx);

      const snapshot: PolicySnapshot = {
        ts: Date.now(),
        level,
        contextPercent: percent || 0,
        pinned: buildPinnedConstraints(),
        adaptiveRules: inferAdaptiveRules(level, issues),
        reason: `${issues.length ? `recent_issues:${issues.join(",")}` : "usage_only"}${badCount > 0 ? `;bad_grades:${badCount}` : ""}`,
      };

      if (badCount >= 2) {
        snapshot.adaptiveRules.push("Recent bad trajectory grades detected: force a mini-replan before side-effectful actions.");
        snapshot.adaptiveRules.push("Ask one clarifying question when uncertainty is high instead of guessing.");
      }

      if (badCount >= 4) {
        snapshot.adaptiveRules.push("Temporarily raise evidence bar: include at least two citations before decisive claims.");
      }

      const changed = !lastSnapshot || lastSnapshot.level !== snapshot.level || lastSnapshot.reason !== snapshot.reason;
      lastSnapshot = snapshot;
      if (changed) pi.appendEntry("adaptive-context-policy", snapshot);
      setStatus(ctx, snapshot);

      return buildInjection(snapshot);
    },
  });

  pi.registerCommand("ace-status", {
    description: "Show adaptive context policy state",
    handler: async (_args, ctx) => {
      if (!lastSnapshot) {
        ctx.ui.notify("No ACE snapshot yet.", "info");
        return;
      }
      const s = lastSnapshot;
      const text = [
        `ACE level: ${s.level.toUpperCase()}`,
        `Context: ${s.contextPercent}%`,
        `Reason: ${s.reason}`,
        "Pinned:",
        ...s.pinned.map(p => `- ${p}`),
        s.adaptiveRules.length ? "Adaptive rules:" : "Adaptive rules: none",
        ...s.adaptiveRules.map(r => `- ${r}`),
      ].join("\n");
      ctx.ui.notify(text, "info");
    },
  });
}
