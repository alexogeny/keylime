import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyIntent } from "../../extensions/shared/intent";
import { classifyToolMutation } from "../../extensions/shared/safety-policy";
import { resolveActiveToolSet, knownToolNames } from "../../extensions/shared/tool-policy";
import { extractMainContent, summarizeText } from "../../extensions/shared/content-distill";
import { inspectTextMatches, planReplacement } from "../../extensions/shared/code-primitives";
import { extractCandidates, classifyCategory } from "../../extensions/user-memory/signals";
import { LruCache } from "../../extensions/shared/lru-cache";
import { readJsonDir, readJsonFile, writeJsonFile } from "../../extensions/shared/json-store";
import { listWorkspaceFiles } from "../../extensions/control-plane-api/stores";

type Row = { subsystem: string; operation: string; iterations: number; totalMs: number; medianUs: number; p95Us: number; opsPerSecond: number };
const rows: Row[] = [];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function bench(subsystem: string, operation: string, iterations: number, fn: (index: number) => unknown): void {
  for (let i = 0; i < Math.min(100, iterations); i++) fn(i);
  const timings: number[] = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const itemStart = performance.now();
    fn(i);
    timings.push((performance.now() - itemStart) * 1000);
  }
  const totalMs = performance.now() - start;
  rows.push({ subsystem, operation, iterations, totalMs, medianUs: percentile(timings, 0.5), p95Us: percentile(timings, 0.95), opsPerSecond: iterations / (totalMs / 1000) });
}

async function benchAsync(subsystem: string, operation: string, iterations: number, fn: (index: number) => Promise<unknown>): Promise<void> {
  const timings: number[] = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const itemStart = performance.now();
    await fn(i);
    timings.push((performance.now() - itemStart) * 1000);
  }
  const totalMs = performance.now() - start;
  rows.push({ subsystem, operation, iterations, totalMs, medianUs: percentile(timings, 0.5), p95Us: percentile(timings, 0.95), opsPerSecond: iterations / (totalMs / 1000) });
}

const prompts = [
  "refactor the TypeScript authentication service and add tests",
  "inspect docker containers and diagnose memory pressure",
  "research the latest running shoe foam updates",
  "remember that I prefer concise answers",
  "profile this Python data pipeline",
];
bench("routing", "classifyIntent", 20_000, i => classifyIntent(prompts[i % prompts.length]));

const mutations = [
  ["inspect_lines", { path: "src/index.ts" }],
  ["apply_code_replacements", { edits: [{ path: "src/index.ts", oldText: "a", newText: "b" }] }],
  ["delete_file", { path: "src/old.ts" }],
  ["run_checks", { suite: "test" }],
] as const;
bench("safety", "classifyToolMutation", 30_000, i => classifyToolMutation(mutations[i % mutations.length][0], mutations[i % mutations.length][1]));

const tools = knownToolNames();
bench("routing", "resolveActiveToolSet", 10_000, i => resolveActiveToolSet({
  availableToolNames: tools,
  currentActiveToolNames: i % 2 ? ["custom_provider_tool"] : [],
  continuityToolNames: ["inspect_lines"],
  groups: i % 3 === 0 ? ["coding", "repo", "safety"] : ["research", "fetch"],
}));

const sourceText = Array.from({ length: 12_000 }, (_, i) => `export function handler${i}() { return "value-${i}"; }`).join("\n");
bench("code", "inspectTextMatches 650KB", 150, i => inspectTextMatches(sourceText, { query: `handler${i % 1000}`, contextLines: 2, maxMatches: 20 }));
bench("code", "planReplacement 650KB", 100, i => planReplacement(sourceText, { path: "generated.ts", oldText: `return \"value-${i % 1000}\";`, newText: "return \"replacement\";", expectedReplacements: 1 }));

const articleParagraph = "Keylime routes agent tools through safety policy and retrieval indexes. The implementation uses bounded context and deterministic ranking. ";
const articleHtml = `<html><nav>${"menu ".repeat(200)}</nav><main><h1>Keylime performance</h1>${Array.from({ length: 250 }, () => `<p>${articleParagraph}</p>`).join("")}</main></html>`;
const articleText = articleParagraph.repeat(500);
bench("content", "extractMainContent 40KB", 250, () => extractMainContent(articleHtml, { maxChars: 8_000 }));
bench("content", "summarizeText 65KB", 100, () => summarizeText(articleText, { query: "safety retrieval ranking", maxSentences: 6, maxChars: 1_500 }));

const memoryText = "I prefer TypeScript and concise answers. My current project uses Bun. Next month I plan to run a marathon. ".repeat(20);
bench("memory", "extractCandidates", 5_000, () => extractCandidates(memoryText));
bench("memory", "classifyCategory", 10_000, i => classifyCategory(prompts[i % prompts.length]));

const lru = new LruCache<string, number>({ maxEntries: 1024 });
bench("cache", "LRU mixed get/set", 100_000, i => {
  const cache = lru;
  cache.set(`key-${i % 2048}`, i);
  cache.get(`key-${(i * 7) % 2048}`);
});

const root = await mkdtemp(join(tmpdir(), "keylime-bench-"));
const jsonDir = join(root, "json");
const workspaceDir = join(root, "workspace");
try {
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => writeJsonFile(join(jsonDir, `${String(i).padStart(4, "0")}.json`), { id: i, body: articleParagraph })));
  await Promise.all(Array.from({ length: 20 }, async (_, dir) => {
    await Promise.all(Array.from({ length: 50 }, (_, file) => writeJsonFile(join(workspaceDir, `dir-${dir}`, `file-${file}.json`), { dir, file })));
  }));
  await benchAsync("storage", "readJsonFile warm", 1_000, i => readJsonFile(join(jsonDir, `${String(i).padStart(4, "0")}.json`), null));
  await benchAsync("storage", "readJsonDir 1000 files", 12, () => readJsonDir(jsonDir, { concurrency: 8 }));
  await benchAsync("storage", "atomic write", 250, i => writeJsonFile(join(root, "atomic.json"), { revision: i, body: articleParagraph }));
  await benchAsync("workspace", "listWorkspaceFiles 1000 files", 20, () => listWorkspaceFiles(workspaceDir, 2_000));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.table(rows.map(row => ({
  subsystem: row.subsystem,
  operation: row.operation,
  iterations: row.iterations,
  totalMs: row.totalMs.toFixed(2),
  medianUs: row.medianUs.toFixed(2),
  p95Us: row.p95Us.toFixed(2),
  opsPerSecond: row.opsPerSecond.toFixed(0),
})));
