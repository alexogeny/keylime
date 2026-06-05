import { routeSummary, type CapabilityGroup, type IntentRoute } from "./intent";
import { GUARDED_TOOL_NOTES, LOCKED_BUILTIN_TOOLS } from "./tool-policy";

export type PolicyEvidenceSummary = Array<{ id: string; score: number; kind?: string }>;

export type ToolSetStatusSummary = {
  source: string;
  fingerprint: string;
  changed: boolean;
  manualOverride: string | null;
};

export function formatPolicyEvidence(evidence: PolicyEvidenceSummary): string {
  return evidence.map(item => `${item.id}=${item.score.toFixed(2)}`).join(", ") || "none";
}

export function formatActiveTools(tools: string[]): string {
  return tools.filter(Boolean).sort().join(", ");
}

export function formatToolSetStatusLines(status: ToolSetStatusSummary): string[] {
  return [
    `  route source: ${status.source}`,
    `  tool set fingerprint: ${status.fingerprint || "none"}`,
    `  tool set changed this turn: ${status.changed ? "yes" : "no"}`,
    `  manual override: ${status.manualOverride ?? "none"}`,
  ];
}

export function formatLockedToolsLine(label = "locked tools"): string {
  return `  ${label}: ${LOCKED_BUILTIN_TOOLS.join(", ")}; ${GUARDED_TOOL_NOTES.join("; ")}`;
}

export function formatIntentStatusLines(args: {
  route: IntentRoute;
  status: ToolSetStatusSummary;
  researchEnabled: boolean;
  shoesEnabled: boolean;
  policyEvidence: PolicyEvidenceSummary;
  activeTools: string[];
}): string[] {
  return [
    "Intent Router",
    `  ${routeSummary(args.route)}`,
    `  confidence: ${Math.round(args.route.confidence * 100)}%`,
    ...formatToolSetStatusLines(args.status),
    `  research enabled: ${args.researchEnabled ? "yes" : "no"}`,
    `  shoes enabled: ${args.shoesEnabled ? "yes" : "no"}`,
    `  policy evidence: ${formatPolicyEvidence(args.policyEvidence)}`,
    `  active tools: ${formatActiveTools(args.activeTools)}`,
  ];
}

export function formatAgentStatusLines(args: {
  route: IntentRoute;
  activeGroups: CapabilityGroup[];
  status: ToolSetStatusSummary;
  policyEvidence: PolicyEvidenceSummary;
  activeTools: string[];
}): string[] {
  return [
    "Agent Status",
    `  intent: ${args.route.primaryIntent} (${Math.round(args.route.confidence * 100)}%)`,
    ...formatToolSetStatusLines(args.status),
    `  active groups: ${args.activeGroups.join(", ") || "none"}`,
    `  active tools: ${formatActiveTools(args.activeTools)}`,
    formatLockedToolsLine("locked tools"),
    `  policy evidence: ${formatPolicyEvidence(args.policyEvidence)}`,
    "  context: turn-context composer enabled; repo-index injects compact skeleton when available",
    "  tool results: oversized successful results are compacted to .pi/tool-results and retrievable by inspect_tool_result",
  ];
}

export function formatToolPolicyLines(args: {
  alwaysOnTools: string[];
  activeGroups: CapabilityGroup[];
  status: ToolSetStatusSummary;
  policyEvidence: PolicyEvidenceSummary;
  routedTools: string[];
  activeTools: string[];
}): string[] {
  return [
    "Tool Policy",
    `  always-on code tools: ${formatActiveTools(args.alwaysOnTools)}`,
    formatLockedToolsLine("locked built-ins"),
    `  active groups: ${args.activeGroups.join(", ") || "none"}`,
    ...formatToolSetStatusLines(args.status),
    `  policy evidence: ${formatPolicyEvidence(args.policyEvidence)}`,
    `  routed tools: ${formatActiveTools(args.routedTools) || "none"}`,
    `  active tools: ${formatActiveTools(args.activeTools)}`,
  ];
}
