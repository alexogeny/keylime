import { TFIDFStore, tokenize } from "../shared/retrieval";
import type { MemoryCategory } from "./types.js";
import type { ExpiryTier } from "./expiry.js";

interface FeatureGroup {
  name: string;
  weight: number;
  tokens: Set<string>;
}

const FEATURE_GROUPS: FeatureGroup[] = [
  {
    name: "preference_strong",
    weight: 3.5,
    tokens: new Set([
      "prefer", "love", "hate", "despise", "dislike", "enjoy", "adore",
      "always", "never", "non-negotiable", "must", "only", "exclusively",
      "favourite", "favorite", "best", "worst",
    ]),
  },
  {
    name: "comparison",
    weight: 2.5,
    tokens: new Set([
      "over", "instead", "rather", "versus", "vs", "avoid",
      "ditch", "ditched", "switch", "switched", "migrated", "moved",
      "replaced", "dropped", "abandoned", "chose", "chosen", "pick", "picked",
    ]),
  },
  {
    name: "personal",
    weight: 1.5,
    tokens: new Set(["i", "my", "mine", "we", "our", "im", "ive", "ill"]),
  },
  {
    name: "temporal",
    weight: 4.0,
    tokens: new Set([
      "marathon", "ultramarathon", "race", "triathlon", "ironman",
      "deadline", "due", "launch", "release", "ship", "shipped", "go-live",
      "birthday", "anniversary", "wedding", "graduation", "holiday",
      "appointment", "meeting", "interview", "conference", "summit", "event",
      "training", "scheduled", "booked", "registered", "signed", "enrolled",
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ]),
  },
  {
    name: "fact_assertion",
    weight: 2.0,
    tokens: new Set([
      "work", "job", "role", "position", "title", "company", "employer", "firm",
      "live", "based", "located", "moved", "relocated",
      "read", "reading", "book", "novel", "currently",
      "run", "running", "train", "training", "gym", "swim", "cycle", "hike", "walk",
      "eat", "diet", "vegan", "vegetarian",
    ]),
  },
  {
    name: "goal",
    weight: 2.5,
    tokens: new Set([
      "want", "plan", "planning", "trying", "goal", "aim", "target",
      "hoping", "aiming", "working", "building", "learning", "studying",
      "achieve", "complete", "finish", "ship",
    ]),
  },
  {
    name: "correction",
    weight: 3.0,
    tokens: new Set([
      "actually", "correction", "wrong", "changed", "updated",
      "wait", "meant", "anymore", "nevermind", "scratch",
    ]),
  },
  {
    name: "recurrence",
    weight: 3.5,
    tokens: new Set([
      "again", "keeps", "always", "every", "constantly", "repeatedly",
      "never", "pattern", "habit", "chronic", "ongoing", "still", "continue",
    ]),
  },
  {
    name: "temporal_context",
    weight: 2.0,
    tokens: new Set([
      "today", "tonight", "morning", "afternoon", "evening",
      "currently", "right now", "atm", "this week", "lately", "recently",
    ]),
  },
  {
    name: "hyperbolic_frustration",
    weight: 2.5,
    tokens: new Set([
      "literally", "dying", "killing", "kill", "die", "dead", "insane",
      "insanity", "torture", "unbearable", "insufferable", "nightmare",
      "impossible", "absurd", "ridiculous",
    ]),
  },
];

export const SHORT_LIVED_FEATURES = new Set(["temporal_context", "fact_assertion"]);

const TASK_SUPPRESSORS = new Set([
  "implement", "fix", "refactor", "debug", "write", "create", "build",
  "delete", "remove", "add", "update", "change", "modify", "edit",
  "run", "execute", "test", "deploy", "check", "review", "explain",
  "show", "list", "print", "generate", "make", "give", "help", "please",
  "can", "could", "would", "should", "shall", "will", "let", "open",
]);

export interface SignalScore {
  score: number;
  features: string[];
  suppressed: boolean;
}

export function scoreSegment(text: string): SignalScore {
  const tokens = tokenize(text);
  if (tokens.length < 4) return { score: 0, features: [], suppressed: false };

  const taskHits = tokens.filter(t => TASK_SUPPRESSORS.has(t)).length;
  const suppressed = taskHits / tokens.length > 0.28;

  const tset = new Set(tokens);
  const features: string[] = [];
  let score = 0;

  for (const group of FEATURE_GROUPS) {
    let hits = 0;
    for (const t of tset) if (group.tokens.has(t)) hits++;
    if (hits > 0) {
      score += group.weight * Math.min(hits, 2);
      features.push(group.name);
    }
  }

  return { score, features, suppressed };
}

export const LOW_SIGNAL_THRESHOLD = 2.3;
export const HIGH_SIGNAL_THRESHOLD = 5.5;

export interface TextCandidate {
  text: string;
  score: number;
  features: string[];
}

export function extractCandidates(rawText: string): TextCandidate[] {
  const segments = rawText
    .split(/[.!?;\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  const out: TextCandidate[] = [];
  for (const seg of segments) {
    const { score, features, suppressed } = scoreSegment(seg);
    if (!suppressed && score >= LOW_SIGNAL_THRESHOLD) {
      out.push({ text: seg, score, features });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const CATEGORY_PROTOTYPES: Record<MemoryCategory, string> = {
  preference:
    "prefer use tool framework library package manager always never instead over versus like hate enjoy dislike " +
    "workflow style editor language runtime choice switch switched migrated replaced avoid ditch exclusively " +
    "favourite favorite best worst non-negotiable must only bun npm yarn pnpm uv pip conda poetry brew apt " +
    "vscode neovim vim emacs cursor dark light theme font keyboard shortcut tdd testing approach methodology",

  fact:
    "work job company role position based live city country book read reading favourite hobby sport " +
    "run swim gym cycle hike background experience biography age name diet vegan vegetarian family " +
    "partner spouse child dog cat pet house flat apartment commute remote office hybrid",

  event:
    "marathon race ultramarathon triathlon deadline birthday anniversary wedding graduation holiday " +
    "meeting appointment interview conference summit launch release ship date scheduled booked registered " +
    "enrolled signed training january february march april may june july august september october november december",

  goal:
    "want plan planning trying goal aim target hoping aiming working building learning studying " +
    "achieve complete finish ship improve get better reach hit milestone project personal professional",

  skill:
    "know expert proficient experienced learning studying mastering understand familiar comfortable " +
    "beginner intermediate advanced certified qualified rust typescript python go java kotlin swift " +
    "react nextjs postgres sql nosql docker kubernetes aws gcp azure",

  context:
    "project current working building configured stack environment setup using active deployed running " +
    "repository codebase module service api database schema migration team sprint backlog feature bug",
};

function buildPrototypeClassifier(): TFIDFStore {
  const store = new TFIDFStore();
  for (const [cat, text] of Object.entries(CATEGORY_PROTOTYPES)) {
    store.add(cat, text);
  }
  return store;
}

const PROTO_CLASSIFIER = buildPrototypeClassifier();

export function classifyCategory(text: string): { category: MemoryCategory; confidence: number } {
  const results = PROTO_CLASSIFIER.search(text, 6);
  if (results.length === 0) return { category: "fact", confidence: 0 };
  const top = results[0];
  return { category: top.id as MemoryCategory, confidence: top.score };
}

export interface DetectedHint {
  text: string;
  category: MemoryCategory;
  features: string[];
  score: number;
  confidence: number;
  novelty: number;
  expiry: ExpiryTier;
  isPattern: boolean;
  turnIndex?: number;
}
