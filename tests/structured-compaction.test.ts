import { describe, expect, test } from "bun:test";
import {
  CompactionCheckpointSchema,
  renderCompactionCheckpoint,
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
} from "../extensions/shared/compaction-schema";
import structuredCompactionExtension, {
  COMPACTION_MAX_CONVERSATION_CHARS,
  COMPACTION_MAX_OUTPUT_TOKENS,
  createStructuredCompactionHandler,
  stabilizeCompactionControlPlane,
} from "../extensions/structured-compaction";

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
    expect(CompactionCheckpointSchema.required).toEqual(expect.arrayContaining(["goal", "constraints", "objectIds"]));
    expect(validateCompactionCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(() => validateCompactionCheckpoint({ ...checkpoint, constraints: undefined })).toThrow("constraints");
    expect(() => validateCompactionCheckpoint({ ...checkpoint, objectIds: ["../../escape"] })).toThrow("objectIds");
  });

  test("returns Pi compaction fields unchanged after checkpoint and evidence validation", async () => {
    const pinned: string[][] = [];
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async () => checkpoint,
      objectExists: async (_cwd, id) => id === "failure-1",
      pinObjects: async (_cwd, ids) => { pinned.push(ids); },
    });
    const notices: string[] = [];
    const result = await handler({
      preparation: {
        firstKeptEntryId: "entry-kept",
        tokensBefore: 42_000,
        messagesToSummarize: [],
        turnPrefixMessages: [],
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as any, {
      cwd: "/tmp/repo",
      ui: { notify: (text: string) => notices.push(text) },
    } as any);

    expect(result?.compaction.firstKeptEntryId).toBe("entry-kept");
    expect(result?.compaction.tokensBefore).toBe(42_000);
    expect(result?.compaction.summary).toContain("# Keylime Compaction Checkpoint");
    expect(pinned).toEqual([["failure-1"]]);
    expect(notices).toEqual([]);
  });

  test("falls back when generated output is invalid or evidence is missing", async () => {
    const notices: string[] = [];
    const invalid = createStructuredCompactionHandler({ generateCheckpoint: async () => ({ goal: "missing sections" }) });
    const missingEvidence = createStructuredCompactionHandler({
      generateCheckpoint: async () => checkpoint,
      objectExists: async () => false,
    });
    const event = {
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    } as any;
    const ctx = { cwd: "/tmp/repo", ui: { notify: (text: string) => notices.push(text) } } as any;

    await expect(invalid(event, ctx)).resolves.toBeUndefined();
    await expect(missingEvidence(event, ctx)).resolves.toBeUndefined();
    expect(notices.some(text => text.includes("default compaction"))).toBe(true);
  });

  test("records one deterministic readiness snapshot per pressure band rather than per entry", async () => {
    const handlers: Record<string, any> = {};
    const entries = [{ id: "entry-1", type: "message" }];
    const appended: any[] = [];
    structuredCompactionExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      appendEntry: (type: string, data: any) => appended.push({ type, data }),
    } as any);
    const ctx = {
      getContextUsage: () => ({ percent: 70 }),
      sessionManager: { getEntries: () => entries },
    } as any;

    await handlers.turn_end({}, ctx);
    await handlers.turn_end({}, ctx);
    entries.push({ id: "entry-2", type: "message" });
    await handlers.turn_end({}, ctx);

    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe("compaction-readiness-v1");
    expect(appended[0].data).toMatchObject({ version: 1, contextPercent: 70, entryCount: 1, lastEntryId: "entry-1" });
    expect(appended[0].data.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  test("bounds model input and output while preserving oldest goals and newest state", async () => {
    let receivedConversation = "";
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async input => { receivedConversation = input.conversation; return checkpoint; },
    });
    const huge = "x".repeat(80_000);
    await handler({
      preparation: {
        firstKeptEntryId: "kept", tokensBefore: 100,
        messagesToSummarize: [
          { role: "user", content: `EARLIEST-GOAL ${huge}` },
          { role: "assistant", content: huge },
          { role: "user", content: `${huge} NEWEST-STATE` },
        ],
        turnPrefixMessages: [],
      },
      branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal,
    } as any, { cwd: "/tmp/repo", ui: { notify: () => {} } } as any);

    expect(receivedConversation.length).toBeLessThanOrEqual(COMPACTION_MAX_CONVERSATION_CHARS);
    expect(receivedConversation).toContain("EARLIEST-GOAL");
    expect(receivedConversation).toContain("NEWEST-STATE");
    expect(COMPACTION_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(4096);
  });

  test("retries an empty checkpoint response before defaulting", async () => {
    const attempts: number[] = [];
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async (_event, _signal, _ctx, attempt = 0) => {
        attempts.push(attempt);
        if (attempt === 0) throw new Error("Empty checkpoint response");
        return checkpoint;
      },
    });
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal,
    } as any, { cwd: "/tmp/repo", ui: { notify: () => {} } } as any);

    expect(attempts).toEqual([0, 1]);
    expect(result?.compaction.summary).toContain("Goal: Implement verified context compaction");
  });

  test("retries truncated JSON with corrective feedback", async () => {
    const attempts: number[] = [];
    const feedback: Array<string | undefined> = [];
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async (input, _signal, _ctx, attempt = 0) => {
        attempts.push(attempt);
        feedback.push(input.validationError);
        if (attempt === 0) throw new SyntaxError("Unterminated string in JSON at position 11879");
        return checkpoint;
      },
    });
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal,
    } as any, { cwd: "/tmp/repo", ui: { notify: () => {} } } as any);

    expect(attempts).toEqual([0, 1]);
    expect(feedback[1]).toContain("Unterminated string in JSON");
    expect(result?.compaction.summary).toContain("Goal: Implement verified context compaction");
  });

  test("retries a schema-invalid checkpoint before defaulting", async () => {
    const attempts: number[] = [];
    const handler = createStructuredCompactionHandler({
      generateCheckpoint: async (_event, _signal, _ctx, attempt = 0) => {
        attempts.push(attempt);
        if (attempt === 0) return { ...checkpoint, activeFiles: ["extensions/structured-compaction.ts"] };
        return checkpoint;
      },
    });
    const result = await handler({
      preparation: { firstKeptEntryId: "kept", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
      branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal,
    } as any, { cwd: "/tmp/repo", ui: { notify: () => {} } } as any);

    expect(attempts).toEqual([0, 1]);
    expect(result?.compaction.summary).toContain("Goal: Implement verified context compaction");
  });

  test("stabilizes control ids and hashes deterministically", () => {
    const first = stabilizeCompactionControlPlane(checkpoint);
    const second = stabilizeCompactionControlPlane(checkpoint);
    expect(first).toEqual(second);
    expect(first.constraints[0].controlId).toMatch(/^constraints:[a-f0-9]{16}$/);
    expect(first.constraints[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("carries active controls forward when a later model checkpoint omits them", () => {
    const previous = stabilizeCompactionControlPlane(checkpoint);
    const candidate = structuredClone(checkpoint);
    candidate.constraints = [];
    candidate.pendingActions = [];
    candidate.safetyState = [];
    const stabilized = stabilizeCompactionControlPlane(candidate, previous);
    expect(stabilized.constraints).toEqual(previous.constraints);
    expect(stabilized.pendingActions).toEqual(previous.pendingActions);
    expect(stabilized.safetyState).toEqual(previous.safetyState);
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
