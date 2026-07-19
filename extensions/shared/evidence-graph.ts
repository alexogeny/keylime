import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readStoredContextObject } from "../context-object-store";

export type EvidenceNode = {
  id: string;
  kind: "claim" | "control" | "file" | "object" | "source_entry";
  contentHash?: string;
  claimId?: string;
  controlId?: string;
  path?: string;
  objectId?: string;
  text?: string;
};
export type EvidenceEdge = { from: string; to: string; kind: "grounded_by" | "verified_by" | "located_in" | "supports" };
export type EvidenceGraph = { version: 1; fingerprint: string; nodes: EvidenceNode[]; edges: EvidenceEdge[]; stats: { claims: number; nodes: number; edges: number; truncatedClaims: number; truncatedEdges: number } };

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const safeId = (value: unknown, max = 160): string => String(value ?? "").replace(/[^a-zA-Z0-9._:@/-]/g, "_").slice(0, max);

function safeRelativePath(path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`Evidence path is outside repository: ${path}`);
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) throw new Error(`Evidence path is outside repository: ${path}`);
  return normalized.slice(0, 500);
}

async function hashRepositoryFile(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const absolute = await realpath(resolve(root, path));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Evidence path escapes repository: ${path}`);
  return sha(await readFile(absolute));
}

function controlClaims(checkpoint: any): any[] {
  const fields = ["constraints", "acceptanceCriteria", "pendingActions", "safetyState", "decisions", "verification", "failures", "blockers"];
  return fields.flatMap(field => (Array.isArray(checkpoint?.[field]) ? checkpoint[field].map((claim: any) => ({ ...claim, field })) : []));
}

export async function buildEvidenceGraph(input: {
  cwd: string;
  checkpoint?: any;
  claims: Array<{ id: string; text: string; sourceEntryIds?: string[]; filePaths?: string[]; objectIds?: string[] }>;
  maxClaims?: number;
  maxEdges?: number;
}): Promise<EvidenceGraph> {
  const maxClaims = Math.max(0, Math.min(10_000, Math.floor(input.maxClaims ?? 2_000)));
  const maxEdges = Math.max(0, Math.min(50_000, Math.floor(input.maxEdges ?? 10_000)));
  const claims = (input.claims ?? []).slice(0, maxClaims);
  const nodes = new Map<string, EvidenceNode>();
  const edges: EvidenceEdge[] = [];
  let truncatedEdges = 0;
  const addNode = (node: EvidenceNode) => { if (!nodes.has(node.id) && nodes.size < maxClaims * 8 + 2_000) nodes.set(node.id, node); };
  const addEdge = (edge: EvidenceEdge) => {
    if (edges.length >= maxEdges) { truncatedEdges++; return; }
    if (!edges.some(item => item.from === edge.from && item.to === edge.to && item.kind === edge.kind)) edges.push(edge);
  };

  const controls = controlClaims(input.checkpoint);
  for (const control of controls.slice(0, 1_000)) {
    if (!control.controlId) continue;
    const id = `control:${safeId(control.controlId)}`;
    addNode({ id, kind: "control", controlId: String(control.controlId), contentHash: control.contentHash ? String(control.contentHash) : sha(String(control.text ?? "")), text: String(control.text ?? "").slice(0, 300) });
  }

  const fileHashes = new Map<string, string>();
  const objectHashes = new Map<string, string>();
  for (const claim of claims) {
    const claimId = safeId(claim.id);
    const claimNodeId = `claim:${claimId}`;
    addNode({ id: claimNodeId, kind: "claim", claimId, contentHash: sha(String(claim.text ?? "")), text: String(claim.text ?? "").slice(0, 500) });

    for (const entryIdRaw of (claim.sourceEntryIds ?? []).slice(0, 50)) {
      const entryId = safeId(entryIdRaw);
      const nodeId = `source:${entryId}`;
      addNode({ id: nodeId, kind: "source_entry", contentHash: sha(entryId) });
      const matchingControl = controls.find(control => (control.sourceEntryIds ?? []).includes(entryIdRaw) && control.controlId);
      if (matchingControl) {
        const controlId = `control:${safeId(matchingControl.controlId)}`;
        addEdge({ from: claimNodeId, to: controlId, kind: "grounded_by" });
      } else addEdge({ from: claimNodeId, to: nodeId, kind: "grounded_by" });
    }

    for (const pathRaw of (claim.filePaths ?? []).slice(0, 50)) {
      const path = safeRelativePath(pathRaw);
      let contentHash = fileHashes.get(path);
      if (!contentHash) { contentHash = await hashRepositoryFile(input.cwd, path); fileHashes.set(path, contentHash); }
      const nodeId = `file:${path}`;
      addNode({ id: nodeId, kind: "file", path, contentHash });
      addEdge({ from: claimNodeId, to: nodeId, kind: "located_in" });
    }

    for (const objectIdRaw of (claim.objectIds ?? []).slice(0, 50)) {
      const objectId = safeId(objectIdRaw);
      let contentHash = objectHashes.get(objectId);
      if (!contentHash) {
        const payload = await readStoredContextObject(input.cwd, objectId);
        contentHash = payload.object.contentHash;
        objectHashes.set(objectId, contentHash);
      }
      const nodeId = `object:${objectId}`;
      addNode({ id: nodeId, kind: "object", objectId, contentHash });
      addEdge({ from: claimNodeId, to: nodeId, kind: "verified_by" });
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => {
    if (a.kind === "control" && b.kind === "control") {
      const aRank = a.controlId?.startsWith("constraints:") ? 0 : 1;
      const bRank = b.controlId?.startsWith("constraints:") ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
    }
    return a.id.localeCompare(b.id);
  });
  const sortedEdges = edges.sort((a, b) => `${a.from}:${a.kind}:${a.to}`.localeCompare(`${b.from}:${b.kind}:${b.to}`));
  validateEvidenceGraph({ nodes: sortedNodes, edges: sortedEdges });
  const body = { version: 1 as const, nodes: sortedNodes, edges: sortedEdges, stats: { claims: claims.length, nodes: sortedNodes.length, edges: sortedEdges.length, truncatedClaims: Math.max(0, input.claims.length - claims.length), truncatedEdges } };
  return { ...body, fingerprint: sha(stable(body)) };
}

export function validateEvidenceGraph(graph: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> }): void {
  const ids = new Set(graph.nodes.map(node => node.id));
  for (const edge of graph.edges) if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Dangling evidence edge: ${edge.from} -> ${edge.to}`);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Evidence graph cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id); for (const next of outgoing.get(id) ?? []) visit(next); visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

export async function verifyEvidenceGraph(graph: EvidenceGraph, cwd: string) {
  const staleNodes: string[] = [];
  for (const node of graph.nodes) {
    try {
      if (node.kind === "file" && node.path && node.contentHash !== await hashRepositoryFile(cwd, node.path)) staleNodes.push(node.id);
      if (node.kind === "object" && node.objectId && node.contentHash !== (await readStoredContextObject(cwd, node.objectId)).object.contentHash) staleNodes.push(node.id);
    } catch { if (node.kind === "file" || node.kind === "object") staleNodes.push(node.id); }
  }
  const staleSet = new Set(staleNodes);
  const staleClaims = graph.nodes.filter(node => node.kind === "claim" && graph.edges.some(edge => edge.from === node.id && staleSet.has(edge.to))).map(node => node.claimId!);
  return { valid: staleNodes.length === 0, staleNodes: staleNodes.sort(), staleClaims: staleClaims.sort() };
}

export function inspectClaims(graph: EvidenceGraph, staleNodeIds: string[] = []) {
  const staleSet = new Set(staleNodeIds);
  const supported: string[] = [], unsupported: string[] = [], stale: string[] = [];
  for (const node of graph.nodes.filter(item => item.kind === "claim")) {
    const evidence = graph.edges.filter(edge => edge.from === node.id);
    if (evidence.some(edge => staleSet.has(edge.to))) stale.push(node.claimId!);
    else if (evidence.length) supported.push(node.claimId!);
    else unsupported.push(node.claimId!);
  }
  return { supported: supported.sort(), unsupported: unsupported.sort(), stale: stale.sort() };
}

export function explainClaim(graph: EvidenceGraph, claimId: string) {
  const id = `claim:${safeId(claimId)}`;
  const claim = graph.nodes.find(node => node.id === id);
  if (!claim) throw new Error(`Unknown claim: ${claimId}`);
  const edges = graph.edges.filter(edge => edge.from === id).slice(0, 100);
  const targets = edges.map(edge => graph.nodes.find(node => node.id === edge.to)).filter(Boolean) as EvidenceNode[];
  const objectIds = targets.filter(node => node.kind === "object").map(node => node.objectId!);
  const filePaths = targets.filter(node => node.kind === "file").map(node => node.path!);
  const controlIds = targets.filter(node => node.kind === "control").map(node => node.controlId!);
  return {
    claimId: safeId(claimId),
    text: `Claim ${safeId(claimId)} has ${edges.length} provenance edge(s): ${edges.map(edge => `${edge.kind}:${edge.to}`).join(", ")}`.slice(0, 1_999),
    objectIds, filePaths, controlIds,
  };
}
