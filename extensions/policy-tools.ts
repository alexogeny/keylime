import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { planCodemod, retrievePolicyEvidence, suggestChecks } from "./shared/policy-actions";

function stringEnum<const T extends readonly string[]>(values: T, options?: Record<string, unknown>) {
  return Type.Union(values.map(value => Type.Literal(value)), options);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function policyToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "retrieve_policy",
    label: "Retrieve Policy",
    description: "Retrieve local routing, mutation, codemod, check, context, or recall policy corpus entries.",
    promptSnippet: "Retrieve local agent policy/corpus docs",
    promptGuidelines: [
      "Use to explain routing/safety/check/codemod evidence without injecting the whole corpus.",
      "Retrieved policy is advisory; hard safety enforcement still lives in guard tools and shared policy code.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      kind: Type.Optional(stringEnum(["routing", "mutation", "codemod", "check", "context", "recall"] as const)),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Changed or relevant paths for path-aware boosting" })),
      top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Maximum policy docs" })),
    }),
    async execute(_id, params) {
      const results = retrievePolicyEvidence({ query: params.query, kind: params.kind as any, paths: params.paths, topK: params.top_k });
      return { content: [{ type: "text", text: formatJson({ results }) }], details: { results } };
    },
  });

  pi.registerTool({
    name: "suggest_checks",
    label: "Suggest Checks",
    description: "Suggest targeted verification commands from the local policy corpus for a task and changed paths.",
    promptSnippet: "Suggest targeted tests/checks",
    promptGuidelines: [
      "Use before run_checks when touched paths make targeted verification unclear.",
      "Report exactly which commands were suggested; run them with run_checks if verification is needed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Task, failure, or verification need" }),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Changed or relevant paths" })),
      top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "Maximum recipes" })),
    }),
    async execute(_id, params) {
      const suggestions = suggestChecks(params.query, params.paths ?? [], params.top_k ?? 3);
      return { content: [{ type: "text", text: formatJson({ suggestions }) }], details: { suggestions } };
    },
  });

  pi.registerTool({
    name: "codemod_plan",
    label: "Codemod Plan",
    description: "Select an advisory high-level codemod primitive and safe tool/check plan from the local policy corpus.",
    promptSnippet: "Plan a high-level codemod",
    promptGuidelines: [
      "Use before broad refactors or repetitive edits to choose the safest primitive and verification path.",
      "This plans only; actual mutations must still use inspect/plan/apply/create tools.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Desired code transformation" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Candidate files or paths" })),
    }),
    async execute(_id, params) {
      const plan = planCodemod(params.goal, params.files ?? []);
      return { content: [{ type: "text", text: formatJson(plan) }], details: plan };
    },
  });
}
