import { performance } from "node:perf_hooks";
import { describe, expect, test } from "bun:test";
import * as compaction from "../../extensions/structured-compaction";
import type { CompactionCheckpoint } from "../../extensions/shared/compaction-schema";

const serializeWithStats = (compaction as any).serializeCompactionMessagesWithStats as (messages: unknown[]) => {
  text: string;
  stats: { visitedNodes: number; copiedSourceChars: number; peakBufferedChars: number; truncatedValues: number };
};
const prepareConversation = (compaction as any).prepareCompactionConversation as (
  messages: unknown[], previousSummary?: string, runtimeFold?: string,
) => { conversation: string; previousSummary?: string; stats: Record<string, number> };

function emptyCheckpoint(): CompactionCheckpoint {
  return {
    version: 1,
    goal: "Bound compaction work",
    constraints: [], acceptanceCriteria: [], decisions: [], activeFiles: [], changes: [], verification: [],
    failures: [], blockers: [], pendingActions: [], safetyState: [], objectIds: [],
  };
}

describe("RED: compaction CPU and memory are bounded before model invocation", () => {
  test("serializes very large message strings with bounded copying and retained buffers", () => {
    const sharedMegabyte = "x".repeat(1_000_000);
    const messages = Array.from({ length: 200 }, (_, index) => ({
      id: `entry-${index}`,
      role: index === 0 ? "user" : "toolResult",
      content: index === 0 ? `EARLIEST ${sharedMegabyte}` : index === 199 ? `${sharedMegabyte} NEWEST` : sharedMegabyte,
    }));

    const started = performance.now();
    const result = serializeWithStats(messages);
    const elapsedMs = performance.now() - started;

    expect(result.text.length).toBeLessThanOrEqual(compaction.COMPACTION_MAX_CONVERSATION_CHARS);
    expect(result.text).toContain("EARLIEST");
    expect(result.text).toContain("NEWEST");
    expect(result.stats.copiedSourceChars).toBeLessThanOrEqual(5_000_000);
    expect(result.stats.peakBufferedChars).toBeLessThanOrEqual(160_000);
    expect(result.stats.visitedNodes).toBeLessThanOrEqual(2_000);
    expect(result.stats.truncatedValues).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("stops traversing pathological nested arrays after a fixed node budget", () => {
    const content = Array.from({ length: 100_000 }, (_, index) => ({ type: "text", text: `node-${index}` }));
    const result = serializeWithStats([{ id: "large-array", role: "toolResult", content }]);

    expect(result.stats.visitedNodes).toBeLessThanOrEqual(4_096);
    expect(result.stats.truncatedValues).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThanOrEqual(24_000);
  });

  test("reserves traversal budget so pathological early output cannot hide the newest state", () => {
    const pathological = Array.from({ length: 100_000 }, (_, index) => ({ type: "text", text: `old-${index}` }));
    const result = serializeWithStats([
      { id: "old-tool", role: "toolResult", content: pathological },
      { id: "latest-user", role: "user", content: "LATEST-CONTROL-STATE" },
    ]);

    expect(result.text).toContain("LATEST-CONTROL-STATE");
    expect(result.stats.visitedNodes).toBeLessThanOrEqual(4_096);
  });

  test("uses a smaller incremental conversation budget once a previous checkpoint exists", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `entry-${index}`,
      role: "user",
      content: `${index === 0 ? "EARLIEST" : ""}${"x".repeat(20_000)}${index === 19 ? "NEWEST" : ""}`,
    }));
    const first = prepareConversation(messages);
    const incremental = prepareConversation(messages, "# previous checkpoint");

    expect(first.conversation.length).toBeLessThanOrEqual(120_000);
    expect(incremental.conversation.length).toBeLessThanOrEqual(80_000);
    expect(incremental.conversation).toContain("EARLIEST");
    expect(incremental.conversation).toContain("NEWEST");
  });

  test("deduplicates byte-identical active controls before carrying them forward", () => {
    const candidate: any = emptyCheckpoint();
    candidate.constraints = [
      { controlId: "constraint:a", text: "Never delete files", status: "active", sourceEntryIds: ["entry-1"] },
      { controlId: "constraint:b", text: "Never delete files", status: "active", sourceEntryIds: ["entry-1"] },
    ];

    const result = compaction.stabilizeCompactionControlPlane(candidate);
    expect(result.constraints).toHaveLength(1);
  });

  test("fails closed before an unbounded durable control plane can inflate every future prompt", () => {
    const candidate: any = emptyCheckpoint();
    candidate.constraints = Array.from({ length: 200 }, (_, index) => ({
      controlId: `constraint:${index}`,
      text: `Mandatory policy ${index}: ${"x".repeat(400)}`,
      status: "active",
      sourceEntryIds: [`entry-${index}`],
    }));

    expect(() => compaction.stabilizeCompactionControlPlane(candidate)).toThrow(/control.*budget/i);
  });
});
