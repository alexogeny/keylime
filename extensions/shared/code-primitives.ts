import { isAbsolute, relative, resolve } from "node:path";

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
  lineText: string;
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

export type ReplacementPreview = {
  line: number;
  before: string;
  after: string;
};

export type ReplacementPlan = {
  path: string;
  before: string;
  after: string;
  replacements: number;
  previews: ReplacementPreview[];
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

function contextForLine(text: string, line: number, contextLines: number): { lineText: string; before: string[]; after: string[] } {
  const lines = text.split("\n");
  const idx = line - 1;
  return {
    lineText: lines[idx] ?? "",
    before: lines.slice(Math.max(0, idx - contextLines), idx),
    after: lines.slice(idx + 1, Math.min(lines.length, idx + 1 + contextLines)),
  };
}

function compactWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function nearMatchHint(text: string, needle: string): string {
  const compactNeedle = compactWhitespace(needle);
  if (!compactNeedle) return "";
  const compactText = compactWhitespace(text);
  if (!compactText.includes(compactNeedle)) return "";

  const firstNeedleToken = compactNeedle.split(" ")[0] ?? "";
  const nearLine = text.split("\n").find(line => compactWhitespace(line).includes(firstNeedleToken));
  return ` Possible whitespace/indentation mismatch${nearLine ? ` near: ${nearLine.trim().slice(0, 160)}` : ""}`;
}

function replacementPreviews(before: string, after: string, maxPreviews = 5): ReplacementPreview[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const limit = Math.max(beforeLines.length, afterLines.length);
  const previews: ReplacementPreview[] = [];

  for (let i = 0; i < limit; i++) {
    if ((beforeLines[i] ?? "") === (afterLines[i] ?? "")) continue;
    previews.push({ line: i + 1, before: beforeLines[i] ?? "", after: afterLines[i] ?? "" });
    if (previews.length >= maxPreviews) break;
  }

  return previews;
}

export function inspectTextMatches(text: string, options: MatchOptions): TextMatch[] {
  if (options.query.length === 0) throw new Error("query must not be empty");
  const contextLines = Math.max(0, options.contextLines ?? 2);
  const maxMatches = Math.max(1, options.maxMatches ?? 20);
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
  if (edit.oldText.length === 0) throw new Error(`oldText must not be empty in ${edit.path}`);
  const occurrences = text.split(edit.oldText).length - 1;
  if (occurrences === 0) throw new Error(`No match for oldText in ${edit.path}.${nearMatchHint(text, edit.oldText)}`);
  if (occurrences > 1 && !edit.replaceAll) throw new Error(`oldText matched ${occurrences} times in ${edit.path}; set replaceAll=true or use a more specific oldText`);
  const after = edit.replaceAll ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText);
  return { path: edit.path, before: text, after, replacements: edit.replaceAll ? occurrences : 1, previews: replacementPreviews(text, after) };
}

function regexCanMatchEmpty(regex: string, flags: string): boolean {
  const re = new RegExp(regex, flags.replaceAll("g", ""));
  return re.test("");
}

function regexReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  if (!edit.regex) throw new Error(`regex is required for regex replacement in ${edit.path}`);
  if (edit.regex.length === 0) throw new Error(`regex must not be empty in ${edit.path}`);
  const flags = edit.flags ?? "g";
  if (regexCanMatchEmpty(edit.regex, flags)) throw new Error(`regex must not match empty strings in ${edit.path}`);
  const re = new RegExp(edit.regex, flags.includes("g") ? flags : `${flags}g`);
  const occurrences = [...text.matchAll(re)].length;
  if (occurrences === 0) throw new Error(`No match for regex in ${edit.path}`);
  if (occurrences > 1 && !edit.replaceAll) throw new Error(`regex matched ${occurrences} times in ${edit.path}; set replaceAll=true or use a more specific regex`);
  const single = new RegExp(edit.regex, flags.replaceAll("g", ""));
  const after = edit.replaceAll ? text.replace(re, edit.newText) : text.replace(single, edit.newText);
  return { path: edit.path, before: text, after, replacements: edit.replaceAll ? occurrences : 1, previews: replacementPreviews(text, after) };
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

export function formatPlanPreview(plan: ReplacementPlan): string {
  if (plan.previews.length === 0) return "";
  return plan.previews
    .map(preview => [`line ${preview.line}:`, `- ${preview.before}`, `+ ${preview.after}`].join("\n"))
    .join("\n");
}

export function resolveSafePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidate;
  throw new Error(`Path is outside cwd: ${inputPath}`);
}

export function isProbablyBinary(buffer: Buffer | Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  if (sample.length === 0) return false;

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    suspicious++;
  }
  return suspicious / sample.length > 0.3;
}
