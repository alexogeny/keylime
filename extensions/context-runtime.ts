import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyObservationLifecycle, type Observation } from "./shared/observation-lifecycle";
import { selectEvidencePackets, type EvidenceCandidate, type EvidenceIntent, type EvidencePacket, type EvidencePacketBudget } from "./shared/evidence-packets";
import { assembleCacheStableContext } from "./shared/cache-stable-context";
import { foldTrajectory, shouldFoldTrajectory, type TrajectoryEvent, type TrajectoryFold } from "./shared/hierarchical-folding";
import { allocateContextBudget } from "./shared/context-value-allocator";
import { assignRetrievalCredit, adaptRetrievalBudget, type RetrievalCredit, type RetrievalInjection, type RetrievalUsage } from "./shared/retrieval-credit";
import { retrieveRepositoryExperiences, type ExperienceMatch, type ExperienceQuery, type RepositoryExperience } from "./shared/experience-memory";
import { chooseCompactionStrategy, type CompactionStrategyDecision, type ProviderContextCapabilities, type ProviderContextState } from "./shared/provider-compaction-policy";

const STATUS_KEY = "context-runtime";

type RecordedToolResult = { toolCallId: string; toolName: string; text: string; objectId?: string; isError: boolean };
type RuntimeOptions = {
  hotTurns?: number;
  warmTurns?: number;
  provider?: ProviderContextCapabilities;
};
type RuntimeTransform = { kind: "observation_mask"; toolCallId: string; beforeChars: number; afterChars: number; recoverable: boolean };
export type RuntimeSnapshot = {
  turn: number;
  observations: number;
  maskedObservations: number;
  cacheFingerprint: string;
  retrieval: RetrievalCredit;
  retrievalBudget: { maxPackets: number; maxChars: number };
  lastFold?: TrajectoryFold;
  compaction?: CompactionStrategyDecision;
};

let lastContextRuntimeSnapshot: RuntimeSnapshot | undefined;
export function getLastContextRuntimeSnapshot(): RuntimeSnapshot | undefined { return lastContextRuntimeSnapshot; }

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? "")).join("\n");
}

function replaceTextContent(content: unknown, text: string): unknown {
  if (typeof content === "string") return text;
  if (!Array.isArray(content)) return [{ type: "text", text }];
  let replaced = false;
  const blocks = content.map((block: any) => {
    if (!replaced && block?.type === "text") { replaced = true; return { ...block, text }; }
    return block;
  });
  return replaced ? blocks : [{ type: "text", text }, ...blocks];
}

export function createContextRuntimeCoordinator(options: RuntimeOptions = {}) {
  let turn = 0;
  let observations = new Map<string, Observation>();
  let trajectory: TrajectoryEvent[] = [];
  let retrievals: RetrievalInjection[] = [];
  let retrievalUsage: RetrievalUsage = {};
  let retrievalHistory: number[] = [];
  let retrievalBudget = { maxPackets: 6, maxChars: 3_000 };
  let experiences: RepositoryExperience[] = [];
  let lastFold: TrajectoryFold | undefined;
  let lastCompaction: CompactionStrategyDecision | undefined;
  let cacheFingerprint = "";
  let maskedObservations = 0;
  const provider = options.provider ?? { serverCompaction: false, selectiveToolClearing: false, promptCaching: false, opaqueCompaction: false };

  const retrievalCredit = (): RetrievalCredit => assignRetrievalCredit(retrievals, retrievalUsage);

  return {
    reset(): void {
      turn = 0; observations = new Map(); trajectory = []; retrievals = []; retrievalUsage = {}; retrievalHistory = [];
      retrievalBudget = { maxPackets: 6, maxChars: 3_000 }; experiences = []; lastFold = undefined; lastCompaction = undefined; cacheFingerprint = ""; maskedObservations = 0;
    },

    recordToolResult(result: RecordedToolResult): void {
      observations.set(result.toolCallId, {
        id: result.toolCallId,
        toolName: result.toolName,
        text: result.text,
        turn,
        kind: result.isError ? "failure" : "success",
        objectId: result.objectId,
      });
    },

    transformContext(messages: any[]): { messages: any[]; transforms: RuntimeTransform[]; cacheFingerprint: string } {
      for (const message of messages) {
        if (message?.role !== "toolResult") continue;
        const id = String(message.toolCallId ?? "");
        const recorded = observations.get(id);
        const objectId = message.details?.contextObjectId ?? message.details?.resultId;
        if (recorded && objectId && !recorded.objectId) observations.set(id, { ...recorded, objectId: String(objectId) });
        if (recorded?.toolName === "code_search" && objectId && !retrievals.some(item => item.objectId === String(objectId))) {
          const firstRegion = Array.isArray(message.details?.regions) ? message.details.regions[0] : undefined;
          retrievals = [{
            id: String(objectId), objectId: String(objectId), path: String(firstRegion?.path ?? "repository"),
            chars: Number(firstRegion?.estimatedChars ?? textFromContent(message.content).length),
          }];
        }
      }
      const lifecycle = applyObservationLifecycle([...observations.values()], {
        currentTurn: turn,
        hotTurns: options.hotTurns ?? 2,
        warmTurns: options.warmTurns ?? 8,
      });
      const byId = new Map(lifecycle.observations.map(item => [item.id, item]));
      const transforms: RuntimeTransform[] = [];
      const next = messages.map(message => {
        if (message?.role !== "toolResult") return message;
        const item = byId.get(String(message.toolCallId ?? ""));
        if (!item || item.tier !== "cold") return message;
        const before = textFromContent(message.content);
        transforms.push({ kind: "observation_mask", toolCallId: item.id, beforeChars: before.length, afterChars: item.rendered.length, recoverable: Boolean(item.objectId) });
        return { ...message, content: replaceTextContent(message.content, item.rendered), details: { ...(message.details ?? {}), contextRuntimeTier: "cold", contextObjectId: item.objectId ?? message.details?.contextObjectId } };
      });
      maskedObservations = transforms.length;
      const stable = assembleCacheStableContext([{ id: "runtime-policy", stability: "static", content: "keylime-context-runtime-v1" }]);
      cacheFingerprint = stable.fingerprint;
      return { messages: next, transforms, cacheFingerprint };
    },

    selectEvidence(intent: EvidenceIntent, candidates: EvidenceCandidate[], budget: EvidencePacketBudget): EvidencePacket[] {
      const packets = selectEvidencePackets(intent, candidates, budget);
      const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
      retrievals = packets.map(packet => ({ id: packet.id, objectId: packet.objectId, path: packet.path, chars: byId.get(packet.id)?.text.length ?? packet.estimatedTokens * 4 }));
      retrievalUsage = {};
      return packets;
    },
    recordRetrieval(items: RetrievalInjection[]): void { retrievals = [...items]; retrievalUsage = {}; },
    recordUsage(usage: RetrievalUsage): void {
      retrievalUsage = {
        mentionedIds: [...new Set([...(retrievalUsage.mentionedIds ?? []), ...(usage.mentionedIds ?? [])])],
        inspectedObjectIds: [...new Set([...(retrievalUsage.inspectedObjectIds ?? []), ...(usage.inspectedObjectIds ?? [])])],
        checkpointObjectIds: [...new Set([...(retrievalUsage.checkpointObjectIds ?? []), ...(usage.checkpointObjectIds ?? [])])],
        modifiedPaths: [...new Set([...(retrievalUsage.modifiedPaths ?? []), ...(usage.modifiedPaths ?? [])])],
        verificationPassed: retrievalUsage.verificationPassed || usage.verificationPassed,
        supersededIds: [...new Set([...(retrievalUsage.supersededIds ?? []), ...(usage.supersededIds ?? [])])],
      };
    },
    recordTrajectory(events: TrajectoryEvent[]): void { trajectory.push(...events); },
    recordExperiences(items: RepositoryExperience[]): void { experiences.push(...items); },
    retrieveExperiences(query: ExperienceQuery): ExperienceMatch[] { return retrieveRepositoryExperiences(query, experiences, { maxResults: 5, minConfidence: .5 }); },

    endTurn(input: { contextPercent: number; boundary?: string }): { fold?: TrajectoryFold; contextBudget: { maxChars: number }; retrievalBudget: { maxPackets: number; maxChars: number } } {
      turn++;
      if (trajectory.length && shouldFoldTrajectory({ kind: input.boundary ?? "ordinary_turn", contextPercent: input.contextPercent })) {
        lastFold = foldTrajectory(trajectory, { level: input.contextPercent >= 85 ? "deep" : "granular", completedSubtasks: input.boundary === "subtask_completed" ? [...new Set(trajectory.map(event => event.subtask))] : [], activeSubtask: trajectory.at(-1)?.subtask });
        trajectory = [];
      }
      const credit = retrievalCredit();
      if (retrievals.length) {
        retrievalHistory.push(credit.utilization);
        retrievalHistory = retrievalHistory.slice(-8);
        retrievalBudget = adaptRetrievalBudget(retrievalHistory, retrievalBudget);
      }
      const maxChars = input.contextPercent >= 85 ? 900 : input.contextPercent >= 65 ? 1_300 : 1_800;
      allocateContextBudget([
        { id: "runtime-state", category: "state", chars: Math.min(maxChars, 200), relevance: 1, impact: 1, freshness: 1, confidence: 1, lossRisk: .8, recoverable: false, mandatory: true },
      ], { maxChars });
      return { fold: lastFold, contextBudget: { maxChars }, retrievalBudget: { ...retrievalBudget } };
    },

    prepareCompaction(state: ProviderContextState): CompactionStrategyDecision {
      lastCompaction = chooseCompactionStrategy(provider, state);
      return lastCompaction;
    },

    snapshot(): RuntimeSnapshot {
      const snapshot = { turn, observations: observations.size, maskedObservations, cacheFingerprint, retrieval: retrievalCredit(), retrievalBudget: { ...retrievalBudget }, lastFold, compaction: lastCompaction };
      lastContextRuntimeSnapshot = snapshot;
      return snapshot;
    },
  };
}

export default function contextRuntimeExtension(pi: ExtensionAPI) {
  const runtime = createContextRuntimeCoordinator({
    provider: {
      serverCompaction: process.env.PI_CONTEXT_SERVER_COMPACTION === "1",
      selectiveToolClearing: process.env.PI_CONTEXT_SELECTIVE_TOOL_CLEARING === "1",
      promptCaching: process.env.PI_CONTEXT_PROMPT_CACHING === "1",
      opaqueCompaction: process.env.PI_CONTEXT_OPAQUE_COMPACTION === "1",
    },
  });
  const status = (ctx: any) => {
    const snapshot = runtime.snapshot();
    ctx.ui?.setStatus?.(STATUS_KEY, ctx.ui.theme?.fg?.("dim", `ctxrt:${snapshot.maskedObservations}/${snapshot.observations}`) ?? `ctxrt:${snapshot.maskedObservations}/${snapshot.observations}`);
  };

  pi.on("session_start", async (event, ctx) => { if (event.reason === "new" || event.reason === "startup") runtime.reset(); status(ctx); });
  pi.on("tool_result", async (event: any) => {
    const toolName = String(event.toolName ?? "tool");
    const text = textFromContent(event.content);
    const objectId = event.details?.contextObjectId ?? event.details?.resultId;
    runtime.recordToolResult({ toolCallId: String(event.toolCallId ?? ""), toolName, text, objectId, isError: Boolean(event.isError) });
    runtime.recordTrajectory([{
      id: String(event.toolCallId ?? `${toolName}-${Date.now()}`), subtask: "active", type: event.isError ? "failure" : "evidence", text,
      objectIds: objectId ? [String(objectId)] : undefined,
    }]);
    if (toolName === "code_search" && objectId) {
      const regions = Array.isArray(event.details?.regions) ? event.details.regions : [];
      const first = regions[0];
      runtime.recordRetrieval([{
        id: String(objectId), objectId: String(objectId), path: String(first?.path ?? "repository"),
        chars: Number(first?.estimatedChars ?? text.length),
      }]);
    }
    if (toolName === "inspect_context_object" && event.input?.object_id) runtime.recordUsage({ inspectedObjectIds: [String(event.input.object_id)] });
    const changedPaths = Array.isArray(event.details?.changedPaths) ? event.details.changedPaths : event.input?.path ? [event.input.path] : [];
    if (["apply_code_replacements", "create_file", "finish_file_write"].includes(toolName) && changedPaths.length) runtime.recordUsage({ modifiedPaths: changedPaths.map(String) });
    if (toolName === "run_checks" && !event.isError && event.details?.ok !== false) runtime.recordUsage({ verificationPassed: true });
  });
  pi.on("context", async (event: any, ctx) => { const result = runtime.transformContext(event.messages ?? []); status(ctx); return { messages: result.messages }; });
  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const text = textFromContent(event.message.content);
    const mentionedIds = [...text.matchAll(/(?:context object|object:\/\/|contextObjectId[=: ]+)([a-zA-Z0-9_.:-]+)/g)].map(match => match[1]);
    if (mentionedIds.length) runtime.recordUsage({ mentionedIds });
  });
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const percent = ctx.getContextUsage?.()?.percent ?? 0;
    const result = runtime.endTurn({ contextPercent: percent });
    pi.appendEntry?.("context-runtime-v1", { version: 1, ...runtime.snapshot(), fold: result.fold });
    status(ctx);
  });
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const percent = ctx.getContextUsage?.()?.percent ?? 100;
    const checkpoint = Boolean(event.preparation?.previousSummary);
    const decision = runtime.prepareCompaction({ contextPercent: percent, hasValidatedCheckpoint: checkpoint, hasObjectManifest: checkpoint, unresolvedFailures: 0 });
    pi.appendEntry?.("context-runtime-compaction-v1", { version: 1, decision });
    return undefined;
  });

  pi.registerTool({
    name: "context_runtime_status", label: "Context Runtime Status", description: "Inspect trajectory masking, retrieval utilization, cache fingerprint, folding, and compaction policy state.",
    promptSnippet: "Inspect adaptive context runtime state", promptGuidelines: ["Use for context/token reduction diagnostics without loading source payloads."], parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: JSON.stringify(runtime.snapshot(), null, 2) }], details: runtime.snapshot() }; },
  });
  pi.registerCommand("context-runtime", { description: "Show adaptive context runtime status", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(runtime.snapshot(), null, 2), "info") });
}
