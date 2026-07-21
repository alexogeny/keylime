import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { classifyIntent, getCurrentRoute, setCurrentRoute, stripSystemReminders, type CapabilityGroup, type IntentId, type IntentRoute } from "./shared/intent";
import { intentCompletionValues, intentSeedPrompt, intentTarget, resolveIntentAlias, type IntentOverrideId } from "./shared/intent-registry";
import { lastUserText } from "./shared/message-content";
import { getCurrentOperationalMode } from "./operational-modes";
import { researchEnabled as sharedResearchEnabled } from "./shared/research-config";
import { registerContextProvider } from "./shared/turn-context";
import { retrievePolicy } from "./shared/policy-corpus";
import { alwaysOnToolNames, capabilityToolMap, domainToolNames, LOCKED_BUILTIN_TOOLS, resolveActiveToolSet } from "./shared/tool-policy";
import { formatAgentStatusLines, formatIntentStatusLines, formatToolPolicyLines } from "./shared/intent-status";
import { CODING_CONTRACT } from "./shared/coding-contract";
import { bestIntentCorpusMatch, FOLLOWUP_STICKINESS_THRESHOLD, SWITCH_THRESHOLD, type IntentCorpusMatch } from "./shared/intent-corpus";
import { agentOsContinuityToolNames, agentOsRoutingPromptSuffix } from "./agent-os";
import { clearDiscoveredToolsForTurn, discoveredToolsForTurn } from "./shared/tool-catalog";
import { stabilizeToolOrder } from "./shared/prompt-prefix-profiler";

const STATUS_KEY = "intent";

type IntentOverride = IntentOverrideId;
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
let branchToolPrefixLocked = false;
let lastToolSetDiagnostics: ActiveToolSetDiagnostics = {
  intent: "chat",
  source: "classifier",
  fingerprint: "",
  changed: false,
  alwaysOn: [],
  routed: [],
  active: [],
  locked: LOCKED_BUILTIN_TOOLS,
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
  clearDiscoveredToolsForTurn();
  lastPolicyEvidence = [];
  lastFingerprint = "";
  branchToolPrefixLocked = false;
  lastToolSetDiagnostics = {
    intent: "chat",
    source: "classifier",
    fingerprint: "",
    changed: false,
    alwaysOn: [],
    routed: [],
    active: [],
    locked: LOCKED_BUILTIN_TOOLS,
    manualOverride: null,
  };
}

export function researchEnabled(): boolean {
  return sharedResearchEnabled();
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

const EXPLICIT_REPLACEMENT_REQUEST = /\bapply\s+(?:code\s+)?replacements?\b/i;
const MUTATION_REQUEST = /\b(implement|edit|change|fix|update|modify|refactor|replace|rename|remove|delete|add)\b|\bapply\s+(?:code\s+)?replacements?\b/i;

export function workflowToolNames(route: IntentRoute): string[] {
  if (!["coding", "refactor"].includes(route.primaryIntent)) return [];
  if (!MUTATION_REQUEST.test(route.prompt)) return [];
  return ["apply_code_replacements", "plan_code_replacements", "run_checks"].sort();
}

function resolveToolsForRoute(pi: ExtensionAPI, groups: CapabilityGroup[], route?: IntentRoute) {
  return resolveActiveToolSet({
    availableToolNames: pi.getAllTools().map(toolName).filter(Boolean) as string[],
    currentActiveToolNames: pi.getActiveTools().map(toolName).filter(Boolean) as string[],
    groups: enabledGroups(modeAdjustedGroups(groups)),
    continuityToolNames: [
      ...agentOsContinuityToolNames(),
      ...discoveredToolsForTurn(),
      ...(route ? workflowToolNames(route) : []),
    ],
  });
}

export function activeToolNames(pi: ExtensionAPI, groups: CapabilityGroup[]): string[] {
  return resolveToolsForRoute(pi, groups).active;
}


function forcedRoute(intent: IntentOverride, prompt: string): IntentRoute {
  const primaryIntent: IntentId = intentTarget(intent);
  const seed = intentSeedPrompt(intent);
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
  if (EXPLICIT_REPLACEMENT_REQUEST.test(prompt)) return forcedRoute("coding", prompt);
  const suffix = agentOsRoutingPromptSuffix();
  return classifyIntent(suffix ? `${prompt}\n\nActive agent OS registers: ${suffix}` : prompt);
}

function sortedToolNames(tools: any[]): string[] {
  return tools.map(toolName).filter(Boolean).sort() as string[];
}

function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function applyRouteTools(pi: ExtensionAPI, route: IntentRoute, source: RouteSource = "classifier", extras: { stickyFrom?: IntentCorpusMatch; switchFrom?: IntentCorpusMatch } = {}): void {
  const resolution = resolveToolsForRoute(pi, route.capabilityGroups, route);
  const routed = resolution.routed;
  const canonicalOrder = sortedToolNames(pi.getAllTools());
  const next = stabilizeToolOrder(resolution.active, canonicalOrder);
  const current = pi.getActiveTools().map(toolName).filter(Boolean) as string[];
  const fingerprint = toolSetFingerprint(next);
  const changed = lastFingerprint !== fingerprint;
  lastFingerprint = fingerprint;
  lastToolSetDiagnostics = {
    intent: route.primaryIntent,
    source,
    fingerprint,
    changed,
    alwaysOn: resolution.alwaysOn,
    routed,
    active: next,
    locked: resolution.locked,
    manualOverride: intentOverride,
    ...extras,
  };
  // Tool definitions precede message history in provider payloads. Once the
  // extension has established a branch prefix, later intent changes must not
  // replace it and force a full uncached replay.
  if (branchToolPrefixLocked) return;
  if (sameTools(current, next)) return;
  pi.setActiveTools(next);
}

function policyAssistedRoute(prompt: string, route: IntentRoute, evidence: Array<{ id: string; score: number; kind?: string }>): { route: IntentRoute; source: RouteSource } {
  if (route.primaryIntent !== "chat" || route.confidence > 0.25) return { route, source: "classifier" };
  if (/\b(remember|recall|forget|memory|preference)\b/i.test(prompt)) return { route: forcedRoute("memory", prompt), source: "policy" };
  const topRouting = evidence.find(item => item.kind === "routing" && item.score >= 0.45)
    ?? evidence.find(item => item.id === "routing.refactor" && item.score >= 0.35);
  if (!topRouting) return { route, source: "classifier" };
  const doc = retrievePolicy(topRouting.id, { topK: 1 }).find(hit => hit.id === topRouting.id)?.document;
  const targetIntent = doc?.fields?.targetIntent;
  if (targetIntent) return { route: forcedRoute(targetIntent, prompt), source: "policy" };
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
    lines.push(`Coding contract: ${CODING_CONTRACT}`);
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
    branchToolPrefixLocked = false;
    clearDiscoveredToolsForTurn();
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "intent:—"));
  });

  pi.on("input", async (event, ctx) => {
    // A new user turn starts a new provider request boundary, so its routed
    // schema may replace the previous turn's prefix. Context/tool-result passes
    // remain locked below until the next input event.
    branchToolPrefixLocked = false;
    clearDiscoveredToolsForTurn();
    const route = routeForPrompt(pi, event.text ?? "");
    branchToolPrefixLocked = true;

    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `${route.primaryIntent}:${enabledGroups(modeAdjustedGroups(route.capabilityGroups)).join("+")}`),
    );

    return { action: "continue" };
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as any[];
    const prompt = lastUserText(messages);

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
      const filtered = intentCompletionValues().filter(item => item.startsWith(prefix.toLowerCase().replace(/-/g, "_")));
      return filtered.length > 0 ? filtered.map(value => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase().replace(/-/g, "_");
      const selected = resolveIntentAlias(arg);

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
      ctx.ui.notify(formatIntentStatusLines({
        route,
        status: lastToolSetDiagnostics,
        researchEnabled: researchEnabled(),
        shoesEnabled: shoesEnabled(),
        policyEvidence: lastPolicyEvidence,
        activeTools: pi.getActiveTools().map(toolName).filter(Boolean) as string[],
      }).join("\n"), "info");
    },
  });

  pi.registerCommand("agent-status", {
    description: "Show current intent, active/locked tools, routing evidence, and context/tool-result policy",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
      ctx.ui.notify(formatAgentStatusLines({
        route,
        activeGroups,
        status: lastToolSetDiagnostics,
        policyEvidence: lastPolicyEvidence,
        activeTools: pi.getActiveTools().map(toolName).filter(Boolean) as string[],
      }).join("\n"), "info");
    },
  });

  pi.registerCommand("tool-policy", {
    description: "Show always-on, routed, locked, and currently active tools",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      const activeGroups = enabledGroups(modeAdjustedGroups(route.capabilityGroups));
      const resolution = resolveToolsForRoute(pi, route.capabilityGroups, route);
      ctx.ui.notify(formatToolPolicyLines({
        alwaysOnTools: resolution.alwaysOn,
        activeGroups,
        status: lastToolSetDiagnostics,
        policyEvidence: lastPolicyEvidence,
        routedTools: resolution.routed,
        activeTools: resolution.active,
      }).join("\n"), "info");
    },
  });
}
