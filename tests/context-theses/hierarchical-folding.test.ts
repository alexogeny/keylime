import { describe, expect, test } from "bun:test";
import { loadThesisModule, thesisFunction } from "./helpers";

type Event = { id: string; subtask: string; type: "action" | "evidence" | "decision" | "failure" | "verification" | "constraint" | "safety"; text: string; objectIds?: string[]; resolved?: boolean };
type Fold = { id: string; level: "granular" | "deep"; subtask: string; goal: string; outcome: string; facts: string[]; failures: string[]; pending: string[]; objectIds: string[]; sourceEventIds: string[] };

const events: Event[] = [
  { id: "e1", subtask: "investigate", type: "constraint", text: "do not change public API" },
  { id: "e2", subtask: "investigate", type: "action", text: "searched cache implementation" },
  { id: "e3", subtask: "investigate", type: "evidence", text: "prefix is keyed without model id", objectIds: ["ctx-code"] },
  { id: "e4", subtask: "implement", type: "decision", text: "include model id in cache key" },
  { id: "e5", subtask: "implement", type: "failure", text: "cache test still fails", objectIds: ["ctx-fail"] },
  { id: "e6", subtask: "implement", type: "verification", text: "cache test passes", resolved: true, objectIds: ["ctx-pass"] },
  { id: "e7", subtask: "release", type: "safety", text: "production push not approved" },
];

async function fold(level: "granular" | "deep", input = events, options: Record<string, unknown> = {}): Promise<Fold> {
  const api = await loadThesisModule("hierarchical-folding");
  const fn = thesisFunction<(events: Event[], options: Record<string, unknown>) => Fold>(api, "foldTrajectory");
  return fn(input, { level, completedSubtasks: ["investigate"], activeSubtask: "implement", ...options });
}

describe("Context thesis: proactive hierarchical context folding", () => {
  test("granular folds retain exact fine-grained evidence", async () => {
    const result = await fold("granular", events.slice(0, 3));
    expect(result.facts).toContain("prefix is keyed without model id");
    expect(result.objectIds).toContain("ctx-code");
  });

  test("deep folds collapse completed subtasks into goal and outcome", async () => {
    const result = await fold("deep", events.slice(0, 3));
    expect(result.level).toBe("deep");
    expect(result.goal).toBeTruthy();
    expect(result.outcome).toContain("prefix");
    expect(result.sourceEventIds).toEqual(["e1", "e2", "e3"]);
  });

  test("preserves unresolved failures", async () => {
    expect((await fold("deep")).failures).toContain("cache test still fails");
  });

  test("marks resolved failures without erasing their diagnostic evidence", async () => {
    const result = await fold("deep");
    expect(result.objectIds).toContain("ctx-fail");
    expect(result.objectIds).toContain("ctx-pass");
  });

  test("preserves constraints and safety decisions across deep folds", async () => {
    const result = await fold("deep");
    expect(result.facts).toContain("do not change public API");
    expect(result.facts).toContain("production push not approved");
  });

  test("does not deep-fold the active incomplete subtask", async () => {
    const result = await fold("deep", events, { completedSubtasks: ["investigate"], activeSubtask: "implement" });
    expect(result.pending).toContain("include model id in cache key");
  });

  test("uses immutable source event ids for auditability", async () => {
    const result = await fold("deep");
    expect(new Set(result.sourceEventIds).size).toBe(result.sourceEventIds.length);
    expect(result.sourceEventIds.every(id => /^e\d+$/.test(id))).toBe(true);
  });

  test("produces stable deltas instead of recursively summarizing prior prose", async () => {
    const first = await fold("deep", events.slice(0, 3));
    const second = await fold("deep", events.slice(0, 3));
    expect(second).toEqual(first);
    expect(second.sourceEventIds).toEqual(events.slice(0, 3).map(event => event.id));
  });

  test("recommends a fold at semantic boundaries before pressure thresholds", async () => {
    const api = await loadThesisModule("hierarchical-folding");
    const shouldFold = thesisFunction<(event: { kind: string; contextPercent: number }) => boolean>(api, "shouldFoldTrajectory");
    expect(shouldFold({ kind: "subtask_completed", contextPercent: 30 })).toBe(true);
    expect(shouldFold({ kind: "file_switched", contextPercent: 40 })).toBe(true);
    expect(shouldFold({ kind: "ordinary_turn", contextPercent: 40 })).toBe(false);
    expect(shouldFold({ kind: "ordinary_turn", contextPercent: 86 })).toBe(true);
  });
});
