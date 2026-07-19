import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarnessGovernanceRuntime } from "./shared/harness-governance-runtime";
import { renderExtensionAuditReport } from "./shared/extension-auditor";
import { classifyToolMutation } from "./shared/safety-policy";

export default function harnessGovernanceExtension(pi: ExtensionAPI) {
  let runtime: any;
  let initializing: Promise<any> | undefined;
  let sessionId = "session";

  const getRuntime = async (ctx: any) => {
    if (runtime && runtime.kernel) return runtime;
    if (!initializing) initializing = createHarnessGovernanceRuntime({ cwd: ctx.cwd, sessionId });
    runtime = await initializing;
    return runtime;
  };
  const notify = (ctx: any, text: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(text.slice(0, 20_000), level);

  pi.on("session_start", async (event: any, ctx: any) => {
    const first = ctx.sessionManager?.getEntries?.()?.[0];
    sessionId = String(first?.id ?? event?.sessionId ?? `session-${Date.now()}`);
    runtime = undefined; initializing = undefined;
    const active = await getRuntime(ctx);
    const audit = await active.auditHarness();
    const drift = await active.trustStore.compare(audit);
    pi.appendEntry("harness-governance-state-v1", {
      version: 1, repositoryFingerprint: active.repositoryFingerprint, auditFingerprint: audit.fingerprint,
      trustStatus: drift.status, packageCount: audit.packages.length, resourceCount: audit.resources.length,
    });
    if (drift.status === "drifted") notify(ctx, `Extension supply-chain drift detected (${drift.beforeFingerprint.slice(0, 12)} → ${drift.afterFingerprint.slice(0, 12)}). Run /extension-diff.`, "warning");
  });

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
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const active = await getRuntime(ctx);
    active.ingestEvent("tool_result", { toolName: event.toolName, toolCallId: event.toolCallId, isError: Boolean(event.isError), contentChars: JSON.stringify(event.content ?? {}).length });
  });
  pi.on("context", async (event: any, ctx: any) => { (await getRuntime(ctx)).ingestEvent("context", { messageCount: event.messages?.length ?? 0 }); });
  pi.on("session_before_compact", async (_event: any, ctx: any) => { (await getRuntime(ctx)).handleBoundary("session_before_compact"); });
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (runtime) runtime.handleBoundary("session_shutdown");
    runtime = undefined; initializing = undefined;
  });

  pi.registerCommand("extension-audit", {
    description: "Audit loaded Keylime extension resources, hook topology, capabilities, and fingerprints",
    handler: async (_args, ctx) => notify(ctx, renderExtensionAuditReport(await (await getRuntime(ctx)).auditHarness())),
  });
  pi.registerCommand("extension-diff", {
    description: "Compare the current extension fingerprint with the explicitly trusted baseline",
    handler: async (_args, ctx) => notify(ctx, JSON.stringify(await (await getRuntime(ctx)).extensionDrift(), null, 2), "info"),
  });
  pi.registerCommand("extension-trust", {
    description: "Explicitly trust the current audited extension fingerprint for this repository",
    handler: async (args, ctx) => {
      const active = await getRuntime(ctx); const entry = await active.trustCurrentAudit(String(args || "explicit user trust"));
      pi.appendEntry("harness-extension-trust-v1", { version: 1, fingerprint: entry.fingerprint, trustedAt: entry.trustedAt });
      notify(ctx, `Trusted extension fingerprint ${entry.fingerprint.slice(0, 16)}.`, "info");
    },
  });
  pi.registerCommand("hook-topology", {
    description: "Show bounded lifecycle-hook ownership across Keylime extensions",
    handler: async (_args, ctx) => {
      const audit = await (await getRuntime(ctx)).auditHarness();
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
    description: "Show structural evidence and recovery-object status for the governance runtime",
    handler: async (_args, ctx) => {
      const snapshot = (await getRuntime(ctx)).snapshot();
      notify(ctx, `Evidence runtime: ${snapshot.events.length} structural events; ${snapshot.performance.repositoryScans} repository scan; fingerprint ${snapshot.repositoryFingerprint.slice(0, 16)}.`);
    },
  });
  pi.registerCommand("why-context", {
    description: "Show bounded causal context-selection diagnostics",
    handler: async (_args, ctx) => notify(ctx, JSON.stringify((await getRuntime(ctx)).snapshot(), null, 2)),
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
  pi.registerCommand("governance-status", {
    description: "Show the integrated governance kernel, trust, lease, replay, and canary state",
    handler: async (_args, ctx) => notify(ctx, JSON.stringify((await getRuntime(ctx)).snapshot(), null, 2)),
  });
}
