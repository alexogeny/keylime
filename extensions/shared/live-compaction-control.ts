import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readStoredContextObject } from "../context-object-store";
import {
  validateCompactionCheckpoint,
  type CompactionCheckpoint,
  type CompactionSourceEntry,
  type CompactionEvidenceStatus,
} from "./compaction-schema";
import { COMPACTION_CONTROL_SECTIONS, stabilizeCompactionControlPlane } from "./compaction-control";

export type AuthorizedControlTransition = {
  controlId: string;
  to: Extract<CompactionEvidenceStatus, "resolved" | "superseded">;
  sourceEntryId: string;
};
export type LiveCompactionAudit = {
  fileHashesVerified: number;
  objectIdsVerified: number;
  activeControlsBefore: number;
  activeControlsAfter: number;
  authorizedTransitions: AuthorizedControlTransition[];
};
export type LiveControlState = {
  version: 1;
  repositoryFingerprint: string;
  sessionKeyHash: string;
  savedAt: string;
  checkpoint: CompactionCheckpoint;
  checksum: string;
};

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sessionHash = (sessionKey: string): string => sha(sessionKey);
const boundedText = (text: string, max = 20_000): string => text.length <= max
  ? text
  : `${text.slice(0, 4_000)}\n[bounded source entry]\n${text.slice(-(max - 4_024))}`;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

export function sourceEntriesFromMessages(messages: unknown[]): CompactionSourceEntry[] {
  return messages.map((raw, index) => {
    const message = raw as any;
    const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "tool";
    return {
      id: String(message?.id ?? message?.entryId ?? `entry-${index + 1}`),
      role,
      text: boundedText(textFromContent(message?.content ?? message)),
      trusted: role === "user",
    };
  });
}

async function repositoryFingerprint(cwd: string): Promise<string> {
  return sha(await realpath(cwd));
}

async function verifiedFile(cwd: string, path: string): Promise<{ contentHash: string }> {
  if (!path || isAbsolute(path)) throw new Error(`Active file path is outside the repository: ${path}`);
  const root = await realpath(cwd);
  const candidate = resolve(root, path);
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new Error(`Active file path escapes the repository: ${path}`);
  const actual = await realpath(candidate);
  const actualRelative = relative(root, actual);
  if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) throw new Error(`Active file resolves outside the repository: ${path}`);
  return { contentHash: sha(await readFile(actual)) };
}

function referencedObjectIds(checkpoint: CompactionCheckpoint): string[] {
  const ids = new Set(checkpoint.objectIds);
  for (const key of [
    "constraints", "acceptanceCriteria", "decisions", "changes", "verification", "failures", "blockers", "pendingActions", "safetyState",
  ] as const) for (const claim of checkpoint[key]) for (const id of claim.objectIds ?? []) ids.add(id);
  return [...ids];
}

function activeControlCount(checkpoint?: CompactionCheckpoint): number {
  if (!checkpoint) return 0;
  return COMPACTION_CONTROL_SECTIONS.reduce((sum, section) => sum + checkpoint[section].filter(claim => claim.status === "active").length, 0);
}

function inferTransitions(
  generated: CompactionCheckpoint,
  previous: CompactionCheckpoint | undefined,
  sources: Map<string, CompactionSourceEntry>,
): AuthorizedControlTransition[] {
  if (!previous) return [];
  const inferred: AuthorizedControlTransition[] = [];
  for (const section of COMPACTION_CONTROL_SECTIONS) {
    const current = new Map(generated[section].filter(claim => claim.controlId).map(claim => [claim.controlId!, claim]));
    for (const prior of previous[section]) {
      if (prior.status !== "active" || !prior.controlId) continue;
      const next = current.get(prior.controlId);
      if (!next || (next.status !== "resolved" && next.status !== "superseded")) continue;
      const source = (next.sourceEntryIds ?? []).map(id => sources.get(id)).find(entry =>
        entry?.trusted && entry.role === "user" && entry.text.includes(prior.controlId!)
        && /\b(?:resolve|resolved|supersede|superseded)\b/i.test(entry.text)
      );
      if (source) inferred.push({ controlId: prior.controlId, to: next.status, sourceEntryId: source.id });
    }
  }
  return inferred;
}

function validateTransitions(transitions: AuthorizedControlTransition[], sources: Map<string, CompactionSourceEntry>): string[] {
  const ids = new Set<string>();
  for (const transition of transitions) {
    const source = sources.get(transition.sourceEntryId);
    if (!source?.trusted || source.role !== "user") throw new Error(`Control transition requires trusted user evidence: ${transition.controlId}`);
    if (!source.text.includes(transition.controlId) || !/\b(?:resolve|resolved|supersede|superseded)\b/i.test(source.text)) {
      throw new Error(`Control transition is not proven by its trusted source: ${transition.controlId}`);
    }
    ids.add(transition.controlId);
  }
  return [...ids];
}

export async function finalizeLiveCompaction(input: {
  cwd: string;
  generated: unknown;
  previous?: CompactionCheckpoint;
  sourceEntries: CompactionSourceEntry[];
  authorizedTransitions?: AuthorizedControlTransition[];
}): Promise<{ checkpoint: CompactionCheckpoint; audit: LiveCompactionAudit }> {
  const structurallyValid = validateCompactionCheckpoint(input.generated);
  const sources = new Map(input.sourceEntries.map(source => [source.id, source]));
  if (input.previous) {
    for (const key of [
      "constraints", "acceptanceCriteria", "decisions", "changes", "verification", "failures", "blockers", "pendingActions", "safetyState",
    ] as const) for (const claim of input.previous[key]) for (const id of claim.sourceEntryIds ?? []) {
      if (!sources.has(id)) sources.set(id, {
        id,
        role: COMPACTION_CONTROL_SECTIONS.includes(key as any) ? "user" : "assistant",
        text: claim.text,
        trusted: COMPACTION_CONTROL_SECTIONS.includes(key as any),
      });
    }
  }
  const transitions = input.authorizedTransitions ?? inferTransitions(structurallyValid, input.previous, sources);
  const authorizedIds = validateTransitions(transitions, sources);
  const checkpoint = stabilizeCompactionControlPlane(structurallyValid, input.previous, authorizedIds);

  let fileHashesVerified = 0;
  for (const file of checkpoint.activeFiles) {
    const verified = await verifiedFile(input.cwd, file.path);
    if (file.contentHash && file.contentHash !== verified.contentHash) throw new Error(`Active file hash mismatch: ${file.path}`);
    file.contentHash = verified.contentHash;
    fileHashesVerified++;
  }

  const objectIds = referencedObjectIds(checkpoint);
  for (const id of objectIds) {
    try { await readStoredContextObject(input.cwd, id); }
    catch { throw new Error(`Missing context object evidence: ${id}`); }
  }
  const validated = validateCompactionCheckpoint(checkpoint, {
    previousCheckpoint: input.previous,
    sourceEntries: [...sources.values()],
    knownObjectIds: objectIds,
    rejectSynthesizedInstructions: true,
    authorizedControlTransitions: authorizedIds,
  });
  return {
    checkpoint: validated,
    audit: {
      fileHashesVerified,
      objectIdsVerified: objectIds.length,
      activeControlsBefore: activeControlCount(input.previous),
      activeControlsAfter: activeControlCount(validated),
      authorizedTransitions: transitions,
    },
  };
}

export function controlStatePath(cwd: string, sessionKey: string): string {
  return resolve(cwd, ".pi", "compaction-controls", `${sessionHash(sessionKey)}.json`);
}

function stateChecksum(state: Omit<LiveControlState, "checksum">): string {
  return sha(JSON.stringify(state));
}

async function pruneControlStates(root: string, maxFiles = 50): Promise<void> {
  const names = (await readdir(root)).filter(name => name.endsWith(".json"));
  if (names.length <= maxFiles) return;
  const files = await Promise.all(names.map(async name => ({ name, mtimeMs: (await stat(resolve(root, name))).mtimeMs })));
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  await Promise.all(files.slice(0, files.length - maxFiles).map(file => rm(resolve(root, file.name), { force: true })));
}

export async function saveLiveControlState(cwd: string, sessionKey: string, checkpoint: CompactionCheckpoint): Promise<void> {
  const withoutChecksum: Omit<LiveControlState, "checksum"> = {
    version: 1,
    repositoryFingerprint: await repositoryFingerprint(cwd),
    sessionKeyHash: sessionHash(sessionKey),
    savedAt: new Date().toISOString(),
    checkpoint: validateCompactionCheckpoint(checkpoint),
  };
  const state: LiveControlState = { ...withoutChecksum, checksum: stateChecksum(withoutChecksum) };
  const path = controlStatePath(cwd, sessionKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
  await pruneControlStates(dirname(path));
}

async function quarantine(path: string): Promise<void> {
  await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`).catch(() => {});
}

export async function loadLiveControlState(cwd: string, sessionKey: string): Promise<LiveControlState | undefined> {
  const path = controlStatePath(cwd, sessionKey);
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as LiveControlState;
    const { checksum, ...withoutChecksum } = state;
    if (state.version !== 1
      || state.sessionKeyHash !== sessionHash(sessionKey)
      || state.repositoryFingerprint !== await repositoryFingerprint(cwd)
      || checksum !== stateChecksum(withoutChecksum)) throw new Error("Invalid persistent control state");
    validateCompactionCheckpoint(state.checkpoint);
    return state;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    await quarantine(path);
    return undefined;
  }
}
