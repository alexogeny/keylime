import { INTENT_PROFILES, type IntentProfileDefinition } from "./intent-registry";

export type IntentId =
  | "chat"
  | "coding"
  | "debugging"
  | "refactor"
  | "review"
  | "planning"
  | "project"
  | "research"
  | "memory"
  | "personal"
  | "running_shoes"
  | "running_biomechanics"
  | "python_engineering"
  | "rust_systems"
  | "rust_shell_emulator"
  | "ui_design";

export type CapabilityGroup =
  | "core"
  | "readonly"
  | "coding"
  | "repo"
  | "project"
  | "memory"
  | "memory-lite"
  | "research"
  | "fetch"
  | "shoes"
  | "personal"
  | "safety";

export type TemporalContext = {
  freshnessRequested: boolean;
  explicitResearchRequested: boolean;
};

export type IntentRoute = {
  primaryIntent: IntentId;
  secondaryIntents: IntentId[];
  confidence: number;
  scores: Partial<Record<IntentId, number>>;
  capabilityGroups: CapabilityGroup[];
  suggestedSkills: string[];
  temporal: TemporalContext;
  prompt: string;
  ts: number;
};

type IntentProfile = IntentProfileDefinition;

const PROFILES: IntentProfile[] = INTENT_PROFILES;

const STOP = new Set(["the", "and", "for", "this", "that", "with", "have", "please", "can", "you", "into", "from", "would", "could"]);

const FRESHNESS_KEYWORDS = new Set(["latest", "newest", "current", "recent", "released", "release", "upcoming", "updated", "2025", "2026", "2027"]);
const FRESHNESS_PHRASES = ["just released", "most recent", "up to date", "up-to-date", "new version", "latest version", "current version", "release date"];
const EXPLICIT_RESEARCH_PHRASES = ["web search", "search the web", "research this", "find sources", "cite sources", "compare sources", "look this up online", "check online"];
const EXPLICIT_RESEARCH_KEYWORDS = new Set(["research", "web", "sources", "cite", "citation", "online"]);

export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
}

function normalize(text: string): string {
  return stripSystemReminders(text).toLowerCase().replace(/[^a-z0-9_+.#\s/-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokensFor(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(t => t.length > 1 && !STOP.has(t)));
}

function scoreProfile(profile: IntentProfile, raw: string, tokens: Set<string>): number {
  let score = 0;

  for (const phrase of profile.phrases) {
    if (phrase.includes(" ") && raw.includes(phrase)) score += 4;
  }

  for (const keyword of profile.keywords) {
    if (tokens.has(keyword)) score += 1;
  }

  for (const entity of profile.entities ?? []) {
    if (entity.includes(" ") ? raw.includes(entity) : tokens.has(entity)) score += 2;
  }

  for (const keyword of profile.negativeKeywords ?? []) {
    if (tokens.has(keyword) || raw.includes(keyword)) score -= 2;
  }
  return score;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function temporalContext(raw: string, tokens: Set<string>): TemporalContext {
  const freshnessRequested = [...FRESHNESS_KEYWORDS].some(k => tokens.has(k)) || FRESHNESS_PHRASES.some(p => raw.includes(p));
  const explicitResearchRequested = [...EXPLICIT_RESEARCH_KEYWORDS].some(k => tokens.has(k)) || EXPLICIT_RESEARCH_PHRASES.some(p => raw.includes(p));
  return { freshnessRequested, explicitResearchRequested };
}

function shouldAddFreshnessResearch(primaryIntent: IntentId, temporal: TemporalContext): boolean {
  if (!temporal.freshnessRequested || temporal.explicitResearchRequested) return false;
  return ["running_shoes"].includes(primaryIntent);
}

export function classifyIntent(prompt: string): IntentRoute {
  const cleanPrompt = stripSystemReminders(prompt);
  const raw = normalize(cleanPrompt);
  const tokens = tokensFor(prompt);
  const scored = PROFILES
    .map(profile => ({ profile, score: scoreProfile(profile, raw, tokens) }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(s => s.score >= s.profile.minScore);
  const temporal = temporalContext(raw, tokens);
  const researchProfile = PROFILES.find(p => p.id === "research")!;
  const inferredPrimary = matched[0]?.profile ?? PROFILES.find(p => p.id === "coding")!;
  const primary = temporal.explicitResearchRequested ? researchProfile : inferredPrimary;
  const secondary = matched.filter(s => s.profile.id !== primary.id).slice(0, 4).map(s => s.profile.id);
  const bestScore = matched[0]?.score ?? 0;
  const confidence = Math.max(0.15, Math.min(0.95, bestScore / 12));

  const capabilityGroups = uniq([
    ...primary.capabilityGroups,
    ...matched.filter(s => s.profile.id !== primary.id).slice(0, 3).flatMap(s => s.profile.capabilityGroups),
    ...(shouldAddFreshnessResearch(primary.id, temporal) ? ["research" as CapabilityGroup, "fetch" as CapabilityGroup] : []),
  ]);
  const suggestedSkills = uniq(matched.flatMap(s => s.profile.skills));
  const scores = Object.fromEntries(scored.filter(s => s.score > 0).map(s => [s.profile.id, s.score])) as Partial<Record<IntentId, number>>;

  if (matched.length === 0 && !temporal.explicitResearchRequested) {
    return {
      primaryIntent: "chat",
      secondaryIntents: [],
      confidence: 0.2,
      scores,
      capabilityGroups: ["readonly", "memory-lite"],
      suggestedSkills: [],
      temporal,
      prompt: cleanPrompt,
      ts: Date.now(),
    };
  }

  return {
    primaryIntent: primary.id,
    secondaryIntents: secondary,
    confidence,
    scores,
    capabilityGroups,
    suggestedSkills,
    temporal,
    prompt: cleanPrompt,
    ts: Date.now(),
  };
}

let currentRoute: IntentRoute = classifyIntent("");

export function setCurrentRoute(route: IntentRoute): void {
  currentRoute = route;
}

export function getCurrentRoute(): IntentRoute {
  return currentRoute;
}

export function isCapabilityActive(group: CapabilityGroup): boolean {
  return currentRoute.capabilityGroups.includes(group);
}

export function routeSummary(route = currentRoute): string {
  const secondary = route.secondaryIntents.length ? ` + ${route.secondaryIntents.join(",")}` : "";
  const skills = route.suggestedSkills.length ? `; skills: ${route.suggestedSkills.join(", ")}` : "";
  return `intent: ${route.primaryIntent}${secondary}; capabilities: ${route.capabilityGroups.join(", ")}${skills}`;
}
