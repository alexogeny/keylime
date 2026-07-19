import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const handbookModule = new URL("../../extensions/shared/harness-handbook.ts", import.meta.url).href;
const traceModule = new URL("../../extensions/shared/harness-trace-ir.ts", import.meta.url).href;

async function loadHandbookProductionModule(): Promise<any> {
  return import(handbookModule);
}

async function loadTraceProductionModule(): Promise<any> {
  return import(traceModule);
}

describe("RED: the harness is behavior-navigable and source-verifiable", () => {
  test("builds a behavior map over the real Keylime harness", async () => {
    const { buildHarnessHandbook } = await loadHandbookProductionModule();
    const handbook = await buildHarnessHandbook(process.cwd());

    const compaction = handbook.behaviors.find((item: any) => item.id === "structured-compaction");
    expect(compaction).toBeDefined();
    expect(compaction.sourceLocations.map((item: any) => item.path)).toEqual(expect.arrayContaining([
      "extensions/structured-compaction.ts",
      "extensions/shared/compaction-schema.ts",
    ]));
    expect(compaction.sourceLocations.every((item: any) => item.contentHash && item.symbols.length > 0)).toBe(true);
  });

  test("progressive disclosure localizes behavior with fewer tokens than broad source loading", async () => {
    const { buildHarnessHandbook, discloseHarnessBehavior } = await loadHandbookProductionModule();
    const handbook = await buildHarnessHandbook(process.cwd());
    const disclosure = await discloseHarnessBehavior(handbook, "compaction schema validation and fallback", {
      level: "implementation-locators",
      cwd: process.cwd(),
    });
    const broadChars = (await Promise.all([
      "extensions/structured-compaction.ts",
      "extensions/shared/compaction-schema.ts",
      "extensions/context-runtime.ts",
    ].map(path => readFile(resolve(process.cwd(), path), "utf8")))).reduce((sum, text) => sum + text.length, 0);

    expect(disclosure.locations.length).toBeGreaterThan(0);
    expect(disclosure.estimatedTokens * 4).toBeLessThan(broadChars);
    expect(disclosure.locations.every((item: any) => item.verifiedAgainstCurrentSource)).toBe(true);
  });

  test("handbook verification fails closed on stale source hashes", async () => {
    const { buildHarnessHandbook, verifyHarnessHandbook } = await loadHandbookProductionModule();
    const handbook = await buildHarnessHandbook(process.cwd());
    const stale = structuredClone(handbook);
    const location = stale.behaviors.flatMap((item: any) => item.sourceLocations)[0];
    location.contentHash = "stale-content-hash";

    const verification = await verifyHarnessHandbook(stale, process.cwd());
    expect(verification.ok).toBe(false);
    expect(verification.staleLocations).toContainEqual(expect.objectContaining({ path: location.path }));
  });
});

describe("RED: failed trajectories diagnose responsible harness mechanisms", () => {
  const rawTrace = {
    sessionId: "session-1",
    events: [
      { id: "step-1", type: "model_response", handler: "structured-compaction", outputChars: 11_879 },
      {
        id: "step-2",
        type: "parse_failure",
        parentId: "step-1",
        handler: "structured-compaction",
        error: "Unterminated string in JSON",
      },
      {
        id: "step-3",
        type: "fallback",
        parentId: "step-2",
        handler: "structured-compaction",
        outcome: "default-compaction",
      },
    ],
    harnessArtifacts: [
      { path: "extensions/structured-compaction.ts", symbols: ["parseCheckpointText", "createStructuredCompactionHandler"] },
      { path: "extensions/shared/compaction-schema.ts", symbols: ["validateCompactionCheckpoint"] },
      { path: "extensions/danger-guard.ts", symbols: ["codingModeBlockReasonForToolCall"] },
    ],
  };

  test("compiles raw events into explicit control-flow, data-flow, and artifact links", async () => {
    const { compileHarnessTrace } = await loadTraceProductionModule();
    const trace = compileHarnessTrace(rawTrace);

    expect(trace.steps.find((step: any) => step.id === "step-2").controlParents).toContain("step-1");
    expect(trace.steps.find((step: any) => step.id === "step-2").responsibleArtifacts).toContainEqual(
      expect.objectContaining({ path: "extensions/structured-compaction.ts", symbol: "parseCheckpointText" }),
    );
    expect(trace.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "step-1", to: "step-2", kind: "control" }),
      expect.objectContaining({ from: "step-2", to: "step-3", kind: "control" }),
    ]));
  });

  test("attributes the failure to narrow responsible source rather than the entire harness", async () => {
    const { compileHarnessTrace, diagnoseHarnessFailure } = await loadTraceProductionModule();
    const diagnosis = diagnoseHarnessFailure(compileHarnessTrace(rawTrace));

    expect(diagnosis.failureStepIds).toContain("step-2");
    expect(diagnosis.responsibleArtifacts).toEqual([
      expect.objectContaining({ path: "extensions/structured-compaction.ts", symbol: "parseCheckpointText" }),
    ]);
    expect(diagnosis.responsibleArtifacts).not.toContainEqual(expect.objectContaining({ path: "extensions/danger-guard.ts" }));
  });

  test("rejects a broad repair that touches files outside diagnosed artifacts", async () => {
    const { compileHarnessTrace, diagnoseHarnessFailure, evaluateHarnessRepair } = await loadTraceProductionModule();
    const diagnosis = diagnoseHarnessFailure(compileHarnessTrace(rawTrace));
    const result = evaluateHarnessRepair(diagnosis, {
      changedPaths: ["extensions/structured-compaction.ts", "extensions/danger-guard.ts"],
      baseline: { targetedPassed: 20, regressions: 0 },
      candidate: { targetedPassed: 21, regressions: 0 },
    });

    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("change_outside_diagnosed_scope");
  });

  test("rejects a scoped repair when independent regression evidence worsens", async () => {
    const { compileHarnessTrace, diagnoseHarnessFailure, evaluateHarnessRepair } = await loadTraceProductionModule();
    const diagnosis = diagnoseHarnessFailure(compileHarnessTrace(rawTrace));
    const result = evaluateHarnessRepair(diagnosis, {
      changedPaths: ["extensions/structured-compaction.ts"],
      optimizerId: "repair-agent",
      evaluatorId: "independent-evaluator",
      baseline: { targetedPassed: 20, regressions: 0 },
      candidate: { targetedPassed: 21, regressions: 1 },
    });

    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("regression_detected");
  });
});
