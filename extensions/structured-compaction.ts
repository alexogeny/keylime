import { complete } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  renderCompactionCheckpoint,
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
  type CompactionSourceEntry,
} from "./shared/compaction-schema";
import { pinContextObjects, readStoredContextObject } from "./context-object-store";
import { readContextRuntimeTelemetry } from "./shared/context-runtime-bus";
import { selectAgentExecutionProfile } from "./shared/agent-execution-profile";
import { COMPACTION_MAX_CONTROL_CHARS, stabilizeCompactionControlPlane } from "./shared/compaction-control";
import { finalizeLiveCompaction, loadLiveControlState, saveLiveControlState, sourceEntriesFromMessages } from "./shared/live-compaction-control";
import { compactionMetricsChannel } from "./shared/compaction-metrics-channel";
import { createProviderCircuitBreaker, type ProviderFailureKind } from "./shared/provider-circuit-breaker";
export { COMPACTION_MAX_CONTROL_CHARS, stabilizeCompactionControlPlane } from "./shared/compaction-control";

export function mergeHandoffIntoCompaction<T extends { repositoryFacts?: unknown[]; externalFacts?: unknown[]; userIntent?: unknown[]; suggestions?: unknown[] }>(handoff: T) {
  return {
    repositoryFacts: structuredClone(handoff.repositoryFacts ?? []),
    externalFacts: structuredClone(handoff.externalFacts ?? []),
    userIntent: structuredClone(handoff.userIntent ?? []),
    suggestions: structuredClone(handoff.suggestions ?? []),
  };
}

export function validateCompactionContinuation(input: { before: { protectedIds: string[] }; after: { retainedIds: string[] } }) {
  const retained = new Set(input.after.retainedIds);
  const missingProtectedIds = input.before.protectedIds.filter(id => !retained.has(id));
  return { valid: missingProtectedIds.length === 0, missingProtectedIds, allowContinuation: missingProtectedIds.length === 0 };
}

const providerCircuitBreaker = createProviderCircuitBreaker();
const COMPACTION_EXECUTION_PROFILE = selectAgentExecutionProfile({
  taskKind: "structured_extraction", ambiguity: 0, risk: "medium", contextPressure: .9, requiresCreativity: false,
});
export const COMPACTION_MAX_CONVERSATION_CHARS = 120_000;
export const COMPACTION_MAX_INCREMENTAL_CONVERSATION_CHARS = 80_000;
export const COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS = 30_000;
export const COMPACTION_MAX_OUTPUT_TOKENS = COMPACTION_EXECUTION_PROFILE.maxOutputTokens;
const COMPACTION_MAX_MESSAGE_CHARS = 24_000;
export const COMPACTION_REQUEST_TIMEOUT_MS = COMPACTION_EXECUTION_PROFILE.timeoutMs;
export const COMPACTION_CRITICAL_INITIAL_TIMEOUT_MS = 25_000;
export const COMPACTION_RETRY_TIMEOUT_MS = 30_000;
export const COMPACTION_MAX_RETRY_CONVERSATION_CHARS = 32_000;

function boundCompactionText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[older middle context omitted for compaction latency]\n\n";
  const headChars = Math.min(24_000, Math.floor((maxChars - marker.length) * .2));
  const tailChars = maxChars - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

type CompactionGenerationInput = {
  conversation: string;
  previousSummary?: string;
  runtimeFold?: string;
  reason: string;
  willRetry: boolean;
  validationError?: string;
  compactRetry?: boolean;
};

type StructuredCompactionOptions = {
  generateCheckpoint: (input: CompactionGenerationInput, signal: AbortSignal, ctx: any, attempt?: number) => Promise<unknown>;
  objectExists?: (cwd: string, id: string) => Promise<boolean>;
  pinObjects?: (cwd: string, ids: string[]) => Promise<void>;
  getPreviousCheckpoint?: () => CompactionCheckpoint | undefined;
  setPreviousCheckpoint?: (checkpoint: CompactionCheckpoint) => void;
  liveSemanticValidation?: boolean;
  sessionKey?: (event: any, ctx: any) => string;
  attemptTimeoutMs?: number;
  retryTimeoutMs?: number;
};

export function createCompactionAttemptSignal(sourceSignal: AbortSignal, timeoutMs: number): AbortSignal {
  if (sourceSignal.aborted) return sourceSignal;
  return AbortSignal.any([sourceSignal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
}

function sanitizeValidationError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
}

const RECOVERED_GOAL_MAX_CHARS = 500;

function boundedRecoveredGoal(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, RECOVERED_GOAL_MAX_CHARS);
}

export function recoverEmptyCompactionGoal(
  value: unknown,
  previous: CompactionCheckpoint | undefined,
  sourceEntries: CompactionSourceEntry[],
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.goal === "string" && candidate.goal.trim()) return value;

  const previousGoal = previous ? boundedRecoveredGoal(previous.goal) : "";
  const latestTrustedUserGoal = [...sourceEntries]
    .reverse()
    .find(entry => entry.trusted && entry.role === "user" && entry.text.trim());
  const recoveredGoal = previousGoal || (latestTrustedUserGoal ? boundedRecoveredGoal(latestTrustedUserGoal.text) : "");
  return recoveredGoal ? { ...candidate, goal: recoveredGoal } : value;
}

export function prepareCompactionInitialInput(input: CompactionGenerationInput, contextPercent: number): CompactionGenerationInput {
  const pressure = Number.isFinite(contextPercent) ? contextPercent : 0;
  const conversationLimit = pressure >= 90 ? 60_000 : pressure >= 85 ? 80_000 : COMPACTION_MAX_CONVERSATION_CHARS;
  const summaryLimit = pressure >= 90 ? 16_000 : pressure >= 85 ? 20_000 : COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS;
  return {
    ...input,
    conversation: boundCompactionText(input.conversation, conversationLimit),
    previousSummary: input.previousSummary ? boundCompactionText(input.previousSummary, summaryLimit) : undefined,
  };
}

export function prepareCompactionRetryInput(input: CompactionGenerationInput): CompactionGenerationInput {
  return {
    ...input,
    conversation: input.conversation.length <= COMPACTION_MAX_RETRY_CONVERSATION_CHARS
      ? input.conversation
      : `[earlier conversation omitted on corrective retry]\n${input.conversation.slice(-COMPACTION_MAX_RETRY_CONVERSATION_CHARS + 52)}`,
    previousSummary: input.previousSummary ? boundCompactionText(input.previousSummary, 8_000) : undefined,
    runtimeFold: input.runtimeFold ? boundCompactionText(input.runtimeFold, 1_200) : undefined,
    validationError: input.validationError ? sanitizeValidationError(input.validationError) : undefined,
    compactRetry: true,
  };
}

export function compactionReadinessBand(percent: number): 0 | 65 | 80 | 90 | 95 {
  if (!Number.isFinite(percent) || percent < 65) return 0;
  if (percent >= 95) return 95;
  if (percent >= 90) return 90;
  if (percent >= 80) return 80;
  return 65;
}

export type CompactionSerializationStats = {
  visitedNodes: number;
  copiedSourceChars: number;
  peakBufferedChars: number;
  truncatedValues: number;
};

class BoundedHeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail: string[] = [];
  private tailChars = 0;
  private totalChars = 0;
  private truncated = false;
  peakBufferedChars = 0;

  constructor(private readonly maxChars: number) {
    const markerChars = 58;
    this.headLimit = Math.min(24_000, Math.floor((maxChars - markerChars) * .2));
    this.tailLimit = maxChars - markerChars - this.headLimit;
  }

  append(value: string): void {
    this.totalChars += value.length;
    let remaining = value;
    if (this.head.length < this.headLimit) {
      const copied = remaining.slice(0, this.headLimit - this.head.length);
      this.head += copied;
      remaining = remaining.slice(copied.length);
    }
    if (remaining) { this.tail.push(remaining); this.tailChars += remaining.length; }
    this.peakBufferedChars = Math.max(this.peakBufferedChars, this.head.length + this.tailChars);
    while (this.tailChars > this.tailLimit && this.tail.length) {
      const excess = this.tailChars - this.tailLimit;
      if (this.tail[0].length <= excess) this.tailChars -= this.tail.shift()!.length;
      else { this.tail[0] = this.tail[0].slice(excess); this.tailChars -= excess; }
      this.truncated = true;
    }
  }

  text(): string {
    const tail = this.tail.join("");
    if (!this.truncated && this.totalChars <= this.maxChars) return this.head + tail;
    return `${this.head}\n\n[older middle context omitted for compaction latency]\n\n${tail}`.slice(0, this.maxChars);
  }
}

type SerializationState = CompactionSerializationStats & { remainingNodes: number; seen: WeakSet<object> };

function boundedJsonValue(value: unknown, state: SerializationState, depth = 0): unknown {
  if (state.remainingNodes-- <= 0) { state.truncatedValues++; return "[node budget exhausted]"; }
  state.visitedNodes++;
  if (typeof value === "string") {
    const bounded = boundCompactionText(value, 20_000);
    state.copiedSourceChars += bounded.length;
    if (bounded.length < value.length) state.truncatedValues++;
    return bounded;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) { state.truncatedValues++; return "[circular]"; }
  if (depth >= 8) { state.truncatedValues++; return "[depth limit]"; }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      if (state.remainingNodes <= 0 || output.length >= 2_048) { output.push("[array truncated]"); state.truncatedValues++; break; }
      output.push(boundedJsonValue(item, state, depth + 1));
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  const object = value as Record<string, unknown>;
  let properties = 0;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (properties++ >= 64 || state.remainingNodes <= 0) { output.__truncated__ = true; state.truncatedValues++; break; }
    output[key] = boundedJsonValue(object[key], state, depth + 1);
  }
  return output;
}

export function serializeCompactionMessagesWithStats(messages: unknown[]): { text: string; stats: CompactionSerializationStats } {
  const state: SerializationState = { visitedNodes: 0, copiedSourceChars: 0, peakBufferedChars: 0, truncatedValues: 0, remainingNodes: 4_096, seen: new WeakSet() };
  const buffer = new BoundedHeadTailBuffer(COMPACTION_MAX_CONVERSATION_CHARS);
  for (const [index, raw] of messages.entries()) {
    const remainingMessages = messages.length - index;
    state.remainingNodes = Math.max(1, Math.floor((4_096 - state.visitedNodes) / Math.max(1, remainingMessages)));
    state.seen = new WeakSet();
    const message = raw as any;
    let chunk: string;
    try {
      const content = boundedJsonValue(message?.content ?? message, state);
      const sourceId = message?.id ?? message?.entryId ?? `entry-${index + 1}`;
      chunk = `[${sourceId}:${message?.role ?? "entry"}] ${JSON.stringify(content)}`;
    } catch {
      state.truncatedValues++;
      const sourceId = message?.id ?? message?.entryId ?? `entry-${index + 1}`;
      chunk = `[${sourceId}:${message?.role ?? "entry"}] [unserializable entry]`;
    }
    chunk = boundCompactionText(chunk, COMPACTION_MAX_MESSAGE_CHARS);
    buffer.append(index ? `\n\n${chunk}` : chunk);
  }
  state.peakBufferedChars = buffer.peakBufferedChars;
  const { remainingNodes: _remainingNodes, seen: _seen, ...stats } = state;
  return { text: buffer.text(), stats };
}

export function prepareCompactionConversation(messages: unknown[], previousSummary?: string, runtimeFold = ""): {
  conversation: string; previousSummary?: string; stats: CompactionSerializationStats;
} {
  const serialized = serializeCompactionMessagesWithStats(messages);
  const maxChars = previousSummary ? COMPACTION_MAX_INCREMENTAL_CONVERSATION_CHARS : COMPACTION_MAX_CONVERSATION_CHARS;
  const conversation = boundCompactionText(runtimeFold ? `${serialized.text}\n\n${runtimeFold}` : serialized.text, maxChars);
  return {
    conversation,
    previousSummary: previousSummary ? boundCompactionText(previousSummary, COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS) : undefined,
    stats: serialized.stats,
  };
}

function checkpointObjectIds(checkpoint: CompactionCheckpoint): string[] {
  const ids = new Set(checkpoint.objectIds);
  for (const claims of [
    checkpoint.constraints,
    checkpoint.acceptanceCriteria,
    checkpoint.decisions,
    checkpoint.changes,
    checkpoint.verification,
    checkpoint.failures,
    checkpoint.blockers,
    checkpoint.pendingActions,
    checkpoint.safetyState,
  ]) {
    for (const claim of claims) for (const id of claim.objectIds ?? []) ids.add(id);
  }
  return [...ids].sort();
}

export function renderRuntimeFoldContext(): string {
  const fold = readContextRuntimeTelemetry()?.lastFold;
  if (!fold) return "";
  const bounded = (values: string[], max = 6) => values.slice(0, max).map(value => value.slice(0, 300));
  return [
    "[Verified runtime trajectory fold]",
    `Level: ${fold.level}`,
    `Subtask: ${fold.subtask}`,
    `Goal: ${fold.goal.slice(0, 300)}`,
    `Outcome: ${fold.outcome.slice(0, 500)}`,
    ...bounded(fold.facts).map(value => `Fact: ${value}`),
    ...bounded(fold.failures).map(value => `Failure: ${value}`),
    ...bounded(fold.pending).map(value => `Pending: ${value}`),
    `Context objects: ${fold.objectIds.slice(0, 20).join(", ") || "none"}`,
    `Source events: ${fold.sourceEventIds.slice(0, 30).join(", ") || "none"}`,
  ].join("\n").slice(0, 2_500);
}

export function createStructuredCompactionHandler(options: StructuredCompactionOptions) {
  return async (event: any, ctx: any): Promise<any | undefined> => {
    const startedAt = Date.now();
    let schemaValid = false;
    let fallbackUsed = false;
    let activeControlsBefore = 0;
    let activeControlsAfter = 0;
    let relinkingDetected = false;
    let attempts = 0;
    let localTimeouts = 0;
    let outputTruncations = 0;
    try {
      const { preparation } = event;
      const sourceSignal: AbortSignal = event.signal ?? new AbortController().signal;
      const allMessages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
      const prepared = prepareCompactionConversation(allMessages, preparation.previousSummary, renderRuntimeFoldContext());
      const sessionKey = options.sessionKey?.(event, ctx) ?? String(preparation.firstKeptEntryId ?? "session");
      const persisted = options.liveSemanticValidation ? await loadLiveControlState(ctx.cwd, sessionKey) : undefined;
      const previous = options.getPreviousCheckpoint?.() ?? persisted?.checkpoint;
      const sourceEntries = sourceEntriesFromMessages(allMessages);
      const usage = ctx.getContextUsage?.();
      const contextPercent = Number(usage?.percent ?? (usage?.tokens && usage?.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : 0));
      const generationInput = prepareCompactionInitialInput({
        conversation: prepared.conversation,
        previousSummary: prepared.previousSummary,
        reason: event.reason,
        willRetry: Boolean(event.willRetry),
      }, contextPercent);
      const finalize = async (value: unknown, recoverEmptyGoal = false): Promise<CompactionCheckpoint> => {
        const candidate = recoverEmptyGoal ? recoverEmptyCompactionGoal(value, previous, sourceEntries) : value;
        const structural = validateCompactionCheckpoint(candidate);
        if (!options.liveSemanticValidation) return stabilizeCompactionControlPlane(structural, previous);
        const result = await finalizeLiveCompaction({ cwd: ctx.cwd, generated: structural, previous, sourceEntries });
        activeControlsBefore = result.audit.activeControlsBefore;
        activeControlsAfter = result.audit.activeControlsAfter;
        return result.checkpoint;
      };

      const invokeGeneration = async (input: CompactionGenerationInput, attempt: number): Promise<unknown> => {
        const timeoutMs = attempt === 0
          ? (options.attemptTimeoutMs ?? (contextPercent >= 85 ? COMPACTION_CRITICAL_INITIAL_TIMEOUT_MS : COMPACTION_REQUEST_TIMEOUT_MS))
          : (options.retryTimeoutMs ?? COMPACTION_RETRY_TIMEOUT_MS);
        const attemptSignal = createCompactionAttemptSignal(sourceSignal, timeoutMs);
        attempts++;
        try {
          return await options.generateCheckpoint(input, attemptSignal, ctx, attempt);
        } finally {
          if (attemptSignal.aborted && !sourceSignal.aborted) localTimeouts++;
        }
      };
      const retryInput = (error: unknown): CompactionGenerationInput => {
        const message = error instanceof Error ? error.message : String(error);
        if (/stop=(?:aborted|max_tokens|length)|unterminated|unexpected end/i.test(message)) outputTruncations++;
        return prepareCompactionRetryInput({ ...generationInput, validationError: message });
      };

      let generated: unknown;
      let retryUsed = false;
      try {
        generated = await invokeGeneration(generationInput, 0);
      } catch (error) {
        if (!isRetryableCheckpointGenerationError(error) || sourceSignal.aborted) throw error;
        retryUsed = true;
        generated = await invokeGeneration(retryInput(error), 1);
      }
      if (sourceSignal.aborted) return;
      let checkpoint: CompactionCheckpoint;
      try {
        checkpoint = await finalize(generated, retryUsed);
      } catch (error) {
        if (sourceSignal.aborted) return;
        if (retryUsed) throw error;
        retryUsed = true;
        generated = await invokeGeneration(retryInput(error), 1);
        if (sourceSignal.aborted) return;
        checkpoint = await finalize(generated, true);
      }
      schemaValid = true;
      const objectIds = checkpointObjectIds(checkpoint);
      if (!options.liveSemanticValidation && options.objectExists && objectIds.length > 0) {
        const existence = await Promise.all(objectIds.map(async id => ({ id, exists: await options.objectExists!(ctx.cwd, id) })));
        const missing = existence.find(item => !item.exists);
        if (missing) throw new Error(`Missing context object evidence: ${missing.id}`);
      }
      if (options.pinObjects && objectIds.length > 0) await options.pinObjects(ctx.cwd, objectIds);
      if (options.liveSemanticValidation) await saveLiveControlState(ctx.cwd, sessionKey, checkpoint);
      options.setPreviousCheckpoint?.(checkpoint);
      return {
        compaction: {
          summary: renderCompactionCheckpoint(checkpoint),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch (error) {
      fallbackUsed = true;
      const message = error instanceof Error ? error.message : String(error);
      relinkingDetected = /synthesized|relink/i.test(message);
      if (!event.signal?.aborted) ctx.ui?.notify?.(`Structured compaction failed (${message}); using default compaction.`, "warning");
      return;
    } finally {
      if (!event.signal?.aborted) {
        const model = ctx?.model;
        compactionMetricsChannel.publish({
          model: model ? { provider: String(model.provider ?? "unknown"), model: String(model.id ?? model.model ?? "unknown"), thinking: COMPACTION_EXECUTION_PROFILE.reasoning } : undefined,
          durationMs: Date.now() - startedAt,
          schemaValid,
          fallbackUsed,
          activeControlsBefore,
          activeControlsAfter,
          relinkingDetected,
          prohibitedBackendActions: 0,
          attempts,
          localTimeouts,
          outputTruncations,
        });
      }
    }
  };
}

export function extractCheckpointJsonText(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) throw new SyntaxError("Checkpoint response contains no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new SyntaxError("Checkpoint response is truncated; no complete balanced JSON object");
}

function parseCheckpointText(text: string): unknown {
  return JSON.parse(extractCheckpointJsonText(text));
}

function isRetryableCheckpointGenerationError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /empty checkpoint response|invalid checkpoint json|unterminated string|unexpected end.*json|expected.*json|abort|timeout|timed out/i.test(message);
}

function providerFailureKind(error: unknown): ProviderFailureKind {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/rate.?limit|\b429\b/i.test(message)) return "rate_limit";
  if (/unavailable|\b50[234]\b/i.test(message)) return "provider_unavailable";
  return "network";
}

async function generateWithActiveModel(input: CompactionGenerationInput, signal: AbortSignal, ctx: any, attempt = 0): Promise<unknown> {
  const model = ctx.model;
  if (!model) throw new Error("No active model available");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const limits = input.compactRetry
    ? { claims: 4, files: 8, textChars: 160, jsonChars: 5_000 }
    : { claims: 6, files: 12, textChars: 220, jsonChars: 8_000 };
  const prompt = `Create a JSON compaction checkpoint with exactly these keys:
version, goal, constraints, acceptanceCriteria, decisions, activeFiles, changes, verification, failures, blockers, pendingActions, safetyState, objectIds.

Each claim is {"text": string, "sourceEntryIds": string[], "objectIds"?: string[], "status"?: "active"|"resolved"|"superseded", "controlId"?: string, "contentHash"?: string}. Every factual claim must cite at least one exact source entry id shown in the conversation labels or an existing object id. Preserve controlId and contentHash exactly for active constraints, acceptance criteria, pending actions, and safety state.
Each activeFiles item is {"path": string, "relevance": string, "contentHash"?: string, "locators"?: [{"path"?: string, "lines"?: {"start": number, "end": number}, "section"?: string, "resultId"?: string}]}. Never use a bare path string in activeFiles. Never invent contentHash; omit it unless an exact hash already appears in the source context because Keylime verifies file bytes.
Preserve exact user constraints, paths, line ranges, hashes, errors, blockers, pending work, safety state, and existing object ids. The goal must be a non-empty concise statement of the latest user task; never return an empty or whitespace-only goal. Be concise: merge duplicates, prefer active over resolved history, use at most ${limits.claims} claims per section, ${limits.files} active files, and ${limits.textChars} characters per text field. Keep the entire JSON under ${limits.jsonChars} characters. Use empty arrays rather than omitting keys. Return one JSON object only.
${input.previousSummary ? `\nPrevious checkpoint:\n${boundCompactionText(input.previousSummary, COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS)}\n` : ""}${input.validationError ? `\nCorrection required: the previous JSON was rejected because ${input.validationError}. Regenerate the entire checkpoint with the exact schema.\n` : ""}
<conversation>
${input.conversation}
</conversation>`;
  const requestSignal = signal;
  const circuitKey = `${String(model.provider ?? "unknown")}/${String(model.id ?? model.model ?? "unknown")}`;
  if (!providerCircuitBreaker.allowRequest(circuitKey)) throw new Error(`Provider circuit is open for ${circuitKey}; using default compaction`);
  let response: Awaited<ReturnType<typeof complete>>;
  try {
    response = await complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: COMPACTION_MAX_OUTPUT_TOKENS,
      reasoning: COMPACTION_EXECUTION_PROFILE.reasoning,
      signal: requestSignal,
    });
  } catch (error) {
    providerCircuitBreaker.recordFailure(circuitKey, providerFailureKind(error));
    throw error;
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
  if (!text.trim()) {
    const thinkingChars = response.content.filter(part => part.type === "thinking").reduce((sum, part: any) => sum + String(part.thinking ?? "").length, 0);
    throw new Error(`Empty checkpoint response (stop=${response.stopReason ?? "unknown"}, thinkingChars=${thinkingChars}, attempt=${attempt + 1})`);
  }
  try {
    const parsed = parseCheckpointText(text);
    providerCircuitBreaker.recordSuccess(circuitKey);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid checkpoint JSON (stop=${response.stopReason ?? "unknown"}, chars=${text.length}, attempt=${attempt + 1}): ${message}`);
  }
}

export default function structuredCompactionExtension(pi: ExtensionAPI) {
  let highestReadinessBand: 0 | 65 | 80 | 90 | 95 = 0;
  let lastCheckpoint: CompactionCheckpoint | undefined;
  pi.on("session_start", async () => { highestReadinessBand = 0; lastCheckpoint = undefined; });
  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage?.();
    const percent = usage?.percent ?? (usage?.tokens && usage?.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0);
    const band = compactionReadinessBand(percent);
    if (!band) { highestReadinessBand = 0; return; }
    if (band <= highestReadinessBand) return;
    highestReadinessBand = band;
    const entries = ctx.sessionManager.getEntries();
    const source = entries
      .filter((entry: any) => entry.customType !== "compaction-readiness-v1")
      .map((entry: any) => `${entry.id ?? ""}:${entry.type ?? ""}`)
      .join("|");
    const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const last = entries.at(-1) as any;
    pi.appendEntry("compaction-readiness-v1", {
      version: 1,
      createdAt: Date.now(),
      contextPercent: Math.max(0, Math.min(100, Math.round(percent))),
      pressureBand: band,
      entryCount: entries.length,
      lastEntryId: last?.id,
      fingerprint,
    });
  });

  const handler = createStructuredCompactionHandler({
    generateCheckpoint: generateWithActiveModel,
    objectExists: async (cwd, id) => {
      try {
        await readStoredContextObject(cwd, id);
        return true;
      } catch {
        return false;
      }
    },
    pinObjects: pinContextObjects,
    getPreviousCheckpoint: () => lastCheckpoint,
    setPreviousCheckpoint: checkpoint => { lastCheckpoint = checkpoint; },
    liveSemanticValidation: true,
    sessionKey: (event, ctx) => {
      const first = ctx.sessionManager?.getEntries?.()?.[0];
      return String(first?.id ?? event.preparation?.firstKeptEntryId ?? "session");
    },
  });
  pi.on("session_before_compact", handler);
}
