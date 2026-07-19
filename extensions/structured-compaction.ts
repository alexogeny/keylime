import { complete } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  renderCompactionCheckpoint,
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
  type EvidenceClaim,
} from "./shared/compaction-schema";
import { pinContextObjects, readStoredContextObject } from "./context-object-store";
import { readContextRuntimeTelemetry } from "./shared/context-runtime-bus";
import { selectAgentExecutionProfile } from "./shared/agent-execution-profile";

const COMPACTION_EXECUTION_PROFILE = selectAgentExecutionProfile({
  taskKind: "structured_extraction", ambiguity: 0, risk: "medium", contextPressure: .8, requiresCreativity: false,
});
export const COMPACTION_MAX_CONVERSATION_CHARS = 120_000;
export const COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS = 30_000;
export const COMPACTION_MAX_OUTPUT_TOKENS = COMPACTION_EXECUTION_PROFILE.maxOutputTokens;
const COMPACTION_MAX_MESSAGE_CHARS = 24_000;
export const COMPACTION_REQUEST_TIMEOUT_MS = COMPACTION_EXECUTION_PROFILE.timeoutMs;

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
  reason: string;
  willRetry: boolean;
  validationError?: string;
};

type StructuredCompactionOptions = {
  generateCheckpoint: (input: CompactionGenerationInput, signal: AbortSignal, ctx: any, attempt?: number) => Promise<unknown>;
  objectExists?: (cwd: string, id: string) => Promise<boolean>;
  pinObjects?: (cwd: string, ids: string[]) => Promise<void>;
  getPreviousCheckpoint?: () => CompactionCheckpoint | undefined;
  setPreviousCheckpoint?: (checkpoint: CompactionCheckpoint) => void;
};

function serializeCompactionMessages(messages: any[]): string {
  let rendered = "";
  for (const [index, message] of messages.entries()) {
    let chunk: string;
    try {
      chunk = `[${index + 1}:${message?.role ?? "entry"}] ${JSON.stringify(message?.content ?? message)}`;
    } catch {
      chunk = `[${index + 1}:${message?.role ?? "entry"}] [unserializable entry]`;
    }
    chunk = boundCompactionText(chunk, COMPACTION_MAX_MESSAGE_CHARS);
    rendered = boundCompactionText(rendered ? `${rendered}\n\n${chunk}` : chunk, COMPACTION_MAX_CONVERSATION_CHARS);
  }
  return rendered;
}

const CONTROL_SECTIONS = ["constraints", "acceptanceCriteria", "pendingActions", "safetyState"] as const;
function claimHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function stabilizeCompactionControlPlane(checkpoint: CompactionCheckpoint, previous?: CompactionCheckpoint): CompactionCheckpoint {
  const next = structuredClone(checkpoint);
  for (const section of CONTROL_SECTIONS) {
    const normalized = next[section].map((claim): EvidenceClaim => {
      const contentHash = claimHash(claim.text);
      return { ...claim, controlId: claim.controlId ?? `${section}:${contentHash.slice(0, 16)}`, contentHash };
    });
    const byId = new Map(normalized.map(claim => [claim.controlId!, claim]));
    for (const prior of previous?.[section] ?? []) {
      if (prior.status !== "active") continue;
      const contentHash = prior.contentHash ?? claimHash(prior.text);
      const controlId = prior.controlId ?? `${section}:${contentHash.slice(0, 16)}`;
      const current = byId.get(controlId);
      if (!current || current.text !== prior.text || current.contentHash !== contentHash || current.status !== "active") {
        byId.set(controlId, { ...prior, controlId, contentHash, status: "active" });
      }
    }
    next[section] = [...byId.values()];
  }
  return next;
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
    try {
      const { preparation } = event;
      const sourceSignal: AbortSignal = event.signal ?? new AbortController().signal;
      const signal = AbortSignal.any([sourceSignal, AbortSignal.timeout(COMPACTION_REQUEST_TIMEOUT_MS)]);
      const allMessages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
      const serialized = serializeCompactionMessages(allMessages);
      const runtimeFold = renderRuntimeFoldContext();
      const conversation = boundCompactionText(runtimeFold ? `${serialized}\n\n${runtimeFold}` : serialized, COMPACTION_MAX_CONVERSATION_CHARS);
      const generationInput = {
        conversation,
        previousSummary: preparation.previousSummary,
        reason: event.reason,
        willRetry: Boolean(event.willRetry),
      };
      let generated: unknown;
      let retryUsed = false;
      try {
        generated = await options.generateCheckpoint(generationInput, signal, ctx, 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRetryableCheckpointGenerationError(error) || signal?.aborted) throw error;
        retryUsed = true;
        generated = await options.generateCheckpoint({ ...generationInput, validationError: message }, signal, ctx, 1);
      }
      if (signal?.aborted) return;
      let checkpoint: CompactionCheckpoint;
      try {
        checkpoint = validateCompactionCheckpoint(generated);
      } catch (error) {
        if (signal?.aborted) return;
        if (retryUsed) throw error;
        const validationError = error instanceof Error ? error.message : String(error);
        generated = await options.generateCheckpoint({ ...generationInput, validationError }, signal, ctx, 1);
        if (signal?.aborted) return;
        checkpoint = validateCompactionCheckpoint(generated);
      }
      checkpoint = stabilizeCompactionControlPlane(checkpoint, options.getPreviousCheckpoint?.());
      const objectIds = checkpointObjectIds(checkpoint);
      if (options.objectExists && objectIds.length > 0) {
        const existence = await Promise.all(objectIds.map(async id => ({ id, exists: await options.objectExists!(ctx.cwd, id) })));
        const missing = existence.find(item => !item.exists);
        if (missing) throw new Error(`Missing context object evidence: ${missing.id}`);
      }
      if (options.pinObjects && objectIds.length > 0) await options.pinObjects(ctx.cwd, objectIds);
      options.setPreviousCheckpoint?.(checkpoint);
      return {
        compaction: {
          summary: renderCompactionCheckpoint(checkpoint),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch (error) {
      if (!event.signal?.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(`Structured compaction failed (${message}); using default compaction.`, "warning");
      }
      return;
    }
  };
}

function parseCheckpointText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function isRetryableCheckpointGenerationError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /empty checkpoint response|invalid checkpoint json|unterminated string|unexpected end.*json|expected.*json/i.test(message);
}

async function generateWithActiveModel(input: CompactionGenerationInput, signal: AbortSignal, ctx: any, attempt = 0): Promise<unknown> {
  const model = ctx.model;
  if (!model) throw new Error("No active model available");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const prompt = `Create a JSON compaction checkpoint with exactly these keys:
version, goal, constraints, acceptanceCriteria, decisions, activeFiles, changes, verification, failures, blockers, pendingActions, safetyState, objectIds.

Each claim is {"text": string, "sourceEntryIds"?: string[], "objectIds"?: string[], "status"?: "active"|"resolved"|"superseded", "controlId"?: string, "contentHash"?: string}. Preserve controlId and contentHash exactly for active constraints, acceptance criteria, pending actions, and safety state.
Each activeFiles item is {"path": string, "relevance": string, "contentHash"?: string, "locators"?: [{"path"?: string, "lines"?: {"start": number, "end": number}, "section"?: string, "resultId"?: string}]}. Never use a bare path string in activeFiles.
Preserve exact user constraints, paths, line ranges, hashes, errors, blockers, pending work, safety state, and existing object ids. Be concise: merge duplicates, prefer active over resolved history, use at most 6 claims per section, 12 active files, and 240 characters per text field. Keep the entire JSON under 10,000 characters. Use empty arrays rather than omitting keys. Return JSON only.
${input.previousSummary ? `\nPrevious checkpoint:\n${boundCompactionText(input.previousSummary, COMPACTION_MAX_PREVIOUS_SUMMARY_CHARS)}\n` : ""}${input.validationError ? `\nCorrection required: the previous JSON was rejected because ${input.validationError}. Regenerate the entire checkpoint with the exact schema.\n` : ""}
<conversation>
${attempt > 0 && input.conversation.length > 60_000 ? `[earlier conversation omitted on retry]\n${input.conversation.slice(-60_000)}` : input.conversation}
</conversation>`;
  const timeoutSignal = AbortSignal.timeout(COMPACTION_REQUEST_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  const response = await complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    reasoning: COMPACTION_EXECUTION_PROFILE.reasoning,
    signal: requestSignal,
  });
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
  if (!text.trim()) {
    const thinkingChars = response.content.filter(part => part.type === "thinking").reduce((sum, part: any) => sum + String(part.thinking ?? "").length, 0);
    throw new Error(`Empty checkpoint response (stop=${response.stopReason ?? "unknown"}, thinkingChars=${thinkingChars}, attempt=${attempt + 1})`);
  }
  try {
    return parseCheckpointText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid checkpoint JSON (stop=${response.stopReason ?? "unknown"}, chars=${text.length}, attempt=${attempt + 1}): ${message}`);
  }
}

export default function structuredCompactionExtension(pi: ExtensionAPI) {
  let readinessFingerprint = "";
  let lastCheckpoint: CompactionCheckpoint | undefined;
  pi.on("session_start", async () => { readinessFingerprint = ""; lastCheckpoint = undefined; });
  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage?.();
    const percent = usage?.percent ?? (usage?.tokens && usage?.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : 0);
    if (!percent || percent < 65) return;
    const entries = ctx.sessionManager.getEntries();
    const source = entries.map((entry: any) => `${entry.id ?? ""}:${entry.type ?? ""}`).join("|");
    const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 16);
    if (fingerprint === readinessFingerprint) return;
    readinessFingerprint = fingerprint;
    const last = entries.at(-1) as any;
    pi.appendEntry("compaction-readiness-v1", {
      version: 1,
      createdAt: Date.now(),
      contextPercent: percent,
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
  });
  pi.on("session_before_compact", handler);
}
