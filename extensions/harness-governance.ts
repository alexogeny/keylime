import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarnessGovernanceRuntime } from "./shared/harness-governance-runtime";
import { renderExtensionAuditReport } from "./shared/extension-auditor";
import { classifyToolMutation } from "./shared/safety-policy";
import { compactionMetricsChannel } from "./shared/compaction-metrics-channel";
import { clearHarnessGovernanceRuntime, publishHarnessGovernanceRuntime } from "./shared/harness-governance-bus";

export default function harnessGovernanceExtension(pi: ExtensionAPI) {
  let runtime: any;
  let initializing: Promise<any> | undefined;
  let sessionId = "session";
  let detachCompactionMetrics: (() => void) | undefined;
  const pendingLeaseCalls = new Map<string, { leaseId: string; operation: string; paths: string[]; command?: string }>();

  const getRuntime = async (ctx: any) => {
    if (runtime && runtime.kernel) return runtime;
    if (!initializing) initializing = createHarnessGovernanceRuntime({ cwd: ctx.cwd, sessionId });
    runtime = await initializing;
    return runtime;
  };
  const notify = (ctx: any, text: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(text.slice(0, 20_000), level);
  const captureSurface = async (active: any) => active.captureRuntimeSurface({ tools: pi.getAllTools?.() ?? [], activeTools: pi.getActiveTools?.() ?? [], commands: pi.getCommands?.() ?? [] });

  pi.on("session_start", async (event: any, ctx: any) => {
    const first = ctx.sessionManager?.getEntries?.()?.[0];
    sessionId = String(first?.id ?? event?.sessionId ?? `session-${Date.now()}`);
    runtime = undefined; initializing = undefined;
    const active = await getRuntime(ctx);
    publishHarnessGovernanceRuntime(ctx.cwd, active);
    detachCompactionMetrics?.();
    detachCompactionMetrics = compactionMetricsChannel.attachStore({ recordCompaction: async metric => active.recordCompactionOutcome(metric) });
    await captureSurface(active);
    const audit = await active.auditHarness();
    let drift: any;
    try { drift = await active.trustStore.compare(audit); }
    catch (error) { drift = { status: "invalid" }; notify(ctx, `Extension trust state is invalid and was not accepted: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    pi.appendEntry("harness-governance-state-v1", {
      version: 1, repositoryFingerprint: active.repositoryFingerprint, auditFingerprint: audit.fingerprint,
      trustStatus: drift.status, packageCount: audit.packages.length, resourceCount: audit.resources.length,
    });
    if (drift.status === "drifted") notify(ctx, `Extension supply-chain drift detected (${drift.beforeFingerprint.slice(0, 12)} → ${drift.afterFingerprint.slice(0, 12)}). Run /extension-diff.`, "warning");
  });

  pi.on("resources_discover", async (event: any, ctx: any) => { (await getRuntime(ctx)).ingestEvent("resources_discover", { reason: event.reason }); });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const active = await getRuntime(ctx);
    active.ingestEvent("tool_call", { toolName: event.toolName, toolCallId: event.toolCallId, inputChars: JSON.stringify(event.input ?? {}).length });
    const leaseId = event.input?.capabilityLeaseId ?? event.input?.leaseId;
    if (!leaseId) return;
    const classification = classifyToolMutation(event.toolName, event.input);
    const operation = String(event.input?.capabilityOperation ?? (classification.mutates ? "modify" : event.toolName === "run_checks" ? "verify" : "execute"));
    const authorization = active.authorizeLease(String(leaseId), {
      tool: event.toolName, operation, paths: classification.writePaths,
      command: typeof event.input?.command === "string" ? event.input.command : undefined,
    });
    if (!authorization.allowed) return { block: true, reason: `capability lease denied: ${authorization.reason}` };
    pendingLeaseCalls.set(String(event.toolCallId ?? `call-${pendingLeaseCalls.size + 1}`), { leaseId: String(leaseId), operation, paths: classification.writePaths, command: typeof event.input?.command === "string" ? event.input.command : undefined });
    if (pendingLeaseCalls.size > 1_000) pendingLeaseCalls.delete(pendingLeaseCalls.keys().next().value!);
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const active = await getRuntime(ctx);
    const changedPaths = Array.isArray(event.details?.changedPaths) ? event.details.changedPaths.map(String) : event.input?.path ? [String(event.input.path)] : [];
    const objectId = event.details?.contextObjectId ?? event.details?.resultId;
    await active.recordToolOutcome({ toolName: event.toolName, toolCallId: event.toolCallId, isError: Boolean(event.isError), objectId, changedPaths, verificationPassed: event.toolName === "run_checks" && !event.isError && event.details?.ok !== false });
    const pending = pendingLeaseCalls.get(String(event.toolCallId));
    if (pending) {
      if (!event.isError && pending.paths.length) active.recordLeaseMutation(pending.leaseId, pending.paths);
      if (pending.operation === "verify") active.recordLeaseVerification(pending.leaseId, { passed: !event.isError && event.details?.ok !== false, command: pending.command });
      pendingLeaseCalls.delete(String(event.toolCallId));
    }
  });
  pi.on("context", async (event: any, ctx: any) => { (await getRuntime(ctx)).ingestEvent("context", { messageCount: event.messages?.length ?? 0 }); });
  pi.on("session_before_compact", async (_event: any, ctx: any) => { (await getRuntime(ctx)).handleBoundary("session_before_compact"); });
  pi.on("session_compact", async (event: any, ctx: any) => { (await getRuntime(ctx)).ingestEvent("session_compact", { fromExtension: Boolean(event.fromExtension), reason: event.reason, willRetry: Boolean(event.willRetry) }); });
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (runtime) runtime.handleBoundary("session_shutdown");
    clearHarnessGovernanceRuntime(runtime);
    detachCompactionMetrics?.(); detachCompactionMetrics = undefined; pendingLeaseCalls.clear();
    runtime = undefined; initializing = undefined;
  });

  pi.registerCommand("extension-audit", {
    description: "Audit loaded Keylime extension resources, hook topology, capabilities, and fingerprints",
    handler: async (_args, ctx) => { const active = await getRuntime(ctx); await captureSurface(active); notify(ctx, renderExtensionAuditReport(await active.auditHarness(true))); },
  });
  pi.registerCommand("extension-diff", {
    description: "Compare the current extension fingerprint with the explicitly trusted baseline",
    handler: async (_args, ctx) => { const active = await getRuntime(ctx); await captureSurface(active); notify(ctx, JSON.stringify(await active.extensionDrift(), null, 2), "info"); },
  });
  pi.registerCommand("extension-trust", {
    description: "Explicitly trust the current audited extension fingerprint for this repository",
    handler: async (args, ctx) => {
      const active = await getRuntime(ctx); await captureSurface(active); const entry = await active.trustCurrentAudit(String(args || "explicit user trust"));
      pi.appendEntry("harness-extension-trust-v1", { version: 1, fingerprint: entry.fingerprint, trustedAt: entry.trustedAt });
      notify(ctx, `Trusted extension fingerprint ${entry.fingerprint.slice(0, 16)}.`, "info");
    },
  });
  pi.registerCommand("hook-topology", {
    description: "Show bounded lifecycle-hook ownership across Keylime extensions",
    handler: async (_args, ctx) => {
      const active = await getRuntime(ctx); await captureSurface(active); const audit = await active.auditHarness(true);
      notify(ctx, audit.hookTopology.slice(0, 200).map((item: any) => `${item.event}: ${item.resources.join(", ")}`).join("\n") || "No hooks found.");
    },
  });
  pi.registerCommand("change-impact", {
    description: "Compute reverse dependency and targeted verification impact for repository-relative paths",
    handler: async (args, ctx) => {
      const paths = String(args ?? "").split(/\s+/).filter(Boolean).slice(0, 100);
      if (!paths.length) return notify(ctx, "Usage: /change-impact <relative-path> [relative-path...]", "warning");
      notify(ctx, JSON.stringify(await (await getRuntime(ctx)).buildImpact(paths), null, 2));
    },
  });
  pi.registerCommand("evidence", {
    description: "Show structural evidence and recovery-object status for live edits and verification",
    handler: async (_args, ctx) => {
      const active = await getRuntime(ctx); const snapshot = active.snapshot();
      if (!snapshot.modifiedPaths.length && !snapshot.evidenceObjectIds.length) return notify(ctx, `No live mutation or verification evidence recorded; fingerprint ${snapshot.repositoryFingerprint.slice(0, 16)}.`);
      try {
        const graph = await active.buildEvidence({ claims: [{ id: "live-work", text: "Live mutation and verification evidence", filePaths: snapshot.modifiedPaths, objectIds: snapshot.evidenceObjectIds }] });
        notify(ctx, `Evidence graph ${graph.fingerprint.slice(0, 16)}: ${graph.nodes.length} nodes, ${graph.edges.length} provenance edges, ${snapshot.evidenceObjectIds.length} recoverable objects.`);
      } catch (error) { notify(ctx, `Evidence verification failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    },
  });
  pi.registerCommand("why-context", {
    description: "Show bounded causal context-selection diagnostics",
    handler: async (_args, ctx) => {
      const active = await getRuntime(ctx); const selection = active.snapshot().contextRuntime?.contextSelection;
      notify(ctx, selection ? active.renderContextDebugSummary(selection, { width: 100, maxRows: 40 }) : "No context-selection explanation has been recorded yet.");
    },
  });
  pi.registerCommand("harness-replay", {
    description: "Replay the current structural harness trace without model or tool execution",
    handler: async (_args, ctx) => {
      const active = await getRuntime(ctx); const result = await active.replay(await active.createReplayBundle([]));
      notify(ctx, `Replayed ${result.steps.length} structural steps; model calls=${result.modelCalls}; tool executions=${result.toolExecutions}.`);
    },
  });
  pi.registerCommand("canary-status", {
    description: "Show bounded runtime-canary promotion and registry state",
    handler: async (_args, ctx) => {
      const registry = (await getRuntime(ctx)).canaryRegistry;
      notify(ctx, JSON.stringify({ activeVersion: registry.activeVersion(), memory: registry.memoryStats(), history: registry.history().slice(-20) }, null, 2));
    },
  });
  pi.registerCommand("capability-lease", {
    description: "Issue an explicit, user-scoped capability lease from a bounded JSON request",
    handler: async (args, ctx) => {
      try {
        const request = JSON.parse(String(args ?? "{}"));
        const entries = ctx.sessionManager?.getEntries?.() ?? [];
        const trustedSourceEntryId = String([...entries].reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "user")?.id ?? "user-command");
        const lease = (await getRuntime(ctx)).issueLease({
          intentId: String(request.intentId ?? `user-lease-${Date.now()}`), trustedSourceEntryId,
          tools: Array.isArray(request.tools) ? request.tools.map(String) : [], paths: Array.isArray(request.paths) ? request.paths.map(String) : [],
          operations: Array.isArray(request.operations) ? request.operations.map(String) : [], commandPatterns: Array.isArray(request.commandPatterns) ? request.commandPatterns.map(String) : [],
          expiresAfterTurns: Number(request.expiresAfterTurns ?? 2), expiresAfterMs: Number(request.expiresAfterMs ?? 60_000), requiresVerification: Boolean(request.requiresVerification),
        });
        pi.appendEntry("harness-capability-lease-v1", { version: 1, leaseId: lease.id, intentId: lease.intentId, tools: lease.tools, paths: lease.paths, operations: lease.operations, expiresAt: lease.expiresAt });
        notify(ctx, `Capability lease ${lease.id.slice(0, 16)} issued for ${lease.tools.join(", ") || "no tools"}.`);
      } catch (error) { notify(ctx, `Capability lease rejected: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
  pi.registerCommand("capability-leases", {
    description: "Show aggregate active capability-lease state without prompts or payloads",
    handler: async (_args, ctx) => notify(ctx, JSON.stringify((await getRuntime(ctx)).snapshot().leases, null, 2)),
  });
  pi.registerCommand("governance-status", {
    description: "Show the integrated governance kernel, trust, lease, replay, and canary state",
    handler: async (_args, ctx) => notify(ctx, JSON.stringify((await getRuntime(ctx)).snapshot(), null, 2)),
  });
}
