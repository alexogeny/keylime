import { describe, expect, test } from "bun:test";
import { selectEvidencePacketsWithStats, type EvidenceCandidate, type EvidenceIntent } from "../../extensions/shared/evidence-packets";
import { productionModule } from "./helpers";

const intent: EvidenceIntent = {
  objective: "fix parser timeout",
  symbols: ["parseCheckpoint"],
  paths: ["src/parser.ts"],
  failure: "timeout",
  pendingStep: "edit parser and run tests",
};
const candidates: EvidenceCandidate[] = [
  { id: "target", path: "src/parser.ts", startLine: 10, endLine: 20, text: "function parseCheckpoint() { /* timeout */ }", lexical: .9, semantic: .9, graph: .8, recency: .7, symbols: ["parseCheckpoint"], objectId: "target-object", representation: "exact_source" },
  { id: "duplicate", path: "src/copy.ts", startLine: 10, endLine: 20, text: "function parseCheckpoint() { /* timeout */ }", lexical: .8, semantic: .8, graph: .5, recency: .4, symbols: ["parseCheckpoint"], objectId: "duplicate-object", representation: "exact_source" },
  { id: "test", path: "tests/parser.test.ts", startLine: 1, endLine: 8, text: "test parser timeout", lexical: .7, semantic: .7, graph: .9, recency: .8, symbols: [], objectId: "test-object", representation: "exact_source" },
  { id: "noise", path: "docs/readme.md", startLine: 1, endLine: 5, text: "unrelated documentation", lexical: .1, semantic: .1, graph: .1, recency: 1, symbols: [], objectId: "noise-object", representation: "summary" },
];

function selection(maxTokens = 500, maxPackets = 2) {
  return selectEvidencePacketsWithStats(intent, candidates, { maxTokens, maxPackets, maxFiles: 3 });
}

describe("RED: causal context debugger", () => {
  test("explains every score component and the final inclusion decision", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const result = selection();
    const explanation = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...result });
    const target = explanation.candidates.find((item: any) => item.id === "target");
    expect(target.decision).toBe("included");
    expect(target.scoreComponents).toEqual(expect.objectContaining({ lexical: expect.anything(), semantic: expect.anything(), graph: expect.anything(), exactness: expect.anything() }));
    expect(target.totalScore).toBeCloseTo(Object.values(target.scoreComponents).reduce((sum: number, value: any) => sum + value, 0), 6);
  });

  test("distinguishes low relevance, duplicate, overlap, file-limit, and token-limit exclusions", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const explanation = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...selection() });
    expect(explanation.candidates.find((item: any) => item.id === "duplicate").reason).toMatch(/duplicate|overlap/i);
    expect(explanation.candidates.find((item: any) => item.id === "noise").reason).toMatch(/relevance|packet|budget/i);
  });

  test("identifies which selected packet displaced an excluded candidate", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const explanation = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 1, maxFiles: 3 }, ...selection(500, 1) });
    const excluded = explanation.candidates.find((item: any) => item.id === "test");
    expect(excluded.displacedBy).toBe("target");
    expect(excluded.reason).toMatch(/packet.*limit|displaced/i);
  });

  test("runs token counterfactuals without invoking a model", async () => {
    const { counterfactualContext } = await productionModule("context-debugger");
    const counterfactual = counterfactualContext({ intent, candidates, currentBudget: { maxTokens: 100, maxPackets: 2, maxFiles: 3 }, tokenDeltas: [0, 100, 400] });
    expect(counterfactual.modelCalls).toBe(0);
    expect(counterfactual.scenarios).toHaveLength(3);
    expect(counterfactual.scenarios[2].selectedIds).toEqual(expect.arrayContaining(["target", "test"]));
  });

  test("explains mandatory safety evidence as non-evictable", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const mandatory = { ...candidates[3], id: "policy", text: "Never execute destructive commands", mandatory: true, category: "safety" } as any;
    const result = explainContextSelection({ intent, candidates: [...candidates, mandatory], budget: { maxTokens: 50, maxPackets: 1, maxFiles: 1 }, packets: [], stats: {} });
    expect(result.candidates.find((item: any) => item.id === "policy").decision).toBe("mandatory");
    expect(result.candidates.find((item: any) => item.id === "policy").evictable).toBe(false);
  });

  test("links explanations to recovery objects without embedding hydrated payloads", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const explanation = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...selection() });
    const target = explanation.candidates.find((item: any) => item.id === "target");
    expect(target.objectId).toBe("target-object");
    expect(JSON.stringify(explanation)).not.toContain("function parseCheckpoint");
  });

  test("produces deterministic explanations under candidate reordering", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const firstSelection = selection();
    const reversed = [...candidates].reverse();
    const secondSelection = selectEvidencePacketsWithStats(intent, reversed, { maxTokens: 500, maxPackets: 2, maxFiles: 3 });
    const first = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...firstSelection });
    const second = explainContextSelection({ intent, candidates: reversed, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...secondSelection });
    expect(first).toEqual(second);
  });

  test("renders a bounded TUI-ready summary", async () => {
    const { explainContextSelection, renderContextDebugSummary } = await productionModule("context-debugger");
    const explanation = explainContextSelection({ intent, candidates, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3 }, ...selection() });
    const rendered = renderContextDebugSummary(explanation, { width: 80, maxRows: 20 });
    expect(rendered).toContain("target");
    expect(rendered.split("\n").length).toBeLessThanOrEqual(20);
    expect(rendered.split("\n").every((line: string) => line.length <= 80)).toBe(true);
  });

  test("keeps explanation work linear in admitted candidates", async () => {
    const { explainContextSelection } = await productionModule("context-debugger");
    const many = Array.from({ length: 10_000 }, (_, index) => ({ ...candidates[3], id: `noise-${index}`, objectId: `object-${index}` }));
    const selected = selectEvidencePacketsWithStats(intent, many, { maxTokens: 500, maxPackets: 2, maxFiles: 3, maxCandidatesEvaluated: 2_000 });
    const explanation = explainContextSelection({ intent, candidates: many, budget: { maxTokens: 500, maxPackets: 2, maxFiles: 3, maxCandidatesEvaluated: 2_000 }, ...selected });
    expect(explanation.stats.candidatesExplained).toBeLessThanOrEqual(2_000);
    expect(explanation.stats.scoreEvaluations).toBeLessThanOrEqual(2_000);
  });
});
