import { describe, expect, test } from "bun:test";
import { evaluateTrajectory } from "./helpers/metrics";
import { assertContextReleaseGate } from "./helpers/assertions";
import type { ContextEvalFixture } from "./helpers/trajectory";
import { readFileSync } from "node:fs";
import { estimateRegisteredToolChars, searchToolCatalog } from "../../extensions/shared/tool-catalog";
import { bootstrapToolNames, TOOL_POLICIES } from "../../extensions/shared/tool-policy";
import { reduceToolResultText, bypassGenericToolResultReduction } from "../../extensions/shared/tool-result-reducers";
import { createContextObject, selectContextObjectText } from "../../extensions/shared/context-objects";
import { renderCompactionCheckpoint, validateCompactionCheckpoint, type CompactionCheckpoint } from "../../extensions/shared/compaction-schema";
import { rankCodeRegions, type CodeRegionBudget, type CodeRegionCandidate } from "../../extensions/shared/repo-regions";
import { bindRepositoryState, loadBoundRepositoryState, type RepositoryIdentity } from "../../extensions/shared/repository-identity";
import { codingModeBlockReasonForToolCall } from "../../extensions/danger-guard";
import { buildContextEvalReport } from "./report";

const safeFixture: ContextEvalFixture = {
  id: "tool-result-success",
  category: "tool-results",
  before: "query\nraw output alpha beta gamma\nnext action: inspect",
  after: "query\nsummary alpha beta\nobject://result-1\nnext action: inspect",
  recoverableRemovedChars: 20,
  requiredFacts: ["alpha", "beta", "next action: inspect"],
  safetyInvariants: ["object://result-1"],
  thresholds: { minReductionRate: -0.5, minFactRecall: 1, maxUnrecoverableRemovedChars: 0, maxTrajectoryChars: 200 },
};

const toolSelection = JSON.parse(readFileSync(new URL("./fixtures/tool-selection/cases.json", import.meta.url), "utf8")) as {
  minSchemaReductionRate: number;
  cases: Array<{ query: string; required: string }>;
  forbidden: string[];
};

describe("tool-selection context fixtures", () => {
  const catalog = TOOL_POLICIES.map(policy => ({
    name: policy.name,
    description: policy.name.replace(/_/g, " "),
    parameters: { type: "object", properties: { query: { type: "string" } } },
  }));

  test("deferred bootstrap meets the configured schema reduction floor", () => {
    const allChars = estimateRegisteredToolChars(catalog);
    const bootstrap = new Set(bootstrapToolNames());
    const bootstrapChars = estimateRegisteredToolChars(catalog.filter(tool => bootstrap.has(tool.name)));
    expect(1 - bootstrapChars / allChars).toBeGreaterThanOrEqual(toolSelection.minSchemaReductionRate);
  });

  test("required tools remain discoverable in one bounded catalog query", () => {
    for (const fixture of toolSelection.cases) {
      const matches = searchToolCatalog(catalog, TOOL_POLICIES, fixture.query, 5).map(match => match.name);
      expect(matches).toContain(fixture.required);
    }
  });

  test("forbidden tools remain classified outside the safe loader allowlist", () => {
    for (const name of toolSelection.forbidden) {
      const policy = TOOL_POLICIES.find(candidate => candidate.name === name);
      expect(policy).toBeDefined();
      expect(policy?.risk).not.toBe("safe");
    }
  });
});

describe("typed reducer and exact-recovery fixtures", () => {
  test("retains mandatory diagnostics and exactly recovers the typed section", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/tool-results/failing-test.json", import.meta.url), "utf8")) as {
      toolName: string; content: string; requiredFacts: string[]; maxActiveChars: number;
    };
    const reduced = reduceToolResultText(fixture.toolName, fixture.content, { maxChars: fixture.maxActiveChars });
    for (const fact of fixture.requiredFacts) expect(reduced.activeText).toContain(fact);
    const object = createContextObject({
      id: "fixture-test-run", kind: "test_run", sourceTool: fixture.toolName, content: fixture.content,
      summary: reduced.summary, sections: reduced.sections, retention: "reconstructable",
    });
    const recovered = selectContextObjectText(object, fixture.content, { section: "diagnostics" });
    expect(recovered).toBe(fixture.requiredFacts.map((fact, index) => `${reduced.sections.diagnostics.startLine + index} | ${fact}`).join("\n"));
    expect(bypassGenericToolResultReduction({ toolName: fixture.toolName, isError: true })).toBe(true);
  });
});

describe("compaction continuation fixtures", () => {
  test("retains constraints evidence safety state and the next action", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/compaction/continuation.json", import.meta.url), "utf8")) as {
      checkpoint: CompactionCheckpoint; requiredFacts: string[]; expectedNextAction: string;
    };
    const checkpoint = validateCompactionCheckpoint(fixture.checkpoint);
    const rendered = renderCompactionCheckpoint(checkpoint);
    const evaluation: ContextEvalFixture = {
      id: "compaction-continuation",
      category: "compaction",
      before: JSON.stringify(checkpoint),
      after: rendered,
      recoverableRemovedChars: 0,
      requiredFacts: fixture.requiredFacts,
      safetyInvariants: ["object://blocked-1", "Default Pi compaction remains fallback"],
      nextAction: { expected: fixture.expectedNextAction, actual: checkpoint.pendingActions[0].text },
      thresholds: { minFactRecall: 1, maxUnrecoverableRemovedChars: Number.MAX_SAFE_INTEGER, maxTrajectoryChars: 5000 },
    };
    const metrics = evaluateTrajectory(evaluation);
    expect(metrics.nextActionMatch).toBe(true);
    expect(metrics.requiredFactsRetained).toBe(metrics.requiredFactsTotal);
    expect(() => assertContextReleaseGate(evaluation, metrics)).not.toThrow();
  });
});

describe("repository retrieval quality fixtures", () => {
  test("meets required-region recall and precision under a fixed budget", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/repository-retrieval/gold-regions.json", import.meta.url), "utf8")) as {
      issue: string; budget: CodeRegionBudget; candidates: CodeRegionCandidate[]; requiredRegionIds: string[];
      minimumRecall: number; minimumPrecision: number;
    };
    const ranked = rankCodeRegions(fixture.candidates, fixture.budget);
    const returnedRegionIds = ranked.regions.map(region => `${region.path}:${region.startLine}-${region.endLine}`);
    const evaluation: ContextEvalFixture = {
      id: "gold-auth-regions", category: "repository-retrieval", before: JSON.stringify(fixture.candidates),
      after: JSON.stringify(ranked.regions), recoverableRemovedChars: 0, requiredFacts: [], safetyInvariants: [],
      retrieval: { requiredRegionIds: fixture.requiredRegionIds, returnedRegionIds, totalReturnedRegionIds: returnedRegionIds.length },
      thresholds: { minFactRecall: 1, maxUnrecoverableRemovedChars: Number.MAX_SAFE_INTEGER, maxTrajectoryChars: 1000 },
    };
    const metrics = evaluateTrajectory(evaluation);
    expect(metrics.retrievalRecall).toBeGreaterThanOrEqual(fixture.minimumRecall);
    expect(metrics.retrievalPrecision).toBeGreaterThanOrEqual(fixture.minimumPrecision);
    expect(ranked.metrics.returnedLines).toBeLessThanOrEqual(fixture.budget.maxLines);
    expect(ranked.regions[0].reasons).toEqual(expect.arrayContaining(["declaration_match", "import_neighbor"]));
  });
});

describe("stale-state and end-to-end safety fixtures", () => {
  test("quarantines foreign state and retains blocked-operation evidence", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/stale-state/foreign-and-blocked.json", import.meta.url), "utf8")) as {
      expectedRepository: RepositoryIdentity; foreignRepository: RepositoryIdentity; foreignPayload: Record<string, unknown>;
      blockedTool: { name: string; input: Record<string, unknown> }; requiredDenial: string;
    };
    const foreignEnvelope = bindRepositoryState(fixture.foreignRepository, fixture.foreignPayload, 1);
    const loaded = loadBoundRepositoryState(foreignEnvelope, fixture.expectedRepository, ".pi/project.json");
    expect(loaded.status).toBe("mismatch");
    expect(loaded).not.toHaveProperty("value");

    const denial = codingModeBlockReasonForToolCall(fixture.blockedTool.name, fixture.blockedTool.input);
    expect(denial).toContain(fixture.requiredDenial);
    expect(bypassGenericToolResultReduction({ toolName: fixture.blockedTool.name, isError: true })).toBe(true);
    const safetyEvaluation: ContextEvalFixture = {
      id: "foreign-state-blocked-operation", category: "safety", before: JSON.stringify(foreignEnvelope), after: denial!,
      recoverableRemovedChars: 0, requiredFacts: [fixture.requiredDenial], safetyInvariants: [fixture.requiredDenial],
      thresholds: { minFactRecall: 1, maxUnrecoverableRemovedChars: Number.MAX_SAFE_INTEGER, maxTrajectoryChars: 500 },
    };
    expect(() => assertContextReleaseGate(safetyEvaluation, evaluateTrajectory(safetyEvaluation))).not.toThrow();
  });
});

describe("context evaluation report", () => {
  test("reports category-level size quality recoverability and safety fields", () => {
    const report = buildContextEvalReport();
    expect(report.categories.map(category => category.category)).toEqual(expect.arrayContaining([
      "tool-selection", "tool-results", "compaction", "repository-retrieval", "stale-state", "safety",
    ]));
    for (const category of report.categories) {
      expect(category.beforeChars).toBeGreaterThanOrEqual(0);
      expect(category.afterChars).toBeGreaterThanOrEqual(0);
      expect(category).toHaveProperty("qualityPass");
      expect(category).toHaveProperty("safetyPass");
    }
  });
});

describe("context evaluation fixture contracts", () => {
  test("computes deterministic reduction recoverability quality and safety metrics", () => {
    const metrics = evaluateTrajectory(safeFixture);
    expect(metrics.beforeChars).toBe(safeFixture.before.length);
    expect(metrics.afterChars).toBe(safeFixture.after.length);
    expect(metrics.requiredFactsRetained).toBe(3);
    expect(metrics.requiredFactsTotal).toBe(3);
    expect(metrics.safetyInvariantPass).toBe(true);
    expect(metrics.unrecoverableRemovedChars).toBe(0);
  });

  test("rejects an over-aggressive reducer despite better character reduction", () => {
    const fixture: ContextEvalFixture = {
      ...safeFixture,
      id: "over-aggressive",
      after: "tiny",
      recoverableRemovedChars: 0,
      thresholds: { ...safeFixture.thresholds, minReductionRate: 0.8 },
    };
    expect(() => assertContextReleaseGate(fixture, evaluateTrajectory(fixture))).toThrow("required fact recall");
  });

  test("rejects a verbose but correct trajectory over its category budget", () => {
    const fixture: ContextEvalFixture = {
      ...safeFixture,
      id: "verbose-correct",
      after: `${safeFixture.after}${" padding".repeat(50)}`,
      thresholds: { ...safeFixture.thresholds, maxTrajectoryChars: 100 },
    };
    expect(() => assertContextReleaseGate(fixture, evaluateTrajectory(fixture))).toThrow("trajectory character budget");
  });
});
