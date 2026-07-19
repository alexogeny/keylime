import { createHash } from "node:crypto";
import { buildRetrievalIndex } from "./retrieval/hybrid";
import type { SearchDocument } from "./retrieval/types";
import type { CompactionCheckpoint, EvidenceClaim } from "./compaction-schema";

export type WorkingMemoryStatus = "active" | "resolved" | "superseded" | "expired";
export type WorkingMemorySensitivity = "baseline" | "general" | "context_gated" | "temporal_gated";
export type WorkingMemorySource = "conversation" | "repository" | "project" | "agent_os" | "user_memory" | "context_object";

export type WorkingMemoryItem = {
  id: string;
  source: WorkingMemorySource;
  repositoryMarker?: string;
  text: string;
  status: WorkingMemoryStatus;
  sensitivity: WorkingMemorySensitivity;
  evidenceIds: string[];
  updatedAt?: number;
  resolutionReason?: string;
};

export type WorkingMemoryDelta =
  | { op: "add"; item: WorkingMemoryItem }
  | { op: "supersede"; id: string; replacement: WorkingMemoryItem }
  | { op: "resolve"; id: string; evidenceIds?: string[] }
  | { op: "expire"; id: string; reason: string };

function mergeEvidence(left: string[], right: string[] = []): string[] {
  return [...new Set([...left, ...right])];
}

export function applyWorkingMemoryDeltas(items: WorkingMemoryItem[], deltas: WorkingMemoryDelta[]): WorkingMemoryItem[] {
  const byId = new Map(items.map(item => [item.id, { ...item, evidenceIds: [...item.evidenceIds] }]));
  for (const delta of deltas) {
    if (delta.op === "add") {
      if (byId.has(delta.item.id)) throw new Error(`Working memory item already exists: ${delta.item.id}`);
      byId.set(delta.item.id, { ...delta.item, evidenceIds: [...delta.item.evidenceIds] });
      continue;
    }
    const current = byId.get(delta.id);
    if (!current) throw new Error(`Unknown working memory item: ${delta.id}`);
    if (delta.op === "supersede") {
      if (delta.replacement.id !== delta.id && byId.has(delta.replacement.id)) throw new Error(`Working memory item already exists: ${delta.replacement.id}`);
      byId.set(delta.id, { ...current, status: "superseded" });
      byId.set(delta.replacement.id, { ...delta.replacement, evidenceIds: [...delta.replacement.evidenceIds] });
    } else if (delta.op === "resolve") {
      byId.set(delta.id, { ...current, status: "resolved", evidenceIds: mergeEvidence(current.evidenceIds, delta.evidenceIds) });
    } else {
      byId.set(delta.id, { ...current, status: "expired", resolutionReason: delta.reason });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function stableMemoryId(section: string, text: string): string {
  return `checkpoint:${section}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function claimItem(section: string, source: WorkingMemorySource, repositoryMarker: string, claim: EvidenceClaim): WorkingMemoryItem {
  return {
    id: stableMemoryId(section, claim.text),
    source,
    repositoryMarker,
    text: claim.text,
    status: claim.status ?? "active",
    sensitivity: "general",
    evidenceIds: [...new Set([...(claim.sourceEntryIds ?? []), ...(claim.objectIds ?? [])])],
  };
}

export function workingMemoryItemsFromCheckpoint(checkpoint: CompactionCheckpoint, repositoryMarker: string): WorkingMemoryItem[] {
  const items: WorkingMemoryItem[] = [];
  const addClaims = (section: string, source: WorkingMemorySource, claims: EvidenceClaim[]) => {
    for (const claim of claims) items.push(claimItem(section, source, repositoryMarker, claim));
  };
  addClaims("constraints", "conversation", checkpoint.constraints);
  addClaims("acceptance", "project", checkpoint.acceptanceCriteria);
  addClaims("decisions", "project", checkpoint.decisions);
  addClaims("changes", "conversation", checkpoint.changes);
  addClaims("verification", "context_object", checkpoint.verification);
  addClaims("failures", "context_object", checkpoint.failures);
  addClaims("blockers", "conversation", checkpoint.blockers);
  addClaims("pending", "agent_os", checkpoint.pendingActions);
  addClaims("safety", "agent_os", checkpoint.safetyState);
  for (const file of checkpoint.activeFiles) {
    items.push({
      id: stableMemoryId("file", file.path),
      source: "repository",
      repositoryMarker,
      text: `${file.path} — ${file.relevance}${file.contentHash ? ` hash=${file.contentHash}` : ""}`,
      status: "active",
      sensitivity: "general",
      evidenceIds: (file.locators ?? []).flatMap(locator => [locator.resultId, locator.path].filter((value): value is string => Boolean(value))),
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function memoryDocument(item: WorkingMemoryItem): SearchDocument {
  return {
    id: item.id,
    kind: item.source,
    title: item.id,
    body: [item.text, item.source, ...item.evidenceIds].join("\n"),
    fields: { source: item.source, sensitivity: item.sensitivity },
  };
}

export function retrieveWorkingSet(items: WorkingMemoryItem[], options: {
  query: string;
  repositoryMarker: string;
  maxChars: number;
  allowedSensitivities: WorkingMemorySensitivity[];
}): { text: string; itemIds: string[]; omitted: number } {
  const allowed = new Set(options.allowedSensitivities);
  const candidates = items.filter(item => item.status === "active"
    && allowed.has(item.sensitivity)
    && (!item.repositoryMarker || item.repositoryMarker === options.repositoryMarker));
  const index = buildRetrievalIndex(candidates.map(memoryDocument));
  const rankedIds = options.query.trim()
    ? index.search(options.query, { topK: candidates.length }).map(result => result.id)
    : candidates.map(item => item.id).sort();
  const byId = new Map(candidates.map(item => [item.id, item]));
  const lines: string[] = [];
  const itemIds: string[] = [];
  let used = 0;
  for (const id of rankedIds) {
    const item = byId.get(id);
    if (!item) continue;
    const line = `- memory://${item.id} [${item.source}] ${item.text} (${item.evidenceIds.map(evidence => `evidence://${evidence}`).join(", ") || "no evidence"})`;
    if (used + line.length + (lines.length ? 1 : 0) > Math.max(0, options.maxChars)) continue;
    lines.push(line);
    itemIds.push(item.id);
    used += line.length + (lines.length > 1 ? 1 : 0);
  }
  return { text: lines.join("\n"), itemIds, omitted: Math.max(0, rankedIds.length - itemIds.length) };
}
