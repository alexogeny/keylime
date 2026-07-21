export function decideCompaction(input: {
  activeContextPercent: number;
  branchInputTotal: number;
  boundary: string;
}) {
  const pressure = input.activeContextPercent >= 80;
  const semanticBoundary = input.boundary !== "none";
  return {
    compact: pressure || semanticBoundary,
    reason: pressure ? "active-context-pressure" : semanticBoundary ? `task-boundary:${input.boundary}` : "not-needed",
  };
}

export function buildHandoffCheckpoint<T extends Record<string, unknown>>(input: T): T {
  return structuredClone(input);
}

function renderCheckpoint(checkpoint: Record<string, unknown>): string {
  const lines = ["# Session handoff"];
  for (const [key, value] of Object.entries(checkpoint)) {
    const title = key.replace(/([a-z])([A-Z])/g, "$1 $2");
    lines.push(`\n## ${title}`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  return lines.join("\n");
}

export function buildSessionBootstrap(input: {
  checkpoint: Record<string, unknown>;
  transcript?: string[];
  maxChars: number;
}): string {
  const rendered = renderCheckpoint(input.checkpoint);
  return rendered.length <= input.maxChars ? rendered : rendered.slice(0, Math.max(0, input.maxChars - 18)) + "\n[handoff clipped]";
}

export function planCompressionRoute(input: {
  mainModel: string;
  availableModels: string[];
  task: string;
  protectedStatePresent: boolean;
}) {
  const sidecarModel = input.availableModels.find(model => model !== input.mainModel && /(?:haiku|mini|small|flash)/i.test(model))
    ?? input.availableModels.find(model => model !== input.mainModel)
    ?? input.mainModel;
  return {
    mainModel: input.mainModel,
    sidecarModel,
    task: input.task,
    validation: { required: input.protectedStatePresent || sidecarModel !== input.mainModel },
  };
}

export function validateHandoffCheckpoint(
  checkpoint: {
    constraints?: Array<{ id?: string }>;
    changes?: Array<{ id?: string }>;
    unresolvedFailures?: Array<{ id?: string }>;
    pendingActions?: unknown[];
  },
  expected: { expectedConstraintIds?: string[]; expectedMutationIds?: string[]; expectedFailureIds?: string[] },
) {
  const presentConstraints = new Set((checkpoint.constraints ?? []).map(item => item.id).filter(Boolean));
  const presentMutations = new Set((checkpoint.changes ?? []).map(item => item.id).filter(Boolean));
  const presentFailures = new Set((checkpoint.unresolvedFailures ?? []).map(item => item.id).filter(Boolean));
  const missing = [
    ...(expected.expectedConstraintIds ?? []).filter(id => !presentConstraints.has(id)),
    ...(expected.expectedMutationIds ?? []).filter(id => !presentMutations.has(id)),
    ...(expected.expectedFailureIds ?? []).filter(id => !presentFailures.has(id)),
  ];
  if ((checkpoint.pendingActions ?? []).length === 0) missing.push("pendingActions");
  return { valid: missing.length === 0, missing };
}

export function decideEconomicCompaction(input: {
  activeContextPercent: number;
  projectedNextTurnCostUsd: number;
  checkpointQuality: number;
  boundary: string;
}) {
  if (input.checkpointQuality < 0.7) return { compact: false, reason: "checkpoint-incomplete" };
  if (input.activeContextPercent >= 80) return { compact: true, reason: "active-context-pressure" };
  if (input.projectedNextTurnCostUsd >= 0.5) return { compact: true, reason: "projected-cost" };
  if (input.boundary !== "none") return { compact: true, reason: `task-boundary:${input.boundary}` };
  return { compact: false, reason: "not-needed" };
}

export function buildHandoffCommandPlan(input: { goal: string; pendingActions: string[]; sessionId: string }) {
  const checkpoint = { id: `${input.sessionId}:handoff`, goal: input.goal, pendingActions: [...input.pendingActions] };
  return {
    entries: [{ customType: "token-efficiency-handoff", data: checkpoint }],
    bootstrap: buildSessionBootstrap({ checkpoint, maxChars: 2_000 }),
    openNewSession: true,
  };
}

export function planSessionBootstrapInjection(input: { destinationSessionId: string; consumedCheckpointIds: string[]; checkpoint: { id: string; goal?: string; bootstrap?: string } }) {
  if (input.consumedCheckpointIds.includes(input.checkpoint.id)) return { inject: false, reason: "already-consumed" };
  return { inject: true, markConsumed: input.checkpoint.id, bootstrap: input.checkpoint.bootstrap ?? buildSessionBootstrap({ checkpoint: input.checkpoint, maxChars: 2_000 }) };
}

export function validateSidecarCompression(input: { sourceIds: string[]; compressed: { retainedSourceIds: string[]; text: string } }) {
  const retained = new Set(input.compressed.retainedSourceIds);
  const missingSourceIds = input.sourceIds.filter(id => !retained.has(id));
  return { valid: missingSourceIds.length === 0, missingSourceIds, useFallback: missingSourceIds.length > 0 };
}

export async function completeSidecarCompression(input: {
  mainModel: string;
  sidecarModel: string;
  sourceIds: string[];
  sidecarResult: { retainedSourceIds: string[]; text: string };
  deterministicFallback: { retainedSourceIds: string[]; text: string };
}) {
  const validation = validateSidecarCompression({ sourceIds: input.sourceIds, compressed: input.sidecarResult });
  const selected = validation.valid ? input.sidecarResult : input.deterministicFallback;
  return {
    mainModelBefore: input.mainModel,
    mainModelAfter: input.mainModel,
    sidecarModel: input.sidecarModel,
    source: validation.valid ? "sidecar" : "deterministic-fallback",
    text: selected.text,
    retainedSourceIds: selected.retainedSourceIds,
  };
}
