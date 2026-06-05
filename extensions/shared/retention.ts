import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function pruneFilesByNewest(dir: string, options: { keep: number; filter?: (fileName: string) => boolean; relatedFiles?: (fileName: string) => string[] }): Promise<number> {
  const keep = Math.max(0, options.keep);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter(options.filter ?? (() => true))
    .sort();
  const stale = files.slice(0, Math.max(0, files.length - keep));
  let deleted = 0;
  for (const file of stale) {
    const related = [file, ...(options.relatedFiles?.(file) ?? [])];
    for (const name of related) {
      try {
        await unlink(join(dir, name));
        deleted += 1;
      } catch {
        // best-effort retention cleanup
      }
    }
  }
  return deleted;
}
