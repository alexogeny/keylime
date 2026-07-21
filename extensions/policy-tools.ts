import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "./shared/schema";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { planCodemod, retrievePolicyEvidence, suggestChecks } from "./shared/policy-actions";
import { classifyToolMutation } from "./shared/safety-policy";
import { LOCKED_BUILTIN_TOOLS, TOOL_POLICIES, toolPolicyFor } from "./shared/tool-policy";
import { resolveSafeExistingPath } from "./shared/path-policy";
import { researchEnabled } from "./shared/research-config";
import { recordDiscoveredToolsForTurn, searchToolCatalog, toolPolicyLoadAllowed } from "./shared/tool-catalog";
import { getCurrentOperationalMode } from "./operational-modes";
import { readHarnessGovernanceRuntime } from "./shared/harness-governance-bus";

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
  if (parts.some(part => part === "__proto__" || part === "prototype" || part === "constructor")) throw new Error("unsafe JSON path segment");
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null) cur[part] = {};
    if (typeof cur[part] !== "object" || Array.isArray(cur[part])) throw new Error(`Cannot create nested key through non-object segment: ${part}`);
    cur = cur[part];
  }
  cur[parts.at(-1)!] = value;
}

export function setJsonPathForTest(target: any, path: string, value: unknown): void {
  setJsonPath(target, path, value);
}

function indentBody(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body.split("\n").map(line => line.trim() ? pad + line : line).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`);
}

type RegisteredTool = {
  name?: string;
  description?: string;
  parameters?: unknown;
};

const TOOL_CALL_EXAMPLES: Record<string, unknown> = {
  apply_code_replacements: {
    edits: [{ path: "extensions/example.ts", oldText: "before", newText: "after" }],
  },
};

function comparableToolName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function policyForRequestedName(name: string) {
  return toolPolicyFor(name)
    ?? TOOL_POLICIES.find(policy => comparableToolName(policy.name) === comparableToolName(name));
}

function registeredTool(allTools: RegisteredTool[], name: string): RegisteredTool | undefined {
  return allTools.find(tool => tool?.name === name);
}

function formatToolUsage(name: string, tool?: RegisteredTool): string {
  const lines = [`Exact name: ${name} (case-sensitive)`];
  if (tool?.description) lines.push(`Description: ${tool.description}`);
  if (tool?.parameters) lines.push(`Parameters (native JSON): ${JSON.stringify(tool.parameters)}`);
  const example = TOOL_CALL_EXAMPLES[name];
  if (example) lines.push(`Canonical call: ${name}(${JSON.stringify(example)})`);
  return lines.join("\n");
}

export default function policyToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description: "Search deferred tools and activate registered matches additively for the next model request.",
    promptSnippet: "Search deferred tools and activate matches for the next model request",
    promptGuidelines: [
      "Use tool_search only when a needed capability is not currently available. Batch related capability needs into one specific search.",
      "Activated tools are exposed on the next model request, including through native deferred loading when available.",
      "Copy the exact case-sensitive snake_case tool name and send arrays/objects as native JSON, not JSON strings.",
      "The search result already includes each activated tool's live schema. Use tool_help only when that schema is absent or still ambiguous; do not add a redundant help call.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or tool name to search for" }),
      group: Type.Optional(Type.String({ description: "Optional capability group filter" })),
      risk: Type.Optional(Type.String({ description: "Optional risk filter" })),
      limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
    }),
    async execute(_id, params) {
      const allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
      const available = allTools.length > 0
        ? new Set(allTools.map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean))
        : undefined;
      const locked = new Set(LOCKED_BUILTIN_TOOLS);
      const limit = Math.min(Math.max(1, params.limit ?? 5), 5);
      const candidates = TOOL_POLICIES
        .filter(policy => toolPolicyLoadAllowed(policy, {
          mode: getCurrentOperationalMode(),
          researchEnabled: researchEnabled(),
        }))
        .filter(policy => !locked.has(policy.name))
        .filter(policy => !available || available.has(policy.name))
        .filter(policy => !params.group || policy.group === params.group)
        .filter(policy => !params.risk || policy.risk === params.risk);
      const query = params.query.trim();
      const exact = query
        ? candidates.find(policy => policy.name === query)
          ?? candidates.find(policy => comparableToolName(policy.name) === comparableToolName(query))
        : undefined;
      const results = exact
        ? [exact]
        : query
          ? searchToolCatalog(allTools, candidates, query, limit).map(match => match.policy)
          : candidates.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
      const current = typeof (pi as any).getActiveTools === "function"
        ? (pi as any).getActiveTools().map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean)
        : [];
      const actualActive = new Set<string>(current);
      const inactive = results.map(policy => policy.name).filter(name => !actualActive.has(name));
      const canActivate = typeof (pi as any).setActiveTools === "function";
      const activated = canActivate ? inactive : [];
      if (activated.length > 0) recordDiscoveredToolsForTurn(activated);
      const alreadyActive = results.map(policy => policy.name).filter(name => actualActive.has(name));
      const callableAfter = activated.length > 0 ? "next_model_request" : alreadyActive.length === results.length && results.length > 0 ? "now" : "unavailable";
      const text = results.length
        ? results.map(policy => {
          const status = activated.includes(policy.name)
            ? `ACTIVATED FOR NEXT MODEL REQUEST: ${policy.name}`
            : alreadyActive.includes(policy.name)
              ? `ALREADY ACTIVE: ${policy.name}`
              : `MATCHED BUT NOT ACTIVATED: ${policy.name}`;
          const metadata = `group=${policy.group ?? "always-on"} risk=${policy.risk}${policy.alwaysOn ? " always_on" : ""}`;
          const usage = results.length === 1 ? `\n${formatToolUsage(policy.name, registeredTool(allTools, policy.name))}` : "";
          return `${status}\n${metadata}${usage}`;
        }).join("\n\n")
        : "No matching tools found.";
      const sequencing = activated.length > 0
        ? "\n\nActivated additively; callable on the immediately following model request."
        : "";
      return {
        content: [{ type: "text", text: text + sequencing }],
        details: { results, loaded: activated, activated, queued: [], alreadyActive, callableAfter, exactNames: results.map(policy => policy.name) },
      };
    },
  });

  pi.registerTool({
    name: "tool_help",
    label: "Tool Help",
    description: "Return one tool's exact case-sensitive name, live schema, activation state, policy, and canonical call.",
    promptSnippet: "Inspect one tool's exact live schema",
    promptGuidelines: ["Use always-on tool_help before guessing a deferred tool's name or structured arguments."],
    parameters: Type.Object({
      name: Type.String({ description: "Tool name" }),
    }),
    async execute(_id, params) {
      const policy = policyForRequestedName(params.name);
      if (!policy) {
        const suggestions = TOOL_POLICIES
          .map(candidate => candidate.name)
          .filter(name => comparableToolName(name).includes(comparableToolName(params.name)) || comparableToolName(params.name).includes(comparableToolName(name)))
          .slice(0, 3);
        throw new Error(`Unknown tool: ${params.name}${suggestions.length ? `. Did you mean ${suggestions.join(", ")}?` : ""} Tool names are case-sensitive snake_case.`);
      }
      const allTools: RegisteredTool[] = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
      const current = typeof (pi as any).getActiveTools === "function"
        ? (pi as any).getActiveTools().map((tool: any) => typeof tool === "string" ? tool : tool?.name).filter(Boolean)
        : [];
      const active = current.includes(policy.name);
      const tool = registeredTool(allTools, policy.name);
      const text = [
        formatToolUsage(policy.name, tool),
        `Activation: ${active ? "already active" : "deferred; run tool_search, wait for its result, then call on the next model step"}`,
        `Policy: ${JSON.stringify(policy)}`,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { policy, tool, active, exactName: policy.name } };
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const suggestions = suggestChecks(params.query, params.paths ?? [], params.top_k ?? 3);
      const governance = ctx?.cwd ? readHarnessGovernanceRuntime(ctx.cwd) : undefined;
      const impact = governance && params.paths?.length ? await governance.buildImpact(params.paths) : undefined;
      const impactSummary = impact ? {
        affectedFiles: impact.affectedFiles?.slice(0, 500) ?? [], selectedTests: impact.selectedTests?.slice(0, 200) ?? [],
        verificationCommands: impact.verificationCommands?.slice(0, 20) ?? [], risk: impact.risk, repositoryFingerprint: impact.repositoryFingerprint,
      } : undefined;
      return { content: [{ type: "text", text: formatJson({ suggestions, impact: impactSummary }) }], details: { suggestions, impact: impactSummary } };
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
      await resolveSafeExistingPath(ctx.cwd, params.path);
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
      await resolveSafeExistingPath(ctx.cwd, params.path);
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
      await resolveSafeExistingPath(ctx.cwd, params.path);
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
