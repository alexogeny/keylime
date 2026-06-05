import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return fallback; }
}

export async function writeJsonFile(path: string, value: unknown, options: { finalNewline?: boolean; createDirs?: boolean } = {}): Promise<void> {
  if (options.createDirs ?? true) await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + (options.finalNewline ? "\n" : "");
  await writeFile(path, text, "utf8");
}

export async function readJsonDir<T>(dir: string, options: { filter?: (fileName: string) => boolean } = {}): Promise<T[]> {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: T[] = [];
  for (const file of files.filter(options.filter ?? (name => name.endsWith(".json")))) {
    try { out.push(JSON.parse(await readFile(join(dir, file), "utf8")) as T); }
    catch { /* skip corrupt */ }
  }
  return out;
}
