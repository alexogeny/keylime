import { describe, expect, test } from "bun:test";
import {
  renderCompactionCheckpoint,
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
} from "../extensions/shared/compaction-schema";

const checkpoint: CompactionCheckpoint = {
  version: 1,
  goal: "Implement verified context compaction",
  constraints: [{ text: "Do not drop failing diagnostics", objectIds: ["failure-1"], status: "active" }],
  acceptanceCriteria: [{ text: "Targeted tests pass", sourceEntryIds: ["entry-test"] }],
  decisions: [{ text: "Use typed checkpoints", sourceEntryIds: ["entry-decision"] }],
  activeFiles: [{
    path: "extensions/structured-compaction.ts",
    relevance: "compaction hook",
    contentHash: "abc123",
    locators: [{ path: "extensions/structured-compaction.ts", lines: { start: 10, end: 30 } }],
  }],
  changes: [{ text: "Added checkpoint schema", sourceEntryIds: ["entry-change"] }],
  verification: [{ text: "Schema test is red", sourceEntryIds: ["entry-test"] }],
  failures: [{ text: "Missing compaction module", objectIds: ["failure-1"], status: "active" }],
  blockers: [],
  pendingActions: [{ text: "Implement the hook", status: "active" }],
  safetyState: [{ text: "Default compaction remains fallback", status: "active" }],
  objectIds: ["failure-1"],
};

describe("structured compaction checkpoint", () => {
  test("validates every required checkpoint section", () => {
    expect(validateCompactionCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(() => validateCompactionCheckpoint({ ...checkpoint, constraints: undefined })).toThrow("constraints");
    expect(() => validateCompactionCheckpoint({ ...checkpoint, objectIds: ["../../escape"] })).toThrow("objectIds");
  });

  test("renders exact paths locators hashes and evidence ids", () => {
    const text = renderCompactionCheckpoint(checkpoint);
    expect(text).toContain("Goal: Implement verified context compaction");
    expect(text).toContain("extensions/structured-compaction.ts:10-30");
    expect(text).toContain("hash=abc123");
    expect(text).toContain("object://failure-1");
    expect(text).toContain("Default compaction remains fallback");
  });
});
