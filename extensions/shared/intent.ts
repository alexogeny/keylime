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

export type IntentRoute = {
  primaryIntent: IntentId;
  secondaryIntents: IntentId[];
  confidence: number;
  scores: Partial<Record<IntentId, number>>;
  capabilityGroups: CapabilityGroup[];
  suggestedSkills: string[];
  prompt: string;
  ts: number;
};

type IntentProfile = {
  id: IntentId;
  phrases: string[];
  keywords: string[];
  negativeKeywords?: string[];
  capabilityGroups: CapabilityGroup[];
  skills: string[];
  minScore: number;
};

const PROFILES: IntentProfile[] = [
  {
    id: "debugging",
    phrases: ["debug this", "failing test", "test is failing", "error message", "stack trace", "regression", "root cause", "why is this failing"],
    keywords: ["debug", "error", "failing", "failed", "failure", "traceback", "panic", "exception", "regression", "reproduce", "isolate"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["debug"],
    minScore: 3,
  },
  {
    id: "refactor",
    phrases: ["refactor this", "clean this up", "restructure", "split this module", "extract function", "without changing behaviour"],
    keywords: ["refactor", "clean", "restructure", "rename", "extract", "simplify", "debt", "behaviour", "behavior"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["refactor"],
    minScore: 3,
  },
  {
    id: "review",
    phrases: ["review my code", "code smells", "audit this", "security review", "read only", "look over"],
    keywords: ["review", "audit", "smell", "inefficiency", "inefficient", "risk", "security", "correctness", "maintainability"],
    capabilityGroups: ["readonly", "repo", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "python_engineering",
    phrases: ["optimize this python", "make this faster", "performance bottleneck", "hot path", "profile this"],
    keywords: ["python", "py", "performance", "optimize", "optimise", "slow", "profiling", "profile", "hotpath", "latency"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["python-eng"],
    minScore: 4,
  },
  {
    id: "rust_shell_emulator",
    phrases: ["shell emulator", "terminal emulator", "pty", "job control", "ansi parser", "vt100"],
    keywords: ["rust", "shell", "terminal", "pty", "tty", "ansi", "vt100", "parser", "job", "signal"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["rust-shell-emulator"],
    minScore: 5,
  },
  {
    id: "rust_systems",
    phrases: ["rust systems", "borrow checker", "lifetime issue", "async rust", "no_std"],
    keywords: ["rust", "cargo", "lifetime", "borrow", "ownership", "tokio", "async", "trait", "unsafe", "no_std"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["rust-systems"],
    minScore: 4,
  },
  {
    id: "ui_design",
    phrases: ["design this screen", "ui design", "component hierarchy", "interaction states", "empty state"],
    keywords: ["ui", "ux", "screen", "component", "layout", "responsive", "accessibility", "a11y", "loading", "empty", "error"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety"],
    skills: ["ui-design"],
    minScore: 3,
  },
  {
    id: "coding",
    phrases: ["build it", "implement", "add feature", "change this code", "edit the file", "write tests", "fix tests"],
    keywords: ["code", "implement", "build", "edit", "file", "test", "repo", "function", "class", "typescript", "javascript", "python", "rust"],
    capabilityGroups: ["core", "repo", "coding", "project", "safety", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "project",
    phrases: ["project plan", "tdd status", "architectural decision", "open question", "acceptance criteria"],
    keywords: ["project", "plan", "feature", "tdd", "adr", "decision", "criteria", "requirements", "scope"],
    capabilityGroups: ["core", "repo", "project", "memory-lite"],
    skills: ["clarify"],
    minScore: 3,
  },
  {
    id: "planning",
    phrases: ["plan out", "how would we", "architecture plan", "design the approach", "break this down"],
    keywords: ["plan", "architecture", "approach", "design", "roadmap", "phase", "strategy"],
    capabilityGroups: ["readonly", "repo", "project", "memory-lite"],
    skills: ["clarify"],
    minScore: 3,
  },
  {
    id: "research",
    phrases: ["web search", "research this", "current information", "latest", "look up", "find sources", "read this url", "pasted url"],
    keywords: ["research", "search", "web", "current", "latest", "source", "sources", "cite", "citation", "tavily", "serper", "bing", "url", "http", "https", "docs"],
    capabilityGroups: ["readonly", "research", "fetch", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "memory",
    phrases: ["remember this", "forget that", "what do you know about me", "my preference", "save this"],
    keywords: ["remember", "forget", "memory", "preference", "recall", "stored", "about me"],
    capabilityGroups: ["memory", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "personal",
    phrases: ["help me decide", "life admin", "habit", "schedule", "personal plan"],
    keywords: ["personal", "habit", "schedule", "decide", "goal", "life", "admin", "coach"],
    capabilityGroups: ["personal", "memory", "memory-lite"],
    skills: [],
    minScore: 3,
  },
  {
    id: "running_shoes",
    phrases: ["running shoes", "shoe rotation", "heel drop", "stack height", "pronation", "gait analysis"],
    keywords: ["shoe", "shoes", "running", "runner", "drop", "stack", "foam", "pronation", "supination", "gait", "hoka", "saucony", "asics"],
    capabilityGroups: ["shoes", "memory-lite"],
    skills: ["running-biomechanics"],
    minScore: 3,
  },
];

const STOP = new Set(["the", "and", "for", "this", "that", "with", "have", "please", "can", "you", "into", "from", "would", "could"]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_+.#\s/-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokensFor(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(t => t.length > 1 && !STOP.has(t)));
}

function scoreProfile(profile: IntentProfile, raw: string, tokens: Set<string>): number {
  let score = 0;
  for (const phrase of profile.phrases) {
    if (raw.includes(phrase)) score += 4;
  }
  for (const keyword of profile.keywords) {
    if (keyword.includes(" ")) {
      if (raw.includes(keyword)) score += 2;
    } else if (tokens.has(keyword)) {
      score += 1;
    }
  }
  for (const keyword of profile.negativeKeywords ?? []) {
    if (tokens.has(keyword) || raw.includes(keyword)) score -= 2;
  }
  return score;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function classifyIntent(prompt: string): IntentRoute {
  const raw = normalize(prompt);
  const tokens = tokensFor(prompt);
  const scored = PROFILES
    .map(profile => ({ profile, score: scoreProfile(profile, raw, tokens) }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(s => s.score >= s.profile.minScore);
  const primary = matched[0]?.profile ?? PROFILES.find(p => p.id === "coding")!;
  const secondary = matched.slice(1, 4).map(s => s.profile.id);
  const bestScore = matched[0]?.score ?? 0;
  const confidence = Math.max(0.15, Math.min(0.95, bestScore / 12));

  const capabilityGroups = uniq([
    ...primary.capabilityGroups,
    ...matched.slice(1, 3).flatMap(s => s.profile.capabilityGroups),
  ]);
  const suggestedSkills = uniq(matched.flatMap(s => s.profile.skills));
  const scores = Object.fromEntries(scored.filter(s => s.score > 0).map(s => [s.profile.id, s.score])) as Partial<Record<IntentId, number>>;

  if (matched.length === 0) {
    return {
      primaryIntent: "chat",
      secondaryIntents: [],
      confidence: 0.2,
      scores,
      capabilityGroups: ["readonly", "memory-lite"],
      suggestedSkills: [],
      prompt,
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
    prompt,
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
