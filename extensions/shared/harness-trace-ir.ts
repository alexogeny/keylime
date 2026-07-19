export type RawHarnessEvent = {
  id: string;
  type: string;
  parentId?: string;
  handler?: string;
  error?: string;
  [key: string]: unknown;
};
export type HarnessArtifact = { path: string; symbols: string[] };
export type HarnessArtifactRef = { path: string; symbol?: string };
export type HarnessTraceStep = RawHarnessEvent & { controlParents: string[]; responsibleArtifacts: HarnessArtifactRef[] };
export type HarnessTraceEdge = { from: string; to: string; kind: "control" | "data" };
export type HarnessTraceIR = { sessionId: string; steps: HarnessTraceStep[]; edges: HarnessTraceEdge[] };
export type HarnessFailureDiagnosis = {
  failureStepIds: string[];
  responsibleArtifacts: HarnessArtifactRef[];
  allowedPaths: string[];
};

function symbolFor(event: RawHarnessEvent, artifact: HarnessArtifact): string | undefined {
  const preferred = event.type === "parse_failure" ? "parseCheckpointText"
    : event.type.includes("validation") ? "validateCompactionCheckpoint"
    : undefined;
  if (preferred && artifact.symbols.includes(preferred)) return preferred;
  return artifact.symbols[0];
}

function relevantArtifacts(event: RawHarnessEvent, artifacts: HarnessArtifact[]): HarnessArtifactRef[] {
  if (!event.handler) return [];
  const handler = event.handler.toLowerCase().replace(/_/g, "-");
  return artifacts
    .filter(artifact => artifact.path.toLowerCase().includes(handler))
    .map(artifact => ({ path: artifact.path, symbol: symbolFor(event, artifact) }));
}

function uniqueArtifacts(items: HarnessArtifactRef[]): HarnessArtifactRef[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.path}:${item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compileHarnessTrace(input: {
  sessionId: string;
  events: RawHarnessEvent[];
  harnessArtifacts: HarnessArtifact[];
}): HarnessTraceIR {
  const ids = new Set(input.events.map(event => event.id));
  const steps = input.events.map(event => ({
    ...event,
    controlParents: event.parentId && ids.has(event.parentId) ? [event.parentId] : [],
    responsibleArtifacts: relevantArtifacts(event, input.harnessArtifacts),
  }));
  const edges = steps.flatMap(step => step.controlParents.map(parent => ({ from: parent, to: step.id, kind: "control" as const })));
  return { sessionId: input.sessionId, steps, edges };
}

export function diagnoseHarnessFailure(trace: HarnessTraceIR): HarnessFailureDiagnosis {
  const failures = trace.steps.filter(step => /failure|error/i.test(step.type) || typeof step.error === "string");
  const responsibleArtifacts = uniqueArtifacts(failures.flatMap(step => step.responsibleArtifacts));
  return {
    failureStepIds: failures.map(step => step.id),
    responsibleArtifacts,
    allowedPaths: [...new Set(responsibleArtifacts.map(item => item.path))],
  };
}

export function evaluateHarnessRepair(
  diagnosis: HarnessFailureDiagnosis,
  repair: {
    changedPaths: string[];
    optimizerId?: string;
    evaluatorId?: string;
    baseline: { targetedPassed: number; regressions: number };
    candidate: { targetedPassed: number; regressions: number };
  },
): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (repair.changedPaths.some(path => !diagnosis.allowedPaths.includes(path))) reasons.push("change_outside_diagnosed_scope");
  if (repair.optimizerId && repair.optimizerId === repair.evaluatorId) reasons.push("evaluator_not_independent");
  if (repair.candidate.targetedPassed < repair.baseline.targetedPassed) reasons.push("targeted_regression");
  if (repair.candidate.regressions > repair.baseline.regressions) reasons.push("regression_detected");
  return { accepted: reasons.length === 0, reasons };
}
