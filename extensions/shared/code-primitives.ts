export type MatchOptions = {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
};

export type TextMatch = {
  index: number;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
};

export type ReplacementEdit = {
  path: string;
  oldText?: string;
  newText: string;
  regex?: string;
  flags?: string;
  replaceAll?: boolean;
};

export type ReplacementPlan = {
  path: string;
  before: string;
  after: string;
  replacements: number;
};

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const starts = lineStarts(text);
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  const lineIdx = Math.max(0, high);
  return { line: lineIdx + 1, column: index - starts[lineIdx] + 1 };
}

function contextForLine(text: string, line: number, contextLines: number): { before: string[]; after: string[] } {
  const lines = text.split("\n");
  const idx = line - 1;
  return {
    before: lines.slice(Math.max(0, idx - contextLines), idx),
    after: lines.slice(idx + 1, Math.min(lines.length, idx + 1 + contextLines)),
  };
}

export function inspectTextMatches(text: string, options: MatchOptions): TextMatch[] {
  const contextLines = options.contextLines ?? 2;
  const maxMatches = options.maxMatches ?? 20;
  const matches: TextMatch[] = [];

  if (options.regex) {
    const flags = options.caseSensitive ? "g" : "gi";
    const re = new RegExp(options.query, flags);
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const { line, column } = lineColumnAt(text, match.index);
      const context = contextForLine(text, line, contextLines);
      matches.push({ index: match.index, line, column, text: match[0], ...context });
      if (matches.length >= maxMatches) break;
    }
    return matches;
  }

  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  let from = 0;
  while (matches.length < maxMatches) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    const { line, column } = lineColumnAt(text, index);
    const context = contextForLine(text, line, contextLines);
    matches.push({ index, line, column, text: text.slice(index, index + options.query.length), ...context });
    from = index + Math.max(1, options.query.length);
  }
  return matches;
}

function exactReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  if (edit.oldText === undefined) throw new Error(`oldText is required for exact replacement in ${edit.path}`);
  const occurrences = text.split(edit.oldText).length - 1;
  if (occurrences === 0) throw new Error(`No match for oldText in ${edit.path}`);
  if (occurrences > 1 && !edit.replaceAll) throw new Error(`oldText matched ${occurrences} times in ${edit.path}; set replaceAll=true or use a more specific oldText`);
  const after = edit.replaceAll ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText);
  return { path: edit.path, before: text, after, replacements: edit.replaceAll ? occurrences : 1 };
}

function regexReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  if (!edit.regex) throw new Error(`regex is required for regex replacement in ${edit.path}`);
  const flags = edit.flags ?? "g";
  const re = new RegExp(edit.regex, flags.includes("g") ? flags : `${flags}g`);
  const occurrences = [...text.matchAll(re)].length;
  if (occurrences === 0) throw new Error(`No match for regex in ${edit.path}`);
  if (occurrences > 1 && !edit.replaceAll) throw new Error(`regex matched ${occurrences} times in ${edit.path}; set replaceAll=true or use a more specific regex`);
  const single = new RegExp(edit.regex, flags.replaceAll("g", ""));
  const after = edit.replaceAll ? text.replace(re, edit.newText) : text.replace(single, edit.newText);
  return { path: edit.path, before: text, after, replacements: edit.replaceAll ? occurrences : 1 };
}

export function planReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  return edit.regex ? regexReplacement(text, edit) : exactReplacement(text, edit);
}

export function summarizePlan(plan: ReplacementPlan): string {
  const beforeLines = plan.before.split("\n").length;
  const afterLines = plan.after.split("\n").length;
  const delta = afterLines - beforeLines;
  return `${plan.path}: ${plan.replacements} replacement${plan.replacements === 1 ? "" : "s"}, line delta ${delta >= 0 ? "+" : ""}${delta}`;
}
