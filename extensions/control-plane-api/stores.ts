import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { loadAllSearchEntries, loadSearchEntry } from "../shared/web-search-store";
import { MEMORY_FILE } from "../user-memory/store";

export const DEFAULT_DATA_DIR = join(homedir(), ".pi", "data", "keylime-control-plane");

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return fallback; }
}

export async function readMemoryStore() {
  return readJson(MEMORY_FILE, { version: 4, profile: {}, memories: [] as any[] });
}

export async function readResearchIndex(query = "") {
  const q = query.toLowerCase();
  const entries = await loadAllSearchEntries();
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
  if (!direct.startsWith(base)) throw new Error("Unsafe tool result path");
  if (existsSync(direct)) return direct;
  const manifest = await readToolResultIndex(cwd);
  const hit = manifest.find((e: any) => e.id === id || e.result_id === id);
  const stored = typeof hit?.stored_at === "string" ? normalize(join(cwd, hit.stored_at)) : "";
  if (stored && stored.startsWith(base) && existsSync(stored)) return stored;
  throw new Error("Tool result not found");
}

export async function readToolResult(cwd: string, id: string) {
  return JSON.parse(await readFile(await findToolResultPath(cwd, id), "utf8"));
}

export async function listWorkspaceFiles(cwd: string, limit = 300) {
  const out: Array<{ path: string; kind: "file" | "directory" }> = [];
  async function walk(dir: string, rel = "") {
    if (out.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= limit) return;
      if ([".git", "node_modules", ".pi"].includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.push({ path: childRel, kind: entry.isDirectory() ? "directory" : "file" });
      if (entry.isDirectory()) await walk(join(dir, entry.name), childRel);
    }
  }
  await walk(cwd);
  return out;
}
