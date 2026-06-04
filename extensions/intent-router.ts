import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyIntent, getCurrentRoute, routeSummary, setCurrentRoute, stripSystemReminders, type CapabilityGroup, type IntentRoute } from "./shared/intent";
import { getCurrentOperationalMode } from "./operational-modes";
import { researchKeyConfigured } from "./shared/research-config";
import { registerContextProvider } from "./shared/turn-context";

const STATUS_KEY = "intent";

type IntentOverride = "programming";

let intentOverride: IntentOverride | null = null;

const ALWAYS_ON_CODE_TOOLS = [
  "code_search",
  "list_files",
  "inspect_json",
  "inspect_text_matches",
  "inspect_code_structure",
  "inspect_lines",
  "plan_code_replacements",
  "apply_code_replacements",
  "create_file",
  "create_directory",
  "run_checks",
  "commit_history",
  "see_file_commit_history",
  "git_status",
  "git_diff",
  "inspect_at_checkpoint",
];

const CAPABILITY_TOOLS: Record<CapabilityGroup, string[]> = {
  core: ["bash"],
  readonly: ["read", "bash", "fetch_url"],
  coding: ["bash"],
  repo: [],
  project: ["save_project_plan", "update_feature_tdd", "log_decision", "manage_question"],
  memory: ["remember", "recall_memories", "update_memory", "forget_memory", "list_memories", "recall_entity", "list_entities"],
  "memory-lite": ["remember", "recall_memories", "recall_entity"],
  research: ["recall_web_knowledge", "list_search_history", "get_search_entry", "web_search", "save_search_knowledge", "research_topic"],
  fetch: ["fetch_url"],
  shoes: ["lookup_shoe", "find_shoes_by_spec", "compare_shoes", "shoe_catalog_stats", "add_shoe", "query_shoes"],
  personal: ["remember", "recall_memories", "recall_entity"],
  safety: [],
};

const DOMAIN_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  ...CAPABILITY_TOOLS.project,
  ...CAPABILITY_TOOLS.memory,
  ...CAPABILITY_TOOLS.research,
  ...CAPABILITY_TOOLS.shoes,
  "fetch_url",
  "code_search",
  "list_files",
  "inspect_json",
  "inspect_text_matches",
  "inspect_code_structure",
  "inspect_lines",
  "plan_code_replacements",
  "apply_code_replacements",
  "create_file",
  "create_directory",
  "run_checks",
  "commit_history",
  "see_file_commit_history",
  "git_status",
  "git_diff",
  "inspect_at_checkpoint",
]);

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


function programmingRoute(prompt: string): IntentRoute {
  return {
    ...classifyIntent("implement code change update code tests repo"),
    primaryIntent: "coding",
    secondaryIntents: [],
    confidence: 1,
    capabilityGroups: ["core", "repo", "coding", "project", "safety", "memory-lite"],
    suggestedSkills: [],
    prompt,
    ts: Date.now(),
  };
}

function routeForIntent(prompt: string): IntentRoute {
  if (intentOverride === "programming") return programmingRoute(prompt);
  return classifyIntent(prompt);
}

function sortedToolNames(tools: any[]): string[] {
  return tools.map(toolName).filter(Boolean).sort() as string[];
}

function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function applyRouteTools(pi: ExtensionAPI, route: IntentRoute): void {
  const next = activeToolNames(pi, route.capabilityGroups);
  const current = sortedToolNames(pi.getActiveTools());
  if (sameTools(current, next)) return;
  pi.setActiveTools(next);
}

export function routeForPrompt(pi: ExtensionAPI, prompt: string): IntentRoute {
  const route = routeForIntent(prompt);
  setCurrentRoute(route);
  applyRouteTools(pi, route);
  return route;
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

  pi.registerCommand("switch-intent", {
    description: "Switch intent routing override",
    getArgumentCompletions: (prefix) => {
      const items = ["programming", "auto"];
      const filtered = items.filter(item => item.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (!arg || arg === "programming" || arg === "code" || arg === "coding") {
        intentOverride = "programming";
        const route = routeForPrompt(pi, "manual programming intent");
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("accent", `${route.primaryIntent}:${enabledGroups(modeAdjustedGroups(route.capabilityGroups)).join("+")}`),
        );
        ctx.ui.notify("Intent override: programming. Use /switch-intent auto to resume automatic routing.", "info");
        return;
      }

      if (arg === "auto" || arg === "off" || arg === "clear") {
        intentOverride = null;
        ctx.ui.notify("Intent override cleared. Automatic routing enabled.", "info");
        return;
      }

      ctx.ui.notify('Unknown intent. Use "programming" or "auto".', "error");
    },
  });

  pi.registerCommand("intent-status", {
    description: "Show current intent routing state and active tool count",
    handler: async (_args, ctx) => {
      const route = getCurrentRoute();
      ctx.ui.notify([
        "Intent Router",
        `  ${routeSummary(route)}`,
        `  confidence: ${Math.round(route.confidence * 100)}%`,
        `  research enabled: ${researchEnabled() ? "yes" : "no"}`,
        `  shoes enabled: ${shoesEnabled() ? "yes" : "no"}`,
        `  active tools: ${pi.getActiveTools().map(toolName).filter(Boolean).sort().join(", ")}`,
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
        `  routed tools: ${routed.join(", ") || "none"}`,
        `  active tools: ${pi.getActiveTools().map(toolName).filter(Boolean).sort().join(", ")}`,
      ].join("\n"), "info");
    },
  });
}
