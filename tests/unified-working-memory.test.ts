import { describe, expect, test } from "bun:test";
import type { CompactionCheckpoint } from "../extensions/shared/compaction-schema";
import {
  applyWorkingMemoryDeltas,
  retrieveWorkingSet,
  workingMemoryItemsFromCheckpoint,
  type WorkingMemoryItem,
} from "../extensions/shared/working-memory";

const base: WorkingMemoryItem[] = [
  { id: "constraint-1", source: "conversation", repositoryMarker: "repo-a", text: "Preserve exact error diagnostics", status: "active", sensitivity: "general", evidenceIds: ["entry-1"] },
  { id: "symbol-1", source: "repository", repositoryMarker: "repo-a", text: "Compaction hook lives in structured-compaction.ts", status: "active", sensitivity: "general", evidenceIds: ["symbol-file"] },
  { id: "foreign-1", source: "repository", repositoryMarker: "repo-b", text: "Unrelated foreign repository architecture", status: "active", sensitivity: "general", evidenceIds: ["foreign"] },
];

describe("unified working memory", () => {
  test("applies incremental add supersede resolve and expire deltas", () => {
    const result = applyWorkingMemoryDeltas(base, [
      { op: "add", item: { id: "failure-1", source: "context_object", repositoryMarker: "repo-a", text: "Schema test failed", status: "active", sensitivity: "general", evidenceIds: ["object-1"] } },
      { op: "supersede", id: "symbol-1", replacement: { id: "symbol-2", source: "repository", repositoryMarker: "repo-a", text: "Hook moved to compaction.ts", status: "active", sensitivity: "general", evidenceIds: ["symbol-new"] } },
      { op: "resolve", id: "constraint-1", evidenceIds: ["check-1"] },
      { op: "expire", id: "foreign-1", reason: "repository changed" },
    ]);

    expect(result.find(item => item.id === "constraint-1")).toMatchObject({ status: "resolved", evidenceIds: ["entry-1", "check-1"] });
    expect(result.find(item => item.id === "symbol-1")?.status).toBe("superseded");
    expect(result.find(item => item.id === "symbol-2")?.status).toBe("active");
    expect(result.find(item => item.id === "foreign-1")?.status).toBe("expired");
    expect(result.find(item => item.id === "failure-1")?.text).toContain("failed");
  });

  test("adapts checkpoint claims and active files into evidence-linked memory items", () => {
    const checkpoint: CompactionCheckpoint = {
      version: 1,
      goal: "Continue compaction",
      constraints: [{ text: "Preserve errors", objectIds: ["error-1"] }],
      acceptanceCriteria: [],
      decisions: [{ text: "Use typed checkpoints", sourceEntryIds: ["decision-1"] }],
      activeFiles: [{ path: "extensions/structured-compaction.ts", relevance: "hook", contentHash: "hash-1" }],
      changes: [], verification: [], failures: [], blockers: [], pendingActions: [], safetyState: [], objectIds: ["error-1"],
    };
    const items = workingMemoryItemsFromCheckpoint(checkpoint, "repo-a");
    expect(items.some(item => item.text === "Preserve errors" && item.evidenceIds.includes("error-1"))).toBe(true);
    expect(items.some(item => item.text.includes("structured-compaction.ts") && item.source === "repository")).toBe(true);
    expect(items.every(item => item.repositoryMarker === "repo-a")).toBe(true);
  });

  test("retrieves bounded conversation and repository evidence without foreign state", () => {
    const result = retrieveWorkingSet(base, {
      query: "compaction diagnostics hook",
      repositoryMarker: "repo-a",
      maxChars: 220,
      allowedSensitivities: ["general"],
    });

    expect(result.text).toContain("memory://constraint-1");
    expect(result.text).toContain("memory://symbol-1");
    expect(result.text).not.toContain("foreign-1");
    expect(result.text.length).toBeLessThanOrEqual(220);
    expect(result.itemIds).toEqual(expect.arrayContaining(["constraint-1", "symbol-1"]));
  });
});
