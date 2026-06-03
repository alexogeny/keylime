---
description: Human-in-the-loop validator for the memory detection pipeline. Use when running labelled validation sessions to evaluate or improve signal detection, expiry tiers, sensitivity policies, or entity extraction in the user-memory extension.
---

# Memory Validation Skill

Interactive human-in-the-loop validator for the memory detection pipeline.
Use when you want to run a labelled validation session to evaluate or improve
the signal detection logic in the user-memory extension.

## When to use

- After changing feature groups, thresholds, or category prototypes
- When generating new ambiguous examples for corpus expansion
- When the user wants to audit what the system thinks is/isn't memorable
- Periodically (every ~200 real memories stored) to check classifier drift

## How to run

```bash
node ./validate.mjs
```

Or with a custom example file:

```bash
node ./validate.mjs --examples /tmp/my-examples.json
```

Results are written to `/tmp/memory-validation-results.json` by default.

## Workflow

1. Generate examples covering the target ambiguity space (all categories,
   edge cases, transient vs persistent, recurrence patterns, etc.)
2. Replace the `EXAMPLES` array in `validate.mjs` with your new set
3. Run the script and work through the examples with the user
4. When done, read `/tmp/memory-validation-results.json`
5. Use disagreements and skips to:
   - Expand/adjust feature group token vocabularies
   - Tune LOW_SIGNAL_THRESHOLD and HIGH_SIGNAL_THRESHOLD
   - Add new feature groups for unhandled signal types
   - Update category prototype documents
   - Add new test cases to the detection test suite

## Output format

```json
{
  "meta": {
    "timestamp": "...",
    "total_examples": 50,
    "answered": 48,
    "agreed": 45,
    "disagreed": 2,
    "corrected": 1,
    "skipped": 2,
    "agreement_rate": "95%"
  },
  "results": [
    {
      "id": 1,
      "text": "...",
      "suggested": { "is_memory": true, "category": "preference", ... },
      "human":    { "action": "agree" | "disagree" | "correct_category" | "skipped", ... }
    }
  ]
}
```

## Key learnings from Round 1 (May 2026, 51 examples, 100% agreement)

- "again" is a recurrence marker — elevates single event to pattern fact
- "today" + state = short-lived context memory (2-day expiry), not a skip
- All 6 categories validated as intuitive
- `subcategory` field is important — "meta-instruction" subcategory on preference
  captures "when you do X, do Y" patterns that are distinct from tool prefs
- Physical/biographical facts (body, health) belong in `fact` — no discomfort
- Transient venting without recurrence markers → skip (confirmed)
- Task suppressors work well; filler/acknowledgment correctly rejected

## Key learnings from Round 3 (May 2026, 20 examples, 90% agreement)

- **Default to store** — when genuinely ambiguous, store as `shortLived` rather than skip.
  False positives expire harmlessly in 2 days; false negatives are unrecoverable.
  Implemented as: moderate-signal detections without a strong preference/pattern marker
  now default to `shortLived: true` in the detection pipeline.
- **Duration is a separate axis from verdict** — #5 (attracted to manager) disagreement
  was not about whether to store but that `shortLived: 2d` was wrong. The correct
  duration was weeks, not days. Added `d` (fix duration) as a 4th option in the validator
  UI alongside `y/n/c`.
- **`shortLived` ≠ "store for 2 days"** — needs richer duration tiers:
  `2d` (today-scoped), `7d` (this week), `30d` (this month), `permanent`.
  Currently all shortLived uses a fixed 2-day expiry; this should be parameterised.
- Everything in the sexual/intimate/identity space confirmed as worth storing —
  no examples were flagged as "shouldn't be stored on principle".
- #20 (meta-instruction: "don't give advice about relationship stuff unless asked")
  confirmed as highest-priority memory type — explicit behavioural instructions
  should be stored immediately and injected on every relevant turn.

## Key learnings from Round 4 (May 2026, 20 examples, 70% agreement — richest round)

All disagreements were about **duration tier**, not about whether to store:

- **Significant life events are biographical facts, always permanent.**
  Death, diagnosis, pregnancy, wedding, redundancy — store permanently regardless
  of temporal anchor. "My dog died yesterday" → permanent. Implemented as
  `SIGNIFICANT_EVENT_TOKENS` vocabulary that short-circuits tier inference.

- **Activity-class overrides short anchors.**
  Inherently multi-week activities (job search, medical treatment, house hunting)
  should be 30d even when the anchor phrase is "this week".
  "Applying for jobs this week" → 30d. Implemented as `ACTIVITY_CLASS_TOKENS`.
  Medical result/appointment tokens (`bloodwork`, `appointment`, `waiting`) added here.

- **`lately` belongs in 30d, not 7d.**
  "Lately" means "for a while recently" — weeks not days. Moved from TIER_7D to TIER_30D.

- **Multiple recurrence signals → 30d.**
  One recurrence word bumps tier by one level. Two or more ("again today, third time")
  jumps straight to 30d. Implemented via recurrence word count threshold.

- **Hyperbolic frustration about recurring situations IS a preference signal.**
  "Literally going to die in planning meetings" → store as context/preference.
  "I'm literally going to die" means "I really hate this." Added `hyperbolic_frustration`
  feature group (weight 2.5): literally, dying, killing, torture, unbearable, impossible.
  Validated across rounds 2 + 4.

- **Third-party social sharing without entity anchor → unresolved design question.**
  "My colleague told me she's pregnant" — user wants to share but there's no
  extractable entity ref. Logged as open question: clarification module needed.
  See open questions in project.json.

## Clarification module (built May 2026)

Three triggers, all deterministic, at most ONE question surfaced per turn.
Grounded in ICLR 2025 Active Task Disambiguation (Bayesian question selection).

**Trigger 1 — Third-party social share** (`clarify.ts: detectThirdPartyShare`)
  Pattern: POSSESSIVE + ROLE_WORD + REPORTING_VERB, user is not the subject.
  "my colleague told me she's pregnant" → ask "Want me to remember anything about
  your colleague? What's their name?"
  Only fires when: no personal-signal tokens in the sentence, user is not the teller.

**Trigger 2 — Borderline scope** (`clarify.ts: detectBorderlineScope`)
  Signal score in LOW–LOW*1.8 range, no temporal anchor, no strong permanence marker.
  "I've been feeling off" → ask "Is this ongoing for you, or more of a one-off?"
  Prevents incorrectly storing a passing remark as a permanent context entry.

**Trigger 3 — Contradiction** (`clarify.ts: detectContradiction`) — HIGH PRIORITY
  New signal has high BM25 similarity to existing memory BUT contains negation/reversal
  tokens not present in the existing memory.
  "Actually I quit coffee" (existing: "drinks coffee daily") → ask "You previously
  mentioned X — is that still true, or should I update it?"
  Implements AGM 'Success' postulate: new belief accepted, but conflict surfaced.
  Does NOT silently overwrite; does NOT silently ignore.

**Injection format** (in system prompt, next turn):
  - High priority: 🚨 "Contradiction detected — ask this before proceeding:"
  - Low priority:  💬 "If it feels natural to ask, consider:"
  LLM decides whether and how to weave the question into the response.

**What the clarification module does NOT do:**
  - Ask multiple questions
  - Ask when interpretation is already clear
  - Interrupt the current response (always deferred to next turn)
  - Store anything autonomously — that's still the LLM's call via remember()

## Adversarial protection (built May 2026)

`remember()` tool now rejects prompt-injection attempts before storing.
Patterns rejected: "you always/should/must", "remember that you", "ignore previous",
"your instructions", "as an AI you", "forget everything".
Throws an error with explanation rather than silently discarding.

## Unexplored dimensions (candidates for future training rounds)

These dimensions exist in the research (especially Kumiho arXiv 2603.17244) but
have not yet been validated against your preferences:

1. **Sensitivity tiers** — should some memories (sexual, health, financial) have
   higher retrieval thresholds? Should they be omitted from auto-injection in
   certain contexts (e.g., when discussing work)? Or does full context always win?

2. **Cross-memory inference** — "I'm pregnant" + "user's partner is a teacher" → should that
   partner entity be proactively enriched? Should partner memories surface more when
   pregnancy comes up? Kumiho calls this "prospective indexing" (at write time,
   generate future-scenario implications).

3. **Memory cluster summarisation** — when 8+ memories share a topic/entity, should
   they be consolidated into a summary memory? What's the right trigger?
   (Kumiho: semantic consolidation; Tsinghua survey: compression)

4. **Contradiction resolution policy** — when two memories directly conflict
   ("sober for 3 years" + "had a drink last week"), which wins? Both stored? Newer
   promotes? Flag for review? AGM says: newer belief accepted, old versioned.

5. **Memory that expires but was significant** — after a 30d memory expires, should
   an episodic trace remain? "I had concerning bloodwork in May 2026" might be
   worth keeping as a historical fact even after the 30d context window closes.

6. **Retrieval confidence display** — should I tell you when I'm recalling a memory
   with low confidence (e.g., decayed preference) vs high confidence?

Suggest focusing round 6 on: prospective indexing + memory cluster summarisation trigger tuning.

## Key learnings from Round 5 (May 2026, 20 policy scenarios, 75% agreement)

**Sensitivity tiers (confirmed with nuance):**
- Identity (bisexual, trans, etc.) and ongoing health conditions (antidepressants, ADHD)
  → `baseline`: always inject regardless of topic
- Specific financial figures and relationship secrets
  → `context_gated`: only when topic/entity matches  
- Grief and acute loss
  → `temporal_gated`: inject for 7 days, then context-gated only
- #1 (infidelity) confirmed as context_gated, but with nuance: even context-gated
  memories should fire if the coding task is in that domain (fuzzy context-gating)
- #5 (grief) refined: not just "time-decay then background" but "time-decay THEN
  context-gated" — actively excluded from unrelated sessions after acute period

**Expiry-to-trace (refined):**
- #7 (relationship tension): slight disagree with full-delete. Keep minimal timestamp
  note: "Had some relationship tension around May 2026" — not rich content, just temporal
  anchoring. Implemented as TRACE_RELATION_SUBCATS producing compressed traces.
- #8 (presentation anxiety 2d): confirmed full delete — too granular
- #6, #9: confirmed episodic traces for medical events + career transitions

**Contradiction resolution (confirmed + sharpened):**
- #13 clarification framing: WRONG to ask backward-looking "did you leave?"
  → Ask FORWARD-LOOKING practical questions: "When do you start? Do you want me
  to update your work context?" Don't therapise. Be the assistant.
  Implemented in `buildContradictionQuestion()` with domain-specific templates.

**Work frustration / cluster summarisation (both/and, not either/or):**
- #18: soft disagree with "don't consolidate". Keep individual memories AND create
  a narrative "job chapter" meta-memory when 3+ work-friction memories accumulate
  for the same employer. Future retrospective: "remember that time at Canva..."
  Implemented as `shouldCreateJobChapter()` + `buildJobChapter()`.

**Cross-memory inference (confirmed):**
- Running cluster → surface all when any member mentioned: confirmed
- Pregnancy + partner → cross-surface: confirmed  
- Financial + relationship → don't conflate without signal: confirmed

**Confidence display (confirmed clean):**
- Old preferences (>20 months, <35% confidence) → flag when retrieving: confirmed
- Biographical facts → use silently, never flag: confirmed

## Ambiguous territory to probe in future rounds

- One-off mentions of a person vs recurring relationship dynamics  
- Single health symptom vs established health pattern
- Current mood that might reveal an underlying trait
- "I don't like X" said in passing vs "I never use X"
- Political/religious views mentioned incidentally
- Financial details (salary, debt, spending habits)
- Relationship issues (friction, attraction, jealousy)
- Things the user clearly wants forgotten vs things worth keeping
- Instructions that apply to one task vs general instructions
