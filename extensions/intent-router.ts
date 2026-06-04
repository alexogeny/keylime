import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyIntent, getCurrentRoute, routeSummary, setCurrentRoute, stripSystemReminders, type CapabilityGroup, type IntentRoute } from "./shared/intent";
import { registerContextProvider } from "./shared/turn-context";

const STATUS_KEY = "intent";

const CAPABILITY_TOOLS: Record<CapabilityGroup, string[]> = {
  core: ["read", "bash", "edit", "write", "code_search", "inspect_text_matches", "inspect_code_structure", "inspect_code_structure", "apply_code_replacements"],
  readonly: ["read", "bash", "code_search", "fetch_url", "inspect_text_matches"],
  coding: ["read", "bash", "edit", "write", "code_search", "inspect_text_matches", "inspect_code_structure", "inspect_code_structure", "apply_code_replacements"],
  repo: ["code_search", "inspect_text_matches", "inspect_code_structure"],
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
  "inspect_text_matches",
  "inspect_code_structure",
  "apply_code_replacements",
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

function providerKeyPresent(): boolean {
  return Boolean(process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY || process.env.BING_API_KEY);
}

export function researchEnabled(): boolean {
  if (process.env.KEYLIME_DISABLE_RESEARCH === "1") return false;
  if (process.env.KEYLIME_ENABLE_RESEARCH === "1") return true;
  return providerKeyPresent();
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

export function activeToolNames(pi: ExtensionAPI, groups: CapabilityGroup[]): string[] {
  const available = new Set(pi.getAllTools().map(toolName).filter(Boolean) as string[]);
  const desired = new Set<string>();

  for (const group of enabledGroups(groups)) {
    for (const name of CAPABILITY_TOOLS[group]) desired.add(name);
  }

  // Preserve non-domain tools from other extensions/providers. Domain tools are
  // explicitly governed by intent so they do not pollute the prompt every turn.
  for (const tool of pi.getActiveTools()) {
    const name = toolName(tool);
    if (name && !DOMAIN_TOOLS.has(name)) desired.add(name);
  }

  return [...desired].filter(name => available.has(name)).sort();
}


export function routeForPrompt(pi: ExtensionAPI, prompt: string): IntentRoute {
  const route = classifyIntent(prompt);
  setCurrentRoute(route);
  pi.setActiveTools(activeToolNames(pi, route.capabilityGroups));
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

  lines.push(`Intent: ${route.primaryIntent}; tools: ${enabledGroups(route.capabilityGroups).join(", ") || "none"}.`);

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
      ctx.ui.theme.fg("dim", `${route.primaryIntent}:${enabledGroups(route.capabilityGroups).join("+")}`),
    );

    return { action: "continue" };
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as any[];
    const prompt = lastUserPrompt(messages);

    // Tool results can cause additional context passes without a new input event.
    // Reclassify here for reminder accuracy, but tool visibility was already set
    // during input so the provider prompt sees the right active schema set.
    if (prompt.trim()) setCurrentRoute(classifyIntent(prompt));

    const route = getCurrentRoute();
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `${route.primaryIntent}:${enabledGroups(route.capabilityGroups).join("+")}`),
    );

    return;
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
}
