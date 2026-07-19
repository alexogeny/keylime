import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createExtensionKernel } from "./extension-kernel";
import { createCapabilityLeaseManager, type CapabilityLeaseRequest } from "./capability-leases";
import { auditCurrentHarness, type ExtensionAudit } from "./extension-auditor";
import { createExtensionTrustStore } from "./extension-trust-store";
import { buildEvidenceGraph } from "./evidence-graph";
import { explainContextSelection, counterfactualContext, renderContextDebugSummary } from "./context-debugger";
import { createReplayBundle, replayHarnessTrace, compareReplayResults, branchReplay } from "./harness-replay";
import { createDelegationContract, deriveDelegationContract, validateDelegationResult, normalizeDelegationResult } from "./delegation-contracts";
import { createCanaryRegistry, evaluateRuntimeCanary, createCanaryFixture } from "./runtime-canaries";
import { createEcosystemAdapters } from "./ecosystem-adapters";
import { readContextRuntimeTelemetry } from "./context-runtime-bus";

export const HARNESS_GOVERNANCE_COMMANDS = [
  "extension-audit", "extension-diff", "extension-trust", "hook-topology", "evidence", "why-context",
  "change-impact", "harness-replay", "canary-status", "governance-status", "capability-lease", "capability-leases",
] as const;
export const HARNESS_GOVERNANCE_HOOKS = [
  "session_start", "resources_discover", "tool_call", "tool_result", "context", "session_before_compact", "session_compact", "session_shutdown",
] as const;

type RuntimeOptions = {
  cwd: string; sessionId: string; maxEvents?: number; maxFiles?: number; maxMetadataChars?: number;
  maxLeases?: number; maxTrustEntries?: number;
};

export async function createHarnessGovernanceRuntime(options: RuntimeOptions) {
  const maxEvents = Math.max(10, Math.min(20_000, Math.floor(options.maxEvents ?? 2_000)));
  const kernel = await createExtensionKernel({ cwd: options.cwd, maxFiles: options.maxFiles, maxMetadataChars: options.maxMetadataChars, maxEventHistory: maxEvents });
  const leases = await createCapabilityLeaseManager({ cwd: options.cwd, sessionId: options.sessionId, maxLeases: options.maxLeases ?? 100 });
  const trustStore = await createExtensionTrustStore({ cwd: options.cwd, maxEntries: options.maxTrustEntries ?? 50 });
  const adapters = createEcosystemAdapters({ cwd: options.cwd, lspOwnership: "external" });
  const canaryRegistry = createCanaryRegistry({ maxFixtures: 1_000, maxResults: 10_000, maxVersions: 100 });
  const events: any[] = [];
  const evidenceObjectIds = new Set<string>();
  const modifiedPaths = new Set<string>();
  let lastAudit: ExtensionAudit | undefined;
  let runtimeSurface: any = { fingerprint: "", tools: [], activeTools: [], commands: [], collisions: { tools: [], commands: [] }, stats: { originHashComputations: 0 } };
  const originHashCache = new Map<string, Promise<string>>();
  let originHashComputations = 0;

  const auditHarness = async (fresh = false) => {
    const codeAudit = (fresh ? await auditCurrentHarness(options.cwd, { maxFiles: options.maxFiles, maxSourceCharsPerFile: 100_000 }) : await kernel.auditExtensions()) as ExtensionAudit;
    const fingerprint = createHash("sha256").update(`${codeAudit.fingerprint}:${runtimeSurface.fingerprint}`).digest("hex");
    lastAudit = { ...codeAudit, fingerprint, runtimeSurface: { fingerprint: runtimeSurface.fingerprint, tools: runtimeSurface.tools, activeTools: runtimeSurface.activeTools, commands: runtimeSurface.commands, collisions: runtimeSurface.collisions } };
    return lastAudit;
  };
  const ingestEvent = (type: string, payload: any = {}) => {
    kernel.ingestPiEvent(type, payload);
    const event = {
      id: String(payload.toolCallId ?? payload.id ?? `event-${events.length + 1}`).slice(0, 200),
      type: String(type).slice(0, 100),
      handler: "harness-governance",
      outcome: payload.isError === true ? "error" : payload.isError === false ? "success" : undefined,
      toolName: payload.toolName ? String(payload.toolName).slice(0, 100) : undefined,
      payloadChars: JSON.stringify(payload ?? {}).length,
    };
    events.push(event); if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    kernel.metrics.publish({ kind: "governance_event", payloadChars: event.payloadChars });
    return event;
  };

  const runtime: any = {
    kernel, repositoryFingerprint: kernel.repositoryFingerprint, capabilityPolicy: kernel.capabilityPolicy, metrics: kernel.metrics,
    adapters, canaryRegistry, trustStore,
    async captureRuntimeSurface(input: { tools?: any[]; activeTools?: string[]; commands?: any[] }) {
      const mapBounded = async <T, R>(values: T[], mapper: (value: T) => Promise<R>): Promise<R[]> => {
        const results = new Array<R>(values.length); let next = 0;
        await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => { while (true) { const index = next++; if (index >= values.length) return; results[index] = await mapper(values[index]); } }));
        return results;
      };
      const origin = async (item: any) => {
        const path = typeof item.sourceInfo?.path === "string" ? item.sourceInfo.path : undefined;
        const metadata = path ? await stat(path).then(value => `${value.size}:${value.mtimeMs}`).catch(() => "missing") : "virtual";
        const key = `${path ?? String(item.source ?? "unknown")}:${metadata}`;
        let originHashPromise = originHashCache.get(key);
        if (!originHashPromise) {
          originHashPromise = path ? readFile(path).then(content => createHash("sha256").update(content).digest("hex")).catch(() => createHash("sha256").update(path).digest("hex")) : Promise.resolve(createHash("sha256").update(String(item.source ?? "unknown")).digest("hex"));
          originHashCache.set(key, originHashPromise); originHashComputations++;
          while (originHashCache.size > 10_000) originHashCache.delete(originHashCache.keys().next().value!);
        }
        const rawScope = String(item.sourceInfo?.scope ?? item.source ?? "unknown");
        const originScope = /^[a-zA-Z0-9_-]{1,80}$/.test(rawScope) ? rawScope : "external";
        return { originScope, originHash: await originHashPromise };
      };
      const tools = await mapBounded((input.tools ?? []).slice(0, 5_000), async (tool: any) => ({ name: String(tool.name ?? "").slice(0, 200), ...await origin(tool) }));
      tools.sort((a: any, b: any) => a.name.localeCompare(b.name) || a.originHash.localeCompare(b.originHash));
      const commands = await mapBounded((input.commands ?? []).slice(0, 5_000), async (command: any) => ({ name: String(command.name ?? "").slice(0, 200), source: /^[a-zA-Z0-9_-]{1,80}$/.test(String(command.source ?? "")) ? String(command.source) : "unknown", scope: /^[a-zA-Z0-9_-]{1,80}$/.test(String(command.sourceInfo?.scope ?? "")) ? String(command.sourceInfo.scope) : "unknown", ...await origin(command) }));
      commands.sort((a: any, b: any) => a.name.localeCompare(b.name) || a.originHash.localeCompare(b.originHash));
      const duplicateNames = (values: Array<{ name: string }>) => [...new Set(values.map(value => value.name).filter((name, index, all) => name && all.indexOf(name) !== index))].sort();
      const body = { tools, activeTools: [...new Set((input.activeTools ?? []).map(String))].sort().slice(0, 5_000), commands, collisions: { tools: duplicateNames(tools), commands: duplicateNames(commands) }, stats: { originHashComputations } };
      runtimeSurface = { ...body, fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
      return runtimeSurface;
    },
    auditExtensions: kernel.auditExtensions,
    auditHarness,
    async trustCurrentAudit(reason?: string) { return trustStore.trust(await auditHarness(true), reason); },
    async extensionDrift() { return trustStore.compare(await auditHarness(true)); },
    buildImpact(changedPaths: string[]) { return kernel.buildImpactPlan({ changedPaths }); },
    async buildEvidence(input: any) { const graph = await buildEvidenceGraph({ cwd: options.cwd, ...input }); return { ...graph, repositoryFingerprint: kernel.repositoryFingerprint }; },
    explainContextSelection,
    counterfactualContext,
    renderContextDebugSummary,
    issueLease(request: CapabilityLeaseRequest) { return leases.issue(request); },
    authorizeLease(id: string, action: any) { return leases.authorize(id, action); },
    recordLeaseMutation(id: string, paths: string[]) { return leases.recordMutation(id, paths); },
    recordLeaseVerification(id: string, result: any) { return leases.recordVerification(id, result); },
    completeLease(id: string) { return leases.complete(id); },
    deriveLease(id: string, request: CapabilityLeaseRequest) { return leases.derive(id, request); },
    handleBoundary(boundary: string) { leases.handleBoundary(boundary); ingestEvent(boundary, {}); },
    ingestEvent,
    async recordToolOutcome(input: { toolName: string; toolCallId?: string; isError?: boolean; objectId?: string; changedPaths?: string[]; verificationPassed?: boolean }) {
      ingestEvent("tool_result", { toolName: input.toolName, toolCallId: input.toolCallId, isError: Boolean(input.isError), objectId: input.objectId });
      if (input.objectId) { evidenceObjectIds.add(String(input.objectId)); while (evidenceObjectIds.size > 1_000) evidenceObjectIds.delete(evidenceObjectIds.values().next().value!); }
      const changed = (input.changedPaths ?? []).map(String).slice(0, 1_000);
      if (!input.isError && changed.length) {
        changed.forEach(path => modifiedPaths.add(path)); while (modifiedPaths.size > 1_000) modifiedPaths.delete(modifiedPaths.values().next().value!);
        await kernel.refreshPaths(changed);
      }
    },
    recordCompactionOutcome(metric: any) {
      canaryRegistry.recordResult({ fixtureId: `compaction-${events.length}`, passed: Boolean(metric?.schemaValid) && !metric?.fallbackUsed });
      ingestEvent("compaction_outcome", { isError: !metric?.schemaValid, fallbackUsed: Boolean(metric?.fallbackUsed), durationMs: Number(metric?.durationMs ?? 0) });
    },
    async createReplayBundle(objectIds: string[] = []) { return createReplayBundle({ cwd: options.cwd, trace: { sessionId: options.sessionId, steps: events }, objectIds, maxEvents }); },
    replay(bundle: any) { return replayHarnessTrace(bundle, { cwd: options.cwd }); },
    compareReplayResults,
    branchReplay,
    async createDelegationContract(input: any) {
      return createDelegationContract({ cwd: options.cwd, maxInputTokens: 20_000, maxOutputTokens: 4_000, timeoutMs: 60_000, maxDepth: 0, requiredResultSchema: "keylime-delegation-result-v1", ...input });
    },
    deriveDelegationContract,
    validateDelegationResult(contract: any, result: any) { return validateDelegationResult(contract, result, options.cwd); },
    normalizeDelegationResult,
    evaluateCanary: evaluateRuntimeCanary,
    createCanaryFixture,
    performanceStats() { return kernel.performanceStats(); },
    snapshot() {
      const context = readContextRuntimeTelemetry();
      const contextRuntime = context ? {
        turn: context.turn, observations: context.observations, maskedObservations: context.maskedObservations,
        cacheFingerprint: context.cacheFingerprint, retrieval: context.retrieval, retrievalBudget: context.retrievalBudget,
        contextSelection: context.contextSelection ? { selectedIds: context.contextSelection.selectedIds, candidates: context.contextSelection.candidates, stats: context.contextSelection.stats } : undefined,
        memoryStats: context.memoryStats,
      } : undefined;
      return {
        version: 1, repositoryFingerprint: kernel.repositoryFingerprint, sessionIdHash: createHash("sha256").update(options.sessionId).digest("hex"),
        events: events.map(event => ({ ...event })), performance: kernel.performanceStats(),
        leases: leases.memoryStats(), canaries: canaryRegistry.memoryStats(), adapters: adapters.stats(),
        evidenceObjectIds: [...evidenceObjectIds].sort(), modifiedPaths: [...modifiedPaths].sort(),
        runtimeSurface, contextRuntime, lastAuditFingerprint: lastAudit?.fingerprint,
      };
    },
  };
  return runtime;
}
