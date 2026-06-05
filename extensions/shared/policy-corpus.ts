import { buildRetrievalIndex, type ScoredResult, type SearchDocument } from "./retrieval";

export type PolicyDocKind = "routing" | "mutation" | "codemod" | "check" | "context" | "recall";

export interface PolicyDocument extends SearchDocument {
  kind: PolicyDocKind;
  fields?: SearchDocument["fields"] & {
    active_tools?: string[];
    locked_tools?: string[];
    paths?: string[];
    commands?: string[];
    severity?: string;
  };
}

export const POLICY_DOCUMENTS: PolicyDocument[] = [
  {
    id: "routing.refactor",
    kind: "routing",
    title: "Refactor / cleanup mode",
    body: "Clean up code, restructure, rename, split modules, reduce duplication, preserve behavior. Prefer search, structure inspection, planned replacements, guarded application, and targeted checks. Lock web and memory writes unless explicitly requested.",
    fields: { active_tools: ["code_search", "inspect_code_structure", "inspect_lines", "plan_code_replacements", "apply_code_replacements", "run_checks"], locked_tools: ["web", "memory_write", "raw_shell_mutation"] },
    tags: ["coding", "safe-edit"],
  },
  {
    id: "routing.debug",
    kind: "routing",
    title: "Debug failing behavior",
    body: "Reproduce failure, inspect stack traces, search related code, make minimal fix, rerun targeted test. Handles vague debugging language such as exploding after a change, broke after change, why did this fail, and unexpected crash. Use run_checks for tests and avoid unrelated refactors.",
    fields: { active_tools: ["code_search", "inspect_text_matches", "inspect_lines", "run_checks"], locked_tools: ["web", "memory_write"] },
    tags: ["coding", "tests"],
  },
  {
    id: "routing.agentic-audit",
    kind: "routing",
    title: "Agentic programming harness audit",
    body: "Review coding-agent harness design: tool exposure, context lifecycle, prompt hygiene, runtime safety, checkpointing, verification loops, repo index, file tools, observability.",
    fields: { active_tools: ["code_search", "inspect_code_structure", "inspect_text_matches", "run_checks"], locked_tools: ["raw_shell_mutation"] },
    tags: ["keylime", "pi", "audit"],
  },
  {
    id: "mutation.runtime-eval",
    kind: "mutation",
    title: "Runtime eval bypass",
    body: "Commands like python -c, node -e, bun -e, deno eval, perl -e, ruby -e can bypass file mutation tools and write arbitrary files. Block or require explicit confirmation in coding/check modes.",
    fields: { severity: "high" },
    tags: ["safety", "shell", "bypass"],
  },
  {
    id: "mutation.shell-mutation",
    kind: "mutation",
    title: "Shell mutation",
    body: "Shell commands that write, delete, move, install packages, modify git state, change permissions, or redirect output are mutating and need danger guard classification, protected path checks, and checkpoint scoring.",
    fields: { severity: "high" },
    tags: ["safety", "bash"],
  },
  {
    id: "codemod.add-import",
    kind: "codemod",
    title: "Add import if missing",
    body: "Use when a TypeScript or JavaScript symbol is needed and the import is missing. Inspect structure first, avoid duplicates, preserve grouping, prefer exact guarded edits, then run typecheck or targeted tests.",
    fields: { active_tools: ["inspect_code_structure", "plan_code_replacements", "apply_code_replacements"], commands: ["typecheck"] },
    tags: ["typescript", "imports"],
  },
  {
    id: "codemod.update-json-key",
    kind: "codemod",
    title: "Update JSON key",
    body: "Use for package scripts, config fields, project metadata, and fixture updates. Inspect JSON projection first, apply exact update with overwrite guard, preserve formatting where possible.",
    fields: { active_tools: ["inspect_json", "apply_code_replacements"], commands: ["targeted_checks"] },
    tags: ["json", "config"],
  },
  {
    id: "checks.danger-guard",
    kind: "check",
    title: "Danger guard and safety policy checks",
    body: "Run targeted danger guard and test runner tests after changing safety policy, bash mutation classification, runtime eval blocking, protected paths, or run_checks command handling.",
    fields: { paths: ["extensions/danger-guard.ts", "extensions/shared/safety-policy.ts", "extensions/test-runner.ts", "extensions/shared/test-runner.ts"], commands: ["bun test tests/danger-guard.test.ts", "bun test tests/test-runner.test.ts"] },
    tags: ["safety", "tests"],
  },
  {
    id: "checks.retrieval",
    kind: "check",
    title: "Retrieval core checks",
    body: "Run retrieval tests after changing tokenization, BM25, TF-IDF, JMLM, hybrid ranking, policy corpus, web knowledge recall, or memory retrieval.",
    fields: { paths: ["extensions/shared/retrieval", "extensions/shared/policy-corpus.ts", "extensions/search-memory.ts", "extensions/user-memory/index.ts"], commands: ["bun test tests/retrieval.test.ts", "bun test tests/policy-corpus.test.ts"] },
    tags: ["retrieval", "tests"],
  },
  {
    id: "context.tool-result-compaction",
    kind: "context",
    title: "Tool result compaction",
    body: "Large tool outputs should be stored outside context with a compact summary, preview, result id, and retrieval tool. Do not compact small outputs or errors by default. Prefer small retrieval caps.",
    tags: ["context", "compaction"],
  },
  {
    id: "recall.project-memory",
    kind: "recall",
    title: "Project memory and decisions",
    body: "For architecture, conventions, check recipes, active plans, and decisions, retrieve file-backed project state or policy corpus snippets instead of reinjecting large stale summaries every turn.",
    tags: ["memory", "project-state"],
  },
];

const index = buildRetrievalIndex(POLICY_DOCUMENTS);

export function retrievePolicy(query: string, options: { topK?: number; kind?: PolicyDocKind; paths?: string[] } = {}): ScoredResult<PolicyDocument>[] {
  const paths = options.paths ?? [];
  return index.search(query, {
    topK: Math.max(options.topK ?? 5, 1) * (options.kind ? 3 : 1),
    heuristic: doc => {
      let score = 0;
      if (options.kind && doc.kind === options.kind) score += 0.6;
      const docPaths = Array.isArray(doc.fields?.paths) ? doc.fields.paths : [];
      if (paths.some(path => docPaths.some(p => path.startsWith(p) || p.startsWith(path)))) score += 0.4;
      return Math.min(1, score);
    },
  })
    .filter(result => !options.kind || result.document?.kind === options.kind)
    .slice(0, options.topK ?? 5) as ScoredResult<PolicyDocument>[];
}
