export type ReportedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
};

export type NormalizedSpend = {
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
};

function reported(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUsage(usage: ReportedUsage): NormalizedSpend {
  return {
    uncachedInputTokens: reported(usage.input),
    cacheReadTokens: reported(usage.cacheRead),
    cacheWriteTokens: reported(usage.cacheWrite),
    outputTokens: reported(usage.output),
    reasoningTokens: reported(usage.reasoning),
    costUsd: reported(usage.cost),
  };
}

export function buildSpendSnapshot(input: {
  activeContext: { chars: number; tokens?: number; percent?: number };
  currentTurn: ReportedUsage;
  branchTotals: ReportedUsage;
}) {
  return {
    activeContext: {
      chars: input.activeContext.chars,
      tokens: reported(input.activeContext.tokens),
      percent: reported(input.activeContext.percent),
    },
    currentTurn: normalizeUsage(input.currentTurn),
    branchTotals: normalizeUsage(input.branchTotals),
  };
}

export function aggregateTaskSpend(calls: Array<ReportedUsage & { purpose: string; succeeded?: boolean }>) {
  const costs = calls.map(call => reported(call.cost)).filter((value): value is number => value !== null);
  const auxiliaryCosts = calls
    .filter(call => call.purpose !== "main")
    .map(call => reported(call.cost))
    .filter((value): value is number => value !== null);
  return {
    totalCostUsd: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null,
    auxiliaryCostUsd: auxiliaryCosts.length > 0 ? auxiliaryCosts.reduce((sum, value) => sum + value, 0) : 0,
    modelCalls: calls.length,
    successfulCalls: calls.filter(call => call.succeeded !== false).length,
  };
}

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "?";
  if (Math.abs(value) >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (Math.abs(value) >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

export function buildSpendDisplay(snapshot: {
  activeContext: { tokens: number | null; percent?: number | null };
  currentTurn: Pick<NormalizedSpend, "uncachedInputTokens" | "cacheReadTokens" | "outputTokens" | "costUsd">;
  branchTotals: Pick<NormalizedSpend, "uncachedInputTokens" | "outputTokens" | "costUsd">;
}): string {
  const percent = snapshot.activeContext.percent == null ? "" : `/${snapshot.activeContext.percent}%`;
  return [
    `ctx ${compactNumber(snapshot.activeContext.tokens)}${percent}`,
    `turn uncached ${compactNumber(snapshot.currentTurn.uncachedInputTokens)} cached ${compactNumber(snapshot.currentTurn.cacheReadTokens)} out ${compactNumber(snapshot.currentTurn.outputTokens)}`,
    `branch in ${compactNumber(snapshot.branchTotals.uncachedInputTokens)} out ${compactNumber(snapshot.branchTotals.outputTokens)}`,
  ].join(" • ");
}
