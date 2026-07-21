import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createTaskOutcomeTracker, type TaskOutcome } from "./shared/task-outcome";

type StepType = "tool_call" | "tool_result" | "assistant_message";

type TrajectoryStep = {
  ts: number;
  type: StepType;
  toolName?: string;
  ok?: boolean;
  isError?: boolean;
  summary?: string;
};

type EvalIssue =
  | "no_tool_use"
  | "tool_errors"
  | "low_evidence"
  | "high_context_pressure"
  | "long_trajectory";

type EvalWeights = {
  toolErrorPenalty: number;
  noToolUsePenalty: number;
  lowEvidencePenalty: number;
  highContextPenalty: number;
  longTrajectoryPenalty: number;
  badThreshold: number;
};

type EvalReport = {
  id: string;
  ts: number;
  steps: number;
  score: number;
  issues: EvalIssue[];
  recommendation: string;
  counterfactuals: string[];
  outcome?: TaskOutcome;
  recoveredFailures?: number;
  finalizationEvent?: "agent_settled";
  humanGrade?: "good" | "bad";
  humanNote?: string;
  survey?: {
    goal: number;      // 1-5: did this move the task forward?
    evidence: number;  // 1-5: was evidence quality sufficient?
    efficiency: number;// 1-5: was this efficient enough?
    note?: string;
  };
};

const STATUS_KEY = "traj-eval";
const DEFAULT_WEIGHTS: EvalWeights = {
  toolErrorPenalty: 0.15,
  noToolUsePenalty: 0.15,
  lowEvidencePenalty: 0.15,
  highContextPenalty: 0.10,
  longTrajectoryPenalty: 0.10,
  badThreshold: 0.75,
};

export default function trajectoryEvalExtension(pi: ExtensionAPI) {
  const enabled = process.env.KEYLIME_ENABLE_TRAJECTORY === "1";

  if (!enabled) {
    pi.registerCommand("traj-status", {
      description: "Show trajectory evaluator status",
      handler: async (_args, ctx) => {
        ctx.ui.notify("Trajectory evaluator is disabled. Set KEYLIME_ENABLE_TRAJECTORY=1 to enable it.", "info");
      },
    });
    return;
  }

  let currentId = "";
  let activeSteps: TrajectoryStep[] = [];
  let taskTracker: ReturnType<typeof createTaskOutcomeTracker> | undefined;
  let weights: EvalWeights = { ...DEFAULT_WEIGHTS };
  let notifyMode: "silent" | "severe" | "normal" = "severe";

  function newId(): string {
    return `traj-${Date.now().toString(36)}`;
  }

  function startTrajectory(ctx?: any) {
    currentId = newId();
    activeSteps = [];
    taskTracker = ctx?.cwd ? createTaskOutcomeTracker({
      taskId: currentId,
      repositoryFingerprint: createHash("sha256").update(String(ctx.cwd)).digest("hex"),
      startedAt: Date.now(),
    }) : undefined;
  }

  function summarizeToolInput(input: any): string {
    if (!input) return "";
    if (typeof input.command === "string") return input.command.slice(0, 140);
    if (typeof input.path === "string") return input.path;
    if (typeof input.url === "string") return input.url;
    return "";
  }

  function buildCounterfactuals(issues: EvalIssue[]): string[] {
    const suggestions: string[] = [];
    if (issues.includes("no_tool_use")) suggestions.push("Start with code_search/read/fetch_url before decisive claims.");
    if (issues.includes("low_evidence")) suggestions.push("Collect at least one concrete file-path or URL citation before concluding.");
    if (issues.includes("tool_errors")) suggestions.push("Insert preflight checks before side-effect tools, then retry with smaller scope.");
    if (issues.includes("high_context_pressure")) suggestions.push("Run a mini-summary and continue with a minimal context pack.");
    if (issues.includes("long_trajectory")) suggestions.push("Split into two milestones with explicit completion checks after each.");
    if (suggestions.length === 0) suggestions.push("Keep current tool order; trajectory already healthy.");
    return suggestions;
  }

  function evaluate(steps: TrajectoryStep[], ctx: any, settled?: ReturnType<ReturnType<typeof createTaskOutcomeTracker>["settle"]>): EvalReport {
    const issues: EvalIssue[] = [];
    const toolCalls = steps.filter(s => s.type === "tool_call");
    const toolErrors = steps.filter(s => s.type === "tool_result" && s.isError).length;

    if (toolErrors > 0 && settled?.outcome !== "verified") issues.push("tool_errors");
    if (steps.length > 16) issues.push("long_trajectory");

    const usage = ctx.getContextUsage?.();
    if (usage?.percent && usage.percent >= 80) issues.push("high_context_pressure");

    const evidenceTools = new Set([
      "code_search", "inspect_lines", "inspect_text_matches", "list_files", "fetch_url", "get_site_page",
      "search_site_content", "recall_web_knowledge", "run_checks", "read_agent_registers", "ctx_region_read",
    ]);
    const hasEvidenceTool = toolCalls.some(s => evidenceTools.has(String(s.toolName ?? "")));
    if (toolCalls.length > 0 && !hasEvidenceTool) issues.push("low_evidence");

    let score = 1;
    score -= toolErrors * weights.toolErrorPenalty;
    if (issues.includes("no_tool_use")) score -= weights.noToolUsePenalty;
    if (issues.includes("low_evidence")) score -= weights.lowEvidencePenalty;
    if (issues.includes("high_context_pressure")) score -= weights.highContextPenalty;
    if (issues.includes("long_trajectory")) score -= weights.longTrajectoryPenalty;
    score = Math.max(0, Math.min(1, score));

    const recommendation = issues.length === 0
      ? "Trajectory looks healthy."
      : `Focus: ${issues.join(", ")}. Consider /traj-status and /traj-cf ${currentId}.`;

    return {
      id: currentId,
      ts: Date.now(),
      steps: steps.length,
      score,
      issues,
      recommendation,
      counterfactuals: buildCounterfactuals(issues),
      outcome: settled?.outcome,
      recoveredFailures: settled?.recoveredFailures,
      finalizationEvent: settled ? "agent_settled" : undefined,
    };
  }

  function setStatus(ctx: any, report: EvalReport) {
    const pct = Math.round(report.score * 100);
    const color = pct >= 80 ? "dim" : pct >= 60 ? "accent" : "warning";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `traj:${pct}`));
  }

  function loadWeightsFromSession(ctx: any) {
    const entries = ctx.sessionManager.getEntries().filter(
      (e: any) => e.type === "custom" && e.customType === "trajectory-eval-config"
    );
    if (entries.length > 0) {
      weights = { ...DEFAULT_WEIGHTS, ...(entries[entries.length - 1] as any).data };
    }
  }

  function saveWeights() {
    pi.appendEntry("trajectory-eval-config", weights);
  }

  function adjustWeightsFromGrade(report: EvalReport, grade: "good" | "bad") {
    const bump = grade === "bad" ? 0.02 : -0.01;
    if (report.issues.includes("tool_errors")) weights.toolErrorPenalty = Math.max(0.05, Math.min(0.35, weights.toolErrorPenalty + bump));
    if (report.issues.includes("no_tool_use")) weights.noToolUsePenalty = Math.max(0.05, Math.min(0.35, weights.noToolUsePenalty + bump));
    if (report.issues.includes("low_evidence")) weights.lowEvidencePenalty = Math.max(0.05, Math.min(0.35, weights.lowEvidencePenalty + bump));
    if (report.issues.includes("high_context_pressure")) weights.highContextPenalty = Math.max(0.05, Math.min(0.3, weights.highContextPenalty + bump));
    if (report.issues.includes("long_trajectory")) weights.longTrajectoryPenalty = Math.max(0.05, Math.min(0.3, weights.longTrajectoryPenalty + bump));

    if (grade === "bad") weights.badThreshold = Math.max(0.65, Math.min(0.9, weights.badThreshold + 0.01));
    if (grade === "good") weights.badThreshold = Math.max(0.6, Math.min(0.9, weights.badThreshold - 0.005));

    saveWeights();
  }

  pi.on("session_start", async (_event, ctx) => {
    startTrajectory();
    loadWeightsFromSession(ctx);
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "traj:—"));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    startTrajectory(ctx);
  });

  pi.on("tool_call", async (event: any) => {
    activeSteps.push({
      ts: Date.now(),
      type: "tool_call",
      toolName: event.toolName,
      summary: summarizeToolInput(event.input),
    });
    taskTracker?.recordToolCall({ toolName: event.toolName, input: event.input });
  });

  pi.on("tool_result", async (event: any) => {
    activeSteps.push({
      ts: Date.now(),
      type: "tool_result",
      toolName: event.toolName,
      ok: !event.isError,
      isError: !!event.isError,
    });
    const verification = event.toolName === "run_checks" && Array.isArray(event.details?.results)
      ? event.details.results.map((item: any) => ({
          command: [item.command, ...(item.args ?? [])].filter(Boolean).join(" "),
          passed: item.ok === true,
          diagnosticPaths: item.diagnosticPaths,
        }))
      : undefined;
    taskTracker?.recordToolResult({
      toolName: event.toolName,
      isError: Boolean(event.isError),
      blocked: Boolean(event.details?.blocked),
      changedPaths: event.details?.changedPaths,
      evidenceObjectIds: [event.details?.contextObjectId, event.details?.resultId].filter(Boolean),
      verification,
    });
  });

  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const summary = (event.message?.content?.[0]?.text ?? "").slice(0, 180);
    activeSteps.push({ ts: Date.now(), type: "assistant_message", summary });
    taskTracker?.recordAssistantMessage({ text: summary });
    const usage = event.message?.usage;
    if (usage) taskTracker?.recordUsage({
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costUsd: typeof usage.cost === "number" ? usage.cost : usage.cost?.total,
    });
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (!taskTracker) return;
    const settled = taskTracker.settle({ settledAt: Date.now() });
    taskTracker = undefined;
    const report = evaluate(activeSteps, ctx, settled);
    pi.appendEntry("trajectory-eval", report);
    setStatus(ctx, report);

    const shouldNotify = notifyMode === "normal"
      ? (report.score < weights.badThreshold || report.issues.length > 0)
      : notifyMode === "severe"
        ? (report.score < 0.6 || report.issues.includes("tool_errors"))
        : false;
    if (shouldNotify) ctx.ui.notify(
      `Trajectory ${report.id}: ${Math.round(report.score * 100)}%\n` +
      `Issues: ${report.issues.join(", ") || "none"}\n` +
      `Counterfactual: ${report.counterfactuals[0]}\n` +
      `Quick survey: /traj-survey ${report.id} <goal1-5> <evidence1-5> <efficiency1-5> [note]`,
      "warning",
    );
  });

  pi.registerCommand("traj-status", {
    description: "Show recent trajectory eval reports",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().filter(
        (e: any) => e.type === "custom" && e.customType === "trajectory-eval"
      );

      if (entries.length === 0) {
        ctx.ui.notify("No trajectory reports yet.", "info");
        return;
      }

      const recent = entries.slice(-5).map((e: any) => e.data as EvalReport);
      const lines = recent.map(r =>
        `${r.id} · ${Math.round(r.score * 100)}% · steps:${r.steps} · issues:${r.issues.join(",") || "none"}` +
        `${r.humanGrade ? ` · grade:${r.humanGrade}` : ""}`
      );

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("traj-cf", {
    description: "Show counterfactual options: /traj-cf <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /traj-cf <id>", "error");
        return;
      }
      const entries = ctx.sessionManager.getEntries();
      const match = [...entries].reverse().find(
        (e: any) => e.type === "custom" && e.customType === "trajectory-eval" && (e.data?.id ?? "").startsWith(id)
      ) as any;

      if (!match) {
        ctx.ui.notify(`No trajectory found for id prefix: ${id}`, "error");
        return;
      }

      const report = match.data as EvalReport;
      ctx.ui.notify(
        `Counterfactuals for ${report.id}:\n- ${report.counterfactuals.join("\n- ")}`,
        "info"
      );
    },
  });

  pi.registerCommand("traj-survey", {
    description: "Quick 3-question practical Likert survey: /traj-survey <id> <goal1-5> <evidence1-5> <efficiency1-5> [note]",
    handler: async (args, ctx) => {
      const [id, goalRaw, evidenceRaw, efficiencyRaw, ...noteParts] = args.trim().split(/\s+/);
      const goal = Number(goalRaw);
      const evidence = Number(evidenceRaw);
      const efficiency = Number(efficiencyRaw);
      const note = noteParts.join(" ").trim();

      const inRange = (n: number) => Number.isFinite(n) && n >= 1 && n <= 5;
      if (!id || !inRange(goal) || !inRange(evidence) || !inRange(efficiency)) {
        ctx.ui.notify("Usage: /traj-survey <id> <goal1-5> <evidence1-5> <efficiency1-5> [note]", "error");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const match = [...entries].reverse().find(
        (e: any) => e.type === "custom" && e.customType === "trajectory-eval" && (e.data?.id ?? "").startsWith(id)
      ) as any;

      if (!match) {
        ctx.ui.notify(`No trajectory found for id prefix: ${id}`, "error");
        return;
      }

      const avg = (goal + evidence + efficiency) / 3;
      const derivedGrade: "good" | "bad" | undefined = avg >= 4 ? "good" : avg <= 2.5 ? "bad" : undefined;
      const updated: EvalReport = {
        ...(match.data as EvalReport),
        survey: { goal, evidence, efficiency, note: note || undefined },
        humanGrade: derivedGrade ?? (match.data?.humanGrade as any),
        humanNote: derivedGrade ? `survey:${goal}/${evidence}/${efficiency}${note ? ` ${note}` : ""}` : (match.data?.humanNote as any),
      };

      pi.appendEntry("trajectory-eval", updated);
      if (derivedGrade) adjustWeightsFromGrade(updated, derivedGrade);

      ctx.ui.notify(
        `Saved survey for ${updated.id}: goal=${goal}, evidence=${evidence}, efficiency=${efficiency}` +
        `${derivedGrade ? ` → derived grade: ${derivedGrade}` : ""}`,
        "info"
      );
    },
  });

  pi.registerCommand("traj-notify", {
    description: "Control trajectory warnings: /traj-notify silent|severe|normal",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (!["silent", "severe", "normal"].includes(mode)) {
        ctx.ui.notify(`Current traj notify mode: ${notifyMode}\nUsage: /traj-notify silent|severe|normal`, "info");
        return;
      }
      notifyMode = mode as any;
      ctx.ui.notify(`Trajectory notify mode set to: ${notifyMode}`, "info");
    },
  });

  pi.registerCommand("traj-grade", {
    description: "Human-grade a trajectory: /traj-grade <id> good|bad [note]",
    handler: async (args, ctx) => {
      const [id, gradeRaw, ...noteParts] = args.trim().split(/\s+/);
      const grade = (gradeRaw || "").toLowerCase();
      const note = noteParts.join(" ").trim();

      if (!id || (grade !== "good" && grade !== "bad")) {
        ctx.ui.notify("Usage: /traj-grade <id> good|bad [note]", "error");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const match = [...entries].reverse().find(
        (e: any) => e.type === "custom" && e.customType === "trajectory-eval" && (e.data?.id ?? "").startsWith(id)
      ) as any;

      if (!match) {
        ctx.ui.notify(`No trajectory found for id prefix: ${id}`, "error");
        return;
      }

      const updated: EvalReport = {
        ...(match.data as EvalReport),
        humanGrade: grade as "good" | "bad",
        humanNote: note || undefined,
      };

      pi.appendEntry("trajectory-eval", updated);
      adjustWeightsFromGrade(updated, updated.humanGrade!);

      ctx.ui.notify(
        `Saved grade for ${updated.id}: ${updated.humanGrade}${updated.humanNote ? ` — ${updated.humanNote}` : ""}\n` +
        `Updated weights: e=${weights.lowEvidencePenalty.toFixed(2)} t=${weights.toolErrorPenalty.toFixed(2)} bad@${Math.round(weights.badThreshold * 100)}%`,
        "info"
      );
    },
  });
}
