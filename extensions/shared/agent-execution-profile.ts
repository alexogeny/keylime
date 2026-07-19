export type AgentTaskKind = "structured_extraction" | "deterministic_validation" | "cross_module_debugging" | string;
export type AgentExecutionRequest = {
  taskKind: AgentTaskKind;
  ambiguity: number;
  risk: "low" | "medium" | "high";
  contextPressure: number;
  requiresCreativity: boolean;
};
export type AgentExecutionProfile = {
  execution: "local_code" | "model";
  modelTier: "none" | "efficient" | "capable";
  reasoning: "off" | "low" | "medium" | "high";
  maxOutputTokens: number;
  timeoutMs: number;
  rationale: string[];
};

function unit(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }

export function selectAgentExecutionProfile(request: AgentExecutionRequest): AgentExecutionProfile {
  const ambiguity = unit(request.ambiguity);
  const pressure = unit(request.contextPressure);
  if (request.taskKind === "deterministic_validation") {
    return {
      execution: "local_code",
      modelTier: "none",
      reasoning: "off",
      maxOutputTokens: 0,
      timeoutMs: 10_000,
      rationale: ["deterministic_validation is enforced by local code", "model tokens cannot improve a deterministic gate"],
    };
  }
  if (request.taskKind === "structured_extraction") {
    return {
      execution: "model",
      modelTier: "efficient",
      reasoning: "off",
      maxOutputTokens: pressure >= .85 ? 3_072 : 4_096,
      timeoutMs: pressure >= .85 ? 45_000 : 60_000,
      rationale: ["structured_extraction uses an efficient model", "bounded output and latency protect the context budget"],
    };
  }
  const capable = request.requiresCreativity || ambiguity >= .7 || request.risk === "high";
  return {
    execution: "model",
    modelTier: capable ? "capable" : "efficient",
    reasoning: capable ? (ambiguity >= .9 ? "high" : "medium") : "low",
    maxOutputTokens: pressure >= .85 ? 4_096 : capable ? 8_192 : 4_096,
    timeoutMs: capable ? 120_000 : 60_000,
    rationale: [
      `${request.taskKind} routed with ambiguity ${ambiguity.toFixed(2)}`,
      capable ? "capable reasoning is justified by ambiguity, creativity, or risk" : "efficient reasoning is sufficient",
    ],
  };
}
