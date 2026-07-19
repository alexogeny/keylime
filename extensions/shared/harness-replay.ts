import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readStoredContextObject } from "../context-object-store";
import type { HarnessTraceIR } from "./harness-trace-ir";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export type ReplayBundle = {
  version: 1; fingerprint: string; repositoryFingerprint: string; sessionId: string;
  events: any[]; dependencies: Array<{ objectId: string; contentHash: string; kind: string; sourceTool: string }>;
  parentFingerprint?: string;
};

async function repositoryFingerprint(cwd: string): Promise<string> { return sha(await realpath(cwd)); }
function structuralEvent(event: any): any {
  const allowed = ["id", "type", "parentId", "handler", "outcome", "objectIds", "controlParents", "responsibleArtifacts"];
  return Object.fromEntries(allowed.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
}
function fingerprintBody(bundle: Omit<ReplayBundle, "fingerprint">): string { return sha(stable(bundle)); }

export async function createReplayBundle(input: {
  cwd: string; trace: HarnessTraceIR | any; objectIds?: string[]; maxEvents?: number; maxDependencies?: number;
  [key: string]: unknown;
}): Promise<ReplayBundle> {
  const maxEvents = Math.max(1, Math.min(100_000, Math.floor(input.maxEvents ?? 20_000)));
  const maxDependencies = Math.max(0, Math.min(10_000, Math.floor(input.maxDependencies ?? 2_000)));
  const rawEvents = Array.isArray(input.trace.steps) ? input.trace.steps : Array.isArray(input.trace.events) ? input.trace.events : [];
  const events = rawEvents.slice(0, maxEvents).map(structuralEvent);
  const dependencies = [] as ReplayBundle["dependencies"];
  for (const objectId of [...new Set((input.objectIds ?? []).map(String))].sort().slice(0, maxDependencies)) {
    const payload = await readStoredContextObject(input.cwd, objectId);
    dependencies.push({ objectId, contentHash: payload.object.contentHash, kind: payload.object.kind, sourceTool: payload.object.sourceTool });
  }
  const without: Omit<ReplayBundle, "fingerprint"> = {
    version: 1, repositoryFingerprint: await repositoryFingerprint(input.cwd), sessionId: String(input.trace.sessionId ?? "session").slice(0, 200), events, dependencies,
  };
  return { ...without, fingerprint: fingerprintBody(without) };
}

export async function replayHarnessTrace(bundle: ReplayBundle, options: { cwd: string }) {
  if (bundle.repositoryFingerprint !== await repositoryFingerprint(options.cwd)) throw new Error("Replay repository identity mismatch");
  const { fingerprint: _fingerprint, ...body } = bundle;
  if (fingerprintBody(body) !== bundle.fingerprint) throw new Error("Replay bundle hash/fingerprint mismatch");
  for (const dependency of bundle.dependencies) {
    const payload = await readStoredContextObject(options.cwd, dependency.objectId);
    if (payload.object.contentHash !== dependency.contentHash) throw new Error(`Replay dependency hash mismatch: ${dependency.objectId}`);
  }
  return {
    version: bundle.fingerprint,
    steps: bundle.events.map(event => ({ ...event })),
    decisions: bundle.events.filter(event => event.outcome !== undefined).map(event => event.outcome),
    objectIds: bundle.dependencies.map(item => item.objectId),
    durationMs: 0, fallbackUsed: false, modelCalls: 0, toolExecutions: 0,
  };
}

export function compareReplayResults(baseline: any, candidate: any) {
  const before = baseline.decisions ?? [], after = candidate.decisions ?? [];
  const decisionChanges = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => ({ index, before: before[index], after: after[index] })).filter(item => item.before !== item.after);
  const baselineObjects = new Set<string>(baseline.objectIds ?? []), candidateObjects = new Set<string>(candidate.objectIds ?? []);
  return {
    baselineVersion: baseline.version, candidateVersion: candidate.version, decisionChanges,
    contextAdded: [...candidateObjects].filter(id => !baselineObjects.has(id)).sort(),
    contextRemoved: [...baselineObjects].filter(id => !candidateObjects.has(id)).sort(),
    latencyDeltaMs: Number(candidate.durationMs ?? 0) - Number(baseline.durationMs ?? 0),
    fallbackChanged: Boolean(candidate.fallbackUsed) !== Boolean(baseline.fallbackUsed),
  };
}

export function serializeReplayBundle(bundle: ReplayBundle): string { return stable(bundle); }

export function branchReplay(bundle: ReplayBundle, eventId: string, change: { policyOutcome?: string; outcome?: string }): ReplayBundle {
  const index = bundle.events.findIndex(event => event.id === eventId);
  if (index < 0) throw new Error(`Unknown replay event: ${eventId}`);
  const outcome = change.policyOutcome ?? change.outcome;
  const events = bundle.events.slice(0, index + 1).map(event => ({ ...event }));
  events[index] = { ...events[index], outcome };
  const without: Omit<ReplayBundle, "fingerprint"> = {
    version: 1, repositoryFingerprint: bundle.repositoryFingerprint, sessionId: bundle.sessionId,
    events, dependencies: bundle.dependencies.map(item => ({ ...item })), parentFingerprint: bundle.fingerprint,
  };
  return { ...without, fingerprint: fingerprintBody(without) };
}

export function firstReplayDivergence(baseline: Array<{ id: string; decision: unknown }>, candidate: Array<{ id: string; decision: unknown }>) {
  const length = Math.max(baseline.length, candidate.length);
  for (let index = 0; index < length; index++) if (baseline[index]?.id !== candidate[index]?.id || baseline[index]?.decision !== candidate[index]?.decision) {
    return { eventId: candidate[index]?.id ?? baseline[index]?.id, index, baseline: baseline[index]?.decision, candidate: candidate[index]?.decision };
  }
  return undefined;
}
