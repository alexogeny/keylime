export type TaskOutcome =
  | "verified"
  | "failed_verification"
  | "unverified_mutation"
  | "read_only_complete"
  | "blocked"
  | "unknown";

export type TaskVerification = {
  command: string;
  passed: boolean;
  diagnosticPaths?: string[];
};

export type SettledTaskOutcome = {
  version: 1;
  taskId: string;
  repositoryFingerprint: string;
  startedAt: number;
  settledAt: number;
  durationMs: number;
  outcome: TaskOutcome;
  changedPaths: string[];
  verification: TaskVerification[];
  recoveredFailures: number;
  blockedCalls: number;
  evidenceObjects: number;
  toolCalls: number;
  assistantMessages: number;
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
};

type TrackerOptions = {
  taskId: string;
  repositoryFingerprint: string;
  startedAt?: number;
};

type ToolResult = {
  toolName?: string;
  isError?: boolean;
  blocked?: boolean;
  changedPaths?: unknown[];
  evidenceObjectIds?: unknown[];
  verification?: Array<{
    command?: unknown;
    passed?: unknown;
    diagnosticPaths?: unknown[];
  }>;
};

const MAX_PATHS = 1_000;
const MAX_VERIFICATION = 100;
const MAX_COMMAND_CHARS = 500;

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function safeRelativePath(value: unknown): string | undefined {
  const path = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return;
  if (path === ".." || path.startsWith("../") || path.includes("/../")) return;
  return path.slice(0, 500);
}

function boundedPaths(values: unknown[] | undefined, max = MAX_PATHS): string[] {
  const paths = new Set<string>();
  for (const value of values ?? []) {
    const path = safeRelativePath(value);
    if (path) paths.add(path);
    if (paths.size >= max) break;
  }
  return [...paths].sort();
}

function boundedVerification(values: ToolResult["verification"]): TaskVerification[] {
  const result: TaskVerification[] = [];
  for (const item of values ?? []) {
    if (result.length >= MAX_VERIFICATION) break;
    result.push({
      command: String(item?.command ?? "unknown verification").slice(0, MAX_COMMAND_CHARS),
      passed: item?.passed === true,
      diagnosticPaths: boundedPaths(item?.diagnosticPaths, 100),
    });
  }
  return result;
}

export function createTaskOutcomeTracker(options: TrackerOptions) {
  const taskId = String(options.taskId ?? "").slice(0, 200);
  const repositoryFingerprint = String(options.repositoryFingerprint ?? "").slice(0, 128);
  const startedAt = finiteNonNegative(options.startedAt ?? Date.now());
  const changedPaths = new Set<string>();
  const verification: TaskVerification[] = [];
  const verificationBatches: TaskVerification[][] = [];
  const evidenceObjectIds = new Set<string>();
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  let blockedCalls = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  let settled = false;

  return {
    recordToolCall(_input: { toolName?: string; input?: unknown }) {
      if (settled) throw new Error("Task outcome is already settled");
      toolCalls++;
    },

    recordToolResult(input: ToolResult) {
      if (settled) throw new Error("Task outcome is already settled");
      if (input.blocked) blockedCalls++;
      for (const path of boundedPaths(input.changedPaths)) {
        if (changedPaths.size >= MAX_PATHS) break;
        changedPaths.add(path);
      }
      for (const id of input.evidenceObjectIds ?? []) {
        if (evidenceObjectIds.size >= 1_000) break;
        evidenceObjectIds.add(String(id).slice(0, 200));
      }
      const batch = boundedVerification(input.verification);
      if (batch.length) {
        verificationBatches.push(batch);
        for (const item of batch) {
          if (verification.length >= MAX_VERIFICATION) break;
          verification.push(item);
        }
      }
    },

    recordUsage(input: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }) {
      if (settled) throw new Error("Task outcome is already settled");
      usage.modelCalls++;
      usage.inputTokens += finiteNonNegative(input.inputTokens);
      usage.outputTokens += finiteNonNegative(input.outputTokens);
      usage.cacheReadTokens += finiteNonNegative(input.cacheReadTokens);
      usage.cacheWriteTokens += finiteNonNegative(input.cacheWriteTokens);
      usage.costUsd = rounded(usage.costUsd + finiteNonNegative(input.costUsd));
    },

    recordAssistantMessage(_input: { text?: string }) {
      if (settled) throw new Error("Task outcome is already settled");
      assistantMessages++;
    },

    settle(input: { settledAt?: number } = {}): SettledTaskOutcome {
      if (settled) throw new Error("Task outcome is already settled");
      settled = true;
      const settledAt = finiteNonNegative(input.settledAt ?? Date.now());
      const finalVerification = verificationBatches.at(-1) ?? [];
      const finalVerificationPassed = finalVerification.length > 0 && finalVerification.every(item => item.passed);
      const finalVerificationFailed = finalVerification.some(item => !item.passed);
      const recoveredFailures = finalVerificationPassed
        ? verificationBatches.slice(0, -1).filter(batch => batch.some(item => !item.passed)).length
        : 0;
      let outcome: TaskOutcome;
      if (blockedCalls > 0 && changedPaths.size === 0) outcome = "blocked";
      else if (changedPaths.size > 0 && finalVerificationFailed) outcome = "failed_verification";
      else if (changedPaths.size > 0 && finalVerificationPassed) outcome = "verified";
      else if (changedPaths.size > 0) outcome = "unverified_mutation";
      else outcome = "read_only_complete";

      return {
        version: 1,
        taskId,
        repositoryFingerprint,
        startedAt,
        settledAt,
        durationMs: Math.max(0, settledAt - startedAt),
        outcome,
        changedPaths: [...changedPaths].sort(),
        verification: verification.map(item => ({ ...item, diagnosticPaths: [...(item.diagnosticPaths ?? [])] })),
        recoveredFailures,
        blockedCalls,
        evidenceObjects: evidenceObjectIds.size,
        toolCalls,
        assistantMessages,
        usage: { ...usage },
      };
    },
  };
}
