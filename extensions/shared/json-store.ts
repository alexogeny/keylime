import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function readJsonFile<T>(path: string, fallback: T, options: { onError?: "fallback" | "throw" } = {}): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if (options.onError === "throw") throw error;
    return fallback;
  }
}

export async function writeJsonFile(path: string, value: unknown, options: { finalNewline?: boolean; createDirs?: boolean; atomic?: boolean } = {}): Promise<void> {
  if (options.createDirs ?? true) await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + (options.finalNewline ? "\n" : "");
  if (options.atomic === false) {
    await writeFile(path, text, "utf8");
    return;
  }
  const temporaryPath = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonDir<T>(dir: string, options: { filter?: (fileName: string) => boolean; concurrency?: number; onError?: "skip" | "throw" } = {}): Promise<T[]> {
  const files = (await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  })).filter(options.filter ?? (name => name.endsWith(".json"))).sort();
  const results = new Array<T | undefined>(files.length);
  const concurrency = Math.max(1, Math.min(files.length || 1, Math.floor(options.concurrency ?? 8)));
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      try { results[index] = JSON.parse(await readFile(join(dir, files[index]), "utf8")) as T; }
      catch (error) {
        if (options.onError === "throw") throw error;
      }
    }
  }));
  return results.filter((value): value is T => value !== undefined);
}
