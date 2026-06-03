#!/usr/bin/env node
/**
 * Memory Detection Validator
 * Usage: node ./validate.mjs
 * Output: /tmp/memory-validation-results.json
 *
 * Skill: memory-validate
 * Replace the EXAMPLES array below to run a new validation round.
 * See SKILL.md for workflow and output format.
 */

import * as readline from "node:readline/promises";
import { writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";

const OUT_FILE = "/tmp/memory-validation-results.json";

// ── ANSI colours ───────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
  white: "\x1b[37m", bgGreen: "\x1b[42m", bgRed: "\x1b[41m",
};
const bold = s => `${c.bold}${s}${c.reset}`;
const dim  = s => `${c.dim}${s}${c.reset}`;
const green= s => `${c.green}${s}${c.reset}`;
const red  = s => `${c.red}${s}${c.reset}`;
const yellow=s => `${c.yellow}${s}${c.reset}`;
const cyan = s => `${c.cyan}${s}${c.reset}`;
const mag  = s => `${c.magenta}${s}${c.reset}`;

// ── EXAMPLES ───────────────────────────────────────────────────────────────────
// Round 5 — 20 policy scenarios. How should memories behave?
// Format: { text, suggested: { is_memory, category, subcategory, tags, reasoning } }
// Flags:  shortLived (2-day expiry), isPattern (recurrence), needsNuance (UI note)

const EXAMPLES = [

  // ── DIMENSION 1: SENSITIVITY TIERS ──────────────────────────────────────────
  // Should some memories be context-gated rather than always injected?

  // #1  Infidelity — inject everywhere or only in relationship discussions?
  { text: "Scenario: memory stored = 'Involved with a partner but not exclusive' (context/relationship).\n" +
           "Policy: CONTEXT-GATED — only auto-inject when relationship topics come up, not in coding sessions.",
    suggested: { is_memory: true, category: "sensitivity", subcategory: "injection-scope",
      expiry: null,
      reasoning: "High-intimacy context is noise in a coding session and potentially embarrassing — scope to relationship topics" } },

  // #2  Sexual identity — always baseline or context-gated?
  { text: "Scenario: memory = 'Identifies as bisexual' (fact/identity).\n" +
           "Policy: ALWAYS inject as baseline — identity affects tone and framing globally, not just in identity discussions.",
    suggested: { is_memory: true, category: "sensitivity", subcategory: "injection-scope",
      expiry: null,
      reasoning: "Identity is foundational, not sensitive-in-context — unlike an affair it doesn't risk embarrassment in unrelated sessions" } },

  // #3  Ongoing health condition — always baseline?
  { text: "Scenario: memory = 'On antidepressants for two years' (fact/health).\n" +
           "Policy: ALWAYS inject — ongoing health conditions shape communication style, pacing, and emotional context globally.",
    suggested: { is_memory: true, category: "sensitivity", subcategory: "injection-scope",
      expiry: null,
      reasoning: "Health conditions that affect capacity should always be in context — not just in health discussions" } },

  // #4  Specific financial figure — always or finance-scoped?
  { text: "Scenario: memory = 'Approximately $30k in credit card debt' (fact/financial).\n" +
           "Policy: CONTEXT-GATED — specific figures only inject when financial topics arise. The ambient 'money is tight' context covers general tone.",
    suggested: { is_memory: true, category: "sensitivity", subcategory: "injection-scope",
      expiry: null,
      reasoning: "Exact debt amounts in a coding session are unnecessary exposure — context-gate to financial topics" } },

  // #5  Grief — time-decay injection scope
  { text: "Scenario: memory = 'Dog died yesterday' (fact/loss, permanent).\n" +
           "Policy: inject for the first ~7 days (high relevance), then only when emotionally-relevant topics arise. Not every coding session forever.",
    suggested: { is_memory: true, category: "sensitivity", subcategory: "injection-scope",
      expiry: null,
      reasoning: "Acute grief is always-relevant briefly, then becomes background — injecting it weekly into code sessions gets intrusive" } },

  // ── DIMENSION 2: EXPIRY-TO-EPISODIC TRACE ────────────────────────────────────
  // When a time-limited memory expires, should a compressed historical note remain?

  // #6  Medical concern — trace or full delete?
  { text: "Scenario: 'Had concerning bloodwork in May 2026, waiting for follow-up' (30d, now expired).\n" +
           "Policy: convert to permanent episodic trace: 'Medical concern (bloodwork), May 2026'.",
    suggested: { is_memory: true, category: "event", subcategory: "expiry-trace",
      expiry: null,
      reasoning: "Medical events are biographically significant — in a year it's useful to know there was a health concern in that period" } },

  // #7  Relationship tension — trace or delete?
  { text: "Scenario: 'Close relationship tension lately' (30d, now expired, no escalation detected).\n" +
           "Policy: FULL DELETE — transient relationship friction that resolved shouldn't persist as history.",
    suggested: { is_memory: true, category: "context", subcategory: "expiry-trace",
      expiry: null,
      reasoning: "Storing resolved friction risks anchoring a past conflict that's moved on — the relationship entity stays, this specific state doesn't" } },

  // #8  Presentation anxiety — trace or delete?
  { text: "Scenario: 'Feeling really anxious about presentation tomorrow' (2d, now expired).\n" +
           "Policy: FULL DELETE — too granular to be historically useful.",
    suggested: { is_memory: true, category: "context", subcategory: "expiry-trace",
      expiry: null,
      reasoning: "A single anxious moment before a presentation has no long-term biographical value" } },

  // #9  Job search context — trace or delete?
  { text: "Scenario: 'Applying for jobs this week, had two phone screens' (30d, now expired).\n" +
           "Policy: convert to episodic trace: 'Was job searching around [month/year]'.",
    suggested: { is_memory: true, category: "event", subcategory: "expiry-trace",
      expiry: null,
      reasoning: "Career transitions are biographically significant — knowing someone was actively job searching in a period provides future context" } },

  // ── DIMENSION 3: CONTRADICTION RESOLUTION ────────────────────────────────────

  // #10  Clear tool switch — newer supersedes, old archived
  { text: "Scenario: Memory A (2yr): 'Uses npm'. Memory B (new): 'Switched to Bun, never going back'.\n" +
           "Policy: B supersedes A. A gets superseded_by pointer and drops from active injection. Both stored in version history.",
    suggested: { is_memory: true, category: "preference", subcategory: "contradiction",
      expiry: null,
      reasoning: "Explicit 'never going back' = clear preference switch. Old archived, not surfaced, not deleted" } },

  // #11  Lifestyle reversal — newer wins AND old becomes episodic context
  { text: "Scenario: Memory A (1yr): 'Drinks alcohol occasionally'. Memory B (new): 'Sober 3 years'.\n" +
           "Policy: B supersedes A. ALSO keep A as episodic trace: 'Previously drank socially' — recovery is enriched by knowing the history.",
    suggested: { is_memory: true, category: "fact", subcategory: "contradiction",
      expiry: null,
      reasoning: "'Was a drinker, now sober' tells a richer story than 'sober' alone — the history has context value" } },

  // #12  Task-scoped exception — must NOT affect permanent preference
  { text: "Scenario: Memory A (permanent): 'TDD non-negotiable'. New: 'For this PR only, skipping tests, no time'.\n" +
           "Policy: A is NOT superseded. 'For this PR only' is an exception, not a preference revision.",
    suggested: { is_memory: true, category: "preference", subcategory: "contradiction",
      expiry: null,
      reasoning: "Explicit scope qualifier makes this an override, not a contradiction — permanent preference stays" } },

  // #13  Career transition — clarify before superseding
  { text: "Scenario: Memory A (6mo): 'Works at a law firm in Sydney'. New signal: 'Just accepted a job offer at Canva'.\n" +
           "Policy: trigger clarification ('Did you leave the law firm?') before superseding — 'accepted offer' ≠ 'started role'.",
    suggested: { is_memory: true, category: "fact", subcategory: "contradiction",
      expiry: null,
      reasoning: "Premature supersession risks being wrong — accepted ≠ started. Ask first" } },

  // ── DIMENSION 4: CROSS-MEMORY INFERENCE ──────────────────────────────────────

  // #14  Topic cluster — surface all when any member mentioned
  { text: "Scenario: user says 'training is going well'. Store has: marathon date, km/week, goal time, shoes, club.\n" +
           "Policy: surface ALL running memories (up to 5) when any running topic arises.",
    suggested: { is_memory: true, category: "context", subcategory: "cross-inference",
      expiry: null,
      reasoning: "Running memories form a coherent profile — surfacing the cluster gives richer coaching context than any single memory" } },

  // #15  Pregnancy + partner — proactively cross-surface
  { text: "Scenario: user mentions pregnancy. Store has: 'trying to get pregnant' + 'partner is a teacher'.\n" +
           "Policy: surface partner-linked memories proactively when pregnancy discussed — they're inherently linked.",
    suggested: { is_memory: true, category: "fact", subcategory: "cross-inference",
      expiry: null,
      reasoning: "Pregnancy is relational by nature — partner context is always relevant to it" } },

  // #16  Financial + relationship — do NOT cross-surface
  { text: "Scenario: user mentions money stress. Store has: '$30k debt' + 'recent relationship tension'.\n" +
           "Policy: financial and relationship memories should NOT cross-inject without explicit user signal linking them.",
    suggested: { is_memory: true, category: "context", subcategory: "cross-inference",
      expiry: null,
      reasoning: "Correlation isn't causation — conflating money stress and relationship stress without signal risks incorrect framing" } },

  // ── DIMENSION 5: MEMORY CLUSTER SUMMARISATION ────────────────────────────────

  // #17  Running cluster — summarise after 5+
  { text: "Scenario: 7 running memories over 3 months (date, goal, km, club, injury, shoes, nutrition).\n" +
           "Policy: auto-consolidate into 'Running profile' summary after 5+ linked memories. Originals kept as sources.",
    suggested: { is_memory: true, category: "context", subcategory: "summarisation",
      expiry: null,
      reasoning: "7 separate injections is token-wasteful — a running profile covers the same ground more efficiently" } },

  // #18  Work frustration pattern — do NOT consolidate
  { text: "Scenario: 4 distinct work-friction memories: reviewer friction, manager goalposts, uncredited work, meeting hatred.\n" +
           "Policy: do NOT consolidate — different entities, different implications, different actionability.",
    suggested: { is_memory: true, category: "fact", subcategory: "summarisation",
      expiry: null,
      reasoning: "A 'work frustration summary' loses entity-specific detail (reviewer, manager, meetings) that makes each memory actionable" } },

  // ── DIMENSION 6: RETRIEVAL CONFIDENCE DISPLAY ────────────────────────────────

  // #19  Old preference, decayed confidence — flag it
  { text: "Scenario: memory = 'Preferred dark mode' (20 months old, preference, confidence ~35%).\n" +
           "Policy: flag when retrieving: 'I recall you preferred dark mode — still true? It's been a while.'",
    suggested: { is_memory: true, category: "preference", subcategory: "confidence-display",
      expiry: null,
      reasoning: "35% confidence is low enough that acting on it without flagging risks stale advice — a quick check costs nothing" } },

  // #20  Biographical fact — never flag confidence
  { text: "Scenario: memory = 'Partner identity is known' (8 months old, fact, no decay applied).\n" +
           "Policy: use silently — facts never need confidence flags.",
    suggested: { is_memory: true, category: "fact", subcategory: "confidence-display",
      expiry: null,
      reasoning: "Facts don't decay — flagging uncertain partner information without evidence is misleading" } },

];

// ── UI helpers ─────────────────────────────────────────────────────────────────
function progressBar(current, total, width = 32) {
  const pct  = current / total;
  const done = Math.round(pct * width);
  return `[${"█".repeat(done)}${"░".repeat(width - done)}] ${current}/${total} (${Math.round(pct*100)}%)`;
}

function categoryColour(cat) {
  const m = { preference: cyan, fact: green, event: yellow, goal: mag,
    skill: s=>`${c.blue}${s}${c.reset}`, context: s=>`${c.white}${s}${c.reset}` };
  return cat ? (m[cat]||(s=>s))(cat) : dim("none");
}

const EXPIRY_LABEL = { "2d": cyan("⏱ 2d (today)"), "7d": cyan("⏱ 7d (this week)"), "30d": cyan("⏱ 30d (this month)") };

function renderSuggestion(s) {
  const verdict = s.is_memory
    ? `${c.bgGreen}${c.bold} CORRECT ${c.reset}` : `${c.bgRed}${c.bold}  WRONG  ${c.reset}`;
  const flags = [];
  if (s.isPattern)  flags.push(yellow("⟳ recurrence → permanent"));
  if (s.expiry)     flags.push(EXPIRY_LABEL[s.expiry] ?? cyan(`⏱ ${s.expiry}`));
  if (!s.expiry && s.is_memory && !s.isPattern) flags.push(dim("permanent"));
  const cat  = s.is_memory ? `  dimension: ${categoryColour(s.category)}${s.subcategory ? dim(" / "+s.subcategory) : ""}` : "";
  const tag  = s.is_memory && s.tags?.length ? `  tags:      ${dim(s.tags.join(", "))}` : "";
  const fl   = flags.length ? `  flags:     ${flags.join("  ")}` : "";
  const why  = `  reasoning: ${dim(s.reasoning)}`;
  return [verdict, cat, tag, fl, why].filter(Boolean).join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input, output });
const CATEGORIES = ["preference","fact","event","goal","skill","context"];

console.clear();
console.log(bold("╔════════════════════════════════════════════════════════════════╗"));
console.log(bold(`║   Memory Policy Validator — ${EXAMPLES.length} scenarios (Round 5)        ║`));
console.log(bold("╚════════════════════════════════════════════════════════════════╝"));
console.log();
console.log(`  ${bold("y")} agree   ${bold("n")} flip verdict   ${bold("c")} fix category   ${bold("d")} fix duration   ${bold("s")} skip   ${bold("q")} quit`);
console.log();
console.log(dim("Round 5: each scenario shows a policy decision. y=agree, n=wrong policy (add note), s=unsure."));
console.log(dim("If you skip, please add a note after — helps improve the corpus."));
console.log();
await rl.question(dim("Press Enter to start..."));

const results = [];

for (let i = 0; i < EXAMPLES.length; i++) {
  const ex = EXAMPLES[i];
  let done = false, result = null;

  while (!done) {
    console.clear();
    console.log(dim(progressBar(i, EXAMPLES.length)));
    console.log();
    console.log(bold(`Example ${i+1} of ${EXAMPLES.length}`));
    console.log();
    console.log(`  ${bold('"'+ex.text+'"')}`);
    console.log();
    console.log(bold("My suggestion:"));
    console.log(renderSuggestion(ex.suggested));
    console.log();

    const raw = (await rl.question(`${bold("→")} [y/n/c/s/q/?] `)).trim().toLowerCase();

    if (raw === "?") {
      console.log("\n  y agree  n flip verdict  c fix category  d fix duration  s skip  q quit\n");
      continue;
    }
    if (raw === "q") {
      for (let j = i; j < EXAMPLES.length; j++)
        results.push({ id:j+1, text:EXAMPLES[j].text, suggested:EXAMPLES[j].suggested, human:{action:"skipped"} });
      i = EXAMPLES.length; done = true; result = {quit:true}; break;
    }
    if (raw === "s") {
      const noteRaw = (await rl.question("  Note on why you skipped (helps corpus — Enter to skip): ")).trim();
      result = { action:"skipped", note: noteRaw || null }; done = true;
    } else if (raw === "y") {
      result = { action:"agree", is_memory:ex.suggested.is_memory, category:ex.suggested.category,
        subcategory:ex.suggested.subcategory, tags:ex.suggested.tags,
        shortLived:ex.suggested.shortLived??false, isPattern:ex.suggested.isPattern??false }; done = true;
    } else if (raw === "n") {
      const flipped = !ex.suggested.is_memory;
      let category=null, subcategory=null, tags=[], shortLived=false, isPattern=false;
      if (flipped) {
        console.log(); CATEGORIES.forEach((cat,idx)=>console.log(`  ${idx+1}. ${categoryColour(cat)}`));
        const cr = (await rl.question("Category number (or name): ")).trim();
        const ci = parseInt(cr)-1;
        category = (ci>=0&&ci<CATEGORIES.length)?CATEGORIES[ci]:cr||"fact";
        subcategory = (await rl.question("Subcategory (optional): ")).trim()||null;
        const tr = (await rl.question("Tags (comma-separated): ")).trim();
        tags = tr ? tr.split(",").map(t=>t.trim()).filter(Boolean) : [];
        const slr = (await rl.question("Short-lived context? (y/n): ")).trim().toLowerCase();
        shortLived = slr === "y";
        const pr = (await rl.question("Recurrence pattern? (y/n): ")).trim().toLowerCase();
        isPattern = pr === "y";
      }
      const note = (await rl.question("Note (optional): ")).trim();
      result = { action:"disagree", is_memory:flipped, category, subcategory, tags,
        shortLived, isPattern, note:note||null }; done = true;
    } else if (raw === "c") {
      console.log(); CATEGORIES.forEach((cat,idx)=>console.log(`  ${idx+1}. ${categoryColour(cat)}`));
      const cr = (await rl.question("Correct category: ")).trim();
      const ci = parseInt(cr)-1;
      const category = (ci>=0&&ci<CATEGORIES.length)?CATEGORIES[ci]:cr||ex.suggested.category;
      const subcategory = (await rl.question("Subcategory (Enter for same): ")).trim()||ex.suggested.subcategory;
      const tr = (await rl.question("Tags (Enter for same): ")).trim();
      const tags = tr ? tr.split(",").map(t=>t.trim()).filter(Boolean) : ex.suggested.tags;
      const slr = (await rl.question(`Short-lived? current:${ex.suggested.shortLived??false} (y/n/Enter=keep): `)).trim().toLowerCase();
      const shortLived = slr==="y" ? true : slr==="n" ? false : ex.suggested.shortLived??false;
      result = { action:"correct_category", is_memory:ex.suggested.is_memory, category,
        subcategory, tags, shortLived, isPattern:ex.suggested.isPattern??false }; done = true;
    } else if (raw === "d") {
      // Fix duration only — verdict and category are correct, just expiry tier is wrong
      console.log();
      console.log(`  Current expiry: ${dim(ex.suggested.expiry ?? "permanent")}`);
      console.log(`  1. 2d  — today-scoped (gone by tomorrow)`);
      console.log(`  2. 7d  — this week`);
      console.log(`  3. 30d — this month`);
      console.log(`  4. permanent — no expiry`);
      const er = (await rl.question("  Pick tier (1-4 or type 2d/7d/30d/permanent): ")).trim().toLowerCase();
      const tierMap = { "1":"2d", "2":"7d", "3":"30d", "4":null, "2d":"2d", "7d":"7d", "30d":"30d", "permanent":null };
      const expiry = er in tierMap ? tierMap[er] : ex.suggested.expiry;
      const note = (await rl.question("  Note (optional): ")).trim();
      result = { action:"correct_duration", is_memory:ex.suggested.is_memory,
        category:ex.suggested.category, subcategory:ex.suggested.subcategory,
        tags:ex.suggested.tags, expiry, isPattern:ex.suggested.isPattern??false,
        note:note||null }; done = true;
    } else {
      console.log(yellow("  Unknown — use y / n / c / s / q / ?"));
    }
  }

  if (result && !result.quit) results.push({ id:i+1, text:ex.text, suggested:ex.suggested, human:result });
  if (i >= EXAMPLES.length) break;
}

// ── Save ───────────────────────────────────────────────────────────────────────
const answered  = results.filter(r=>r.human.action!=="skipped").length;
const agreed    = results.filter(r=>r.human.action==="agree").length;
const disagreed = results.filter(r=>r.human.action==="disagree").length;
const corrected = results.filter(r=>r.human.action==="correct_category").length;
const skipped   = results.filter(r=>r.human.action==="skipped").length;
const pct = answered>0 ? Math.round((agreed+corrected)/answered*100) : 0;

await writeFile(OUT_FILE, JSON.stringify({
  meta: { timestamp:new Date().toISOString(), round:5, total_examples:EXAMPLES.length,
    answered, agreed, disagreed, corrected, skipped, agreement_rate:`${pct}%` },
  results,
}, null, 2));

console.clear();
console.log(bold("╔══════════════════════════════════════════════════════════╗"));
console.log(bold("║                 Round 5 complete!                       ║"));
console.log(bold("╚══════════════════════════════════════════════════════════╝"));
console.log();
console.log(`  Answered:       ${bold(answered)}`);
console.log(`  Agreed:         ${green(agreed)}`);
console.log(`  Corrected cat:  ${yellow(corrected)}`);
console.log(`  Disagreed:      ${red(disagreed)}`);
console.log(`  Skipped:        ${dim(skipped)}`);
console.log(`  Agreement rate: ${bold(pct+"%")}`);
console.log();
console.log(`  Results → ${bold(OUT_FILE)}`);
console.log();
console.log(dim("Tell me when done — I'll read the file and update the corpus."));
rl.close();
process.exit(0);
