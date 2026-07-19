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

export const HARNESS_GOVERNANCE_COMMANDS = [
  "extension-audit", "extension-diff", "extension-trust", "hook-topology", "evidence", "why-context",
  "change-impact", "harness-replay", "canary-status", "governance-status",
] as const;
export const HARNESS_GOVERNANCE_HOOKS = [
  "session_start", "tool_call", "tool_result", "context", "session_before_compact", "session_shutdown",
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
  let lastAudit: ExtensionAudit | undefined;

  const auditHarness = async () => {
    lastAudit = await auditCurrentHarness(options.cwd, { maxFiles: options.maxFiles, maxSourceCharsPerFile: 100_000 }) as ExtensionAudit;
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
    auditExtensions: kernel.auditExtensions,
    auditHarness,
    async trustCurrentAudit(reason?: string) { return trustStore.trust(await auditHarness(), reason); },
    async extensionDrift() { return trustStore.compare(await auditHarness()); },
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
      return {
        version: 1, repositoryFingerprint: kernel.repositoryFingerprint, sessionIdHash: options.sessionId.length,
        events: events.map(event => ({ ...event })), performance: kernel.performanceStats(),
        leases: leases.memoryStats(), canaries: canaryRegistry.memoryStats(), adapters: adapters.stats(),
        lastAuditFingerprint: lastAudit?.fingerprint,
      };
    },
  };
  return runtime;
}
