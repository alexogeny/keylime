import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
} from "../../extensions/shared/compaction-schema";

type SourceEntry = { id: string; role: "user" | "assistant" | "tool"; text: string; trusted: boolean };
type SemanticValidationContext = {
  previousCheckpoint?: CompactionCheckpoint;
  sourceEntries: SourceEntry[];
  knownObjectIds: string[];
};

const validateWithContext = validateCompactionCheckpoint as unknown as (
  value: unknown,
  context: SemanticValidationContext,
) => CompactionCheckpoint;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const constraintText = "Never delete repository files without explicit user approval.";
const planText = "Implement semantic compaction validation before changing runtime behavior.";
const acceptanceText = "Every active control survives compaction byte-for-byte.";
const safetyText = "Destructive operations remain blocked by deterministic policy.";

function checkpoint(): any {
  return {
    version: 1,
    goal: "Build a safe token-efficient agent harness",
    constraints: [{
      controlId: "constraint:no-unapproved-delete",
      contentHash: hash(constraintText),
      text: constraintText,
      sourceEntryIds: ["entry-constraint"],
      status: "active",
    }],
    acceptanceCriteria: [{
      controlId: "acceptance:control-retention",
      contentHash: hash(acceptanceText),
      text: acceptanceText,
      sourceEntryIds: ["entry-acceptance"],
      status: "active",
    }],
    decisions: [],
    activeFiles: [{
      path: "extensions/structured-compaction.ts",
      relevance: "active implementation",
      contentHash: "source-hash-1",
    }],
    changes: [],
    verification: [],
    failures: [],
    blockers: [],
    pendingActions: [{
      controlId: "plan:semantic-validation",
      contentHash: hash(planText),
      text: planText,
      sourceEntryIds: ["entry-plan"],
      status: "active",
    }],
    safetyState: [{
      controlId: "safety:deterministic-guard",
      contentHash: hash(safetyText),
      text: safetyText,
      sourceEntryIds: ["entry-safety"],
      status: "active",
    }],
    objectIds: ["evidence-1"],
  };
}

const sourceEntries: SourceEntry[] = [
  { id: "entry-constraint", role: "user", text: constraintText, trusted: true },
  { id: "entry-plan", role: "user", text: planText, trusted: true },
  { id: "entry-acceptance", role: "user", text: acceptanceText, trusted: true },
  { id: "entry-safety", role: "user", text: safetyText, trusted: true },
];

function context(previousCheckpoint?: CompactionCheckpoint): SemanticValidationContext {
  return { previousCheckpoint, sourceEntries, knownObjectIds: ["evidence-1"] };
}

describe("RED: compaction has an immutable semantic control plane", () => {
  test("requires stable IDs and hashes for active constraints", () => {
    const candidate = checkpoint();
    delete candidate.constraints[0].controlId;
    delete candidate.constraints[0].contentHash;

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("requires stable IDs and hashes for plans, acceptance criteria, and safety state", () => {
    const candidate = checkpoint();
    for (const section of [candidate.pendingActions, candidate.acceptanceCriteria, candidate.safetyState]) {
      delete section[0].controlId;
      delete section[0].contentHash;
    }

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("rejects an otherwise schema-valid checkpoint that drops an active constraint", () => {
    const previous = validateCompactionCheckpoint(checkpoint());
    const candidate = checkpoint();
    candidate.constraints = [];

    expect(() => validateWithContext(candidate, context(previous))).toThrow();
  });

  test("rejects loss of an active plan during repeated compaction", () => {
    const first = validateCompactionCheckpoint(checkpoint());
    const second = checkpoint();
    second.pendingActions = [];

    expect(() => validateWithContext(second, context(first))).toThrow();
  });

  test("rejects loss of acceptance criteria even when all required arrays remain present", () => {
    const previous = validateCompactionCheckpoint(checkpoint());
    const candidate = checkpoint();
    candidate.acceptanceCriteria = [];

    expect(() => validateWithContext(candidate, context(previous))).toThrow();
  });

  test("rejects loss of deterministic safety state", () => {
    const previous = validateCompactionCheckpoint(checkpoint());
    const candidate = checkpoint();
    candidate.safetyState = [];

    expect(() => validateWithContext(candidate, context(previous))).toThrow();
  });

  test("rejects paraphrasing of immutable active control text", () => {
    const previous = validateCompactionCheckpoint(checkpoint());
    const candidate = checkpoint();
    candidate.constraints[0].text = "Avoid deleting files unless the user probably agrees.";

    expect(() => validateWithContext(candidate, context(previous))).toThrow();
  });

  test("rejects an active control whose content hash no longer matches its text", () => {
    const candidate = checkpoint();
    candidate.constraints[0].text += " This text was altered.";

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("requires provenance on every factual checkpoint claim", () => {
    const candidate = checkpoint();
    candidate.changes.push({ text: "The migration is complete.", status: "active" });

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("rejects references to source entries and context objects that do not exist", () => {
    const candidate = checkpoint();
    candidate.verification.push({
      text: "All production checks passed.",
      sourceEntryIds: ["entry-that-does-not-exist"],
      objectIds: ["unknown-evidence"],
      status: "active",
    });
    candidate.objectIds.push("unknown-evidence");

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("requires a current content hash for every active edit target", () => {
    const candidate = checkpoint();
    delete candidate.activeFiles[0].contentHash;

    expect(() => validateWithContext(candidate, context())).toThrow();
  });

  test("does not allow an active control to become resolved or superseded without trusted evidence", () => {
    const previous = validateCompactionCheckpoint(checkpoint());
    const candidate = checkpoint();
    candidate.constraints[0].status = "superseded";

    expect(() => validateWithContext(candidate, context(previous))).toThrow();
  });
});
