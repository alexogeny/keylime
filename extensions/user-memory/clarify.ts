/**
 * Clarification Module
 *
 * Detects three situations where a single targeted question, asked naturally
 * in the next response, is better than silently guessing or silently skipping.
 *
 * Grounded in ICLR 2025 Active Task Disambiguation research:
 *   - Ask at most ONE question per turn
 *   - Only when the interpretation-space entropy is genuinely high
 *   - Pick the question with the highest expected information gain
 *   - Never interrogate; surface the question only when conversationally natural
 *
 * Three triggers:
 *
 *   1. THIRD_PARTY_SHARE
 *      "my colleague told me she's pregnant" — a personal signal fires but the
 *      fact is about someone else, not the user. No entity anchor exists for the
 *      third party. Ask who they are, or whether to remember it at all.
 *
 *   2. BORDERLINE_SCOPE
 *      Signal fires in the ambiguous zone (low–medium confidence) with no
 *      temporal anchor and no strong preference marker. Ask whether this is
 *      ongoing or a one-off moment.
 *
 *   3. CONTRADICTION
 *      New signal resembles an existing memory topically (high BM25) but the
 *      content appears to conflict (negation markers present). Ask which is
 *      current rather than silently overwriting or silently ignoring.
 *
 * Output: PendingClarification[]
 * Consumed by: before_agent_start (injected as a soft system-prompt suggestion)
 * The LLM (me) decides whether and how to surface the question naturally.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ClarificationType = "third_party" | "borderline_scope" | "contradiction";

export interface PendingClarification {
  type:     ClarificationType;
  question: string;     // suggested question to weave into next response
  context:  string;     // the triggering text snippet
  priority: "high" | "low";
}

// ─── Token helpers ─────────────────────────────────────────────────────────────

const STOP = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","have","has","do","does","it","as","if",
  "this","that","not","no","so","i","my","me","we","our","you","your",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g," ").split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

// ─── Trigger 1: Third-party social share ─────────────────────────────────────
//
// Pattern: POSSESSIVE ("my") + ROLE_WORD + REPORTING_VERB in the same sentence.
// The key distinction: the user is passing on information about someone else,
// not stating a fact about themselves.
//
// Examples that fire:
//   "my colleague told me she's pregnant"
//   "mum said she's coming to visit next week"
//   "A colleague texted me, he got the job"
//
// Examples that must NOT fire (user is the subject):
//   "I told my partner I was leaving"
//   "I mentioned to my boss that I need time off"

const REPORTING_VERBS = new Set([
  "told", "said", "texted", "messaged", "called", "mentioned", "shared",
  "announced", "revealed", "told", "informed", "notified", "let",  // "let me know"
]);

const POSSESSIVE_ROLES = new Set([
  "mum","mom","mother","dad","father","sister","brother","wife","husband",
  "partner","boyfriend","girlfriend","son","daughter","colleague","coworker",
  "teammate","boss","manager","friend","mate","flatmate","housemate","therapist",
  "doctor","gp","client","cat","dog",
]);

export function detectThirdPartyShare(text: string): PendingClarification | null {
  const words    = text.toLowerCase().split(/\s+/);
  const tokens   = new Set(tokenize(text));

  // Must have a reporting verb
  const hasReporting = words.some(w => REPORTING_VERBS.has(w.replace(/[^a-z]/g,"")));
  if (!hasReporting) return null;

  // Must have possessive role reference
  const role = words.find(w => POSSESSIVE_ROLES.has(w.replace(/[^a-z]/g,"")));
  if (!role) return null;

  // The personal-signal score should be LOW (the content is about someone else)
  // Heuristic: the sentence shouldn't contain first-person feature tokens
  const firstPersonTokens = new Set(["prefer","love","hate","always","never","switched","moved","diagnosed"]);
  const hasPersonalSignal = [...firstPersonTokens].some(t => tokens.has(t));
  if (hasPersonalSignal) return null;  // user is the subject, not a reporter

  // Avoid firing on "I told X that I did Y" — check the subject of the reporting verb
  const iIdx = words.findIndex(w => w === "i" || w === "i'm" || w === "i've");
  const rIdx  = words.findIndex(w => REPORTING_VERBS.has(w.replace(/[^a-z]/g,"")));
  if (iIdx !== -1 && iIdx < rIdx) return null; // "I told..." — user is the teller

  const cleanRole = role.replace(/[^a-z]/g,"");

  return {
    type:     "third_party",
    question: `Want me to remember anything about your ${cleanRole} from that? If so, what's their name?`,
    context:  text,
    priority: "low",
  };
}

// ─── Trigger 2: Borderline scope ─────────────────────────────────────────────
//
// Fires when: signal is in the borderline zone (LOW ≤ score < LOW * 1.8) AND
// there's no temporal anchor AND no strong preference marker. The ambiguity is
// in whether this is a permanent fact or a passing moment.

const STRONG_PERM_TOKENS = new Set([
  "always","never","non-negotiable","only","exclusively","every","habit",
  "prefer","hate","love","years","chronic","forever",
]);

const TEMPORAL_TOKENS = new Set([
  "today","tonight","this week","lately","recently","currently","right now",
  "these days","this month","yesterday","atm","rn",
]);

export function detectBorderlineScope(
  text:      string,
  score:     number,
  lowThresh: number,
): PendingClarification | null {
  if (score < lowThresh || score >= lowThresh * 1.8) return null;

  const tokens = new Set(tokenize(text));
  const raw    = text.toLowerCase();

  const hasStrongPerm  = [...STRONG_PERM_TOKENS].some(t => tokens.has(t));
  const hasTimeAnchor  = [...TEMPORAL_TOKENS].some(t => raw.includes(t));
  if (hasStrongPerm || hasTimeAnchor) return null; // anchor already clear

  return {
    type:     "borderline_scope",
    question: "Is this something ongoing for you, or more of a one-time moment?",
    context:  text,
    priority: "low",
  };
}

// ─── Trigger 3: Contradiction ─────────────────────────────────────────────────
//
// Fires when: a new signal has high topical similarity to an existing memory
// (BM25 candidates surface it) BUT the new text contains negation / reversal
// markers that suggest the existing memory may no longer be true.
//
// Uses a simple negation vocabulary — no LLM call needed.
// The actual resolution (which is current?) is left to the LLM.
//
// Implements AGM "Success" postulate: the new belief is accepted, but we
// surface the conflict rather than silently overwriting.

const NEGATION_TOKENS = new Set([
  // Explicit negation / reversal
  "not","no","never","stopped","quit","gave","changed","different",
  "longer","anymore","actually","wrong","mistaken","incorrect",
  "opposite","reversed","dropped","abandoned","switched","moved",
  // Positive-reversal: imply the end of a prior behaviour without "not"
  // "I've been sober" implies stopped drinking; "I'm vegan now" implies diet change
  "sober","sobriety","clean","recovered","recovery","quitting",
  "abstinent","abstaining","vegan","vegetarian",
  "ex","former","retired","resigned","graduated",
]);

const REVERSAL_PHRASES = [
  "no longer", "not anymore", "gave up", "quit doing", "stopped being",
  "changed my mind", "turns out", "actually i", "wait no",
];

export interface ExistingMemorySnapshot {
  id:      string;
  content: string;
  score:   number;  // BM25 similarity score to new signal
}

export function detectContradiction(
  newText:   string,
  similar:   ExistingMemorySnapshot[],  // top BM25 hits for the new text
): PendingClarification | null {
  if (similar.length === 0) return null;

  const tokens   = new Set(tokenize(newText));
  const rawLower = newText.toLowerCase();

  // Does the new text contain negation/reversal signals?
  const hasNegation = [...NEGATION_TOKENS].some(t => tokens.has(t));
  const hasReversal = REVERSAL_PHRASES.some(p => rawLower.includes(p));
  if (!hasNegation && !hasReversal) return null;

  // Is there a highly similar existing memory? (topical match but content may conflict)
  const top = similar.find(m => m.score > 0.5);
  if (!top) return null;

  // Quick check: if the existing memory also has the same negation tokens, they
  // probably agree (both say "I don't drink") — don't trigger
  const existingTokens = new Set(tokenize(top.content));
  const sharedNegation = [...NEGATION_TOKENS].some(
    t => tokens.has(t) && existingTokens.has(t)
  );
  if (sharedNegation) return null;

  // Generate a forward-looking question, not backward-looking confirmation.
  // Validated r5 #13: "When do you start?" beats "Did you leave your old job?"
  // Don't therapise; ask practically.
  const question = buildContradictionQuestion(newText, top.content);

  return { type:"contradiction", question, context:newText, priority:"high" };
}

// Vocabulary for forward-looking contradiction questions
const CAREER_TOKENS   = new Set(["job","offer","accepted","role","position","hired","canva","google","company","start"]);
const SOBRIETY_TOKENS = new Set(["sober","sobriety","clean","quit","alcohol","drinking","recovery"]);
const DIET_TOKENS     = new Set(["vegan","vegetarian","carnivore","diet","eating"]);
const TOOL_TOKENS     = new Set(["bun","npm","pnpm","pip","uv","vim","neovim","vscode","cursor"]);

function buildContradictionQuestion(newText: string, existingContent: string): string {
  const newToks = new Set(tokenize(newText));

  // Career transition: forward-looking, practical
  if ([...CAREER_TOKENS].some(t => newToks.has(t))) {
    return `When do you start, and do you want me to update your work context?`;
  }

  // Sobriety / substance: celebrate + practical
  if ([...SOBRIETY_TOKENS].some(t => newToks.has(t))) {
    return `How long have you been ${[...SOBRIETY_TOKENS].find(t=>newToks.has(t)) ?? "on this path"}? I'll update what I know about you.`;
  }

  // Diet change
  if ([...DIET_TOKENS].some(t => newToks.has(t))) {
    return `Is this a recent change? Want me to update your diet context?`;
  }

  // Tool/preference switch
  if ([...TOOL_TOKENS].some(t => newToks.has(t))) {
    return `Should I update your tooling preferences to reflect this switch?`;
  }

  // Default: practical, not "are you sure"
  const brief = existingContent.slice(0, 50);
  return `Sounds like this might have changed — want me to update "${brief}${existingContent.length>50?"...":""}"`;
}
