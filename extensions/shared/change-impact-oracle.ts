import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const slash = (value: string): string => value.split(sep).join("/");

type ImpactEdge = { from: string; to: string; kind: "imports" | "lsp" };
type ImpactPlan = {
  repositoryFingerprint: string; changedPaths: string[]; affectedFiles: string[]; selectedTests: string[]; edges: ImpactEdge[];
  verificationCommands: string[]; scope: "targeted" | "repository"; risk: { level: "low" | "medium" | "high"; reasons: string[] };
  stats: { repositoryScans: number; filesParsed: number; duplicateFileReads: number; lspProcessesSpawned: number };
  escalationHistory: any[];
  _allFiles?: string[];
};

async function sourceFiles(cwd: string, maxFiles: number): Promise<string[]> {
  const result: string[] = [], queue = [cwd];
  const ignored = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage"]);
  while (queue.length && result.length < maxFiles) {
    const directory = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) queue.push(join(directory, entry.name)); }
      else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(entry.name)) result.push(slash(relative(cwd, join(directory, entry.name))));
      if (result.length >= maxFiles) break;
    }
  }
  return result.sort();
}

function resolveImport(from: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return;
  const base = slash(normalize(join(dirname(from), specifier)));
  const candidates = extname(base) ? [base] : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.js`];
  return candidates.find(candidate => files.has(candidate));
}
function importedSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g, /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1]);
  return [...found];
}
function reverseClosure(changed: string[], edges: ImpactEdge[]): string[] {
  const reverse = new Map<string, string[]>();
  for (const edge of edges) reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge.from]);
  const seen = new Set(changed), queue = [...changed];
  while (queue.length) for (const parent of reverse.get(queue.shift()!) ?? []) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
  return [...seen].sort();
}
const isTest = (path: string): boolean => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(path);
const broadPath = (path: string): boolean => /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);

export async function buildChangeImpactPlan(input: {
  cwd: string; changedPaths: string[]; deletedPaths?: string[]; maxFiles?: number; maxEdges?: number;
  lspSignals?: Array<{ kind: string; from: string; to: string }>; lspEnabled?: boolean;
}): Promise<ImpactPlan> {
  const root = await realpath(input.cwd);
  const maxFiles = Math.max(1, Math.min(20_000, Math.floor(input.maxFiles ?? 5_000)));
  const maxEdges = Math.max(1, Math.min(100_000, Math.floor(input.maxEdges ?? 20_000)));
  const files = await sourceFiles(root, maxFiles);
  const fileSet = new Set(files);
  const sources = await Promise.all(files.map(async path => [path, await readFile(resolve(root, path), "utf8")] as const));
  const edges: ImpactEdge[] = [];
  for (const [from, source] of sources) for (const specifier of importedSpecifiers(source)) {
    const to = resolveImport(from, specifier, fileSet);
    if (to && edges.length < maxEdges) edges.push({ from, to, kind: "imports" });
  }
  for (const signal of input.lspSignals ?? []) if (edges.length < maxEdges && fileSet.has(signal.from) && fileSet.has(signal.to)) edges.push({ from: signal.from, to: signal.to, kind: "lsp" });
  const changedPaths = [...new Set((input.changedPaths ?? []).map(path => slash(path.replace(/^\.\//, ""))))].sort();
  const broad = changedPaths.some(broadPath);
  const affectedFiles = broad ? files : reverseClosure(changedPaths, edges);
  const selectedTests = (broad ? files.filter(isTest) : affectedFiles.filter(isTest)).sort();
  const reasons: string[] = [];
  if (broad) reasons.push("repository_configuration_changed");
  if ((input.deletedPaths ?? []).length) reasons.push("deleted_dependency");
  const riskLevel: ImpactPlan["risk"]["level"] = broad || reasons.includes("deleted_dependency") ? "high" : affectedFiles.length > 20 ? "medium" : "low";
  const verificationCommands = broad ? ["bun run typecheck", "bun test"] : selectedTests.length ? [`bun test ${selectedTests.join(" ")}`] : ["bun run typecheck"];
  const plan: ImpactPlan = {
    repositoryFingerprint: sha(root), changedPaths, affectedFiles, selectedTests, edges: edges.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    verificationCommands, scope: broad ? "repository" : "targeted", risk: { level: riskLevel, reasons },
    stats: { repositoryScans: 1, filesParsed: files.length, duplicateFileReads: 0, lspProcessesSpawned: 0 }, escalationHistory: [],
  };
  Object.defineProperty(plan, "_allFiles", { value: files, enumerable: false });
  return plan;
}

export function explainImpactSelection(plan: ImpactPlan, selectedPath: string) {
  const targets = new Set(plan.changedPaths);
  const queue: Array<{ node: string; path: string[] }> = [{ node: selectedPath, path: [selectedPath] }];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (targets.has(current.node)) return { path: current.path, reason: current.path.length > 2 ? "transitive import impact" : "direct import impact" };
    if (seen.has(current.node)) continue; seen.add(current.node);
    for (const edge of plan.edges.filter(edge => edge.from === current.node)) queue.push({ node: edge.to, path: [...current.path, edge.to] });
  }
  return { path: [selectedPath], reason: "repository-wide risk" };
}

export function expandImpactPlan(plan: ImpactPlan, failure: { command: string; passed: boolean; diagnosticPaths?: string[] }): ImpactPlan {
  if (failure.passed) return plan;
  const diagnosticPaths = (failure.diagnosticPaths ?? []).map(path => slash(path));
  const expandedAffected = reverseClosure([...plan.changedPaths, ...diagnosticPaths], plan.edges);
  const selectedTests = expandedAffected.filter(isTest).sort();
  const allTests = (plan._allFiles ?? []).filter(isTest);
  const widened = selectedTests.length > plan.selectedTests.length ? selectedTests : [...new Set([...plan.selectedTests, ...allTests])].sort();
  const expanded: ImpactPlan = {
    ...plan, affectedFiles: expandedAffected, selectedTests: widened,
    verificationCommands: widened.length ? [`bun test ${widened.join(" ")}`, "bun run typecheck"] : ["bun test", "bun run typecheck"],
    risk: { level: "high", reasons: [...new Set([...plan.risk.reasons, "targeted_verification_failed"])] },
    escalationHistory: [...plan.escalationHistory, { command: failure.command.slice(0, 500), diagnosticPathCount: diagnosticPaths.length }],
  };
  Object.defineProperty(expanded, "_allFiles", { value: plan._allFiles, enumerable: false });
  return expanded;
}
