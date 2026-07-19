import { describe, expect, test } from "bun:test";
import { evaluateTrajectory } from "./helpers/metrics";
import { assertContextReleaseGate } from "./helpers/assertions";
import type { ContextEvalFixture } from "./helpers/trajectory";
import { readFileSync } from "node:fs";
import { estimateRegisteredToolChars, searchToolCatalog } from "../../extensions/shared/tool-catalog";
import { bootstrapToolNames, TOOL_POLICIES } from "../../extensions/shared/tool-policy";
import { reduceToolResultText, bypassGenericToolResultReduction } from "../../extensions/shared/tool-result-reducers";
import { createContextObject, selectContextObjectText } from "../../extensions/shared/context-objects";

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
