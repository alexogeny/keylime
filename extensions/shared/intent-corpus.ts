import { buildRetrievalIndex, tokenize, type SearchDocument } from "./retrieval";
import type { IntentId } from "./intent";

export type IntentCorpusKind = "followup" | "switch";

export interface IntentCorpusEntry {
  id: string;
  kind: IntentCorpusKind;
  title: string;
  examples: string[];
  targetIntent?: IntentId;
  sticky?: boolean;
  weight?: number;
}

export interface IntentCorpusMatch {
  id: string;
  kind: IntentCorpusKind;
  score: number;
  targetIntent?: IntentId;
  sticky: boolean;
  title: string;
}

export const FOLLOWUP_STICKINESS_THRESHOLD = 0.48;
export const SWITCH_THRESHOLD = 0.52;

export const INTENT_CORPUS: IntentCorpusEntry[] = [
  {
    id: "followup.continue",
    kind: "followup",
    title: "Continue previous task",
    sticky: true,
    examples: [
      "continue", "keep going", "go on", "carry on", "proceed", "ok proceed", "yep proceed", "do that", "do it", "do the next bit",
      "next", "next step", "finish it", "finish this", "complete it", "wrap it up", "keep working", "continue from there", "pick up where you left off",
      "yes", "yep", "yeah", "sounds good", "that sounds good", "looks good", "okay", "ok", "sure", "please do", "go ahead", "ship it",
    ],
  },
  {
    id: "followup.retry-fix",
    kind: "followup",
    title: "Retry or fix previous attempt",
    sticky: true,
    examples: [
      "try again", "retry", "one more try", "fix that", "fix it", "that failed", "it failed", "still failing", "same failure", "same error",
      "that broke", "it broke", "not quite", "almost", "make it pass", "rerun and fix", "address that", "handle that error", "use the same approach",
      "same thing", "same as before", "apply that", "apply the fix", "do the same there", "now the next one", "continue fixing", "keep debugging",
    ],
  },
  {
    id: "followup.elaborate",
    kind: "followup",
    title: "Elaborate on previous answer",
    sticky: true,
    examples: [
      "explain more", "expand on that", "can you elaborate", "more detail", "give examples", "show me", "why", "how so", "what do you mean",
      "make it clearer", "simpler", "summarize that", "turn that into steps", "give me the short version", "give me the detailed version",
    ],
  },
  {
    id: "switch.coding",
    kind: "switch",
    title: "Switch to coding",
    targetIntent: "coding",
    examples: [
      "implement this", "edit the code", "modify the code", "change the source", "update the repository", "patch this", "write the code",
      "add the feature", "fix the code", "make the tests pass", "add tests", "create a file", "update package json", "refactor the module",
      "open the repo", "work in the codebase", "apply the change", "make that change", "commit the implementation", "code this now",
    ],
  },
  {
    id: "switch.debugging",
    kind: "switch",
    title: "Switch to debugging",
    targetIntent: "debugging",
    examples: [
      "debug this", "track down the bug", "why is this failing", "find the root cause", "reproduce the failure", "inspect the stack trace",
      "test is failing", "failing test", "unexpected output", "it crashes", "panic when", "throws an exception", "regression after change",
    ],
  },
  {
    id: "switch.research",
    kind: "switch",
    title: "Switch to research",
    targetIntent: "research",
    examples: [
      "search the web", "look this up", "research this", "find current info", "find latest information", "check current sources", "web search this",
      "is this still true", "what is the latest", "current best practice", "find sources", "read the docs online", "fetch this url", "open this website",
      "browse for", "look online", "verify against current sources", "find recent papers", "find 2026 information",
    ],
  },
  {
    id: "switch.memory",
    kind: "switch",
    title: "Switch to memory",
    targetIntent: "memory",
    examples: [
      "remember this", "save this memory", "store this", "add to memory", "recall my memory", "what do you remember", "forget this",
      "save my preference", "remember my preference", "update my profile", "record this fact", "remember that I", "my preference is", "note this about me",
    ],
  },
  {
    id: "switch.planning",
    kind: "switch",
    title: "Switch to planning",
    targetIntent: "planning",
    examples: [
      "make a plan", "plan this project", "break this down", "roadmap", "implementation plan", "write a spec", "acceptance criteria",
      "task breakdown", "sequence the work", "prioritize the work", "project plan", "tdd plan", "design the approach",
    ],
  },
  {
    id: "switch.review",
    kind: "switch",
    title: "Switch to review",
    targetIntent: "review",
    examples: [
      "review this", "audit this", "critique the code", "look for issues", "security review", "test audit", "what is missing",
      "find risks", "inspect quality", "review the design", "check for bugs", "evaluate this implementation",
    ],
  },
  {
    id: "switch.chat",
    kind: "switch",
    title: "Switch to chat",
    targetIntent: "chat",
    examples: [
      "just chat", "answer normally", "no tools", "stop coding", "talk only", "explain without editing", "do not use tools", "general question",
      "quick answer", "conceptual answer", "high level answer", "brainstorm only", "no repo work",
    ],
  },
];

function entryText(entry: IntentCorpusEntry): string {
  return [entry.title, entry.kind, entry.targetIntent ?? "", ...entry.examples].join("\n");
}

const corpusDocs: SearchDocument[] = INTENT_CORPUS.map(entry => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  body: entryText(entry),
  fields: {
    targetIntent: entry.targetIntent,
    sticky: entry.sticky ?? false,
    examples: entry.examples,
  },
  tags: [entry.kind, entry.targetIntent ?? "sticky"],
}));

const corpusIndex = buildRetrievalIndex(corpusDocs);
const byId = new Map(INTENT_CORPUS.map(entry => [entry.id, entry]));

function exactOrTokenBoost(entry: IntentCorpusEntry, prompt: string): number {
  const clean = prompt.toLowerCase().trim();
  if (!clean) return 0;
  if (entry.examples.some(example => example === clean)) return 0.55;
  if (entry.examples.some(example => clean.includes(example) && example.length >= 6)) return 0.35;
  const promptTokens = new Set(tokenize(clean, { minLength: 2 }));
  let best = 0;
  for (const example of entry.examples) {
    const exampleTokens = tokenize(example, { minLength: 2 });
    if (exampleTokens.length === 0) continue;
    const overlap = exampleTokens.filter(token => promptTokens.has(token)).length;
    best = Math.max(best, overlap / exampleTokens.length);
  }
  return Math.min(0.3, best * 0.3);
}

export function matchIntentCorpus(prompt: string, options: { kind?: IntentCorpusKind; topK?: number } = {}): IntentCorpusMatch[] {
  const hits = corpusIndex.search(prompt, {
    topK: Math.max(options.topK ?? 4, 1) * 2,
    heuristic: doc => {
      const entry = byId.get(doc.id);
      if (!entry) return 0;
      let score = exactOrTokenBoost(entry, prompt);
      if (options.kind && entry.kind === options.kind) score += 0.2;
      if (entry.weight) score += entry.weight;
      return Math.min(1, score);
    },
  });

  return hits
    .map(hit => {
      const entry = byId.get(hit.id)!;
      const lexical = exactOrTokenBoost(entry, prompt);
      return {
        id: entry.id,
        kind: entry.kind,
        score: Math.min(1, lexical + hit.score * 0.25),
        targetIntent: entry.targetIntent,
        sticky: entry.sticky ?? false,
        title: entry.title,
      } satisfies IntentCorpusMatch;
    })
    .filter(match => !options.kind || match.kind === options.kind)
    .slice(0, options.topK ?? 4);
}

export function bestIntentCorpusMatch(prompt: string, kind?: IntentCorpusKind): IntentCorpusMatch | undefined {
  return matchIntentCorpus(prompt, { kind, topK: 1 })[0];
}
