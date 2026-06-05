import type { IntentId } from "./intent";

export type IntentOverrideId = IntentId | "programming";

export interface IntentRegistryEntry {
  id: IntentOverrideId;
  targetIntent: IntentId;
  aliases: string[];
  seedPrompt: string;
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
  { id: "ui_design", targetIntent: "ui_design", aliases: ["ui_design", "ui", "ux"], seedPrompt: "ui ux design component accessibility screen" },
  { id: "chat", targetIntent: "chat", aliases: ["chat", "talk"], seedPrompt: "general chat answer normally no tools" },
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
