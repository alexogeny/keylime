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

type IntentProfile = {
  id: IntentId;
  /** Multi-word prompt fragments, e.g. "failing test" or "brooks ghost". */
  phrases: string[];
  /** Single-token signals matched after tokenization. */
  keywords: string[];
  /** Domain entities/model names that should boost an intent without being skill hints. */
  entities?: string[];
  negativeKeywords?: string[];
  capabilityGroups: CapabilityGroup[];
  skills: string[];
  minScore: number;
};

const PROFILES: IntentProfile[] = [
  {
    id: "debugging",
    phrases: ["debug this", "failing test", "test is failing", "error message", "stack trace", "regression", "root cause", "why is this failing", "track down", "figure out why", "reproduce the bug", "unexpected output", "crashes when", "throws when", "panic when", "broken after", "test failure", "failing spec"],
    keywords: ["debug", "bug", "bugs", "broken", "error", "errors", "failing", "failed", "failure", "traceback", "stacktrace", "stack", "panic", "exception", "crash", "crashes", "regression", "reproduce", "repro", "isolate", "unexpected", "wrong", "flaky"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["debug"],
    minScore: 3,
  },
  {
    id: "refactor",
    phrases: ["refactor this", "clean this up", "split this module", "extract function", "without changing behaviour", "without changing behavior", "simplify this", "make this cleaner", "remove duplication", "break up this file", "rename this", "tidy this", "clean architecture"],
    keywords: ["refactor", "refactoring", "clean", "cleanup", "tidy", "restructure", "reorganize", "reorganise", "rename", "extract", "simplify", "debt", "duplication", "duplicate", "abstraction", "behaviour", "behavior"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["refactor"],
    minScore: 3,
  },
  {
    id: "review",
    phrases: ["review my code", "code smells", "audit this", "security review", "read only", "look over", "what is wrong", "find issues", "spot problems", "review these changes", "pr review", "pull request review", "code audit", "perf review", "cache invalidation", "prompt pollution", "context drift"],
    keywords: ["review", "audit", "smell", "smells", "inefficiency", "inefficient", "risk", "risks", "security", "correctness", "maintainability", "pollution", "drift", "cache", "invalidation", "prompt", "context"],
    capabilityGroups: ["readonly", "repo", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "python_engineering",
    phrases: ["codemod python", "modernize python typing", "rewrite python imports", "bulk edit python", "optimize this python", "optimise this python", "make this faster", "performance bottleneck", "hot path", "profile this", "speed up", "too slow", "reduce allocations", "memory usage", "cpu bound", "io bound", "syscall heavy", "python performance"],
    keywords: ["python", "py", "pytest", "django", "fastapi", "performance", "optimize", "optimise", "slow", "slower", "profiling", "profile", "hotpath", "latency", "throughput", "allocation", "allocations", "memory", "cpu", "syscall"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["python-eng", "python-codemod"],
    minScore: 4,
  },
  {
    id: "rust_shell_emulator",
    phrases: ["shell emulator", "terminal emulator", "pseudo terminal", "job control", "ansi parser", "posix shell", "word expansion", "process group", "foreground job", "terminal escape"],
    keywords: ["rust", "shell", "terminal", "pty", "tty", "ansi", "vt100", "parser", "lexing", "ast", "expansion", "job", "jobs", "signal", "signals", "process", "processes", "posix", "termios"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["rust-shell-emulator"],
    minScore: 5,
  },
  {
    id: "rust_systems",
    phrases: ["codemod rust", "bulk edit rust", "rename rust module", "rewrite rust imports", "rust systems", "borrow checker", "lifetime issue", "async rust", "no_std", "ownership issue", "trait bounds", "cargo check", "clippy warning", "unsafe rust", "tokio task", "lifetime error"],
    keywords: ["rust", "cargo", "clippy", "lifetime", "lifetimes", "borrow", "ownership", "tokio", "async", "await", "trait", "traits", "unsafe", "no_std", "mutex", "arc", "pin", "send", "sync"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["rust-systems", "rust-codemod"],
    minScore: 4,
  },
  {
    id: "ui_design",
    phrases: ["design this screen", "ui design", "component hierarchy", "interaction states", "empty state", "loading state", "error state", "user flow", "wireframe", "responsive design", "accessibility review", "design system"],
    keywords: ["ui", "ux", "screen", "page", "component", "layout", "responsive", "accessibility", "a11y", "loading", "empty", "error", "success", "state", "states", "flow", "journey", "wireframe", "tokens"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["ui-design"],
    minScore: 3,
  },
  {
    id: "coding",
    phrases: ["codemod", "bulk edit", "replace across files", "rename across repo", "modernize typing", "build it", "add feature", "change this code", "edit the file", "write tests", "fix tests", "can you build", "can you implement", "make the change", "update the code", "add tests", "write code", "wire this up", "ship this", "next phase"],
    keywords: ["code", "implement", "implementation", "build", "edit", "file", "files", "test", "tests", "repo", "repository", "function", "class", "module", "typescript", "javascript", "node", "bun", "python", "rust", "fix", "change", "update", "proceed"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "project",
    phrases: ["project plan", "tdd status", "architectural decision", "open question", "acceptance criteria", "save project", "update feature", "log decision", "decision record", "requirements clarification", "feature list"],
    keywords: ["project", "plan", "feature", "features", "tdd", "red", "green", "refactor", "adr", "decision", "decisions", "criteria", "requirements", "scope", "milestone", "roadmap"],
    capabilityGroups: ["core", "repo", "project", "memory-lite"],
    skills: ["clarify"],
    minScore: 3,
  },
  {
    id: "planning",
    phrases: ["plan out", "how would we", "architecture plan", "design the approach", "break this down", "what is left", "what should we do", "next steps", "implementation plan", "migration plan", "rollout plan", "pros and cons"],
    keywords: ["plan", "planning", "architecture", "approach", "design", "roadmap", "phase", "phases", "strategy", "tradeoff", "tradeoffs", "sequence", "prioritize", "prioritise"],
    capabilityGroups: ["readonly", "repo", "project", "memory-lite"],
    skills: ["clarify"],
    minScore: 3,
  },
  {
    id: "research",
    phrases: ["web search", "research this", "current information", "look up", "find sources", "read this url", "pasted url", "search the web", "find current", "compare sources", "cite sources", "official docs", "read the docs", "fetch this", "open this link"],
    keywords: ["research", "search", "web", "current", "latest", "source", "sources", "cite", "citation", "tavily", "serper", "bing", "url", "http", "https", "docs", "documentation", "link", "links", "article", "paper", "reference"],
    capabilityGroups: ["readonly", "research", "fetch", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "memory",
    phrases: ["remember this", "forget that", "what do you know about me", "my preference", "save this", "store this", "do you remember", "recall my", "update memory", "delete memory", "my details", "about me"],
    keywords: ["remember", "forget", "memory", "memories", "preference", "preferences", "recall", "stored", "save", "store", "profile", "about", "me"],
    capabilityGroups: ["memory", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "personal",
    phrases: ["help me decide", "life admin", "habit", "schedule", "personal plan", "make a plan for me", "workout plan", "training plan", "meal plan", "what should i do", "help me choose", "pros and cons for me"],
    keywords: ["personal", "habit", "habits", "schedule", "calendar", "decide", "decision", "goal", "goals", "life", "admin", "coach", "coaching", "routine", "training", "workout"],
    capabilityGroups: ["personal", "memory", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "running_biomechanics",
    phrases: ["gait analysis", "running form", "foot strike", "injury prevention", "shin splints", "plantar fasciitis", "heel pain", "knee pain"],
    keywords: ["gait", "form", "pronation", "supination", "strike", "cadence", "overstride", "injury", "pain", "biomechanics", "stability"],
    capabilityGroups: ["shoes", "memory-lite"],
    skills: ["running-biomechanics"],
    minScore: 3,
  },
  {
    id: "running_shoes",
    phrases: ["running shoes", "shoe rotation", "heel drop", "stack height", "daily trainer", "tempo shoe", "race shoe", "carbon plate", "super shoe", "stability shoe", "max cushion", "wide fit", "shoe recommendation", "brooks ghost", "ghost max", "brooks glycerin", "brooks adrenaline", "hoka clifton", "hoka bondi", "saucony ride", "saucony triumph", "asics gel nimbus", "asics novablast", "nike pegasus", "new balance 1080"],
    keywords: ["shoe", "shoes", "trainer", "trainers", "running", "runner", "drop", "stack", "midsole", "outsole", "foam", "plate", "carbon", "cushion"],
    entities: ["hoka", "saucony", "asics", "nike", "adidas", "brooks", "ghost", "glycerin", "adrenaline", "hyperion", "new balance", "newbalance", "puma", "pegasus", "clifton", "bondi", "novablast", "nimbus", "kayano", "1080", "880"],
    capabilityGroups: ["shoes", "memory-lite"],
    skills: [],
    minScore: 3,
  },
];

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
