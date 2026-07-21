const EXACT_RECOVERY_TOOLS = new Set(["inspect_tool_result", "inspect_context_object"]);

const MUTATION_EVIDENCE_TOOLS = new Set([
  "apply_code_replacements",
  "create_file",
  "create_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "replace_file",
  "finish_file_write",
  "codemod_add_import",
  "codemod_insert_test_case",
  "codemod_update_json",
  "save_project_plan",
  "update_feature_tdd",
  "log_decision",
  "manage_question",
  "remember",
  "ctx_region_write",
]);

export function contextObjectKindForTool(toolName: string): "repo_search" | "test_run" | "file_read" | "research" | "table" | "generic" {
  if (["code_search", "inspect_text_matches", "list_files"].includes(toolName)) return "repo_search";
  if (["run_checks", "test", "typecheck", "lint"].includes(toolName)) return "test_run";
  if (["inspect_lines", "inspect_document", "inspect_json"].includes(toolName)) return "file_read";
  if (["web_search", "fetch_url", "recall_web_knowledge"].includes(toolName)) return "research";
  if (["inspect_spreadsheet", "extract_document_tables", "analyze_csv"].includes(toolName)) return "table";
  return "generic";
}

export type ReducedToolResultText = {
  activeText: string;
  summary: string;
  sections: Record<string, { startLine: number; endLine: number }>;
};

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n… [omitted ${omitted} chars]`;
}

const QUERY_STOPWORDS = new Set(["and", "are", "for", "from", "find", "how", "into", "that", "the", "this", "with", "configuration"]);

function queryTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter(term => !QUERY_STOPWORDS.has(term)))];
}

function taskConditionedSelection(lines: string[], query: string, maxChars: number): ReducedToolResultText | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const ranked = lines
    .map((line, index) => {
      const normalized = line.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
      return { line, index, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (ranked.length === 0) return undefined;

  const selected: typeof ranked = [];
  let used = 48;
  for (const item of ranked) {
    const renderedLength = item.line.length + String(item.index + 1).length + 4;
    if (selected.length > 0 && used + renderedLength > maxChars) continue;
    selected.push(item);
    used += renderedLength;
    if (used >= maxChars) break;
  }
  selected.sort((left, right) => left.index - right.index);
  const sections = Object.fromEntries(selected.map((item, index) => [
    `task_match_${index + 1}`,
    { startLine: item.index + 1, endLine: item.index + 1 },
  ]));
  return {
    activeText: cap(`Task-relevant excerpts from ${lines.length} lines:\n${selected.map(item => `L${item.index + 1}: ${item.line}`).join("\n")}`, maxChars),
    summary: `${selected.length} task-conditioned line${selected.length === 1 ? "" : "s"} retained from ${lines.length}`,
    sections,
  };
}

export function reduceToolResultText(toolName: string, text: string, options: { maxChars: number; query?: string }): ReducedToolResultText {
  const kind = contextObjectKindForTool(toolName);
  const lines = text.split("\n");
  if (kind === "test_run") {
    const diagnosticIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(item => /\bFAIL\b|\bError\b|exception|traceback|\bat\s+\S+?:\d+/i.test(item.line))
      .map(item => item.index);
    if (diagnosticIndexes.length > 0) {
      const start = diagnosticIndexes[0];
      const end = diagnosticIndexes[diagnosticIndexes.length - 1];
      const diagnosticText = lines.slice(start, end + 1).join("\n");
      return {
        activeText: cap(`Test diagnostics (${start + 1}-${end + 1} of ${lines.length} lines):\n${diagnosticText}`, options.maxChars),
        summary: `${diagnosticIndexes.length} diagnostic line${diagnosticIndexes.length === 1 ? "" : "s"} in ${lines.length} total lines`,
        sections: { diagnostics: { startLine: start + 1, endLine: end + 1 } },
      };
    }
  }
  if (kind === "repo_search") {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > Math.max(80, options.maxChars - 80)) break;
      kept.push(line);
      used += line.length + 1;
    }
    const omitted = Math.max(0, lines.length - kept.length);
    return {
      activeText: `${kept.join("\n")}\n[${omitted} result line${omitted === 1 ? "" : "s"} omitted]`,
      summary: `${kept.length} of ${lines.length} ranked result lines retained`,
      sections: kept.length ? { leading_matches: { startLine: 1, endLine: kept.length } } : {},
    };
  }
  if (options.query && text.length > options.maxChars) {
    const selected = taskConditionedSelection(lines, options.query, options.maxChars);
    if (selected) return selected;
  }
  return {
    activeText: cap(text, options.maxChars),
    summary: `${text.length} chars`,
    sections: {},
  };
}

export function bypassGenericToolResultReduction(input: { toolName: string; isError: boolean }): boolean {
  return input.isError || EXACT_RECOVERY_TOOLS.has(input.toolName) || MUTATION_EVIDENCE_TOOLS.has(input.toolName);
}
