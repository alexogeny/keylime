import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./shared/json-store";
import {
  createContextObject,
  selectContextObjectText,
  verifyContextObjectContent,
  type ContextObject,
  type CreateContextObjectInput,
} from "./shared/context-objects";

const STORE_DIR = join(".pi", "context-objects");
const MANIFEST_FILE = "index.json";
const ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

type StoredContextObjectPayload = {
  object: ContextObject;
  content: string;
};

type ContextObjectManifestEntry = ContextObject & { path: string };

let storeQueue: Promise<void> = Promise.resolve();

function validateId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid context object id: ${id}`);
}

function storeRoot(cwd: string): string {
  return join(cwd, STORE_DIR);
}

function payloadPath(cwd: string, id: string): string {
  validateId(id);
  return join(storeRoot(cwd), `${id}.json`);
}

function manifestPath(cwd: string): string {
  return join(storeRoot(cwd), MANIFEST_FILE);
}

async function queued<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation, operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isContextObject(value: unknown): value is ContextObject {
  const object = value as ContextObject | undefined;
  return object?.version === 1
    && typeof object.id === "string"
    && typeof object.contentHash === "string"
    && typeof object.originalChars === "number"
    && typeof object.sourceTool === "string"
    && typeof object.summary === "string"
    && typeof object.sections === "object";
}

export async function storeContextObject(cwd: string, input: CreateContextObjectInput): Promise<{ object: ContextObject; path: string; deduplicated: boolean }> {
  validateId(input.id);
  return queued(async () => {
    const root = storeRoot(cwd);
    await mkdir(root, { recursive: true });
    const object = createContextObject(input);
    const manifest = await readJsonFile<ContextObjectManifestEntry[]>(manifestPath(cwd), []);
    if (object.retention !== "pinned") {
      const duplicate = manifest.find(entry => entry.retention !== "pinned"
        && entry.kind === object.kind
        && entry.sourceTool === object.sourceTool
        && entry.contentHash === object.contentHash);
      if (duplicate) {
        try {
          const existing = await readStoredContextObject(cwd, duplicate.id);
          return { object: existing.object, path: payloadPath(cwd, duplicate.id), deduplicated: true };
        } catch {
          // Stale manifest entry: write a fresh verified payload below.
        }
      }
    }
    const path = payloadPath(cwd, object.id);
    await writeJsonFile(path, { object, content: input.content } satisfies StoredContextObjectPayload, { finalNewline: true });

    const entry: ContextObjectManifestEntry = { ...object, path: join(STORE_DIR, `${object.id}.json`).replace(/\\/g, "/") };
    const next = [...manifest.filter(item => item.id !== object.id), entry]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    await writeJsonFile(manifestPath(cwd), next, { finalNewline: true });
    return { object, path, deduplicated: false };
  });
}

export async function pinContextObjects(cwd: string, ids: string[]): Promise<void> {
  for (const id of ids) validateId(id);
  await queued(async () => {
    const manifest = await readJsonFile<ContextObjectManifestEntry[]>(manifestPath(cwd), []);
    const byId = new Map(manifest.map(entry => [entry.id, entry]));
    for (const id of ids) if (!byId.has(id)) throw new Error(`Unknown context object: ${id}`);
    for (const id of ids) {
      const payload = await readStoredContextObject(cwd, id);
      if (payload.object.retention === "pinned") continue;
      const object: ContextObject = { ...payload.object, retention: "pinned" };
      await writeJsonFile(payloadPath(cwd, id), { object, content: payload.content } satisfies StoredContextObjectPayload, { finalNewline: true });
      byId.set(id, { ...byId.get(id)!, retention: "pinned" });
    }
    const next = manifest.map(entry => byId.get(entry.id)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    await writeJsonFile(manifestPath(cwd), next, { finalNewline: true });
  });
}

export async function cleanupContextObjects(
  cwd: string,
  options: { maxAgeDays?: number; maxEntries?: number; now?: string } = {},
): Promise<{ deleted: string[]; kept: string[] }> {
  return queued(async () => {
    const manifest = await readJsonFile<ContextObjectManifestEntry[]>(manifestPath(cwd), []);
    const now = new Date(options.now ?? new Date().toISOString()).getTime();
    const maxAgeMs = options.maxAgeDays === undefined ? undefined : Math.max(0, options.maxAgeDays) * 86_400_000;
    const byId = new Map(manifest.map(entry => [entry.id, entry]));
    const protectedIds = new Set(manifest.filter(entry => entry.retention === "pinned").map(entry => entry.id));
    const pending = [...protectedIds];
    while (pending.length > 0) {
      const entry = byId.get(pending.pop()!);
      for (const dependency of entry?.dependencies ?? []) {
        if (!protectedIds.has(dependency) && byId.has(dependency)) {
          protectedIds.add(dependency);
          pending.push(dependency);
        }
      }
    }
    let candidates = manifest.filter(entry => !protectedIds.has(entry.id));
    const deleted = new Set<string>();
    if (maxAgeMs !== undefined) {
      for (const entry of candidates) {
        const age = now - new Date(entry.createdAt).getTime();
        if (Number.isFinite(age) && age > maxAgeMs) deleted.add(entry.id);
      }
    }
    candidates = candidates.filter(entry => !deleted.has(entry.id));
    if (options.maxEntries !== undefined) {
      const keep = Math.max(0, Math.floor(options.maxEntries));
      const newest = candidates.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      for (const entry of newest.slice(keep)) deleted.add(entry.id);
    }
    for (const id of deleted) await rm(payloadPath(cwd, id), { force: true });
    const keptEntries = manifest.filter(entry => !deleted.has(entry.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    await writeJsonFile(manifestPath(cwd), keptEntries, { finalNewline: true });
    return { deleted: [...deleted].sort(), kept: keptEntries.map(entry => entry.id) };
  });
}

export async function readStoredContextObject(cwd: string, id: string): Promise<StoredContextObjectPayload> {
  const path = payloadPath(cwd, id);
  const payload = await readJsonFile<StoredContextObjectPayload | null>(path, null, { onError: "throw" });
  if (!payload || !isContextObject(payload.object) || typeof payload.content !== "string") {
    throw new Error(`Invalid context object payload: ${id}`);
  }
  if (payload.object.id !== id) throw new Error(`Context object id mismatch: ${id}`);
  if (!verifyContextObjectContent(payload.object, payload.content)) throw new Error(`Context object ${id} hash mismatch`);
  return payload;
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…\n[truncated ${text.length - maxChars} chars]`;
}

export default function contextObjectStoreExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "inspect_context_object",
    label: "Inspect Context Object",
    description: "Recover a verified context-object section or exact line range with a bounded output cap.",
    promptSnippet: "Inspect a stored context object",
    promptGuidelines: ["Use inspect_context_object for exact partial recovery instead of reloading a full stored tool payload."],
    parameters: Type.Object({
      object_id: Type.String({ description: "Context object id" }),
      section: Type.Optional(Type.String({ description: "Named section to recover" })),
      start_line: Type.Optional(Type.Number({ minimum: 1, description: "First original line" })),
      end_line: Type.Optional(Type.Number({ minimum: 1, description: "Last original line" })),
      max_chars: Type.Optional(Type.Number({ minimum: 100, maximum: 50_000, description: "Maximum returned characters" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if ((params.start_line === undefined) !== (params.end_line === undefined)) {
        throw new Error("start_line and end_line must be supplied together");
      }
      if (params.section && params.start_line !== undefined) throw new Error("Choose section or line range, not both");
      const payload = await readStoredContextObject(ctx?.cwd ?? process.cwd(), params.object_id);
      const selected = selectContextObjectText(payload.object, payload.content, {
        section: params.section,
        lines: params.start_line === undefined ? undefined : { start: params.start_line, end: params.end_line! },
      });
      const maxChars = Math.max(100, Math.min(50_000, params.max_chars ?? 4_000));
      return {
        content: [{ type: "text", text: capText(selected, maxChars) }],
        details: {
          objectId: payload.object.id,
          section: params.section,
          lines: params.start_line === undefined ? undefined : { start: params.start_line, end: params.end_line },
          selectedChars: selected.length,
          originalChars: payload.object.originalChars,
          verified: true,
        },
      };
    },
  });
}
