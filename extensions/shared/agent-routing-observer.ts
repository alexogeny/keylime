import { selectAgentExecutionProfile } from "./agent-execution-profile";

export type AgentRoutingObservation = {
  taskId: string;
  taskKind: string;
  recommended: ReturnType<typeof selectAgentExecutionProfile>;
  actual: { provider?: string; model?: string; thinking?: string };
  applied: boolean;
  outcome?: string;
  successfulTaskCostUsd?: number;
  modelCalls?: number;
  settledAt?: number;
};

const KNOWN_TASK_KINDS = new Set(["structured_extraction", "deterministic_validation", "cross_module_debugging", "debugging", "coding", "research", "review"]);

function boundedId(value: unknown): string {
  return String(value ?? "").replace(/[^a-zA-Z0-9._:@-]/g, "_").slice(0, 200);
}

function taskKind(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return KNOWN_TASK_KINDS.has(normalized) ? normalized : "other";
}

export function createAgentRoutingObserver(options: { mode?: "observe-only"; maxRecords?: number } = {}) {
  const maxRecords = Math.max(1, Math.min(10_000, Math.floor(options.maxRecords ?? 1_000)));
  const records: AgentRoutingObservation[] = [];

  return {
    observe(input: any): AgentRoutingObservation {
      const kind = taskKind(input.taskKind);
      const recommended = selectAgentExecutionProfile({
        taskKind: kind,
        ambiguity: Number(input.ambiguity ?? 0),
        risk: ["low", "medium", "high"].includes(input.risk) ? input.risk : "medium",
        contextPressure: Number(input.contextPressure ?? 0),
        requiresCreativity: Boolean(input.requiresCreativity),
      });
      const record: AgentRoutingObservation = {
        taskId: boundedId(input.taskId),
        taskKind: kind,
        recommended,
        actual: {
          provider: input.actual?.provider ? boundedId(input.actual.provider) : undefined,
          model: input.actual?.model ? boundedId(input.actual.model) : undefined,
          thinking: input.actual?.thinking ? boundedId(input.actual.thinking) : undefined,
        },
        applied: false,
      };
      records.push(record);
      if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
      return structuredClone(record);
    },

    attachOutcome(taskId: string, outcome: any): AgentRoutingObservation {
      const id = boundedId(taskId);
      const record = [...records].reverse().find(item => item.taskId === id);
      if (!record) throw new Error(`Unknown routing task: ${id}`);
      record.outcome = String(outcome?.outcome ?? "unknown").slice(0, 100);
      record.successfulTaskCostUsd = record.outcome === "verified" || record.outcome === "read_only_complete"
        ? Number(outcome?.usage?.costUsd ?? 0)
        : undefined;
      record.modelCalls = Math.max(0, Math.floor(Number(outcome?.usage?.modelCalls ?? 0)));
      record.settledAt = Math.max(0, Math.floor(Number(outcome?.settledAt ?? 0)));
      return structuredClone(record);
    },

    snapshot(): AgentRoutingObservation[] {
      return records.map(record => structuredClone(record));
    },
  };
}
