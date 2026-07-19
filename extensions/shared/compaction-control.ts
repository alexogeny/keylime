import { createHash } from "node:crypto";
import type { CompactionCheckpoint, EvidenceClaim } from "./compaction-schema";

export const COMPACTION_MAX_CONTROL_CHARS = 40_000;
export const COMPACTION_CONTROL_SECTIONS = ["constraints", "acceptanceCriteria", "pendingActions", "safetyState"] as const;

export function compactionClaimHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stabilizeCompactionControlPlane(
  checkpoint: CompactionCheckpoint,
  previous?: CompactionCheckpoint,
  authorizedTransitions: string[] = [],
): CompactionCheckpoint {
  const next = structuredClone(checkpoint);
  const authorized = new Set(authorizedTransitions);
  for (const section of COMPACTION_CONTROL_SECTIONS) {
    const normalized = next[section].map((claim): EvidenceClaim => {
      const contentHash = compactionClaimHash(claim.text);
      return { ...claim, controlId: claim.controlId ?? `${section}:${contentHash.slice(0, 16)}`, contentHash };
    });
    const byHash = new Map<string, EvidenceClaim>();
    for (const claim of normalized) if (!byHash.has(claim.contentHash!)) byHash.set(claim.contentHash!, claim);
    for (const prior of previous?.[section] ?? []) {
      if (prior.status !== "active") continue;
      const contentHash = prior.contentHash ?? compactionClaimHash(prior.text);
      const controlId = prior.controlId ?? `${section}:${contentHash.slice(0, 16)}`;
      const current = byHash.get(contentHash);
      const authorizedCurrent = current?.controlId === controlId && current.status !== "active" && authorized.has(controlId);
      if (!authorizedCurrent && (!current || current.text !== prior.text || current.status !== "active")) {
        byHash.set(contentHash, { ...prior, controlId, contentHash, status: "active" });
      }
    }
    next[section] = [...byHash.values()];
  }
  const controlChars = COMPACTION_CONTROL_SECTIONS.reduce(
    (sum, section) => sum + next[section].reduce((sectionSum, claim) => sectionSum + claim.text.length + (claim.controlId?.length ?? 0) + 80, 0),
    0,
  );
  if (controlChars > COMPACTION_MAX_CONTROL_CHARS) {
    throw new Error(`Compaction control plane exceeds control character budget (${controlChars}/${COMPACTION_MAX_CONTROL_CHARS})`);
  }
  return next;
}
