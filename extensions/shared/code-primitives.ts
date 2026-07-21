import { extname, relative, resolve } from "node:path";
import { resolveSafePath } from "./path-policy";

export type Language = "typescript" | "python" | "rust" | "javascript";
export type MatchMode = "exact" | "trimmed_lines" | "normalized_whitespace";

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
  matchMode?: MatchMode;
  expectedReplacements?: number;
  minReplacements?: number;
  maxReplacements?: number;
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

export type CodeDeclaration = {
  kind: string;
  name: string;
  line: number;
};

export type CodeStructure = {
  language: Language;
  imports: string[];
  declarations: CodeDeclaration[];
};

const DEFAULT_EXCLUDE_GLOBS = [
  "node_modules/**",
  "**/node_modules/**",
  ".git/**",
  "**/.git/**",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  "**/target/**",
  "target/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/bun.lock",
  "**/package-lock.json",
];

const LANGUAGE_EXTENSIONS: Record<Language, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  rust: [".rs"],
};

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineColumnAt(starts: readonly number[], index: number): { line: number; column: number } {
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

function contextForLine(lines: readonly string[], line: number, contextLines: number): { lineText: string; before: string[]; after: string[] } {
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

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

function closestSourceLine(text: string, needle: string): { line: number; text: string } | null {
  const needleLine = needle.split("\n").map(line => compactWhitespace(line)).find(Boolean);
  if (!needleLine) return null;
  const needleTokens = new Set(needleLine.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
  if (needleTokens.size === 0) return null;

  let best: { line: number; text: string; score: number } | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    const compactLine = compactWhitespace(line);
    if (!compactLine) continue;
    const lineTokens = new Set(compactLine.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
    let shared = 0;
    for (const token of needleTokens) if (lineTokens.has(token)) shared++;
    const score = (2 * shared) / (needleTokens.size + lineTokens.size);
    if (!best || score > best.score) best = { line: index + 1, text: line.trim().slice(0, 160), score };
  }
  return best && best.score >= 0.5 ? best : null;
}

function nearMatchHint(text: string, needle: string): string {
  const trimmedMatches = findTrimmedLinesMatches(text, needle);
  if (trimmedMatches.length === 1) {
    const match = trimmedMatches[0];
    return ` Found a unique whitespace-equivalent match at lines ${formatLineRange(match.startLine + 1, match.endLine)}; retry with matchMode: "trimmed_lines"`;
  }
  if (trimmedMatches.length > 1) {
    return ` Found ${trimmedMatches.length} whitespace-equivalent matches; include more unique surrounding lines`;
  }

  const compactNeedle = compactWhitespace(needle);
  if (compactNeedle && compactWhitespace(text).includes(compactNeedle)) {
    const firstNeedleToken = compactNeedle.split(" ")[0] ?? "";
    const nearLine = text.split("\n").find(line => compactWhitespace(line).includes(firstNeedleToken));
    return ` Possible whitespace/indentation mismatch${nearLine ? ` near: ${nearLine.trim().slice(0, 160)}` : ""}`;
  }

  const closest = closestSourceLine(text, needle);
  return closest ? ` Closest source line ${closest.line}: ${closest.text}` : "";
}

function replacementPreviews(before: string, after: string, maxPreviews = 5): ReplacementPreview[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const previews: ReplacementPreview[] = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if ((beforeLines[i] ?? "") === (afterLines[i] ?? "")) continue;
    previews.push({ line: i + 1, before: beforeLines[i] ?? "", after: afterLines[i] ?? "" });
    if (previews.length >= maxPreviews) break;
  }
  return previews;
}

function assertReplacementCount(edit: ReplacementEdit, count: number): void {
  if (edit.expectedReplacements !== undefined && count !== edit.expectedReplacements) {
    throw new Error(`Expected ${edit.expectedReplacements} replacement${edit.expectedReplacements === 1 ? "" : "s"} in ${edit.path}, got ${count}`);
  }
  if (edit.minReplacements !== undefined && count < edit.minReplacements) {
    throw new Error(`Expected at least ${edit.minReplacements} replacement${edit.minReplacements === 1 ? "" : "s"} in ${edit.path}, got ${count}`);
  }
  if (edit.maxReplacements !== undefined && count > edit.maxReplacements) {
    throw new Error(`Expected at most ${edit.maxReplacements} replacement${edit.maxReplacements === 1 ? "" : "s"} in ${edit.path}, got ${count}`);
  }
}

function findTrimmedLinesMatches(text: string, oldText: string): Array<{ startLine: number; endLine: number }> {
  const lines = text.split("\n");
  const oldLines = oldText.split("\n").map(line => line.trim());
  const matches: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    const slice = lines.slice(i, i + oldLines.length).map(line => line.trim());
    if (slice.every((line, idx) => line === oldLines[idx])) matches.push({ startLine: i, endLine: i + oldLines.length });
  }
  return matches;
}

function replaceTrimmedLines(text: string, edit: ReplacementEdit): { after: string; count: number } {
  if (edit.oldText === undefined) throw new Error(`oldText is required for trimmed_lines replacement in ${edit.path}`);
  const lines = text.split("\n");
  const normalized = lines.map(line => line.trim());
  const needle = edit.oldText.split("\n").map(line => line.trim());
  const prefix = new Array<number>(needle.length).fill(0);
  for (let i = 1, j = 0; i < needle.length;) {
    if (needle[i] === needle[j]) prefix[i++] = ++j;
    else if (j > 0) j = prefix[j - 1];
    else i++;
  }
  const starts: number[] = [];
  for (let i = 0, j = 0; i < normalized.length;) {
    if (normalized[i] === needle[j]) { i++; j++; if (j === needle.length) { starts.push(i - j); j = edit.replaceAll ? prefix[j - 1] : 0; if (!edit.replaceAll) break; } }
    else if (j > 0) j = prefix[j - 1];
    else i++;
  }
  if (starts.length === 0) throw new Error(`No match for oldText in ${edit.path}.${nearMatchHint(text, edit.oldText)}`);
  const output: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const start of starts) {
    if (start < cursor) continue;
    output.push(...lines.slice(cursor, start), edit.newText);
    cursor = start + needle.length;
    count++;
  }
  output.push(...lines.slice(cursor));
  return { after: output.join("\n"), count };
}

function replaceNormalizedWhitespace(_text: string, edit: ReplacementEdit): { after: string; count: number } {
  throw new Error(`normalized_whitespace replacement is disabled for ${edit.path}; use exact or trimmed_lines to preserve file formatting`);
}

export function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 500) return false;
  if (/\\[1-9]/.test(pattern) || /\(\?<([=!])/.test(pattern)) return false;
  if (/\([^)]*(?:\+|\*|\{\d*,?\d*\})[^)]*\)(?:\+|\*|\{)/.test(pattern)) return false;
  if (/\.\*[^\n]*\.\*/.test(pattern)) return false;
  return true;
}

function looksLikeRegexQuery(query: string): boolean {
  return /(^|[^\\])[|()[\]{}+?]/.test(query);
}

export function inspectTextMatches(text: string, options: MatchOptions): TextMatch[] {
  if (options.query.length === 0) throw new Error("query must not be empty");
  const contextLines = Math.max(0, options.contextLines ?? 2);
  const maxMatches = Math.max(1, options.maxMatches ?? 20);
  const matches: TextMatch[] = [];
  const starts = lineStarts(text);
  const lines = text.split("\n");

  const autoRegex = !options.regex && looksLikeRegexQuery(options.query);
  if (options.regex || autoRegex) {
    if (!isSafeRegexPattern(options.query)) throw new Error("Unsafe or overly complex regex pattern");
    const flags = options.caseSensitive ? "g" : "gi";
    try {
      const re = new RegExp(options.query, flags);
      for (const match of text.matchAll(re)) {
        if (match.index === undefined) continue;
        const { line, column } = lineColumnAt(starts, match.index);
        matches.push({ index: match.index, line, column, text: match[0], ...contextForLine(lines, line, contextLines) });
        if (matches.length >= maxMatches) break;
      }
      return matches;
    } catch (error) {
      if (options.regex) throw error;
    }
  }

  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  let from = 0;
  while (matches.length < maxMatches) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    const { line, column } = lineColumnAt(starts, index);
    matches.push({ index, line, column, text: text.slice(index, index + options.query.length), ...contextForLine(lines, line, contextLines) });
    from = index + Math.max(1, options.query.length);
  }
  return matches;
}

function exactReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  if (edit.oldText === undefined) throw new Error(`oldText is required for exact replacement in ${edit.path}`);
  if (edit.oldText.length === 0) throw new Error(`oldText must not be empty in ${edit.path}`);
  const mode = edit.matchMode ?? "exact";

  if (mode === "trimmed_lines") {
    const { after, count } = replaceTrimmedLines(text, edit);
    assertReplacementCount(edit, count);
    return { path: edit.path, before: text, after, replacements: count, previews: replacementPreviews(text, after) };
  }

  if (mode === "normalized_whitespace") {
    const { after, count } = replaceNormalizedWhitespace(text, edit);
    assertReplacementCount(edit, count);
    return { path: edit.path, before: text, after, replacements: count, previews: replacementPreviews(text, after) };
  }

  const occurrences = text.split(edit.oldText).length - 1;
  if (occurrences === 0) throw new Error(`No match for oldText in ${edit.path}.${nearMatchHint(text, edit.oldText)}`);
  if (occurrences > 1 && !edit.replaceAll) {
    const starts = lineStarts(text);
    const matchLines: number[] = [];
    for (let from = 0; matchLines.length < 5;) {
      const index = text.indexOf(edit.oldText, from);
      if (index < 0) break;
      matchLines.push(lineColumnAt(starts, index).line);
      from = index + edit.oldText.length;
    }
    const locations = `${matchLines.join(", ")}${occurrences > matchLines.length ? ", …" : ""}`;
    throw new Error(`oldText matched ${occurrences} times in ${edit.path} (matches at lines ${locations}); set replaceAll=true only if every match is intended, otherwise include more unique surrounding lines`);
  }
  const count = edit.replaceAll ? occurrences : 1;
  assertReplacementCount(edit, count);
  const after = edit.replaceAll ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText);
  return { path: edit.path, before: text, after, replacements: count, previews: replacementPreviews(text, after) };
}

function regexCanMatchEmpty(regex: string, flags: string): boolean {
  return new RegExp(regex, flags.replaceAll("g", "")).test("");
}

function regexReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  if (!edit.regex) throw new Error(`regex is required for regex replacement in ${edit.path}`);
  if (edit.regex.length === 0) throw new Error(`regex must not be empty in ${edit.path}`);
  if (!isSafeRegexPattern(edit.regex)) throw new Error(`Unsafe or overly complex regex in ${edit.path}`);
  const flags = edit.flags ?? "g";
  if (regexCanMatchEmpty(edit.regex, flags)) throw new Error(`regex must not match empty strings in ${edit.path}`);
  const re = new RegExp(edit.regex, flags.includes("g") ? flags : `${flags}g`);
  const occurrences = [...text.matchAll(re)].length;
  if (occurrences === 0) throw new Error(`No match for regex in ${edit.path}`);
  if (occurrences > 1 && !edit.replaceAll) throw new Error(`regex matched ${occurrences} times in ${edit.path}; set replaceAll=true or use a more specific regex`);
  const count = edit.replaceAll ? occurrences : 1;
  assertReplacementCount(edit, count);
  const single = new RegExp(edit.regex, flags.replaceAll("g", ""));
  const after = edit.replaceAll ? text.replace(re, edit.newText) : text.replace(single, edit.newText);
  return { path: edit.path, before: text, after, replacements: count, previews: replacementPreviews(text, after) };
}

export function planReplacement(text: string, edit: ReplacementEdit): ReplacementPlan {
  return edit.regex ? regexReplacement(text, edit) : exactReplacement(text, edit);
}

export function summarizePlan(plan: ReplacementPlan): string {
  const delta = plan.after.split("\n").length - plan.before.split("\n").length;
  return `${plan.path}: ${plan.replacements} replacement${plan.replacements === 1 ? "" : "s"}, line delta ${delta >= 0 ? "+" : ""}${delta}`;
}

const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

function colorLine(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI_RESET}` : text;
}

export function formatPlanPreview(plan: ReplacementPlan, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  return plan.previews.map(preview => [
    colorLine(`@@ -${preview.line} +${preview.line} @@`, ANSI_DIM, color),
    colorLine(`-${preview.before}`, ANSI_RED, color),
    colorLine(`+${preview.after}`, ANSI_GREEN, color),
  ].join("\n")).join("\n");
}

export { resolveSafePath } from "./path-policy";

export function isProbablyBinary(buffer: Buffer | Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.length === 0) return false;

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: buffer.length > sample.length });
  } catch {
    return true;
  }

  let suspicious = 0;
  let characters = 0;
  for (const character of decoded) {
    characters++;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13) continue;
    if (codePoint < 32 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159)) suspicious++;
  }
  return characters > 0 && suspicious / characters > 0.3;
}

export function extensionsForLanguage(language: Language): string[] {
  return LANGUAGE_EXTENSIONS[language];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globAlternatives(glob: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of glob) {
    if (char === "{") depth++;
    if (char === "}") depth = Math.max(0, depth - 1);
    if ((/\s/.test(char) || char === ",") && depth === 0) {
      if (current.trim()) alternatives.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) alternatives.push(current.trim());
  return alternatives;
}

function globPartPattern(part: string): string {
  if (part === "**") return "(?:.*)?";
  return escapeRegex(part)
    .replace(/\\\{([^}]+)\\\}/g, (_match, choices: string) => "(?:" + choices.split(",").map(escapeRegex).join("|") + ")")
    .replaceAll("\\*", "[^/]*");
}

export function matchesGlob(path: string, glob: string): boolean {
  return globAlternatives(glob).some(alternative => {
    const pattern = alternative.split("/").map(globPartPattern).join("/");
    return new RegExp("^" + pattern + "$" ).test(path);
  });
}

export function shouldExcludePath(path: string, excludeGlobs: string[] = []): boolean {
  return [...DEFAULT_EXCLUDE_GLOBS, ...excludeGlobs].some(glob => matchesGlob(path, glob));
}

export function matchesLanguage(path: string, language?: Language): boolean {
  if (!language) return true;
  return extensionsForLanguage(language).includes(extname(path));
}

export function inspectCodeStructure(text: string, language: Language): CodeStructure {
  const imports: string[] = [];
  const declarations: CodeDeclaration[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m: RegExpMatchArray | null;

    if (language === "typescript" || language === "javascript") {
      m = line.match(/^import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/);
      if (m) imports.push(m[1]);
      m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (m) declarations.push({ kind: "function", name: m[1], line: i + 1 });
      m = line.match(/^(?:export\s+)?class\s+(\w+)/);
      if (m) declarations.push({ kind: "class", name: m[1], line: i + 1 });
      m = line.match(/^(?:export\s+)?(?:type|interface)\s+(\w+)/);
      if (m) declarations.push({ kind: "type", name: m[1], line: i + 1 });
    }

    if (language === "python") {
      m = line.match(/^import\s+([\w.]+)/);
      if (m) imports.push(m[1]);
      m = line.match(/^from\s+([\w.]+)\s+import\s+/);
      if (m) imports.push(m[1]);
      m = line.match(/^def\s+(\w+)/);
      if (m) declarations.push({ kind: "def", name: m[1], line: i + 1 });
      m = line.match(/^class\s+(\w+)/);
      if (m) declarations.push({ kind: "class", name: m[1], line: i + 1 });
    }

    if (language === "rust") {
      m = line.match(/^use\s+([^;]+);/);
      if (m) imports.push(m[1]);
      m = line.match(/^(?:pub\s+)?fn\s+(\w+)/);
      if (m) declarations.push({ kind: "fn", name: m[1], line: i + 1 });
      m = line.match(/^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/);
      if (m) declarations.push({ kind: "type", name: m[1], line: i + 1 });
    }
  }

  return { language, imports, declarations };
}
