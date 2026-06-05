import { buildRetrievalIndex, tokenize, type SearchDocument } from "./retrieval";
import type { IntentId } from "./intent";
import { INTENT_FOLLOWUP_CORPUS, INTENT_SWITCH_CORPUS } from "./intent-registry";

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

export const INTENT_CORPUS: IntentCorpusEntry[] = [...INTENT_FOLLOWUP_CORPUS, ...INTENT_SWITCH_CORPUS];

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
