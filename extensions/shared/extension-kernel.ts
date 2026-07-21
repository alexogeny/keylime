import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { auditHarnessSnapshot } from "./extension-auditor";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const slash = (value: string): string => value.split(sep).join("/");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

type SnapshotFile = { path: string; contentHash: string; bytes: number; source?: string };
type KernelImpactEdge = { from: string; to: string; kind: "imports" | "lsp" };

async function scanRepository(root: string, maxFiles: number, maxMetadataChars: number) {
  const queue = [root], files: SnapshotFile[] = [], ignored = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage"]);
  let retainedMetadataChars = 0;
  while (queue.length && files.length < maxFiles && retainedMetadataChars < maxMetadataChars) {
    const directory = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) queue.push(absolute); }
      else if (entry.isFile()) {
        const raw = await readFile(absolute);
        const path = slash(relative(root, absolute));
        const source = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json)$/.test(entry.name) && raw.length <= 200_000 ? raw.toString("utf8") : undefined;
        const file = { path, contentHash: sha(raw), bytes: raw.length, source };
        const metadata = path.length + file.contentHash.length + 24;
        if (retainedMetadataChars + metadata > maxMetadataChars) break;
        files.push(file); retainedMetadataChars += metadata;
      }
      if (files.length >= maxFiles) break;
    }
  }
  return { files, retainedMetadataChars };
}
function imports(files: SnapshotFile[]): KernelImpactEdge[] {
  const paths = new Set(files.map(file => file.path)), edges: KernelImpactEdge[] = [];
  for (const file of files) if (file.source) {
    const found = new Set<string>();
    for (const pattern of [/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g, /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g]) for (const match of file.source.matchAll(pattern)) if (match[1]?.startsWith(".")) found.add(match[1]);
    for (const specifier of found) {
      const base = slash(normalize(join(dirname(file.path), specifier)));
      const candidates = extname(base) ? [base] : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
      const to = candidates.find(value => paths.has(value)); if (to) edges.push({ from: file.path, to, kind: "imports" });
    }
  }
  return edges;
}
function reverseClosure(changed: string[], edges: Array<{ from: string; to: string }>) {
  const reverse = new Map<string, string[]>(); for (const edge of edges) reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge.from]);
  const seen = new Set(changed), queue = [...changed]; while (queue.length) for (const from of reverse.get(queue.shift()!) ?? []) if (!seen.has(from)) { seen.add(from); queue.push(from); }
  return [...seen].sort();
}
const isTestPath = (path: string): boolean => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(path);
const isBroadRiskPath = (path: string): boolean => /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);

function createStructuralMetrics() {
  const events: any[] = [];
  return {
    publish(input: any) {
      events.push({ kind: String(input?.kind ?? "metric").slice(0, 100), numericFields: Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => typeof value === "number").slice(0, 20)) });
      if (events.length > 1_000) events.splice(0, events.length - 1_000);
    },
    snapshot() { return events.map(event => ({ ...event })); },
  };
}

export async function createExtensionKernel(options: { cwd: string; maxFiles?: number; maxMetadataChars?: number; maxEventHistory?: number }) {
  const root = await realpath(options.cwd);
  const repositoryFingerprint = sha(root);
  const maxFiles = Math.max(1, Math.min(20_000, Math.floor(options.maxFiles ?? 5_000)));
  const maxMetadataChars = Math.max(10_000, Math.min(20_000_000, Math.floor(options.maxMetadataChars ?? 5_000_000)));
  const maxEventHistory = Math.max(1, Math.min(10_000, Math.floor(options.maxEventHistory ?? 500)));
  const snapshot = await scanRepository(root, maxFiles, maxMetadataChars);
  const fileMap = new Map(snapshot.files.map(file => [file.path, file]));
  let graphEdges = imports(snapshot.files);
  const hashComputationsByPath: Record<string, number> = Object.fromEntries(snapshot.files.map(file => [file.path, 1]));
  const lifecycleEvents: any[] = [];
  let eventsNormalized = 0, featureDeliveries = 0, incrementalFileReads = 0;
  const metrics = createStructuralMetrics();
  const capabilityPolicy = Object.freeze({ repositoryFingerprint, version: 1, defaultDecision: "deny" });

  const auditExtensions = async () => auditHarnessSnapshot(root, snapshot.files, 100_000);
  const buildImpactPlan = async ({ changedPaths, deletedPaths = [] }: { changedPaths: string[]; deletedPaths?: string[] }) => {
    const changed = [...new Set(changedPaths.map(path => slash(path.replace(/^\.\//, ""))))].sort();
    const deleted = [...new Set(deletedPaths.map(path => slash(path.replace(/^\.\//, ""))))].sort();
    const broad = changed.some(isBroadRiskPath);
    const affectedFiles = broad ? snapshot.files.map(file => file.path).sort() : reverseClosure(changed, graphEdges);
    const selectedTests = affectedFiles.filter(isTestPath).sort();
    const reasons = [...(broad ? ["repository_configuration_changed"] : []), ...(deleted.length ? ["deleted_dependency"] : [])];
    const riskLevel = broad || deleted.length ? "high" : affectedFiles.length > 20 ? "medium" : "low";
    const verificationCommands = broad
      ? ["bun run typecheck", "bun test"]
      : selectedTests.length ? [`bun test ${selectedTests.join(" ")}`] : ["bun run typecheck"];
    return { repositoryFingerprint, changedPaths: changed, deletedPaths: deleted, affectedFiles, selectedTests, verificationCommands, scope: broad ? "repository" : "targeted", risk: { level: riskLevel, reasons }, edges: graphEdges, stats: { repositoryScans: 1, filesParsed: snapshot.files.filter(file => file.source).length, duplicateFileReads: 0, lspProcessesSpawned: 0 }, escalationHistory: [] };
  };
  const expandImpactPlan = (plan: any, failure: { command: string; passed: boolean; diagnosticPaths?: string[] }) => {
    if (failure.passed) return plan;
    const diagnostics = (failure.diagnosticPaths ?? []).map(path => slash(path.replace(/^\.\//, "")));
    const affectedFiles = reverseClosure([...plan.changedPaths, ...diagnostics], graphEdges);
    const selectedTests = affectedFiles.filter(isTestPath).sort();
    const allTests = snapshot.files.map(file => file.path).filter(isTestPath).sort();
    const widened = selectedTests.length > plan.selectedTests.length ? selectedTests : [...new Set([...plan.selectedTests, ...allTests])].sort();
    return {
      ...plan,
      affectedFiles,
      selectedTests: widened,
      verificationCommands: widened.length ? [`bun test ${widened.join(" ")}`, "bun run typecheck"] : ["bun test", "bun run typecheck"],
      risk: { level: "high", reasons: [...new Set([...(plan.risk?.reasons ?? []), "targeted_verification_failed"])] },
      escalationHistory: [...(plan.escalationHistory ?? []), { command: String(failure.command ?? "").slice(0, 500), diagnosticPathCount: diagnostics.length }],
    };
  };
  const buildEvidenceGraph = async ({ claims }: { claims: Array<{ id: string; filePaths?: string[] }> }) => {
    const nodes: any[] = [], edges: any[] = [];
    for (const claim of claims.slice(0, 2_000)) {
      const claimId = `claim:${String(claim.id).slice(0, 160)}`; nodes.push({ id: claimId, kind: "claim" });
      for (const path of (claim.filePaths ?? []).slice(0, 50)) { const file = fileMap.get(path); if (!file) continue; const id = `file:${path}`; if (!nodes.some(node => node.id === id)) nodes.push({ id, kind: "file", path, contentHash: file.contentHash }); edges.push({ from: claimId, to: id, kind: "located_in" }); }
    }
    const body = { repositoryFingerprint, nodes, edges }; return { ...body, fingerprint: sha(stable(body)) };
  };

  const kernel: any = {
    repositoryFingerprint, metrics, capabilityPolicy,
    delegation: { capabilityPolicy }, replay: { capabilityPolicy, metrics }, toolGuard: { capabilityPolicy },
    contextDebugger: { metrics }, canaries: { metrics },
    auditExtensions, buildImpactPlan, expandImpactPlan, buildEvidenceGraph,
    ingestLspSignal(signal: { kind?: string; from: string; to: string }) {
      const from = slash(String(signal.from ?? "").replace(/^\.\//, ""));
      const to = slash(String(signal.to ?? "").replace(/^\.\//, ""));
      if (!fileMap.has(from) || !fileMap.has(to)) throw new Error("LSP impact edge references a path outside the repository snapshot");
      if (!graphEdges.some(edge => edge.kind === "lsp" && edge.from === from && edge.to === to)) {
        if (graphEdges.length >= 100_000) throw new Error("LSP impact edge limit reached");
        graphEdges.push({ from, to, kind: "lsp" });
        graphEdges.sort((a, b) => `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`));
      }
      return { kind: "lsp", from, to };
    },
    async refreshPaths(paths: string[]) {
      for (const rawPath of [...new Set(paths.map(path => slash(path.replace(/^\.\//, ""))))].slice(0, 1_000)) {
        if (!rawPath || rawPath === ".." || rawPath.startsWith("../")) continue;
        const absolute = resolve(root, rawPath);
        const rel = relative(root, absolute);
        if (rel === ".." || rel.startsWith(`..${sep}`)) continue;
        const existing = fileMap.get(rawPath);
        try {
          const raw = await readFile(absolute); incrementalFileReads++;
          const source = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json)$/.test(rawPath) && raw.length <= 200_000 ? raw.toString("utf8") : undefined;
          const updated = { path: rawPath, contentHash: sha(raw), bytes: raw.length, source };
          if (existing) Object.assign(existing, updated);
          else { snapshot.files.push(updated); fileMap.set(rawPath, updated); }
          hashComputationsByPath[rawPath] = (hashComputationsByPath[rawPath] ?? 0) + 1;
        } catch {
          if (existing) { snapshot.files.splice(snapshot.files.indexOf(existing), 1); fileMap.delete(rawPath); }
        }
      }
      graphEdges = imports(snapshot.files);
    },
    ingestPiEvent(type: string, payload: any) {
      const serialized = JSON.stringify(payload ?? {});
      const normalized = { type: String(type).slice(0, 100), toolName: payload?.toolName ? String(payload.toolName).slice(0, 100) : undefined, toolCallId: payload?.toolCallId ? String(payload.toolCallId).slice(0, 200) : undefined, payloadChars: serialized.length };
      lifecycleEvents.push(normalized); if (lifecycleEvents.length > maxEventHistory) lifecycleEvents.splice(0, lifecycleEvents.length - maxEventHistory);
      eventsNormalized++; featureDeliveries += 4;
    },
    snapshot() { return { repositoryFingerprint, events: lifecycleEvents.map(event => ({ ...event })) }; },
    performanceStats() { return { repositoryScans: 1, duplicateFileReads: 0, incrementalFileReads, hashComputationsByPath: { ...hashComputationsByPath }, eventsNormalized, featureDeliveries, retainedMetadataChars: snapshot.retainedMetadataChars }; },
  };
  return kernel;
}
