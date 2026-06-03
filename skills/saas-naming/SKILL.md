---
name: saas-naming
description: Generates contemporary SaaS product name candidates. Use when naming or renaming a product, exploring brand directions, or when the current name isn't working. Reads the project plan for context, applies multiple naming frameworks, scores candidates against practical criteria (memorability, pronounceability, .com availability, trademark risk), and presents a shortlist with rationale.
---

# SaaS Naming Skill

Generates a shortlist of contemporary, market-ready product name candidates using structured creative frameworks. Grounded in linguistics research and current naming patterns across B2B SaaS and legal/professional services tech.

## Workflow

Work through all five phases in order. Do not skip phases.

---

### Phase 1 — Extract Context

Read the project plan (`.pi/project.json`) to extract:

- **What the product does** — the core job it performs for users
- **Who it's for** — industry, buyer persona, company size
- **The differentiator** — what makes it meaningfully different
- **Emotional register** — should the name feel precise/technical, warm/human, bold/confident, calm/trustworthy?
- **Competitors** — note their naming style so candidates can deliberately contrast or align

If no project plan exists, ask the user for a 2-sentence product description before proceeding.

---

### Phase 2 — Apply Naming Frameworks

Generate **at least 3 candidates per framework** below. Aim for 25–35 raw candidates total before filtering. Think laterally — include surprising options.

#### Framework A: Coined / Invented Words
Pure invented words with no prior meaning. Clean trademark slate, infinitely ownable.
- Portmanteau: blend two relevant words (e.g. *Figma* ← figure + enigma; *LexisNexis* ← legal lexicon + news nexus)
- Truncation: chop a meaningful word to a fragment that still sounds complete (e.g. *Vercel* ← versatile)
- Phonetic respelling: real word spelled differently (e.g. *Fiverr*, *Tumblr*) — **note: this pattern now feels dated (2010–2015 era)**
- Suffix play: Latin endings (-ix, -or, -us, -ar) add premium institutional weight (e.g. *Kalix*, *Nexar*)
- CV-CV alternation: consonant-vowel-consonant-vowel patterns are the most universally pronounceable (e.g. *Figma*, *Versa*)

#### Framework B: Metaphor / Borrowed Meaning
Real words repurposed — their prior associations do the emotional work.
- Structural/engineering terms that imply the product's load-bearing function (e.g. *Truss*, *Keystone*, *Span*)
- Actions that name the outcome, not the mechanism (e.g. *Zoom*, *Slack*, *Linear*)
- Mythology and classical references — project permanence and institutional weight (e.g. *Clio* ← Muse of history, for a legal records platform; *Palantir* ← seeing-stone)
- Natural world: materials, phenomena with fitting qualities
- Legal/professional domain concepts repurposed (e.g. *Ironclad*, *Quorum*, *Axiom*)

#### Framework C: Human Names
**The Harvey pattern** — naming a product after a person (real, fictional, or invented) to signal "trusted colleague, not software tool." This is the dominant emerging pattern for professional services AI and B2B software as of 2024–2025.

- Real names with strong cultural resonance in the target industry: *Harvey* works because every lawyer knows Harvey Specter (Suits); the name evokes the archetype of the best lawyer in the room
- Founder names with cultural fit (Harvey AI = Winston Weinberg's own name, plus the Suits resonance — dual signal)
- Invented first names that feel like a real person: warm, approachable, memorable
- Names from the target culture: for Australian law firms, names that feel Anglo-professional without being stuffy

**Why this works:** Buyers in professional services are being asked to trust software with sensitive work. A human name reduces the psychological distance between "tool" and "trusted colleague." Harvey AI used this to go from seed to $3B valuation without ever needing to rebrand.

**Risks:** Human names lose distinctiveness faster; common names may have .com taken. Use `.ai`, `.app`, or `getharvey.com`-style variants.

#### Framework D: Abstract Proper Nouns
Names that mean nothing literally but feel premium and ownable (e.g. *Palantir*, *Okta*, *Airtable*).
- Single evocative syllables with hard consonants: K, T, P, X project precision and authority (Bouba/Kiki effect — cross-linguistically, hard consonants signal sharpness and competence)
- Two-syllable constructions with Latin-root endings (-ix, -or, -ar, -us): feel institutional and premium
- Names that look good in a wordmark: favour visual symmetry, avoid double-letter junctions
- Back vowels (oo, oh, aw) feel weightier/more authoritative; front vowels (ee, ay) feel sharper/lighter — match to emotional register

#### Framework E: Compound Clarity
Two real words fused or paired — transparency with personality (e.g. *Basecamp*, *Workday*, *Ironclad*).
- Verb + noun: implies action and outcome
- Adjective + noun: implies quality of the thing
- Noun + noun: implies intersection of two domains
- **Note:** avoid "Hub" compounds (HubSpot-era legacy feel) and colour/material compounds (Copper, Bronze — oversaturated)

#### Framework F: Classical / Mythological Reference
Draws on Greek, Latin, or other classical sources for a name with depth that rewards the curious without requiring explanation.
- Greek Muses, concepts, or figures with a clear thematic link (e.g. *Clio* ← Muse of History = perfect for records/institutional memory)
- Latin terms used in law that non-lawyers find intriguing (e.g. *Stare*, *Ratio*, *Gravitas*)
- Single classical words that are short, pronounceable, and unused in software

---

### Phase 3 — Score and Filter

Score every raw candidate against these six criteria. Eliminate ruthlessly — only carry forward candidates that pass all six.

| Criterion | Pass condition |
|-----------|---------------|
| **Pronounceable** | A stranger reads it aloud correctly on first attempt (fluency effect: this directly increases perceived trust) |
| **Memorable** | Sticks after hearing it once — short, distinctive sound |
| **Spellable** | Heard aloud → typed correctly without asking "how do you spell that?" |
| **Distinctive** | Doesn't sound like an existing product in the same or adjacent category — name confusion is a documented epidemic in legal tech |
| **Domain-plausible** | `.com` is plausibly acquirable — not an obvious Fortune 500 generic term; 144 of the top legal tech companies have exact-match .com domains |
| **Trademark-safe** | Not an obvious collision with a registered mark in software/HR/legal/SaaS classes (USPTO classes 35, 42) |

Flag any candidate with known collision risk rather than silently dropping it — the user may still want to see it.

---

### Phase 4 — Present Shortlist

Present **5–8 finalists** in this exact format for each:

```
## [Name]

**Framework:** [which framework generated it]
**Say it:** [phonetic guide if non-obvious, e.g. "VEHR-sel"]
**Why it works:** 2–3 sentences on the emotional register, what associations it carries, why it fits this product specifically.
**Watch out for:** Any risks, caveats, or things to verify (trademark class, existing company with similar name in different industry, etc.)
**Domain:** [name].com — [Available / Likely available / Check needed / Likely taken]
**Variants to explore:** [name].io · [name]hq.com · get[name].com · [name]app.com
```

After the shortlist, add a short **Direction Summary** — two or three sentences characterising what direction the shortlist leans and what's *not* represented, in case the user wants to pull the exploration in a different direction.

---

### Phase 5 — Iterate

After presenting the shortlist, offer three explicit next steps:

1. **Go deeper on a direction** — pick a framework or emotional register and generate 10 more in that vein
2. **Eliminate and replace** — strike names from the shortlist and generate fresh ones to fill the gaps
3. **Domain + trademark check** — use `web_search` to do a live surface-level collision check on the top 2–3 favourites

Always wait for the user's direction before proceeding. Do not auto-select a winner.

---

## Naming Principles to Apply Throughout

- **Short is strong.** 1–2 syllables is ideal; 3 is acceptable; 4+ needs a very compelling reason.
- **The fluency effect is real.** Psychological research shows that easy-to-pronounce names are subconsciously perceived as more trustworthy, more competent, and more valuable. A name a stranger reads correctly on first attempt gets a cognitive trust bonus.
- **Hard consonants project authority.** K, T, P, X (the "kiki" sounds in Bouba/Kiki research) signal sharpness, precision, and competence across languages — right register for law firm buyers.
- **Latin endings feel premium.** -ix, -or, -us, -um, -ar endings carry institutional weight (Vercel, Kalix, Linear all benefit from this).
- **Avoid acronyms.** They're unmemorable and look desperate.
- **Avoid hyphens.** Hyphens in domain names are a red flag.
- **Avoid generic descriptors.** Names like "HRFlow" or "LegalHR" are forgettable and hard to trademark.
- **Numbers in names age poorly.** Avoid unless there's a specific conceptual reason.
- **Test the coffee shop test:** Can you tell a colleague the name over background noise and have them type it correctly?
- **Check plural and possessive forms** — do they sound awkward?
- **Consider verb-ability** — can the name become a verb? ("Just Slack me" is worth billions.)
- **Names need to scale from seed to IPO.** Harvey AI never rebranded through $3B valuation. Pick for scale.

---

## Legal / Professional Services Naming Landscape

**What's working** (study these):

| Name | Type | Why it works |
|------|------|-------------|
| **Harvey** | Human name | Harvey Specter (Suits) resonance — the best lawyer in the room; positions as AI colleague not tool |
| **Clio** | Mythological | Greek Muse of History — perfect for a product that holds a firm's institutional records; $5B valuation 2025 |
| **Ironclad** | Compound metaphor | Contracts that cannot be broken — the strongest possible signal for a contract platform |
| **Relativity** | Abstract concept | Everything is relative to context in legal discovery — smart for eDiscovery |
| **Linear** | Abstract single word | Pure, direct, unambiguous — premium feel, engineering aesthetic |

**What's saturated** (avoid or stand out very deliberately):

- **-io TLD as the primary domain:** Feels 2018. Fine as variant, not as primary
- **-ai suffix:** Extremely crowded, reads as trend not brand
- **All colour/material names:** Copper, Bronze, Slate, Ivory — completely saturated in B2B SaaS
- **Geographic names:** Aspen, Mesa, Alpine — generic feel
- **"Hub" compounds:** HubSpot-era legacy; feels corporate-old
- **Dropped vowels:** Tumblr, Fiverr style — firmly 2010–2015, now signals budget/startup not premium
- **"Legal" or "HR" in the name:** Hard to trademark, hard to stand out, forgettable

**Strong contemporary patterns:**

- Clean two-syllable invented words with hard consonants and Latin endings (crisp, confident, premium)
- Human names with strong cultural resonance in the target industry (Harvey pattern — warm, colleague-like)
- Classical/mythological single words with a clear thematic connection (Clio pattern — depth without explanation)
- Real words from unexpected domains repurposed into professional services tech (creates intrigue, rewards curiosity)
- Names that are a complete word in another language with a fitting meaning (subtle international depth)

---

## Case Study: Harvey

Harvey AI is the benchmark for naming in legal/professional services tech as of 2025. Key lessons:

1. **Dual resonance beats single resonance.** Harvey = founder's name AND Harvey Specter. One name, two hooks.
2. **Name the product as a person when it does a person's job.** Harvey doesn't analyse documents — Harvey *helps lawyers think*. Human name, human framing.
3. **Premium buyers in conservative industries trust people more than tools.** Law firm partners accept "Harvey" into their workflow; they'd resist "LegalAI Pro."
4. **The name held through $3B valuation without change.** Simple, clean, short names scale. Clever names don't.
5. **harvey.ai was fine as a domain.** Exact .com isn't always achievable for human names; the .ai extension became part of the brand story.
