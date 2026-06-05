import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { classifyIntent, getCurrentRoute, routeSummary, setCurrentRoute, stripSystemReminders, type CapabilityGroup, type IntentId, type IntentRoute } from "./shared/intent";
import { getCurrentOperationalMode } from "./operational-modes";
import { researchKeyConfigured } from "./shared/research-config";
import { registerContextProvider } from "./shared/turn-context";
import { retrievePolicy } from "./shared/policy-corpus";
import { alwaysOnToolNames, capabilityToolMap, domainToolNames } from "./shared/tool-policy";
import { bestIntentCorpusMatch, FOLLOWUP_STICKINESS_THRESHOLD, SWITCH_THRESHOLD, type IntentCorpusMatch } from "./shared/intent-corpus";

const STATUS_KEY = "intent";

type IntentOverride = IntentId | "programming";
type RouteSource = "classifier" | "policy" | "corpus-switch" | "sticky" | "manual";

export type ActiveToolSetDiagnostics = {
  intent: IntentId;
  source: RouteSource;
  fingerprint: string;
  changed: boolean;
  alwaysOn: string[];
  routed: string[];
  active: string[];
  locked: string[];
  manualOverride: IntentOverride | null;
  stickyFrom?: IntentCorpusMatch;
  switchFrom?: IntentCorpusMatch;
};

let intentOverride: IntentOverride | null = null;
let lastPolicyEvidence: Array<{ id: string; score: number; kind?: string }> = [];
let lastFingerprint = "";
let lastToolSetDiagnostics: ActiveToolSetDiagnostics = {
  intent: "chat",
  source: "classifier",
  fingerprint: "",
  changed: false,
  alwaysOn: [],
  routed: [],
  active: [],
  locked: ["read", "write", "edit"],
  manualOverride: null,
};

export function policyEvidenceForPrompt(prompt: string) {
  return retrievePolicy(prompt, { topK: 4 }).map(hit => ({
    id: hit.id,
    score: hit.score,
    kind: hit.document?.kind,
  }));
}

export function getLastPolicyEvidence() {
  return lastPolicyEvidence;
}

export const ALWAYS_ON_CODE_TOOLS = alwaysOnToolNames();

export const CAPABILITY_TOOLS: Record<CapabilityGroup, string[]> = capabilityToolMap();

export const DOMAIN_TOOLS = new Set(domainToolNames());

export function toolSetFingerprint(names: string[]): string {
  return createHash("sha256").update([...new Set(names)].sort().join("\n")).digest("hex").slice(0, 12);
}

export function getActiveToolSetDiagnostics(): ActiveToolSetDiagnostics {
  return lastToolSetDiagnostics;
}

export function resetIntentRoutingForTests(): void {
  intentOverride = null;
  lastPolicyEvidence = [];
  lastFingerprint = "";
  lastToolSetDiagnostics = {
    intent: "chat",
    source: "classifier",
    fingerprint: "",
    changed: false,
    alwaysOn: [],
    routed: [],
    active: [],
    locked: ["read", "write", "edit"],
    manualOverride: null,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return stripSystemReminders(content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text as string)
    .join("\n");
}

function lastUserPrompt(messages: any[]): string {
  const msg = [...messages].reverse().find((m: any) => m?.role === "user");
  return msg ? textFromContent(msg.content) : "";
}

export function researchEnabled(): boolean {
  if (process.env.KEYLIME_DISABLE_RESEARCH === "1") return false;
  if (process.env.KEYLIME_ENABLE_RESEARCH === "1") return true;
  return researchKeyConfigured();
}

export function shoesEnabled(): boolean {
  return process.env.KEYLIME_DISABLE_SHOES !== "1";
}

export function enabledGroups(groups: CapabilityGroup[]): CapabilityGroup[] {
  return groups.filter(group => {
    if (group === "research") return researchEnabled();
    if (group === "shoes") return shoesEnabled();
    return true;
  });
}

function toolName(tool: any): string | undefined {
  return typeof tool === "string" ? tool : tool?.name;
}

export function modeAdjustedGroups(groups: CapabilityGroup[]): CapabilityGroup[] {
  const mode = getCurrentOperationalMode();
  if (mode === "REVIEW") return ["readonly", "repo"];
  if (mode === "RESEARCH") return ["research", "fetch", "memory-lite"];
  if (mode === "PERSONAL") return ["personal", "memory-lite"];
  return groups;
}

export function activeToolNames(pi: ExtensionAPI, groups: CapabilityGroup[]): string[] {
  const available = new Set(pi.getAllTools().map(toolName).filter(Boolean) as string[]);
  const desired = new Set<string>();

  for (const name of ALWAYS_ON_CODE_TOOLS) desired.add(name);

  for (const group of enabledGroups(modeAdjustedGroups(groups))) {
    for (const name of CAPABILITY_TOOLS[group]) desired.add(name);
  }

  // Preserve non-domain tools from other extensions/providers. Domain tools are
  // explicitly governed by intent except always-on safe code primitives, which
  // avoid routing mistakes stranding repository inspection/editing.
  for (const tool of pi.getActiveTools()) {
    const name = toolName(tool);
    if (name && !DOMAIN_TOOLS.has(name)) desired.add(name);
  }

  return [...desired].filter(name => available.has(name)).sort();
}


const INTENT_PROMPTS: Partial<Record<IntentOverride, string>> = {
  programming: "implement code change update code tests repo",
  coding: "implement code change update code tests repo",
  debugging: "debug failing test error stack trace root cause",
  refactor: "refactor code cleanup preserve behavior",
  review: "review audit critique code quality risks",
  planning: "make a plan roadmap acceptance criteria",
  project: "project plan feature tdd implementation",
  research: "search the web research latest current sources",
  memory: "remember save memory preference recall",
  personal: "personal profile preferences about me",
  running_shoes: "running shoe recommendation drop stack foam",
  running_biomechanics: "running biomechanics gait injury training load",
  python_engineering: "python optimize performance typing pytest",
  rust_systems: "rust systems ownership lifetime cargo clippy",
  rust_shell_emulator: "rust shell terminal emulator pty ansi parser",
  ui_design: "ui ux design component accessibility screen",
  chat: "general chat answer normally no tools",
};

function forcedRoute(intent: IntentOverride, prompt: string): IntentRoute {
  const primaryIntent: IntentId = intent === "programming" ? "coding" : intent;
  const seed = INTENT_PROMPTS[intent] ?? INTENT_PROMPTS[primaryIntent] ?? prompt;
  const route = classifyIntent(seed);
  return {
    ...route,
    primaryIntent,
    secondaryIntents: [],
    confidence: 1,
    prompt,
    ts: Date.now(),
  };
}

function routeForIntent(prompt: string): IntentRoute {
  if (intentOverride) return forcedRoute(intentOverride, prompt);
  return classifyIntent(prompt);
}

function sortedToolNames(tools: any[]): string[] {
  return tools.map(toolName).filter(Boolean).sort() as string[];
}

function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function applyRouteTools(pi: ExtensionAPI, route: IntentRoute, source: RouteSource = "classifier", extras: { stickyFrom?: IntentCorpusMatch; switchFrom?: IntentCorpusMatch } = {}): void {
  const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
  const routed = [...new Set(activeGroups.flatMap(group => CAPABILITY_TOOLS[group]))].filter(Boolean).sort();
  const next = activeToolNames(pi, route.capabilityGroups);
  const current = sortedToolNames(pi.getActiveTools());
  const fingerprint = toolSetFingerprint(next);
  const changed = lastFingerprint !== fingerprint;
  lastFingerprint = fingerprint;
  lastToolSetDiagnostics = {
    intent: route.primaryIntent,
    source,
    fingerprint,
    changed,
    alwaysOn: [...ALWAYS_ON_CODE_TOOLS].sort(),
    routed,
    active: next,
    locked: ["read", "write", "edit"],
    manualOverride: intentOverride,
    ...extras,
  };
  if (sameTools(current, next)) return;
  pi.setActiveTools(next);
}

function policyAssistedRoute(prompt: string, route: IntentRoute, evidence: Array<{ id: string; score: number; kind?: string }>): { route: IntentRoute; source: RouteSource } {
  if (route.primaryIntent !== "chat" || route.confidence > 0.25) return { route, source: "classifier" };
  if (/\b(remember|recall|forget|memory|preference)\b/i.test(prompt)) return { route: forcedRoute("memory", prompt), source: "policy" };
  const topRouting = evidence.find(item => item.kind === "routing" && item.score >= 0.45)
    ?? evidence.find(item => item.id === "routing.refactor" && item.score >= 0.35);
  if (!topRouting) return { route, source: "classifier" };
  if (topRouting.id === "routing.refactor") return { route: forcedRoute("refactor", prompt), source: "policy" };
  if (topRouting.id === "routing.debug") return { route: forcedRoute("debugging", prompt), source: "policy" };
  if (topRouting.id === "routing.agentic-audit") return { route: forcedRoute("review", prompt), source: "policy" };
  return { route, source: "classifier" };
}

export function routeForPrompt(pi: ExtensionAPI, prompt: string): IntentRoute {
  const previousRoute = getCurrentRoute();
  lastPolicyEvidence = policyEvidenceForPrompt(prompt);

  if (intentOverride) {
    const route = forcedRoute(intentOverride, prompt);
    setCurrentRoute(route);
    applyRouteTools(pi, route, "manual");
    return route;
  }

  const classified = routeForIntent(prompt);
  let routed = policyAssistedRoute(prompt, classified, lastPolicyEvidence);
  let stickyFrom: IntentCorpusMatch | undefined;
  let switchFrom: IntentCorpusMatch | undefined;

  const switchMatch = bestIntentCorpusMatch(prompt, "switch");
  if (switchMatch?.targetIntent && switchMatch.score >= SWITCH_THRESHOLD) {
    const target = switchMatch.targetIntent;
    const explicitResearchSwitch = target === "research" && /\b(search|web search|look up|look online|research|sources|fetch|open this website|browse|verify)\b/i.test(prompt);
    const mayOverride = routed.route.primaryIntent === "chat" || routed.route.confidence < 0.4 || explicitResearchSwitch || target !== "research";
    if (target !== routed.route.primaryIntent && mayOverride) {
      routed = { route: forcedRoute(target, prompt), source: "corpus-switch" };
      switchFrom = switchMatch;
    }
  }

  if (routed.route.primaryIntent === "chat" && routed.route.confidence <= 0.25 && previousRoute.primaryIntent !== "chat") {
    const followup = bestIntentCorpusMatch(prompt, "followup");
    if (followup?.sticky && followup.score >= FOLLOWUP_STICKINESS_THRESHOLD) {
      routed = {
        route: { ...previousRoute, prompt: stripSystemReminders(prompt), ts: Date.now() },
        source: "sticky",
      };
      stickyFrom = followup;
    }
  }

  setCurrentRoute(routed.route);
  applyRouteTools(pi, routed.route, routed.source, { stickyFrom, switchFrom });
  return routed.route;
}

export function reminderText(): string {
  const route = getCurrentRoute();
  const researchOn = researchEnabled();
  const lines: string[] = [];

  if (route.temporal.freshnessRequested && !researchOn) {
    lines.push("Freshness requested but web research is DISABLED: do not claim this is latest/current; say answer is local/catalog-only.");
  } else if (route.temporal.freshnessRequested) {
    lines.push("Freshness requested: verify local/catalog knowledge against current sources before claiming latest/current.");
  } else if (!researchOn && route.capabilityGroups.includes("research")) {
    lines.push("Research requested but web tools are disabled: say so if it affects the answer.");
  }

  const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
  lines.push(`Intent: ${route.primaryIntent}; tools: ${activeGroups.join(", ") || "none"}.`);

  if (activeGroups.includes("coding")) {
    lines.push("Git checkpoints handle rollback safety; do not spend extra turns on manual git safety unless asked.");
    lines.push("For repository file mutations, use codemod tools/create_file/create_directory; do not use read/write/edit, bash, node, python, perl, sed, awk, tee, heredocs, shell redirection, or raw git mutation commands.");
    lines.push("Use checkpoint/git inspection tools instead of raw git add/commit/reset/restore/clean/rebase/merge/push/stash; use git_status/git_diff for repository state inspection.");
    lines.push("For verification, prefer run_checks; use bash only when run_checks cannot express the command.");
  }

  if (route.suggestedSkills.length > 0) {
    lines.push(`Skill hint: ${route.suggestedSkills.map(s => `/skill:${s}`).join(", ")} only if materially useful.`);
  }

  return lines.join("\n");
}

export default function intentRouterExtension(pi: ExtensionAPI) {
  registerContextProvider({
    id: "intent-router",
    priority: 100,
    maxChars: 520,
    build: () => reminderText(),
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "intent:—"));
  });

  pi.on("input", async (event, ctx) => {
    const route = routeForPrompt(pi, event.text ?? "");

    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `${route.primaryIntent}:${enabledGroups(modeAdjustedGroups(route.capabilityGroups)).join("+")}`),
    );

    return { action: "continue" };
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as any[];
    const prompt = lastUserPrompt(messages);

    // Tool results can cause additional context passes without a new input event.
    // Keep route state and tool visibility aligned; applyRouteTools is a no-op
    // when the active schema set is already correct, avoiding prompt churn.
    if (prompt.trim()) routeForPrompt(pi, prompt);

    const route = getCurrentRoute();
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `${route.primaryIntent}:${enabledGroups(modeAdjustedGroups(route.capabilityGroups)).join("+")}`),
    );

    return;
  });

  const intentCommand = {
    description: "Manually override intent routing, or reset to automatic routing",
    getArgumentCompletions: (prefix: string) => {
      const items = ["auto", "reset", "programming", "coding", "research", "memory", "chat", "debugging", "refactor", "review", "planning", "project", "personal", "running_shoes", "running_biomechanics", "python_engineering", "rust_systems", "rust_shell_emulator", "ui_design"];
      const filtered = items.filter(item => item.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map(value => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase().replace(/-/g, "_");
      const aliases: Record<string, IntentOverride | "auto"> = {
        "": "auto",
        auto: "auto",
        off: "auto",
        clear: "auto",
        reset: "auto",
        code: "coding",
        coding: "coding",
        programming: "programming",
        research: "research",
        memory: "memory",
        chat: "chat",
        debugging: "debugging",
        debug: "debugging",
        refactor: "refactor",
        review: "review",
        planning: "planning",
        plan: "planning",
        project: "project",
        personal: "personal",
        running_shoes: "running_shoes",
        shoes: "running_shoes",
        running_biomechanics: "running_biomechanics",
        biomechanics: "running_biomechanics",
        python_engineering: "python_engineering",
        python: "python_engineering",
        rust_systems: "rust_systems",
        rust: "rust_systems",
        rust_shell_emulator: "rust_shell_emulator",
        shell_emulator: "rust_shell_emulator",
        ui_design: "ui_design",
        ui: "ui_design",
      };
      const selected = aliases[arg];

      if (selected === "auto") {
        intentOverride = null;
        ctx.ui.notify("Intent override cleared. Automatic routing enabled.", "info");
        return;
      }

      if (selected) {
        intentOverride = selected;
        const route = routeForPrompt(pi, `manual ${selected} intent`);
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("accent", `${route.primaryIntent}:${enabledGroups(modeAdjustedGroups(route.capabilityGroups)).join("+")}`),
        );
        ctx.ui.notify(`Intent override: ${selected}. Use /intent auto to resume automatic routing.`, "info");
        return;
      }

      ctx.ui.notify('Unknown intent. Use /intent auto, coding, research, memory, chat, debugging, refactor, review, planning, or a domain intent.', "error");
    },
  };

  pi.registerCommand("intent", intentCommand);
  pi.registerCommand("switch-intent", intentCommand);

  pi.registerCommand("intent-status", {
    description: "Show current intent routing state and active tool count",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      ctx.ui.notify([
        "Intent Router",
        `  ${routeSummary(route)}`,
        `  confidence: ${Math.round(route.confidence * 100)}%`,
        `  route source: ${lastToolSetDiagnostics.source}`,
        `  tool set fingerprint: ${lastToolSetDiagnostics.fingerprint || "none"}`,
        `  tool set changed this turn: ${lastToolSetDiagnostics.changed ? "yes" : "no"}`,
        `  manual override: ${intentOverride ?? "none"}`,
        `  research enabled: ${researchEnabled() ? "yes" : "no"}`,
        `  shoes enabled: ${shoesEnabled() ? "yes" : "no"}`,
        `  policy evidence: ${lastPolicyEvidence.map(e => `${e.id}=${e.score.toFixed(2)}`).join(", ") || "none"}`,
        `  active tools: ${pi.getActiveTools().map(toolName).filter(Boolean).sort().join(", ")}`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("agent-status", {
    description: "Show current intent, active/locked tools, routing evidence, and context/tool-result policy",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
      ctx.ui.notify([
        "Agent Status",
        `  intent: ${route.primaryIntent} (${Math.round(route.confidence * 100)}%)`,
        `  route source: ${lastToolSetDiagnostics.source}`,
        `  tool set fingerprint: ${lastToolSetDiagnostics.fingerprint || "none"}`,
        `  tool set changed this turn: ${lastToolSetDiagnostics.changed ? "yes" : "no"}`,
        `  manual override: ${intentOverride ?? "none"}`,
        `  active groups: ${activeGroups.join(", ") || "none"}`,
        `  active tools: ${pi.getActiveTools().map(toolName).filter(Boolean).sort().join(", ")}`,
        `  locked tools: read, write, edit; bash mutation guarded`,
        `  policy evidence: ${lastPolicyEvidence.map(e => `${e.id}=${e.score.toFixed(2)}`).join(", ") || "none"}`,
        "  context: turn-context composer enabled; repo-index injects compact skeleton when available",
        "  tool results: oversized successful results are compacted to .pi/tool-results and retrievable by inspect_tool_result",
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("tool-policy", {
    description: "Show always-on, routed, locked, and currently active tools",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
      const routed = [...new Set(activeGroups.flatMap(group => CAPABILITY_TOOLS[group]))].sort();
      ctx.ui.notify([
        "Tool Policy",
        `  always-on code tools: ${ALWAYS_ON_CODE_TOOLS.join(", ")}`,
        `  locked built-ins: read, write, edit; bash is routed and guarded`,
        `  active groups: ${activeGroups.join(", ") || "none"}`,
        `  route source: ${lastToolSetDiagnostics.source}`,
        `  tool set fingerprint: ${lastToolSetDiagnostics.fingerprint || "none"}`,
        `  tool set changed this turn: ${lastToolSetDiagnostics.changed ? "yes" : "no"}`,
        `  manual override: ${intentOverride ?? "none"}`,
        `  policy evidence: ${lastPolicyEvidence.map(e => `${e.id}=${e.score.toFixed(2)}`).join(", ") || "none"}`,
        `  routed tools: ${routed.join(", ") || "none"}`,
        `  active tools: ${pi.getActiveTools().map(toolName).filter(Boolean).sort().join(", ")}`,
      ].join("\n"), "info");
    },
  });
}
