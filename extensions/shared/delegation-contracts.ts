import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readStoredContextObject } from "../context-object-store";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const strings = (values: unknown[], max = 100): string[] => [...new Set(values.map(String))].sort().slice(0, max);
const repoFingerprint = (cwd: string): string => sha(realpathSync(cwd));

function controls(checkpoint: any) {
  const result: Array<{ controlId: string; contentHash: string; kind: string; status: string }> = [];
  for (const kind of ["constraints", "acceptanceCriteria", "pendingActions", "safetyState"]) for (const control of checkpoint?.[kind] ?? []) {
    if (control.status === "superseded" || !control.controlId || !control.contentHash) continue;
    result.push({ controlId: String(control.controlId), contentHash: String(control.contentHash), kind, status: String(control.status ?? "active") });
  }
  return result.sort((a, b) => a.controlId.localeCompare(b.controlId));
}
function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) { const prefix = pattern.slice(0, -3).replace(/\/$/, ""); return path === prefix || path.startsWith(`${prefix}/`); }
  return pattern === path;
}
function safePath(path: string): boolean {
  const value = path.replace(/\\/g, "/");
  return Boolean(value) && !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.includes("/../");
}

export async function createDelegationContract(input: any) {
  const body = {
    version: 1 as const,
    schema: String(input.requiredResultSchema ?? "keylime-delegation-result-v1"),
    repositoryFingerprint: repoFingerprint(input.cwd),
    goal: String(input.goal ?? "").slice(0, 500),
    controls: controls(input.checkpoint),
    tools: strings(input.tools ?? []), paths: strings(input.paths ?? []),
    budgets: {
      maxInputTokens: Math.max(0, Math.floor(input.maxInputTokens ?? 0)),
      maxOutputTokens: Math.max(0, Math.floor(input.maxOutputTokens ?? 0)),
      timeoutMs: Math.max(1, Math.floor(input.timeoutMs ?? 60_000)),
    },
    maxDepth: Math.max(0, Math.floor(input.maxDepth ?? 0)),
    requiredVerification: strings(input.requiredVerification ?? [], 50),
  };
  return { ...body, id: sha(stable(body)) };
}

export function deriveDelegationContract(parent: any, request: any) {
  const tools = strings(request.tools ?? parent.tools), paths = strings(request.paths ?? parent.paths);
  if (!tools.every(tool => parent.tools.includes(tool))) throw new Error("Cannot broaden delegated tool authority");
  if (!paths.every(path => parent.paths.some((pattern: string) => pathMatches(pattern, path)))) throw new Error("Cannot broaden delegated path authority");
  const maxInputTokens = Number(request.maxInputTokens ?? parent.budgets.maxInputTokens);
  const maxOutputTokens = Number(request.maxOutputTokens ?? parent.budgets.maxOutputTokens);
  const timeoutMs = Number(request.timeoutMs ?? parent.budgets.timeoutMs);
  if (maxInputTokens > parent.budgets.maxInputTokens || maxOutputTokens > parent.budgets.maxOutputTokens || timeoutMs > parent.budgets.timeoutMs) throw new Error("Cannot broaden delegation budget");
  const maxDepth = Number(request.maxDepth ?? parent.maxDepth);
  if (maxDepth > parent.maxDepth) throw new Error("Cannot broaden delegation depth");
  const body = { ...parent, tools, paths, budgets: { maxInputTokens, maxOutputTokens, timeoutMs }, maxDepth, parentContractId: parent.id };
  delete body.id;
  return { ...body, id: sha(stable(body)) };
}

export function validateDelegationResult(contract: any, result: any, cwd: string): Promise<any> {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Delegation result schema is invalid");
  if (result.version !== 1) throw new Error("Delegation result schema version is invalid");
  if (result.contractId !== contract.id) throw new Error("Delegation result contract mismatch");
  if (result.repositoryFingerprint !== contract.repositoryFingerprint || repoFingerprint(cwd) !== contract.repositoryFingerprint) throw new Error("Delegation result repository mismatch");
  const changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths.map(String) : [];
  if (changedPaths.some(path => !safePath(path) || !contract.paths.some((pattern: string) => pathMatches(pattern, path.replace(/\\/g, "/"))))) throw new Error("Delegation changed path is outside scope");
  const usage = result.usage ?? {};
  if (Number(usage.inputTokens ?? 0) > contract.budgets.maxInputTokens || Number(usage.outputTokens ?? 0) > contract.budgets.maxOutputTokens || Number(usage.durationMs ?? 0) > contract.budgets.timeoutMs) throw new Error("Delegation budget exceeded");
  for (const required of contract.requiredVerification ?? []) {
    if (!(result.verification ?? []).some((item: any) => item.command === required && item.passed === true)) throw new Error(`Required delegation verification failed: ${required}`);
  }
  return (async () => {
    let evidenceVerified = 0;
    for (const objectId of strings(result.evidenceObjectIds ?? [], 1_000)) { await readStoredContextObject(cwd, objectId); evidenceVerified++; }
    return { accepted: true, evidenceVerified, changedPaths, verification: result.verification ?? [] };
  })();
}

export function serializeDelegationContract(contract: any): string { return stable(contract); }

export function normalizeDelegationResult(contract: any, result: any) {
  return {
    version: 1,
    contractId: contract.id,
    repositoryFingerprint: contract.repositoryFingerprint,
    summary: String(result?.summary ?? "").slice(0, 2_000),
    evidenceObjectIds: strings(result?.evidenceObjectIds ?? [], 1_000),
    changedPaths: strings(result?.changedPaths ?? [], 1_000),
    verification: Array.isArray(result?.verification) ? result.verification.slice(0, 100).map((item: any) => ({ command: String(item.command ?? "").slice(0, 500), passed: Boolean(item.passed) })) : [],
  };
}
