/**
 * Entity Registry — deterministic NER + entity-memory graph
 *
 * Two-stage extraction, zero dependencies, no model:
 *
 *   Stage A — Bigram role scan
 *     Tokenize → find "my"/"the" + known role word → canonical alias resolution
 *     Catches: mum/mom/mother → mum, boss/manager → boss, etc.
 *
 *   Stage B — Capitalization heuristic
 *     Scan raw text words → mid-sentence capitals → proper noun candidates
 *     Cross-reference against TECH_VOCAB → system entities
 *     Unknown capitals → person/unknown (names: personA, personB, personC…)
 *
 * Stored in: ~/.pi/data/user-memory/entities.json
 * Linked to memories via entity.memory_ids ↔ memory.entity_refs (set in index.ts)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Paths ─────────────────────────────────────────────────────────────────────

export const ENTITY_FILE = join(homedir(), ".pi", "data", "user-memory", "entities.json");
const DATA_DIR           = join(homedir(), ".pi", "data", "user-memory");

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityType = "person" | "organization" | "system" | "place" | "role" | "unknown";

export interface Entity {
  id:          string;
  name:        string;        // canonical display name ("mum", "partner", "manager")
  aliases:     string[];      // other names this entity goes by
  type:        EntityType;
  subtype?:    string;        // "family" | "work" | "social" | "pet" | "tech" | etc.
  memory_ids:  string[];      // memories that reference this entity
  mentions:    number;        // total times seen across all memories
  created_at:  number;
  updated_at:  number;
}

export interface EntityStore {
  version:  1;
  entities: Entity[];
}

export interface ExtractedEntity {
  raw:       string;          // as it appeared in the text
  canonical: string;          // resolved canonical name
  type:      EntityType;
  subtype?:  string;
  source:    "role_bigram" | "proper_noun" | "tech_vocab";
}

// ─── Role vocabulary ──────────────────────────────────────────────────────────
//
// Maps every alias a user might say → canonical name + type metadata.
// Extend this freely — adding entries here is the main tuning knob for
// role-based entity detection.

interface RoleEntry {
  canonical: string;
  type:      EntityType;
  subtype:   string;
}

export const ROLE_VOCAB: Record<string, RoleEntry> = {
  // Family
  mum:        { canonical: "mum",       type: "person", subtype: "family" },
  mom:        { canonical: "mum",       type: "person", subtype: "family" },
  mother:     { canonical: "mum",       type: "person", subtype: "family" },
  dad:        { canonical: "dad",       type: "person", subtype: "family" },
  father:     { canonical: "dad",       type: "person", subtype: "family" },
  pa:         { canonical: "dad",       type: "person", subtype: "family" },
  sister:     { canonical: "sister",    type: "person", subtype: "family" },
  brother:    { canonical: "brother",   type: "person", subtype: "family" },
  wife:       { canonical: "wife",      type: "person", subtype: "family" },
  husband:    { canonical: "husband",   type: "person", subtype: "family" },
  partner:    { canonical: "partner",   type: "person", subtype: "family" },
  boyfriend:  { canonical: "partner",   type: "person", subtype: "family" },
  girlfriend: { canonical: "partner",   type: "person", subtype: "family" },
  spouse:     { canonical: "spouse",    type: "person", subtype: "family" },
  son:        { canonical: "son",       type: "person", subtype: "family" },
  daughter:   { canonical: "daughter",  type: "person", subtype: "family" },
  grandma:    { canonical: "grandma",   type: "person", subtype: "family" },
  grandpa:    { canonical: "grandpa",   type: "person", subtype: "family" },
  // Work
  boss:       { canonical: "boss",      type: "person", subtype: "work" },
  manager:    { canonical: "manager",   type: "person", subtype: "work" },
  supervisor: { canonical: "manager",   type: "person", subtype: "work" },
  cto:        { canonical: "CTO",       type: "person", subtype: "work" },
  ceo:        { canonical: "CEO",       type: "person", subtype: "work" },
  coo:        { canonical: "COO",       type: "person", subtype: "work" },
  colleague:  { canonical: "colleague", type: "person", subtype: "work" },
  coworker:   { canonical: "colleague", type: "person", subtype: "work" },
  teammate:   { canonical: "colleague", type: "person", subtype: "work" },
  employer:   { canonical: "employer",  type: "organization", subtype: "work" },
  company:    { canonical: "employer",  type: "organization", subtype: "work" },
  firm:       { canonical: "employer",  type: "organization", subtype: "work" },
  team:       { canonical: "team",      type: "organization", subtype: "work" },
  client:     { canonical: "client",    type: "organization", subtype: "work" },
  // Social
  friend:     { canonical: "friend",    type: "person", subtype: "social" },
  mate:       { canonical: "friend",    type: "person", subtype: "social" },
  flatmate:   { canonical: "flatmate",  type: "person", subtype: "social" },
  housemate:  { canonical: "flatmate",  type: "person", subtype: "social" },
  // Health
  therapist:  { canonical: "therapist", type: "person", subtype: "health" },
  doctor:     { canonical: "doctor",    type: "person", subtype: "health" },
  gp:         { canonical: "GP",        type: "person", subtype: "health" },
  // Pets
  cat:        { canonical: "cat",       type: "person", subtype: "pet" },
  dog:        { canonical: "dog",       type: "person", subtype: "pet" },
};

// ─── Tech / system vocabulary ─────────────────────────────────────────────────
//
// Known proper-noun systems. These get classified as type:"system" when found
// as mid-sentence capitals.  Add freely — every entry improves recall.

export const TECH_VOCAB = new Set([
  // Dev tools & platforms
  "github","gitlab","bitbucket","jira","linear","notion","confluence","slack",
  "discord","figma","zeplin","asana","trello","clickup","monday",
  "aws","gcp","azure","vercel","netlify","cloudflare","railway","fly",
  "supabase","planetscale","neon","turso","upstash",
  "postgres","postgresql","mysql","sqlite","mongodb","redis","elasticsearch",
  "docker","kubernetes","terraform","ansible","pulumi",
  "github","openai","anthropic","mistral","groq","ollama",
  // Package managers / runtimes
  "bun","npm","pnpm","yarn","pip","uv","poetry","conda","cargo","homebrew","nix",
  "node","deno","bun",
  // Languages & frameworks (often appear as proper nouns in memory content)
  "typescript","javascript","python","rust","golang","java","kotlin","swift",
  "react","nextjs","nuxt","svelte","angular","vue","remix",
  "fastapi","django","rails","laravel","express","fastify","hono",
  "drizzle","prisma","sqlalchemy","typeorm",
  "vitest","jest","playwright","cypress",
  "tailwind","shadcn",
  // Companies (that commonly appear in personal memories)
  "google","microsoft","apple","meta","amazon","netflix","spotify","airbnb",
  "stripe","twilio","sendgrid","resend","sentry","datadog","pagerduty",
  "canva","atlassian","shopify","hubspot","salesforce",
  "xero","myob","quickbooks",
]);

// ─── Stage A — Bigram role scan ───────────────────────────────────────────────
//
// Tokenize → find possessive/article + role word bigrams.
// "my colleague" → role entity "colleague/work"
// "my mum"       → role entity "mum/family"
// "the CTO"      → role entity "CTO/work"
//
// We also look one token ahead for a potential proper name:
// "my colleague Alex" → role "colleague" + name "Alex"

const POSSESSIVE_TRIGGERS = new Set(["my", "the", "our", "his", "her", "their"]);

function bigramRoleScan(text: string): ExtractedEntity[] {
  // Simple whitespace split on lowercased text for role matching
  const rawWords = text.split(/\s+/);
  const results:  ExtractedEntity[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawWords.length - 1; i++) {
    const trigger = rawWords[i].toLowerCase().replace(/[^a-z]/g, "");
    if (!POSSESSIVE_TRIGGERS.has(trigger)) continue;

    const next = rawWords[i + 1].toLowerCase().replace(/[^a-z]/g, "");
    const role  = ROLE_VOCAB[next];
    if (!role) continue;

    const key = role.canonical;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      raw:       rawWords[i + 1],
      canonical: role.canonical,
      type:      role.type,
      subtype:   role.subtype,
      source:    "role_bigram",
    });

    // Look ahead one more token for an associated proper name
    // "my colleague Alex" → also extract "Alex" as a person
    if (i + 2 < rawWords.length) {
      const nameWord = rawWords[i + 2].replace(/[^a-zA-Z]/g, "");
      if (nameWord.length >= 2 && /^[A-Z]/.test(nameWord) && !TECH_VOCAB.has(nameWord.toLowerCase())) {
        const nk = nameWord.toLowerCase();
        if (!seen.has(nk)) {
          seen.add(nk);
          results.push({
            raw:       nameWord,
            canonical: nameWord,
            type:      "person",
            subtype:   role.subtype,   // inherit context from role
            source:    "proper_noun",
          });
        }
      }
    }
  }

  return results;
}

// ─── Stage B — Capitalization heuristic ──────────────────────────────────────
//
// Walk raw text words.  Words capitalized mid-sentence (not after . ! ?) are
// proper noun candidates.  Cross-reference TECH_VOCAB for system entities.
// Unknown → person/unknown.
//
// Skipped: single-char words, "I", known stop-list words, words already
// found by Stage A.

// Common all-caps acronyms that are NOT entity names
const ACRONYM_SKIP = new Set([
  "PR","MR","API","URL","UI","UX","DB","SQL","CSS","HTML","JSON","CSV",
  "CI","CD","MVP","KPI","OKR","SLA","SLO","ETA","EST","UTC","GMT",
  "AU","US","UK","EU","NZ","WFH","TIL","IMO","IIRC","FYI","LGTM",
]);

// Place names — classified as "place" type rather than person/unknown
const PLACE_VOCAB = new Set([
  // Australian cities (most relevant given user context)
  "Sydney","Melbourne","Brisbane","Perth","Adelaide","Canberra","Darwin","Hobart",
  // Major world cities
  "London","NewYork","Tokyo","Paris","Berlin","Amsterdam","Singapore","Auckland",
  // Countries
  "Australia","America","England","Japan","Germany","Canada","Zealand",
]);

const CAP_SKIP = new Set([
  "I","A","The","An","But","And","Or","So","If","This","That","It",
  "He","She","They","We","You","Me","My","His","Her","Their","Its",
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  "January","February","March","April","May","June","July","August",
  "September","October","November","December",
]);

function capitalizationScan(text: string, alreadyFound: Set<string>): ExtractedEntity[] {
  const words   = text.split(/\s+/);
  const results: ExtractedEntity[] = [];
  const seen    = new Set(alreadyFound);
  let prevWasBoundary = true; // treat start of text as a boundary

  for (const raw of words) {
    const clean = raw.replace(/[^a-zA-Z]/g, "");
    const isBoundary = /[.!?]$/.test(raw);

    if (clean.length >= 2 && !prevWasBoundary && /^[A-Z]/.test(clean) && !CAP_SKIP.has(clean)) {
      const lc  = clean.toLowerCase();
      const key = lc;
      if (!seen.has(key)) {
        seen.add(key);
        if (ACRONYM_SKIP.has(clean)) {
          // skip
        } else if (TECH_VOCAB.has(lc)) {
          results.push({ raw: clean, canonical: clean, type: "system", subtype: "tech", source: "tech_vocab" });
        } else if (PLACE_VOCAB.has(clean)) {
          results.push({ raw: clean, canonical: clean, type: "place", subtype: "location", source: "proper_noun" });
        } else if (clean.length >= 2) {
          // Assume proper name — person/unknown until proven otherwise
          results.push({ raw: clean, canonical: clean, type: "person", subtype: "unknown", source: "proper_noun" });
        }
      }
    }

    prevWasBoundary = isBoundary || clean.length === 0;
  }

  return results;
}

// ─── Public NER entry point ───────────────────────────────────────────────────

export function extractEntities(text: string): ExtractedEntity[] {
  if (!text?.trim()) return [];

  // Stage A
  const roleEntities = bigramRoleScan(text);
  const foundCanonicals = new Set(roleEntities.map(e => e.canonical.toLowerCase()));

  // Stage B — skip anything Stage A already found
  const capEntities = capitalizationScan(text, foundCanonicals);

  return [...roleEntities, ...capEntities];
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export async function loadEntityStore(): Promise<EntityStore> {
  if (!existsSync(ENTITY_FILE)) return { version: 1, entities: [] };
  try   { return JSON.parse(await readFile(ENTITY_FILE, "utf8")); }
  catch { return { version: 1, entities: [] }; }
}

export async function saveEntityStore(store: EntityStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ENTITY_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ─── Registry operations ──────────────────────────────────────────────────────

/** Find an existing entity by name or alias (case-insensitive). */
export function findEntity(store: EntityStore, nameOrAlias: string): Entity | undefined {
  const lower = nameOrAlias.toLowerCase();
  return store.entities.find(e =>
    e.name.toLowerCase()   === lower ||
    e.aliases.some(a => a.toLowerCase() === lower)
  );
}

/**
 * Upsert an entity and link it to a memory.
 * Returns the entity id.
 */
export function upsertEntity(
  store:     EntityStore,
  extracted: ExtractedEntity,
  memoryId:  string,
  now:       number,
): string {
  const existing = findEntity(store, extracted.canonical);

  if (existing) {
    existing.mentions++;
    existing.updated_at = now;
    if (!existing.memory_ids.includes(memoryId)) {
      existing.memory_ids.push(memoryId);
    }
    // Absorb new alias if raw text differs from canonical
    const rawLower = extracted.raw.toLowerCase();
    if (rawLower !== existing.name.toLowerCase() && !existing.aliases.map(a=>a.toLowerCase()).includes(rawLower)) {
      existing.aliases.push(extracted.raw);
    }
    return existing.id;
  }

  const entity: Entity = {
    id:         randomUUID(),
    name:       extracted.canonical,
    aliases:    extracted.raw !== extracted.canonical ? [extracted.raw] : [],
    type:       extracted.type,
    subtype:    extracted.subtype,
    memory_ids: [memoryId],
    mentions:   1,
    created_at: now,
    updated_at: now,
  };
  store.entities.push(entity);
  return entity.id;
}

/** Remove a memory reference from all entities that link to it. */
export function unlinkMemory(store: EntityStore, memoryId: string): void {
  for (const entity of store.entities) {
    entity.memory_ids = entity.memory_ids.filter(id => id !== memoryId);
  }
  // Prune entities with no remaining memories
  store.entities = store.entities.filter(e => e.memory_ids.length > 0);
}

/**
 * Find all entities mentioned in a query string (by name or alias).
 * Used at recall time to augment retrieval with entity-linked memories.
 */
export function queryEntities(store: EntityStore, queryText: string): Entity[] {
  const words = queryText.toLowerCase().split(/\s+/);
  const found: Entity[] = [];
  const seen  = new Set<string>();

  for (const entity of store.entities) {
    if (seen.has(entity.id)) continue;
    const names = [entity.name.toLowerCase(), ...entity.aliases.map(a => a.toLowerCase())];
    if (names.some(n => words.some(w => w.replace(/[^a-z]/g,"") === n.replace(/[^a-z]/g,"")))) {
      found.push(entity);
      seen.add(entity.id);
    }
  }

  return found;
}
