import { complete } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  renderCompactionCheckpoint,
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
} from "./shared/compaction-schema";
import { pinContextObjects, readStoredContextObject } from "./context-object-store";

type CompactionGenerationInput = {
  conversation: string;
  previousSummary?: string;
  reason: string;
  willRetry: boolean;
};

type StructuredCompactionOptions = {
  generateCheckpoint: (input: CompactionGenerationInput, signal: AbortSignal, ctx: any) => Promise<unknown>;
  objectExists?: (cwd: string, id: string) => Promise<boolean>;
  pinObjects?: (cwd: string, ids: string[]) => Promise<void>;
};

function serializeCompactionMessages(messages: any[]): string {
  return messages.map((message, index) => {
    try {
      return `[${index + 1}:${message?.role ?? "entry"}] ${JSON.stringify(message?.content ?? message)}`;
    } catch {
      return `[${index + 1}:${message?.role ?? "entry"}] [unserializable entry]`;
    }
  }).join("\n\n");
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

export function createStructuredCompactionHandler(options: StructuredCompactionOptions) {
  return async (event: any, ctx: any): Promise<any | undefined> => {
    try {
      const { preparation, signal } = event;
      const allMessages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
      const conversation = serializeCompactionMessages(allMessages);
      const generated = await options.generateCheckpoint({
        conversation,
        previousSummary: preparation.previousSummary,
        reason: event.reason,
        willRetry: Boolean(event.willRetry),
      }, signal, ctx);
      if (signal?.aborted) return;
      const checkpoint = validateCompactionCheckpoint(generated);
      const objectIds = checkpointObjectIds(checkpoint);
      if (options.objectExists) {
        for (const id of objectIds) {
          if (!(await options.objectExists(ctx.cwd, id))) throw new Error(`Missing context object evidence: ${id}`);
        }
      }
      if (options.pinObjects && objectIds.length > 0) await options.pinObjects(ctx.cwd, objectIds);
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

async function generateWithActiveModel(input: CompactionGenerationInput, signal: AbortSignal, ctx: any): Promise<unknown> {
  const model = ctx.model;
  if (!model) throw new Error("No active model available");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const prompt = `Create a JSON compaction checkpoint with exactly these keys:
version, goal, constraints, acceptanceCriteria, decisions, activeFiles, changes, verification, failures, blockers, pendingActions, safetyState, objectIds.

Each claim is {"text": string, "sourceEntryIds"?: string[], "objectIds"?: string[], "status"?: "active"|"resolved"|"superseded"}.
Preserve exact user constraints, paths, line ranges, hashes, errors, blockers, pending work, safety state, and existing object ids. Use empty arrays rather than omitting keys. Return JSON only.
${input.previousSummary ? `\nPrevious checkpoint:\n${input.previousSummary}\n` : ""}
<conversation>
${input.conversation}
</conversation>`;
  const response = await complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: 8192,
    signal,
  });
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
  if (!text.trim()) throw new Error("Empty checkpoint response");
  return parseCheckpointText(text);
}

export default function structuredCompactionExtension(pi: ExtensionAPI) {
  let readinessFingerprint = "";
  pi.on("session_start", async () => { readinessFingerprint = ""; });
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
  });
  pi.on("session_before_compact", handler);
}
