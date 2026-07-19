import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export type CapabilityLeaseRequest = {
  intentId: string; trustedSourceEntryId: string; tools: string[]; paths: string[]; operations: string[];
  commandPatterns?: string[]; expiresAfterTurns?: number; expiresAfterMs?: number; requiresVerification?: boolean;
};
type Lease = CapabilityLeaseRequest & {
  id: string; repositoryFingerprint: string; sessionId: string; issuedAt: number; expiresAt: number;
  issuedTurn: number; active: boolean; parentLeaseId?: string; mutations: Set<string>; verificationPassed: boolean;
};

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedStrings = (values: unknown[], max: number, chars = 300): string[] => [...new Set(values.map(value => String(value).slice(0, chars)))].sort().slice(0, max);

function pathMatches(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern === "**") return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalizedPattern;
}
function subset(values: string[], allowed: string[]): boolean { return values.every(value => allowed.includes(value)); }

export async function createCapabilityLeaseManager(options: { cwd: string; sessionId: string; maxLeases?: number; maxAuditRecords?: number }) {
  const canonicalRoot = await realpath(options.cwd);
  const repositoryFingerprint = sha(canonicalRoot);
  const maxLeases = Math.max(1, Math.min(1_000, Math.floor(options.maxLeases ?? 100)));
  const maxAuditRecords = Math.max(1, Math.min(10_000, Math.floor(options.maxAuditRecords ?? 500)));
  const leases = new Map<string, Lease>();
  const auditRecords: any[] = [];
  let turn = 0;

  const record = (value: Record<string, unknown>) => {
    auditRecords.push({ timestamp: Date.now(), ...value });
    if (auditRecords.length > maxAuditRecords) auditRecords.splice(0, auditRecords.length - maxAuditRecords);
  };
  const deactivateOldest = () => {
    while ([...leases.values()].filter(lease => lease.active).length > maxLeases) {
      const oldest = [...leases.values()].filter(lease => lease.active).sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id))[0];
      if (!oldest) break; oldest.active = false; record({ leaseId: oldest.id, action: "evicted", allowed: false });
    }
  };
  const normalizeRequest = (request: CapabilityLeaseRequest): CapabilityLeaseRequest => ({
    intentId: String(request.intentId).slice(0, 200),
    trustedSourceEntryId: String(request.trustedSourceEntryId).slice(0, 200),
    tools: boundedStrings(request.tools ?? [], 100), paths: boundedStrings(request.paths ?? [], 100), operations: boundedStrings(request.operations ?? [], 100),
    commandPatterns: boundedStrings(request.commandPatterns ?? [], 50, 500),
    expiresAfterTurns: Math.max(1, Math.min(1_000, Math.floor(request.expiresAfterTurns ?? 1))),
    expiresAfterMs: Math.max(1, Math.min(86_400_000, Math.floor(request.expiresAfterMs ?? 60_000))),
    requiresVerification: Boolean(request.requiresVerification),
  });
  const issueLease = (request: CapabilityLeaseRequest, parentLeaseId?: string): Lease => {
    const normalized = normalizeRequest(request);
    const issuedAt = Date.now();
    const id = sha(`${repositoryFingerprint}:${options.sessionId}:${normalized.intentId}:${issuedAt}:${randomUUID()}`);
    const lease: Lease = {
      ...normalized, id, repositoryFingerprint, sessionId: options.sessionId, issuedAt,
      expiresAt: issuedAt + (normalized.expiresAfterMs ?? 60_000), issuedTurn: turn, active: true,
      parentLeaseId, mutations: new Set(), verificationPassed: false,
    };
    leases.set(id, lease); deactivateOldest(); return lease;
  };
  const publicLease = (lease: Lease) => ({
    id: lease.id, repositoryFingerprint: lease.repositoryFingerprint, sessionId: lease.sessionId,
    intentId: lease.intentId, trustedSourceEntryId: lease.trustedSourceEntryId, tools: lease.tools, paths: lease.paths,
    operations: lease.operations, commandPatterns: lease.commandPatterns, expiresAt: lease.expiresAt,
    expiresAfterTurns: lease.expiresAfterTurns, requiresVerification: lease.requiresVerification, parentLeaseId: lease.parentLeaseId,
  });
  const invalidReason = (lease: Lease | undefined): string | undefined => {
    if (!lease) return "unknown lease";
    if (!lease.active) return "inactive lease";
    if (Date.now() >= lease.expiresAt) { lease.active = false; return "expired wall-clock lease"; }
    if (turn - lease.issuedTurn >= (lease.expiresAfterTurns ?? 1)) { lease.active = false; return "expired turn lease"; }
    return;
  };
  const authorizePath = (pathRaw: string, patterns: string[]): boolean => {
    if (!pathRaw || isAbsolute(pathRaw)) return false;
    const path = pathRaw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (path === ".." || path.startsWith("../") || path.includes("/../")) return false;
    const absolute = resolve(canonicalRoot, path);
    const rel = relative(canonicalRoot, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    if (existsSync(absolute)) {
      const actual = realpathSync(absolute);
      const actualRel = relative(canonicalRoot, actual);
      if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) return false;
    }
    return patterns.some(pattern => pathMatches(pattern, path));
  };

  return {
    issue(request: CapabilityLeaseRequest) { return publicLease(issueLease(request)); },
    authorize(id: string, action: { tool: string; operation: string; paths?: string[]; command?: string; sessionId?: string; repositoryFingerprint?: string; [key: string]: unknown }) {
      const lease = leases.get(id); let reason = invalidReason(lease);
      if (!reason && action.sessionId && action.sessionId !== options.sessionId) reason = "session identity mismatch";
      if (!reason && action.repositoryFingerprint && action.repositoryFingerprint !== repositoryFingerprint) reason = "repository identity mismatch";
      if (!reason && !lease!.tools.includes(action.tool)) reason = "tool not leased";
      if (!reason && !lease!.operations.includes(action.operation)) reason = "operation not leased";
      if (!reason && (action.paths ?? []).some(path => !authorizePath(path, lease!.paths))) reason = "path outside lease scope";
      if (!reason && action.command) {
        if (/[;&|`]|\$\(|\r|\n/.test(action.command)) reason = "unsafe command composition";
        else if (!(lease!.commandPatterns ?? []).some(pattern => { try { return new RegExp(pattern).test(action.command!); } catch { return false; } })) reason = "command not leased";
      }
      const allowed = !reason;
      record({ leaseId: id, tool: String(action.tool).slice(0, 100), operation: String(action.operation).slice(0, 100), allowed, reason, pathCount: action.paths?.length ?? 0 });
      return { allowed, reason };
    },
    recordMutation(id: string, paths: string[]) {
      const lease = leases.get(id); if (invalidReason(lease)) return false;
      for (const path of paths.slice(0, 100)) if (authorizePath(path, lease!.paths)) lease!.mutations.add(path.replace(/\\/g, "/"));
      record({ leaseId: id, action: "mutation", allowed: true, pathCount: lease!.mutations.size }); return true;
    },
    recordVerification(id: string, result: { passed: boolean; command?: string }) {
      const lease = leases.get(id); if (invalidReason(lease)) return false;
      lease!.verificationPassed = Boolean(result.passed); record({ leaseId: id, action: "verification", allowed: Boolean(result.passed) }); return true;
    },
    complete(id: string) {
      const lease = leases.get(id); const reason = invalidReason(lease);
      if (reason) return { accepted: false, reason };
      if (lease!.requiresVerification && lease!.mutations.size > 0 && !lease!.verificationPassed) return { accepted: false, reason: "verification required" };
      lease!.active = false; record({ leaseId: id, action: "completed", allowed: true }); return { accepted: true };
    },
    derive(parentId: string, request: CapabilityLeaseRequest) {
      const parent = leases.get(parentId); const reason = invalidReason(parent); if (reason) throw new Error(reason);
      const child = normalizeRequest(request);
      if (!subset(child.tools, parent!.tools) || !subset(child.operations, parent!.operations)) throw new Error("Cannot broaden delegated authority");
      if (!child.paths.every(path => parent!.paths.some(pattern => path === pattern || (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -3)))))) throw new Error("Cannot broaden path authority");
      if ((child.expiresAfterTurns ?? 1) > (parent!.expiresAfterTurns ?? 1) || (child.expiresAfterMs ?? 1) > (parent!.expiresAfterMs ?? 1)) throw new Error("Cannot broaden lease budget");
      const remainingMs = Math.max(1, parent!.expiresAt - Date.now());
      return publicLease(issueLease({ ...child, expiresAfterMs: Math.min(child.expiresAfterMs ?? remainingMs, remainingMs) }, parentId));
    },
    handleBoundary(boundary: string) {
      if (boundary === "turn_end") { turn++; return; }
      if (boundary === "session_before_compact" || boundary === "session_shutdown") for (const lease of leases.values()) lease.active = false;
      record({ action: boundary.slice(0, 100), allowed: true });
    },
    audit() { return auditRecords.map(record => ({ ...record })); },
    memoryStats() { return { activeLeases: [...leases.values()].filter(lease => lease.active).length, auditRecords: auditRecords.length }; },
  };
}
