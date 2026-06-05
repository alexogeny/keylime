import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "../shared/turn-context";
import { daysUntil } from "../shared/time-format";
import { queryEntities, type EntityStore } from "./entity.js";
import { profileContextLines } from "./profile-context.js";
import { decayedConfidence, type Memory, type MemoryStore } from "./store.js";
import { inferSensitivityTier } from "./sensitivity.js";
import { HIGH_SIGNAL_THRESHOLD, type DetectedHint } from "./signals.js";
import type { PendingClarification } from "./clarify.js";

type MemoryHit = { memory: Memory; score: number };

export type UserMemoryContextRuntime = {
  resetSessionState: () => void;
};

type RegisterUserMemoryContextOptions = {
  pi: ExtensionAPI;
  ensureLoaded: () => Promise<void>;
  getStore: () => MemoryStore;
  getEntityStore: () => EntityStore;
  pendingHints: DetectedHint[];
  pendingClarifications: PendingClarification[];
  hybridSearch: (prompt: string, topK: number) => Promise<MemoryHit[]>;
};

const PINNED_PROFILE_TAGS = new Set(["name", "height", "weight", "measurements", "body", "dob", "birthday", "age"]);
const LEDGER_SUPPRESS = 3;
const VOLATILE_CAP = 7;

function isPinnedProfileMemory(m: Memory): boolean {
  return !m.trace_only && m.tags.some(t => PINNED_PROFILE_TAGS.has(t.toLowerCase()));
}

function buildStableBlock(store: MemoryStore): string {
  const profileLines = profileContextLines(store.profile);
  if (store.memories.length === 0 && profileLines.length === 0) return "";
  const now = Date.now();

  const pinned = store.memories.filter(isPinnedProfileMemory);
  const base = store.memories.filter(m => {
    if (m.trace_only) return false;
    const tier = m.sensitivity ?? inferSensitivityTier(m);
    if (tier === "baseline") return true;
    if (tier === "general" && m.category === "preference") return true;
    return false;
  });

  const unique = new Map<string, Memory>();
  for (const m of [...pinned, ...base]) unique.set(m.id, m);

  const stableMems = [...unique.values()]
    .map(m => ({ m, conf: decayedConfidence(m, now) }))
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 5)
    .map(x => x.m);

  if (stableMems.length === 0 && profileLines.length === 0) return "";

  const lines = ["## What you know about this user"];
  lines.push(...profileLines.slice(0, 8));
  for (const m of stableMems) {
    const prefix = `(${m.category}${m.promoted_from ? " ⬆️" : ""}) `;
    const mentions = m.mentions > 1 ? ` [×${m.mentions}]` : "";
    const dateRef = m.date_ref ? ` [${m.date_ref}]` : "";
    lines.push(`- ${prefix}${m.content}${dateRef}${mentions}`);
  }
  return lines.join("\n");
}

export function registerUserMemoryContext(options: RegisterUserMemoryContextOptions): UserMemoryContextRuntime {
  let stableBlock = "";
  let stableStoreLen = -1;
  const injectionLedger = new Map<string, number>();

  options.pi.on("before_agent_start", async (event, _ctx) => {
    await options.ensureLoaded();
    const store = options.getStore();
    if (store.memories.length === 0) return;

    if (store.memories.length !== stableStoreLen) {
      stableBlock = buildStableBlock(store);
      stableStoreLen = store.memories.length;
    }

    if (!stableBlock) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + stableBlock };
  });

  registerContextProvider({
    id: "user-memory",
    priority: 60,
    maxChars: 520,
    build: async ({ prompt }) => {
      await options.ensureLoaded();
      const store = options.getStore();
      if (store.memories.length === 0) return null;

      const now = Date.now();
      const lines: string[] = [];

      if (options.pendingHints.length > 0) {
        const hints = options.pendingHints.splice(0);
        lines.push("Memory hints detected:");
        for (const h of hints.slice(0, 3)) {
          const strength = h.score >= HIGH_SIGNAL_THRESHOLD ? "strong" : "moderate";
          lines.push(`- [${h.category}, ${strength}] "${h.text.slice(0, 100)}"`);
        }
      }

      if (options.pendingClarifications.length > 0) {
        const [clar] = options.pendingClarifications.splice(0);
        options.pendingClarifications.length = 0;
        lines.push(clar.priority === "high" ? "Contradiction: ask before proceeding:" : "Consider asking:");
        lines.push(`- ${clar.question}`);
      }

      if (prompt.trim()) {
        const memMap = new Map(store.memories.map(m => [m.id, m]));
        const stableIds = new Set(
          store.memories
            .filter(m => {
              if (isPinnedProfileMemory(m)) return true;
              const tier = m.sensitivity ?? inferSensitivityTier(m);
              return tier === "baseline" || (tier === "general" && m.category === "preference");
            })
            .map(m => m.id)
        );

        const upcoming = store.memories
          .filter(m => m.expires_at && m.expires_at > now && daysUntil(m.expires_at) <= 90)
          .sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0));

        const mentionedEntities = queryEntities(options.getEntityStore(), prompt);
        const entityMems: Memory[] = [];
        for (const entity of mentionedEntities.slice(0, 3)) {
          for (const mid of entity.memory_ids) {
            const m = memMap.get(mid);
            if (m) entityMems.push(m);
          }
        }

        const relevant = await options.hybridSearch(prompt, 5);
        const seen = new Set<string>(stableIds);
        const volatile: Memory[] = [];
        const candidates = [...upcoming, ...entityMems, ...relevant.map(r => r.memory)];

        for (const m of candidates) {
          if (seen.has(m.id) || m.trace_only) continue;
          seen.add(m.id);

          const ledgerCount = injectionLedger.get(m.id) ?? 0;
          const isEntityHit = entityMems.some(em => em.id === m.id);
          if (ledgerCount >= LEDGER_SUPPRESS && !isEntityHit) continue;

          volatile.push(m);
          if (volatile.length >= VOLATILE_CAP) break;
        }

        if (volatile.length > 0) {
          lines.push("Relevant memory:");
          for (const m of volatile.slice(0, 5)) {
            const prefix = m.expires_at ? `in ${daysUntil(m.expires_at)}d` : m.category;
            const mentions = m.mentions > 1 ? ` [×${m.mentions}]` : "";
            lines.push(`- (${prefix}) ${m.content}${m.date_ref ? ` [${m.date_ref}]` : ""}${mentions}`);
            injectionLedger.set(m.id, (injectionLedger.get(m.id) ?? 0) + 1);
          }
          if (mentionedEntities.length > 0) {
            lines.push(`entity context: ${mentionedEntities.map(e => e.name).join(", ")}`);
          }
        }
      }

      return lines.length > 0 ? lines.join("\n") : null;
    },
  });

  return {
    resetSessionState: () => {
      stableStoreLen = -1;
      injectionLedger.clear();
    },
  };
}
