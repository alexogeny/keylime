import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { readStoredContextObject } from "../context-object-store";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { loadSearchEntry, loadSearchIndex } from "../shared/web-search-store";
import { readJsonFile, writeJsonFile } from "../shared/json-store";
import { isPathWithin, resolveSafeExistingPath } from "../shared/path-policy";
import { MEMORY_FILE } from "../user-memory/store";

export const DEFAULT_DATA_DIR = join(homedir(), ".pi", "data", "keylime-control-plane");

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  return readJsonFile(path, fallback);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeJsonFile(path, value, { finalNewline: true });
}

export async function readMemoryStore() {
  return readJson(MEMORY_FILE, { version: 4, profile: {}, memories: [] as any[] });
}

export async function writeMemoryStore(store: unknown) {
  await writeJson(MEMORY_FILE, store);
}

export async function readResearchIndex(query = "") {
  const q = query.toLowerCase();
  const entries = (await loadSearchIndex()).entries;
  return entries
    .filter((e: any) => !q || [e.id, e.query, e.provider, e.summary, e.distilled?.summary, ...(e.distilled?.tags ?? []), ...(e.distilled?.categories ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q))
    .sort((a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function readResearchEntry(id: string) {
  return loadSearchEntry(id);
}

export async function readToolResultIndex(cwd: string) {
  return readJson(join(cwd, ".pi", "tool-results", "index.json"), [] as any[]);
}

export async function findToolResultPath(cwd: string, id: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Unsafe tool result id");
  const base = join(cwd, ".pi", "tool-results");
  const direct = normalize(join(base, `${id}.json`));
  if (!isPathWithin(base, direct)) throw new Error("Unsafe tool result path");
  if (existsSync(direct)) return resolveSafeExistingPath(cwd, direct);
  const manifest = await readToolResultIndex(cwd);
  const hit = manifest.find((e: any) => e.id === id || e.result_id === id);
  const stored = typeof hit?.stored_at === "string" ? normalize(join(cwd, hit.stored_at)) : "";
  if (stored && isPathWithin(base, stored) && existsSync(stored)) return resolveSafeExistingPath(cwd, stored);
  throw new Error("Tool result not found");
}

export async function readToolResult(cwd: string, id: string) {
  const result = JSON.parse(await readFile(await findToolResultPath(cwd, id), "utf8"));
  if (typeof result.contextObjectId === "string") result.content = (await readStoredContextObject(cwd, result.contextObjectId)).content;
  return result;
}

export async function listWorkspaceFiles(cwd: string, limit = 300) {
  const out: Array<{ path: string; kind: "file" | "directory" }> = [];
  const queue: Array<{ dir: string; rel: string }> = [{ dir: cwd, rel: "" }];
  let queueHead = 0;
  const ignored = new Set([".git", "node_modules", ".pi"]);
  while (queueHead < queue.length && out.length < limit) {
    const current = queue[queueHead++];
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (ignored.has(entry.name)) continue;
      const childRel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory() && !entry.isSymbolicLink();
      out.push({ path: childRel, kind: isDirectory ? "directory" : "file" });
      if (isDirectory) queue.push({ dir: join(current.dir, entry.name), rel: childRel });
    }
  }
  return out;
}
