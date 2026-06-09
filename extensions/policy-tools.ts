import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "./shared/schema";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { planCodemod, retrievePolicyEvidence, suggestChecks } from "./shared/policy-actions";
import { classifyToolMutation } from "./shared/safety-policy";
import { TOOL_POLICIES, toolPolicyFor } from "./shared/tool-policy";

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeRelPath(cwd: string, inputPath: string): { abs: string; rel: string } {
  const abs = resolve(cwd, inputPath);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || rel === "") throw new Error(`Path must be inside cwd: ${inputPath}`);
  return { abs, rel };
}

function setJsonPath(target: any, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("json_path must not be empty");
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null) cur[part] = {};
    if (typeof cur[part] !== "object" || Array.isArray(cur[part])) throw new Error(`Cannot create nested key through non-object segment: ${part}`);
    cur = cur[part];
  }
  cur[parts.at(-1)!] = value;
}

function indentBody(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body.split("\n").map(line => line.trim() ? pad + line : line).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`);
}

export default function policyToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description: "Search the local Keylime tool policy catalog without loading every tool schema into context.",
    promptSnippet: "Search available tools",
    promptGuidelines: [
      "Use when you need a capability but are unsure which tool to call.",
      "Keeps prompt pollution low by returning compact tool references; use tool_help for one specific tool.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or tool name to search for" }),
      group: Type.Optional(Type.String({ description: "Optional capability group filter" })),
      risk: Type.Optional(Type.String({ description: "Optional risk filter" })),
      limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
    }),
    async execute(_id, params) {
      const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = TOOL_POLICIES
        .filter(policy => !params.group || policy.group === params.group)
        .filter(policy => !params.risk || policy.risk === params.risk)
        .map(policy => {
          const haystack = [policy.name, policy.name.replace(/_/g, " "), policy.group ?? "", policy.risk, policy.alwaysOn ? "always-on" : "", policy.domain ? "domain" : ""].join(" ").toLowerCase();
          const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) + (policy.name.toLowerCase().includes(params.query.toLowerCase()) ? 2 : 0);
          return { policy, score };
        })
        .filter(item => item.score > 0 || terms.length === 0)
        .sort((a, b) => b.score - a.score || a.policy.name.localeCompare(b.policy.name))
        .slice(0, Math.min(Math.max(1, params.limit ?? 12), 50));
      const results = scored.map(({ policy }) => policy);
      const text = results.length
        ? results.map(policy => `${policy.name} — group=${policy.group ?? "always-on"} risk=${policy.risk}${policy.alwaysOn ? " always_on" : ""}`).join("\n")
        : "No matching tools found.";
      return { content: [{ type: "text", text }], details: { results } };
    },
  });

  pi.registerTool({
    name: "tool_help",
    label: "Tool Help",
    description: "Return compact policy metadata for one known Keylime tool.",
    promptSnippet: "Inspect one tool policy",
    promptGuidelines: ["Use after tool_search when you need one specific tool's routing/risk metadata."],
    parameters: Type.Object({
      name: Type.String({ description: "Tool name" }),
    }),
    async execute(_id, params) {
      const policy = toolPolicyFor(params.name);
      if (!policy) throw new Error(`Unknown tool: ${params.name}`);
      return { content: [{ type: "text", text: formatJson(policy) }], details: { policy } };
    },
  });

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
    name: "codemod_update_json",
    label: "Codemod Update JSON",
    description: "Safely update a JSON value by dot path with dry-run support.",
    promptSnippet: "Update JSON by path",
    promptGuidelines: ["Use for package scripts/config JSON updates; dry-run first for risky edits."],
    parameters: Type.Object({
      path: Type.String({ description: "JSON file path" }),
      json_path: Type.String({ description: "Dot path to update, e.g. scripts.test" }),
      value: Type.Any({ description: "New JSON value" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("apply_code_replacements", { dry_run: params.dry_run, edits: [{ path: params.path }] });
      if (!classification.allowed) throw new Error(`codemod_update_json blocked by safety policy: ${classification.reasons.join(", ")}`);
      const { abs, rel } = safeRelPath(ctx.cwd, params.path);
      const before = await readFile(abs, "utf8");
      const parsed = JSON.parse(before);
      setJsonPath(parsed, params.json_path, params.value);
      const after = `${JSON.stringify(parsed, null, 2)}\n`;
      if (!params.dry_run) await writeFile(abs, after, "utf8");
      return { content: [{ type: "text", text: `${params.dry_run ? "Dry run" : "Updated"} ${rel}: ${params.json_path}` }], details: { path: rel, jsonPath: params.json_path, dryRun: params.dry_run ?? false } };
    },
  });

  pi.registerTool({
    name: "codemod_add_import",
    label: "Codemod Add Import",
    description: "Safely add a named TypeScript/JavaScript import if missing.",
    promptSnippet: "Add import if missing",
    promptGuidelines: ["Use for simple named imports; refuses duplicate imports."],
    parameters: Type.Object({
      path: Type.String({ description: "Source file path" }),
      symbol: Type.String({ description: "Named import symbol" }),
      module: Type.String({ description: "Module specifier" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("apply_code_replacements", { dry_run: params.dry_run, edits: [{ path: params.path }] });
      if (!classification.allowed) throw new Error(`codemod_add_import blocked by safety policy: ${classification.reasons.join(", ")}`);
      const { abs, rel } = safeRelPath(ctx.cwd, params.path);
      const before = await readFile(abs, "utf8");
      const importLine = `import { ${params.symbol} } from "${params.module}";`;
      const duplicatePattern = new RegExp(`import\\s+\\{[^}]*\\b${escapeRegExp(params.symbol)}\\b[^}]*\\}\\s+from\\s+["']${escapeRegExp(params.module)}["']`);
      if (before.includes(importLine) || duplicatePattern.test(before)) {
        throw new Error(`${params.symbol} is already imported from ${params.module}`);
      }
      const after = before.startsWith("import ") ? `${importLine}\n${before}` : `${importLine}\n${before}`;
      if (!params.dry_run) await writeFile(abs, after, "utf8");
      return { content: [{ type: "text", text: `${params.dry_run ? "Dry run" : "Updated"} ${rel}\n${importLine}` }], details: { path: rel, symbol: params.symbol, module: params.module, dryRun: params.dry_run ?? false } };
    },
  });

  pi.registerTool({
    name: "codemod_insert_test_case",
    label: "Codemod Insert Test Case",
    description: "Safely insert a Bun/Jest-style test case into a test file.",
    promptSnippet: "Insert test case",
    promptGuidelines: ["Use for adding focused test cases; dry-run first when unsure."],
    parameters: Type.Object({
      path: Type.String({ description: "Test file path" }),
      describe_name: Type.Optional(Type.String({ description: "Describe block name" })),
      test_name: Type.String({ description: "Test name" }),
      body: Type.String({ description: "Test body statements" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview only" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("apply_code_replacements", { dry_run: params.dry_run, edits: [{ path: params.path }] });
      if (!classification.allowed) throw new Error(`codemod_insert_test_case blocked by safety policy: ${classification.reasons.join(", ")}`);
      const { abs, rel } = safeRelPath(ctx.cwd, params.path);
      const before = await readFile(abs, "utf8");
      const testBlock = `  test("${params.test_name}", () => {\n${indentBody(params.body, 4)}\n  });\n`;
      let after: string;
      if (params.describe_name) {
        const marker = new RegExp(`describe\\(["']${escapeRegExp(params.describe_name)}["'],\\s*\\(\\)\\s*=>\\s*\\{`);
        const match = marker.exec(before);
        if (!match) throw new Error(`describe block not found: ${params.describe_name}`);
        const insertAt = before.lastIndexOf("});");
        after = `${before.slice(0, insertAt)}${testBlock}${before.slice(insertAt)}`;
      } else {
        after = `${before.trimEnd()}\n\n${testBlock}`;
      }
      if (!params.dry_run) await writeFile(abs, after, "utf8");
      return { content: [{ type: "text", text: `${params.dry_run ? "Dry run" : "Updated"} ${rel}\n${testBlock}` }], details: { path: rel, testName: params.test_name, dryRun: params.dry_run ?? false } };
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
