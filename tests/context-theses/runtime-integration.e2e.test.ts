import { describe, expect, test } from "bun:test";
import contextRuntimeExtension, { createContextRuntimeCoordinator } from "../../extensions/context-runtime";
import { mockPiFixture } from "../helpers/mock-pi";
import { renderRuntimeFoldContext } from "../../extensions/structured-compaction";

const toolMessage = (id: string, text: string, details: Record<string, unknown> = {}) => ({
  role: "toolResult", toolCallId: id, toolName: "inspect_lines", content: [{ type: "text", text }], details, isError: false, timestamp: 1,
});

describe("context runtime end-to-end wiring", () => {
  test("ages recoverable tool observations across turns and masks them in the context event", () => {
    const runtime = createContextRuntimeCoordinator({ hotTurns: 1, warmTurns: 2 });
    runtime.recordToolResult({ toolCallId: "old", toolName: "inspect_lines", text: "old exact payload ".repeat(200), objectId: "ctx-old", isError: false });
    runtime.endTurn({ contextPercent: 20 });
    runtime.endTurn({ contextPercent: 20 });
    runtime.endTurn({ contextPercent: 20 });
    runtime.recordToolResult({ toolCallId: "new", toolName: "inspect_lines", text: "latest exact payload", objectId: "ctx-new", isError: false });

    const result = runtime.transformContext([toolMessage("old", "old exact payload ".repeat(200), { contextObjectId: "ctx-old" }), toolMessage("new", "latest exact payload", { contextObjectId: "ctx-new" })]);
    expect(JSON.stringify(result.messages)).toContain("ctx-old");
    expect(JSON.stringify(result.messages)).not.toContain("old exact payload old exact payload");
    expect(JSON.stringify(result.messages)).toContain("latest exact payload");
    expect(result.transforms.some(transform => transform.kind === "observation_mask")).toBe(true);
  });

  test("adopts recoverability metadata added by a later tool-result compactor", () => {
    const runtime = createContextRuntimeCoordinator({ hotTurns: 0, warmTurns: 0 });
    runtime.recordToolResult({ toolCallId: "late-sidecar", toolName: "inspect_lines", text: "large raw output ".repeat(100), isError: false });
    runtime.endTurn({ contextPercent: 20 });
    const result = runtime.transformContext([toolMessage("late-sidecar", "large raw output ".repeat(100), { contextObjectId: "ctx-late" })]);
    expect(JSON.stringify(result.messages)).toContain("ctx-late");
    expect(result.transforms).toHaveLength(1);
  });

  test("hydrates retrieval telemetry when compaction metadata arrives during the context hook", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordToolResult({ toolCallId: "late-search", toolName: "code_search", text: "src/cache.ts:10-20", isError: false });
    runtime.transformContext([{ ...toolMessage("late-search", "src/cache.ts:10-20", { contextObjectId: "ctx-late-search", regions: [{ path: "src/cache.ts", estimatedChars: 220 }] }), toolName: "code_search" }]);
    expect(runtime.snapshot().retrieval.injectedChars).toBe(220);
  });

  test("keeps unresolved errors exact even when old", () => {
    const runtime = createContextRuntimeCoordinator({ hotTurns: 0, warmTurns: 0 });
    runtime.recordToolResult({ toolCallId: "failure", toolName: "run_checks", text: "AssertionError: expected 2 received 1", objectId: "ctx-failure", isError: true });
    for (let index = 0; index < 10; index++) runtime.endTurn({ contextPercent: 20 });
    const message = { ...toolMessage("failure", "AssertionError: expected 2 received 1", { contextObjectId: "ctx-failure" }), isError: true };
    expect(JSON.stringify(runtime.transformContext([message]).messages)).toContain("AssertionError: expected 2 received 1");
  });

  test("keeps a cache-stable fingerprint when only volatile tool evidence changes", () => {
    const runtime = createContextRuntimeCoordinator();
    const first = runtime.transformContext([{ role: "user", content: "fix cache" }, toolMessage("a", "first")]);
    const second = runtime.transformContext([{ role: "user", content: "fix cache" }, toolMessage("b", "second")]);
    expect(second.cacheFingerprint).toBe(first.cacheFingerprint);
  });

  test("selects intent-aware packets before recording retrieval utilization", () => {
    const runtime = createContextRuntimeCoordinator();
    const packets = runtime.selectEvidence(
      { objective: "fix cache key", symbols: ["cacheKey"], paths: ["src/cache.ts"] },
      [
        { id: "target", path: "src/cache.ts", startLine: 10, endLine: 20, text: "function cacheKey model id", lexical: .9, semantic: .9, graph: .5, recency: .5, symbols: ["cacheKey"], objectId: "ctx-target" },
        { id: "noise", path: "docs/theme.md", startLine: 1, endLine: 5, text: "colors", lexical: .1, semantic: .1, graph: 0, recency: 1, symbols: [], objectId: "ctx-noise" },
      ],
      { maxTokens: 100, maxPackets: 2, maxFiles: 2 },
    );
    expect(packets.map(packet => packet.id)).toEqual(["target"]);
    expect(runtime.snapshot().retrieval.injectedChars).toBeGreaterThan(0);
  });

  test("assigns retrieval credit from assistant citations inspections edits and verification", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordRetrieval([{ id: "region", objectId: "ctx-region", path: "src/cache.ts", chars: 200 }]);
    runtime.recordUsage({ mentionedIds: ["region"], inspectedObjectIds: ["ctx-region"], modifiedPaths: ["src/cache.ts"], verificationPassed: true });
    const snapshot = runtime.snapshot();
    expect(snapshot.retrieval.utilization).toBe(1);
    expect(snapshot.retrieval.byId.region).toBeGreaterThanOrEqual(4);
  });

  test("emits proactive folds and adaptive budgets at turn boundaries", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordTrajectory([
      { id: "e1", subtask: "inspect", type: "evidence", text: "cache key omits model", objectIds: ["ctx-code"] },
      { id: "e2", subtask: "inspect", type: "verification", text: "reproduction confirmed" },
    ]);
    const result = runtime.endTurn({ contextPercent: 30, boundary: "subtask_completed" });
    expect(result.fold?.objectIds).toContain("ctx-code");
    expect(result.contextBudget.maxChars).toBeGreaterThan(0);
    expect(result.retrievalBudget.maxPackets).toBeGreaterThan(0);
  });

  test("feeds bounded proactive folds into structured compaction input", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordTrajectory([{ id: "fold-evidence", subtask: "diagnose", type: "evidence", text: "cache key omits model id", objectIds: ["ctx-fold"] }]);
    runtime.endTurn({ contextPercent: 40, boundary: "subtask_completed" });
    runtime.snapshot();
    const folded = renderRuntimeFoldContext();
    expect(folded).toContain("[Verified runtime trajectory fold]");
    expect(folded).toContain("cache key omits model id");
    expect(folded).toContain("ctx-fold");
    expect(folded.length).toBeLessThanOrEqual(2_500);
  });

  test("coordinates provider-native compaction without replacing Pi compaction", () => {
    const runtime = createContextRuntimeCoordinator({ provider: { serverCompaction: true, selectiveToolClearing: true, promptCaching: true, opaqueCompaction: false } });
    const decision = runtime.prepareCompaction({ contextPercent: 88, hasValidatedCheckpoint: true, hasObjectManifest: true, unresolvedFailures: 1 });
    expect(decision.strategy).toBe("provider-compact");
    expect(decision.requireCheckpoint).toBe(true);
  });

  test("retrieves only repository-compatible typed experiences", () => {
    const runtime = createContextRuntimeCoordinator();
    runtime.recordExperiences([
      { id: "local", repository: "acme/app", revision: "main", problemSignature: "stale cache key", symbols: ["cacheKey"], approach: "add model id", outcome: "success", verification: ["test passes"], confidence: .9, createdAt: 10 },
      { id: "foreign", repository: "other/app", revision: "main", problemSignature: "stale cache key", symbols: ["cacheKey"], approach: "foreign", outcome: "success", verification: ["test passes"], confidence: 1, createdAt: 11 },
    ]);
    const matches = runtime.retrieveExperiences({ repository: "acme/app", revision: "main", problemSignature: "cache key stale", symbols: ["cacheKey"], now: 20 });
    expect(matches.map(match => match.id)).toEqual(["local"]);
  });

  test("automatically records search retrieval, bounded inspection, edits, and verification from Pi tool events", async () => {
    const harness = mockPiFixture();
    contextRuntimeExtension(harness.pi);
    const onToolResult = harness.handlers.tool_result[0];
    await onToolResult({ toolCallId: "search", toolName: "code_search", input: { query: "cache" }, content: [{ type: "text", text: "src/cache.ts:10-20" }], details: { contextObjectId: "ctx-search", regions: [{ path: "src/cache.ts", startLine: 10, endLine: 20, estimatedChars: 200 }] }, isError: false }, harness.ctx);
    await onToolResult({ toolCallId: "inspect", toolName: "inspect_context_object", input: { object_id: "ctx-search" }, content: [{ type: "text", text: "exact evidence" }], details: {}, isError: false }, harness.ctx);
    await onToolResult({ toolCallId: "edit", toolName: "apply_code_replacements", input: { path: "src/cache.ts" }, content: [{ type: "text", text: "Applied" }], details: { changedPaths: ["src/cache.ts"] }, isError: false }, harness.ctx);
    await onToolResult({ toolCallId: "verify", toolName: "run_checks", input: {}, content: [{ type: "text", text: "0 fail" }], details: { ok: true }, isError: false }, harness.ctx);
    const status = await harness.tools.context_runtime_status.execute("status", {}, new AbortController().signal, undefined, harness.ctx);
    expect(status.details.retrieval.injectedChars).toBe(200);
    expect(status.details.retrieval.signals["ctx-search"]).toEqual(expect.arrayContaining(["reinspected", "verified_change"]));
  });

  test("registers Pi context lifecycle telemetry compaction and status hooks", async () => {
    const harness = mockPiFixture();
    contextRuntimeExtension(harness.pi);
    expect(Object.keys(harness.handlers)).toEqual(expect.arrayContaining(["session_start", "tool_result", "context", "turn_end", "message_end", "session_before_compact"]));
    expect(harness.tools.context_runtime_status).toBeDefined();
    expect(harness.commands["context-runtime"]).toBeDefined();

    await harness.handlers.session_start[0]({ reason: "new" }, harness.ctx);
    expect(harness.status["context-runtime"]).toContain("ctxrt:");
  });
});
