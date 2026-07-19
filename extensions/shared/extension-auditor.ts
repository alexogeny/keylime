import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ExtensionAuditOptions = {
  globalDir: string;
  projectDir: string;
  maxFiles?: number;
  maxSourceCharsPerFile?: number;
};

type ResourceAudit = { package: string; path: string; contentHash: string; bytes: number };
type PackageAudit = {
  name: string; version: string; scope: "global" | "project"; license?: string;
  resources: string[]; resourceHashes: string[]; capabilities: string[];
  hooks: string[]; tools: string[]; commands: string[];
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  fingerprint: string;
};
type Finding = { code: string; package: string; detail?: string };
export type ExtensionAudit = {
  fingerprint: string;
  repositoryFingerprint?: string;
  packages: PackageAudit[];
  resources: ResourceAudit[];
  findings: Finding[];
  collisions: { tools: Array<{ name: string; packages: string[] }>; commands: Array<{ name: string; packages: string[] }>; hooks: Array<{ event: string; packages: string[] }> };
  hookTopology: Array<{ event: string; packages: string[]; resources: string[] }>;
  stats: { filesRead: number; filesVisited: number; retainedSourceChars: 0; truncatedFiles: number };
};

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  : item);
const slash = (path: string): string => path.split(sep).join("/");

async function packageManifests(root: string, maxFiles: number): Promise<string[]> {
  const start = join(root, "packages");
  const found: string[] = [];
  const queue = [start];
  while (queue.length && found.length < maxFiles) {
    const directory = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === "package.json") found.push(path);
      if (found.length >= maxFiles) break;
    }
  }
  return found.sort();
}

function captures(source: string, pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const match of source.matchAll(pattern)) if (match[1]) values.add(match[1]);
  return [...values].sort();
}

function inspectSource(source: string) {
  const hooks = captures(source, /\bpi\.on\(\s*["'`]([^"'`]+)["'`]/g);
  const tools = captures(source, /\b(?:pi\.)?registerTool\s*\(\s*\{[\s\S]{0,800}?\bname\s*:\s*["'`]([^"'`]+)["'`]/g);
  const commands = captures(source, /\b(?:pi\.)?registerCommand\s*\(\s*["'`]([^"'`]+)["'`]/g);
  const capabilities = new Set<string>();
  if (/node:child_process|\b(?:exec|execFile|spawn|fork)\s*\(|Bun\.spawn|Deno\.Command/.test(source)) capabilities.add("process_execution");
  if (/\bfetch\s*\(|node:https?|WebSocket|EventSource/.test(source)) capabilities.add("network");
  if (/node:fs|\b(?:readFile|writeFile|appendFile|rm|rename|chmod|mkdir)\s*\(/.test(source)) capabilities.add("filesystem");
  if (hooks.includes("context") || /appendSystemPrompt|systemPrompt|transformContext/.test(source)) capabilities.add("context_mutation");
  if (hooks.some(value => value === "session_before_compact" || value === "session_after_compact")) capabilities.add("compaction_interception");
  return { hooks, tools, commands, capabilities: [...capabilities].sort() };
}

function collision<T extends "hooks" | "tools" | "commands">(packages: PackageAudit[], field: T, key: T extends "hooks" ? "event" : "name") {
  const owners = new Map<string, Set<string>>();
  for (const item of packages) for (const value of item[field]) {
    const set = owners.get(value) ?? new Set<string>(); set.add(item.name); owners.set(value, set);
  }
  return [...owners.entries()].filter(([, values]) => values.size > 1)
    .map(([value, values]) => ({ [key]: value, packages: [...values].sort() }))
    .sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function escaped(packageRoot: string, resource: string): boolean {
  if (isAbsolute(resource)) return true;
  const rel = relative(packageRoot, resolve(packageRoot, resource));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export async function auditPiExtensionLandscape(options: ExtensionAuditOptions): Promise<ExtensionAudit> {
  const maxFiles = Math.max(1, Math.min(10_000, Math.floor(options.maxFiles ?? 2_000)));
  const maxSourceChars = Math.max(1_000, Math.min(1_000_000, Math.floor(options.maxSourceCharsPerFile ?? 100_000)));
  const findings: Finding[] = [];
  const resources: ResourceAudit[] = [];
  const candidates: PackageAudit[] = [];
  let filesRead = 0, filesVisited = 0, truncatedFiles = 0;

  for (const [scope, root] of [["global", options.globalDir], ["project", options.projectDir]] as const) {
    const manifests = await packageManifests(root, maxFiles - filesVisited);
    for (const manifestPath of manifests) {
      if (filesVisited >= maxFiles) break;
      filesVisited++; filesRead++;
      let manifest: any;
      try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { continue; }
      const name = String(manifest.name ?? basename(dirname(manifestPath)));
      const packageRoot = dirname(manifestPath);
      const declared = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions.map(String) : [];
      if (!manifest.license) findings.push({ code: "missing_license", package: name });
      for (const [dependency, specifier] of Object.entries(manifest.dependencies ?? {})) {
        if (/(?:github:|git\+|\.git(?:#|$))/.test(String(specifier)) && !/#[a-f0-9]{7,40}$/i.test(String(specifier))) {
          findings.push({ code: "unpinned_git_dependency", package: name, detail: dependency });
        }
      }
      const hooks = new Set<string>(), tools = new Set<string>(), commands = new Set<string>(), capabilities = new Set<string>();
      const packageResources: string[] = [], resourceHashes: string[] = [];
      for (const declaredPath of declared) {
        if (escaped(packageRoot, declaredPath)) {
          findings.push({ code: "resource_path_escape", package: name, detail: declaredPath.slice(0, 200) });
          continue;
        }
        if (filesVisited >= maxFiles) break;
        const absolute = resolve(packageRoot, declaredPath);
        try {
          const canonicalRoot = await realpath(packageRoot);
          const canonical = await realpath(absolute);
          if (escaped(canonicalRoot, relative(canonicalRoot, canonical))) {
            findings.push({ code: "resource_path_escape", package: name, detail: declaredPath.slice(0, 200) });
            continue;
          }
          const info = await stat(canonical);
          if (!info.isFile()) continue;
          filesVisited++; filesRead++;
          const raw = await readFile(canonical);
          const contentHash = sha(raw);
          const relativePath = slash(relative(root, canonical));
          resources.push({ package: name, path: relativePath, contentHash, bytes: raw.length });
          packageResources.push(relativePath); resourceHashes.push(contentHash);
          if (raw.length > maxSourceChars) truncatedFiles++;
          const inspected = inspectSource(raw.toString("utf8", 0, Math.min(raw.length, maxSourceChars)));
          inspected.hooks.forEach(value => hooks.add(value)); inspected.tools.forEach(value => tools.add(value));
          inspected.commands.forEach(value => commands.add(value)); inspected.capabilities.forEach(value => capabilities.add(value));
        } catch { /* Missing resources are reported by Pi at load time; the audit remains bounded. */ }
      }
      const reasons = [...capabilities];
      const level: PackageAudit["risk"]["level"] = capabilities.has("process_execution") || capabilities.has("compaction_interception") ? "high"
        : capabilities.size ? "medium" : "low";
      const partial = {
        name, version: String(manifest.version ?? "0.0.0"), scope,
        license: manifest.license ? String(manifest.license) : undefined,
        resources: packageResources.sort(), resourceHashes: resourceHashes.sort(),
        hooks: [...hooks].sort(), tools: [...tools].sort(), commands: [...commands].sort(), capabilities: [...capabilities].sort(),
        risk: { level, reasons },
      };
      candidates.push({ ...partial, fingerprint: sha(stable(partial)) });
    }
  }

  const selected = new Map<string, PackageAudit>();
  for (const item of candidates.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "global" ? -1 : 1))) selected.set(item.name, item);
  const packages = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  const selectedNames = new Set(packages.map(item => item.name));
  const selectedResources = resources.filter(item => selectedNames.has(item.package) && packages.find(pkg => pkg.name === item.package)?.resourceHashes.includes(item.contentHash))
    .sort((a, b) => a.path.localeCompare(b.path));
  const events = new Map<string, { packages: Set<string>; resources: Set<string> }>();
  for (const item of packages) for (const event of item.hooks) {
    const topology = events.get(event) ?? { packages: new Set(), resources: new Set() };
    topology.packages.add(item.name); item.resources.forEach(path => topology.resources.add(path)); events.set(event, topology);
  }
  const hookTopology = [...events.entries()].map(([event, value]) => ({ event, packages: [...value.packages].sort(), resources: [...value.resources].sort() })).sort((a, b) => a.event.localeCompare(b.event));
  const auditBase = {
    packages, resources: selectedResources, findings: findings.sort((a, b) => `${a.code}:${a.package}`.localeCompare(`${b.code}:${b.package}`)),
    collisions: {
      tools: collision(packages, "tools", "name") as Array<{ name: string; packages: string[] }>,
      commands: collision(packages, "commands", "name") as Array<{ name: string; packages: string[] }>,
      hooks: collision(packages, "hooks", "event") as Array<{ event: string; packages: string[] }>,
    },
    hookTopology,
    stats: { filesRead, filesVisited, retainedSourceChars: 0 as const, truncatedFiles },
  };
  return { ...auditBase, fingerprint: sha(stable(auditBase)) };
}

export function diffExtensionAudits(before: ExtensionAudit, after: ExtensionAudit) {
  const prior = new Map(before.packages.map(item => [item.name, item.fingerprint]));
  const next = new Map(after.packages.map(item => [item.name, item.fingerprint]));
  return {
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    addedPackages: [...next.keys()].filter(name => !prior.has(name)).sort(),
    removedPackages: [...prior.keys()].filter(name => !next.has(name)).sort(),
    changedPackages: [...next.keys()].filter(name => prior.has(name) && prior.get(name) !== next.get(name)).sort(),
  };
}

export async function auditCurrentHarness(cwd: string, options: { maxFiles?: number; maxSourceCharsPerFile?: number } = {}) {
  const maxFiles = Math.max(1, Math.min(10_000, options.maxFiles ?? 2_000));
  const maxChars = Math.max(1_000, Math.min(1_000_000, options.maxSourceCharsPerFile ?? 100_000));
  const root = await realpath(cwd);
  const queue = [join(root, "extensions")];
  const resources: ResourceAudit[] = [];
  const topology = new Map<string, Set<string>>();
  let filesRead = 0, truncatedFiles = 0;
  while (queue.length && filesRead < maxFiles) {
    const directory = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile() && /\.(?:ts|js|mjs|cjs)$/.test(entry.name)) {
        const raw = await readFile(absolute); filesRead++;
        if (raw.length > maxChars) truncatedFiles++;
        const path = slash(relative(root, absolute));
        resources.push({ package: "keylime", path, contentHash: sha(raw), bytes: raw.length });
        for (const event of inspectSource(raw.toString("utf8", 0, Math.min(raw.length, maxChars))).hooks) {
          const paths = topology.get(event) ?? new Set<string>(); paths.add(path); topology.set(event, paths);
        }
      }
      if (filesRead >= maxFiles) break;
    }
  }
  const hookTopology = [...topology.entries()].map(([event, paths]) => ({ event, packages: ["keylime"], resources: [...paths].sort() })).sort((a, b) => a.event.localeCompare(b.event));
  const base = { packages: [], resources: resources.sort((a, b) => a.path.localeCompare(b.path)), findings: [], collisions: { tools: [], commands: [], hooks: [] }, hookTopology, stats: { filesRead, filesVisited: filesRead, retainedSourceChars: 0 as const, truncatedFiles } };
  return { ...base, repositoryFingerprint: sha(root), fingerprint: sha(stable(base)) };
}

export function renderExtensionAuditReport(audit: ExtensionAudit): string {
  const lines = [
    `Extension audit ${audit.fingerprint}`,
    `Packages: ${audit.packages.length}; resources: ${audit.resources.length}; findings: ${audit.findings.length}`,
    ...audit.packages.slice(0, 200).map(item => `- ${item.name}@${item.version} [${item.scope}] risk=${item.risk.level} capabilities=${item.capabilities.join(",") || "none"}`),
    ...audit.findings.slice(0, 200).map(item => `! ${item.code}: ${item.package}${item.detail ? ` (${item.detail})` : ""}`),
    ...audit.hookTopology.slice(0, 100).map(item => `hook ${item.event}: ${item.packages.join(", ")}`),
  ];
  return lines.join("\n").slice(0, 19_999);
}
