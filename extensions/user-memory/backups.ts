import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/json-store";
import { pruneFilesByNewest } from "../shared/retention";
import { safeTimestampForFilename } from "../shared/time-format";
import type { EntityStore } from "./entity.js";

type MemoryStoreLike = { version: 1; memories: unknown[] };

export function backupDirFor(dataDir: string): string {
  return join(dataDir, "backups");
}

export async function createMemoryBackup(dataDir: string, store: MemoryStoreLike, entityStore: EntityStore, timestamp = safeTimestampForFilename()): Promise<{ timestamp: string; memoryFile: string; entityFile: string }> {
  const backupDir = backupDirFor(dataDir);
  await mkdir(backupDir, { recursive: true });
  const memoryFile = `memories-${timestamp}.json`;
  const entityFile = `entities-${timestamp}.json`;
  await writeJsonFile(join(backupDir, memoryFile), store);
  await writeJsonFile(join(backupDir, entityFile), entityStore);
  return { timestamp, memoryFile, entityFile };
}

export async function pruneMemoryBackups(dataDir: string, keep = 10): Promise<number> {
  return pruneFilesByNewest(backupDirFor(dataDir), {
    keep,
    filter: file => file.startsWith("memories-") && file.endsWith(".json"),
    relatedFiles: file => [file.replace("memories-", "entities-")],
  });
}

export async function listMemoryBackups(dataDir: string): Promise<string[]> {
  const backupDir = backupDirFor(dataDir);
  await mkdir(backupDir, { recursive: true });
  return (await readdir(backupDir).catch(() => [] as string[]))
    .filter(file => file.startsWith("memories-") && file.endsWith(".json"))
    .sort()
    .reverse();
}

export function backupLabel(file: string, count: number): string {
  const ts = file.replace("memories-", "").replace(".json", "").replace(/-/g, (_m, i) => i === 13 ? ":" : i === 16 ? ":" : i === 10 ? "T" : "-");
  return `${ts}  (${count} memories)`;
}

export async function backupLabels(dataDir: string, files: string[]): Promise<string[]> {
  const backupDir = backupDirFor(dataDir);
  return Promise.all(files.map(async file => {
    try {
      const raw = await readJsonFile<MemoryStoreLike>(join(backupDir, file), { version: 1, memories: [] });
      return backupLabel(file, raw.memories?.length ?? 0);
    } catch {
      return file;
    }
  }));
}

export async function loadMemoryBackup<T extends MemoryStoreLike>(dataDir: string, file: string): Promise<T> {
  return readJsonFile<T>(join(backupDirFor(dataDir), file), { version: 1, memories: [] } as T);
}

export async function restoreEntityBackup(dataDir: string, memoryBackupFile: string): Promise<boolean> {
  const entityBackupFile = memoryBackupFile.replace("memories-", "entities-");
  const entityBackupPath = join(backupDirFor(dataDir), entityBackupFile);
  if (!existsSync(entityBackupPath)) return false;
  const restoredEntities = await readJsonFile<EntityStore>(entityBackupPath, { version: 1, entities: [] });
  await writeJsonFile(join(dataDir, "entities.json"), restoredEntities);
  return true;
}
