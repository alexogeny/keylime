import type { CapabilityGroup, IntentId } from "./intent";

export type IntentOverrideId = IntentId | "programming";

export interface IntentRegistryEntry {
  id: IntentOverrideId;
  targetIntent: IntentId;
  aliases: string[];
  seedPrompt: string;
}

export interface IntentProfileDefinition {
  id: IntentId;
  phrases: string[];
  keywords: string[];
  entities?: string[];
  negativeKeywords?: string[];
  capabilityGroups: CapabilityGroup[];
  skills: string[];
  minScore: number;
}

export interface IntentCorpusSeed {
  id: string;
  kind: "followup" | "switch";
  title: string;
  examples: string[];
  targetIntent?: IntentId;
  sticky?: boolean;
  weight?: number;
}

export const INTENT_REGISTRY: IntentRegistryEntry[] = [
  { id: "programming", targetIntent: "coding", aliases: ["programming", "code", "coding"], seedPrompt: "implement code change update code tests repo" },
  { id: "coding", targetIntent: "coding", aliases: ["coding", "code"], seedPrompt: "implement code change update code tests repo" },
  { id: "debugging", targetIntent: "debugging", aliases: ["debugging", "debug"], seedPrompt: "debug failing test error stack trace root cause" },
  { id: "refactor", targetIntent: "refactor", aliases: ["refactor"], seedPrompt: "refactor code cleanup preserve behavior" },
  { id: "review", targetIntent: "review", aliases: ["review", "audit"], seedPrompt: "review audit critique code quality risks" },
  { id: "planning", targetIntent: "planning", aliases: ["planning", "plan"], seedPrompt: "make a plan roadmap acceptance criteria" },
  { id: "project", targetIntent: "project", aliases: ["project"], seedPrompt: "project plan feature tdd implementation" },
  { id: "research", targetIntent: "research", aliases: ["research", "web", "search"], seedPrompt: "search the web research latest current sources" },
  { id: "memory", targetIntent: "memory", aliases: ["memory", "remember"], seedPrompt: "remember save memory preference recall" },
  { id: "personal", targetIntent: "personal", aliases: ["personal"], seedPrompt: "personal profile preferences about me" },
  { id: "running_shoes", targetIntent: "running_shoes", aliases: ["running_shoes", "shoes"], seedPrompt: "running shoe recommendation drop stack foam" },
  { id: "running_biomechanics", targetIntent: "running_biomechanics", aliases: ["running_biomechanics", "biomechanics"], seedPrompt: "running biomechanics gait injury training load" },
  { id: "python_engineering", targetIntent: "python_engineering", aliases: ["python_engineering", "python"], seedPrompt: "python optimize performance typing pytest" },
  { id: "rust_systems", targetIntent: "rust_systems", aliases: ["rust_systems", "rust"], seedPrompt: "rust systems ownership lifetime cargo clippy" },
  { id: "rust_shell_emulator", targetIntent: "rust_shell_emulator", aliases: ["rust_shell_emulator", "shell_emulator"], seedPrompt: "rust shell terminal emulator pty ansi parser" },
  { id: "linux_ops", targetIntent: "linux_ops", aliases: ["linux_ops", "linux", "sysadmin"], seedPrompt: "linux ubuntu debian arch cachy systemd apt pacman sudo logs services" },
  { id: "profiling", targetIntent: "profiling", aliases: ["profiling", "profile", "performance"], seedPrompt: "profile performance bottleneck cProfile flamegraph cpu-prof cargo bench py-spy" },
  { id: "ui_design", targetIntent: "ui_design", aliases: ["ui_design", "ui", "ux"], seedPrompt: "ui ux design component accessibility screen" },
  { id: "chat", targetIntent: "chat", aliases: ["chat", "talk"], seedPrompt: "general chat answer normally no tools" },
];

export const INTENT_PROFILES: IntentProfileDefinition[] = [
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
    capabilityGroups: ["readonly", "repo", "safety", "memory-lite"],
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
    id: "linux_ops",
    phrases: ["linux system", "ubuntu server", "debian package", "arch package", "cachy package", "systemd service", "journal logs", "apt install", "pacman install", "sudo password", "disk full", "network diagnostics", "linux permissions", "kill process"],
    keywords: ["linux", "ubuntu", "debian", "arch", "cachy", "systemd", "journalctl", "service", "services", "apt", "apt-get", "pacman", "paru", "yay", "sudo", "kernel", "lsblk", "mount", "ports", "firewall", "chmod", "chown", "process", "disk", "logs", "sysadmin"],
    capabilityGroups: ["readonly", "linux", "safety"],
    skills: ["agentic-programming"],
    minScore: 3,
  },
  {
    id: "profiling",
    phrases: ["profile this", "performance profile", "find bottleneck", "cpu profile", "flamegraph", "benchmark this", "python cprofile", "typescript cpu profile", "node cpu profile", "bun profile", "cargo bench", "rust flamegraph"],
    keywords: ["profile", "profiling", "profiler", "performance", "perf", "bottleneck", "benchmark", "bench", "cprofile", "py-spy", "flamegraph", "cpu-prof", "hot", "slow", "latency", "throughput"],
    capabilityGroups: ["readonly", "repo", "profiling", "safety"],
    skills: ["agentic-programming"],
    minScore: 3,
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

export const INTENT_FOLLOWUP_CORPUS: IntentCorpusSeed[] = [
  { id: "followup.continue", kind: "followup", title: "Continue previous task", sticky: true, examples: ["continue", "keep going", "go on", "carry on", "proceed", "ok proceed", "yep proceed", "do that", "do it", "do the next bit", "next", "next step", "finish it", "finish this", "complete it", "wrap it up", "keep working", "continue from there", "pick up where you left off", "yes", "yep", "yeah", "sounds good", "that sounds good", "looks good", "okay", "ok", "sure", "please do", "go ahead", "ship it"] },
  { id: "followup.retry-fix", kind: "followup", title: "Retry or fix previous attempt", sticky: true, examples: ["try again", "retry", "one more try", "fix that", "fix it", "that failed", "it failed", "still failing", "same failure", "same error", "that broke", "it broke", "not quite", "almost", "make it pass", "rerun and fix", "address that", "handle that error", "use the same approach", "same thing", "same as before", "apply that", "apply the fix", "do the same there", "now the next one", "continue fixing", "keep debugging"] },
  { id: "followup.elaborate", kind: "followup", title: "Elaborate on previous answer", sticky: true, examples: ["explain more", "expand on that", "can you elaborate", "more detail", "give examples", "show me", "why", "how so", "what do you mean", "make it clearer", "simpler", "summarize that", "turn that into steps", "give me the short version", "give me the detailed version"] },
];

export const INTENT_SWITCH_CORPUS: IntentCorpusSeed[] = [
  { id: "switch.coding", kind: "switch", title: "Switch to coding", targetIntent: "coding", examples: ["implement this", "edit the code", "modify the code", "change the source", "update the repository", "patch this", "write the code", "add the feature", "fix the code", "make the tests pass", "add tests", "create a file", "update package json", "refactor the module", "open the repo", "work in the codebase", "apply the change", "make that change", "commit the implementation", "code this now"] },
  { id: "switch.debugging", kind: "switch", title: "Switch to debugging", targetIntent: "debugging", examples: ["debug this", "track down the bug", "why is this failing", "find the root cause", "reproduce the failure", "inspect the stack trace", "test is failing", "failing test", "unexpected output", "it crashes", "panic when", "throws an exception", "regression after change"] },
  { id: "switch.research", kind: "switch", title: "Switch to research", targetIntent: "research", examples: ["search the web", "look this up", "research this", "find current info", "find latest information", "check current sources", "web search this", "is this still true", "what is the latest", "current best practice", "find sources", "read the docs online", "fetch this url", "open this website", "browse for", "look online", "verify against current sources", "find recent papers", "find 2026 information"] },
  { id: "switch.memory", kind: "switch", title: "Switch to memory", targetIntent: "memory", examples: ["remember this", "save this memory", "store this", "add to memory", "recall my memory", "what do you remember", "forget this", "save my preference", "remember my preference", "update my profile", "record this fact", "remember that I", "my preference is", "note this about me"] },
  { id: "switch.planning", kind: "switch", title: "Switch to planning", targetIntent: "planning", examples: ["make a plan", "plan this project", "break this down", "roadmap", "implementation plan", "write a spec", "acceptance criteria", "task breakdown", "sequence the work", "prioritize the work", "project plan", "tdd plan", "design the approach"] },
  { id: "switch.review", kind: "switch", title: "Switch to review", targetIntent: "review", examples: ["review this", "audit this", "critique the code", "look for issues", "security review", "test audit", "what is missing", "find risks", "inspect quality", "review the design", "check for bugs", "evaluate this implementation"] },
  { id: "switch.chat", kind: "switch", title: "Switch to chat", targetIntent: "chat", examples: ["just chat", "answer normally", "no tools", "stop coding", "talk only", "explain without editing", "do not use tools", "general question", "quick answer", "conceptual answer", "high level answer", "brainstorm only", "no repo work"] },
];

export const AUTO_INTENT_ALIASES = ["", "auto", "off", "clear", "reset"];

const byId = new Map(INTENT_REGISTRY.map(entry => [entry.id, entry]));
const byAlias = new Map<string, IntentRegistryEntry>();
for (const entry of INTENT_REGISTRY) {
  byAlias.set(entry.id, entry);
  for (const alias of entry.aliases) byAlias.set(alias, entry);
}

export function intentRegistryEntry(id: IntentOverrideId): IntentRegistryEntry | undefined {
  return byId.get(id);
}

export function resolveIntentAlias(value: string): IntentOverrideId | "auto" | undefined {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (AUTO_INTENT_ALIASES.includes(normalized)) return "auto";
  return byAlias.get(normalized)?.id;
}

export function intentSeedPrompt(id: IntentOverrideId): string {
  return byId.get(id)?.seedPrompt ?? "general chat answer normally no tools";
}

export function intentTarget(id: IntentOverrideId): IntentId {
  return byId.get(id)?.targetIntent ?? (id === "programming" ? "coding" : id as IntentId);
}

export function intentCompletionValues(): string[] {
  return ["auto", "reset", ...INTENT_REGISTRY.map(entry => entry.id)].sort();
}

export function validIntentOverrideIds(): IntentOverrideId[] {
  return INTENT_REGISTRY.map(entry => entry.id);
}
