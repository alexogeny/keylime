import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testables as fetchHelpers } from "../../extensions/fetch";
import documentPrimitives from "../../extensions/document-primitives";
import repoIndexExtension from "../../extensions/repo-index/index";
import { compactToolResultContent } from "../../extensions/tool-result-compactor";
import { handleControlPlaneRequest } from "../../extensions/control-plane-api";
import { stageCheckpointChangesForTest } from "../../extensions/git-checkpoint";
import { extractEntities } from "../../extensions/user-memory/entity";
import { extractCandidates, classifyCategory } from "../../extensions/user-memory/signals";
import { buildRetrievalIndex } from "../../extensions/shared/retrieval";

const execFileAsync = promisify(execFile);
type Row = { subsystem: string; operation: string; scale: string; iterations: number; medianMs: number; p95Ms: number; totalMs: number; note?: string };
const rows: Row[] = [];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function measure(subsystem: string, operation: string, scale: string, iterations: number, fn: (index: number) => unknown | Promise<unknown>): Promise<void> {
  const timings: number[] = [];
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const itemStarted = performance.now();
    await fn(index);
    timings.push(performance.now() - itemStarted);
  }
  rows.push({ subsystem, operation, scale, iterations, medianMs: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95), totalMs: performance.now() - started });
}

function skipped(subsystem: string, operation: string, note: string): void {
  rows.push({ subsystem, operation, scale: "n/a", iterations: 0, medianMs: 0, p95Ms: 0, totalMs: 0, note });
}

function registerTools(extension: (pi: any) => unknown): Record<string, any> {
  const tools: Record<string, any> = {};
  extension({ registerTool: (tool: any) => { tools[tool.name] = tool; }, registerCommand: () => {}, on: () => {} });
  return tools;
}

function request(path: string): Request {
  return new Request(`http://127.0.0.1${path}`);
}

const root = await mkdtemp(join(tmpdir(), "keylime-system-bench-"));
try {
  // Fetch parsing and response distillation: excludes network variability.
  const articleHtml = `<html><head><title>Keylime systems benchmark</title></head><body><nav>${"navigation ".repeat(500)}</nav><article>${Array.from({ length: 2_000 }, (_, i) => `<p>Paragraph ${i}: retrieval, safety, context, and performance details. <a href="/docs/${i}">docs</a></p>`).join("")}</article></body></html>`;
  await measure("fetch", "htmlToText", `${Math.round(articleHtml.length / 1024)} KiB HTML`, 100, () => fetchHelpers.htmlToText(articleHtml));
  await measure("fetch", "extract same-domain links", "2,000 links", 100, () => fetchHelpers.extractLinks(articleHtml, "https://example.test/guide"));
  await measure("fetch", "formatFetchText", "large parsed page", 100, () => fetchHelpers.formatFetchText({
    outcome: "ok",
    classification: "ok_content",
    url: "https://example.test/guide",
    title: "Guide",
    content: fetchHelpers.htmlToText(articleHtml),
    links: fetchHelpers.extractLinks(articleHtml, "https://example.test/guide"),
    fetchedAt: new Date(0).toISOString(),
    reasonCodes: [],
    timingsMs: { total: 1, download: 1, extract: 0 },
    redirectCount: 0,
    contentLength: articleHtml.length,
    confidence: { score: 0.9, reasons: [] },
  } as any, { query: "retrieval safety performance" }));

  // Tool-result compaction: pure CPU/serialization across realistic thresholds.
  for (const bytes of [100_000, 1_000_000, 10_000_000]) {
    const text = Array.from({ length: Math.ceil(bytes / 80) }, (_, i) => i % 200 === 0 ? `Error ${i}: representative failure line` : `ordinary bounded tool output line ${i}`).join("\n").slice(0, bytes);
    await measure("tool-results", "compactToolResultContent", `${Math.round(bytes / 1_000)} KB`, bytes >= 10_000_000 ? 3 : 20, () => compactToolResultContent([{ type: "text", text }], { thresholdChars: 20_000, previewChars: 4_000 }));
  }

  // Document primitives: text, CSV, archive, and citation paths without external OCR dependencies.
  const documentDir = join(root, "documents");
  await mkdir(documentDir, { recursive: true });
  const largeText = Array.from({ length: 20_000 }, (_, i) => `Finding ${i}. Keylime safely processes documents and extracts useful evidence.`).join("\n");
  const csv = ["id,name,score,category", ...Array.from({ length: 10_000 }, (_, i) => `${i},item-${i},${i % 100},group-${i % 20}`)].join("\n");
  await writeFile(join(documentDir, "large.md"), largeText);
  await writeFile(join(documentDir, "large.csv"), csv);
  const tar = Buffer.alloc(512 * 2_002);
  for (let i = 0; i < 2_000; i++) {
    const offset = i * 512;
    tar.write(`docs/file-${i}.txt`, offset, "utf8");
    tar.write("0000644\0", offset + 100, "ascii");
    tar.write("00000000000\0", offset + 124, "ascii");
    tar.write("ustar\0", offset + 257, "ascii");
  }
  await writeFile(join(documentDir, "large.tar"), tar);
  const documentTools = registerTools(documentPrimitives);
  const documentContext = { cwd: documentDir };
  await measure("documents", "inspect_document", `${Math.round(largeText.length / 1024)} KiB Markdown`, 20, () => documentTools.inspect_document.execute("bench", { path: "large.md", max_chars: 60_000 }, undefined, undefined, documentContext));
  await measure("documents", "summarize_document", `${Math.round(largeText.length / 1024)} KiB Markdown`, 20, () => documentTools.summarize_document.execute("bench", { path: "large.md", max_extract_chars: 60_000 }, undefined, undefined, documentContext));
  await measure("documents", "analyze_csv", "10,000 rows", 20, () => documentTools.analyze_csv.execute("bench", { path: "large.csv", max_rows: 10_000 }, undefined, undefined, documentContext));
  await measure("documents", "inspect_archive", "2,000 TAR entries", 20, () => documentTools.inspect_archive.execute("bench", { path: "large.tar", max_entries: 500 }, undefined, undefined, documentContext));

  // Repository search includes subprocess startup, ripgrep traversal, and output formatting.
  const repoDir = join(root, "repository");
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "benchmark" }));
  await Promise.all(Array.from({ length: 1_000 }, async (_, i) => {
    const dir = join(repoDir, `module-${Math.floor(i / 50)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `service-${i}.ts`), `export function service${i}(input: string) { return input + "marker-${i % 25}"; }\n`);
  }));
  const repoTools: Record<string, any> = {};
  await repoIndexExtension({ registerTool: (tool: any) => { repoTools[tool.name] = tool; }, registerCommand: () => {}, on: () => {} } as any);
  await measure("repository", "code_search lexical", "1,000 TypeScript files", 20, () => repoTools.code_search.execute("bench", { query: "marker-17", mode: "lexical", max_results: 30 }, undefined, undefined, { cwd: repoDir }));
  await measure("repository", "code_search structural", "1,000 TypeScript files", 20, () => repoTools.code_search.execute("bench", { query: "service917", mode: "structural", max_results: 30 }, undefined, undefined, { cwd: repoDir }));

  // Git status/staging costs over a many-file worktree.
  const gitDir = join(root, "git-repository");
  await mkdir(gitDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: gitDir });
  await execFileAsync("git", ["config", "user.email", "bench@example.test"], { cwd: gitDir });
  await execFileAsync("git", ["config", "user.name", "Keylime Benchmark"], { cwd: gitDir });
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => writeFile(join(gitDir, `file-${i}.txt`), `initial ${i}\n`)));
  await execFileAsync("git", ["add", "-A"], { cwd: gitDir });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: gitDir });
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => writeFile(join(gitDir, `file-${i}.txt`), `modified ${i}\n`)));
  await measure("git", "status --short", "1,000 modified files", 20, () => execFileAsync("git", ["status", "--short"], { cwd: gitDir }));
  await measure("git", "checkpoint staging", "1,000 modified files", 5, async i => {
    await writeFile(join(gitDir, `iteration-${i}.txt`), `iteration ${i}\n`);
    stageCheckpointChangesForTest(gitDir);
  });

  // Memory/entity lifecycle CPU and index startup at realistic cardinalities.
  const entityText = Array.from({ length: 500 }, (_, i) => `I worked with Person ${i} at Company ${i % 30} in Brisbane. My colleague Alex manages Project ${i % 50}.`).join(" ");
  await measure("memory", "extractEntities", "500 statements", 100, () => extractEntities(entityText));
  await measure("memory", "candidate extraction + categorization", "500 statements", 100, () => extractCandidates(entityText).map(candidate => classifyCategory(candidate.text)));
  for (const count of [1_000, 10_000]) {
    const memories = Array.from({ length: count }, (_, i) => ({ id: `memory-${i}`, kind: "memory", title: `Memory ${i}`, body: `Preference project context person ${i % 100} category ${i % 8} durable fact` }));
    await measure("memory", "build retrieval index", `${count} memories`, 5, () => buildRetrievalIndex(memories));
  }

  // Control-plane bundles include filesystem reads, normalization, and response serialization.
  const controlState = { cwd: repoDir, dataDir: join(root, "control-data"), runtime: { agentState: "idle", model: { id: "benchmark-model", provider: "local" }, messages: [] } } as any;
  for (const endpoint of ["/api/system", "/api/status", "/api/models", "/api/workspace", "/api/memory", "/api/graph"]) {
    await measure("control-plane", endpoint, "1,000-file workspace", 30, async () => {
      const response = await handleControlPlaneRequest(request(endpoint), controlState);
      await response.arrayBuffer();
    });
  }

  // Browser/UI timing is optional so the rest of the suite remains dependency-light.
  try {
    const { chromium } = await import("playwright");
    await measure("ui", "Chromium startup + static render", "keylime.dc.html", 3, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(await readFile(join(process.cwd(), "ui", "keylime.dc.html"), "utf8"), { waitUntil: "domcontentloaded" });
        await page.locator("body").count();
      } finally {
        await browser.close();
      }
    });
  } catch {
    skipped("ui", "Chromium startup + static render", "Playwright/browser unavailable; install Playwright to enable this row");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

const requestedSubsystems = new Set((process.env.KEYLIME_BENCH_SUBSYSTEMS ?? "").split(",").map(value => value.trim()).filter(Boolean));
const displayedRows = requestedSubsystems.size === 0 ? rows : rows.filter(row => requestedSubsystems.has(row.subsystem));
console.table(displayedRows.map(row => ({
  subsystem: row.subsystem,
  operation: row.operation,
  scale: row.scale,
  iterations: row.iterations,
  medianMs: row.medianMs.toFixed(3),
  p95Ms: row.p95Ms.toFixed(3),
  totalMs: row.totalMs.toFixed(1),
  note: row.note ?? "",
})));
