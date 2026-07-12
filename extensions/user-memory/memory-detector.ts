import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BM25Index } from "../shared/retrieval";
import {
  detectBorderlineScope,
  detectContradiction,
  detectThirdPartyShare,
  type PendingClarification,
} from "./clarify.js";
import { inferExpiryTier } from "./expiry.js";
import { jaccard, type MemoryStore } from "./store.js";
import {
  classifyCategory,
  extractCandidates,
  LOW_SIGNAL_THRESHOLD,
  type DetectedHint,
} from "./signals.js";

export type MemoryDetectorRuntime = {
  pendingHints: DetectedHint[];
  pendingClarifications: PendingClarification[];
  reset: () => void;
};

type RegisterMemoryDetectorOptions = {
  pi: ExtensionAPI;
  ensureLoaded: () => Promise<void>;
  getStore: () => MemoryStore;
  getBm25: () => BM25Index;
};

export function registerMemoryDetector(options: RegisterMemoryDetectorOptions): MemoryDetectorRuntime {
  const pendingHints: DetectedHint[] = [];
  const pendingClarifications: PendingClarification[] = [];

  options.pi.on("agent_end", async (event, _ctx) => {
    await options.ensureLoaded();
    const store = options.getStore();
    const bm25 = options.getBm25();

    const userTexts: string[] = [];
    for (const msg of event.messages) {
      if (msg.role !== "user") continue;
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text) userTexts.push(text);
    }
    if (userTexts.length === 0) return;
    const fullUserText = userTexts.join(" ");

    const candidates = extractCandidates(fullUserText);
    if (candidates.length === 0) return;

    for (const candidate of candidates.slice(0, 3)) {
      const existing = bm25.search(candidate.text, 5);
      const topBM25 = existing[0]?.score ?? 0;
      const novelty = Math.max(0, 1 - topBM25 / 4.0);
      if (novelty < 0.25) continue;

      const { category, confidence } = classifyCategory(candidate.text);
      const featureSet = new Set(candidate.features);
      const isPattern = featureSet.has("recurrence");
      const expiry = inferExpiryTier(candidate.text, candidate.features, candidate.score);

      const isDup = pendingHints.some(h => jaccard(h.text, candidate.text) > 0.55);
      if (isDup) continue;

      pendingHints.push({
        text: candidate.text,
        category: expiry ? "context" : category,
        features: candidate.features,
        score: candidate.score,
        confidence,
        novelty,
        expiry,
        isPattern,
      });

      if (pendingClarifications.length === 0) {
        const contradictionC = detectContradiction(
          candidate.text,
          existing.map(h => ({ id: h.id, content: store.memories.find(m => m.id === h.id)?.content ?? "", score: h.score })),
        );
        if (contradictionC) {
          pendingClarifications.push(contradictionC);
        } else {
          const thirdPartyC = detectThirdPartyShare(fullUserText);
          if (thirdPartyC) {
            pendingClarifications.push(thirdPartyC);
          } else {
            const borderlineC = detectBorderlineScope(candidate.text, candidate.score, LOW_SIGNAL_THRESHOLD);
            if (borderlineC) pendingClarifications.push(borderlineC);
          }
        }
      }
    }
  });

  return {
    pendingHints,
    pendingClarifications,
    reset: () => {
      pendingHints.length = 0;
      pendingClarifications.length = 0;
    },
  };
}
