import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readJsonDir, readJsonFile, writeJsonFile } from "./json-store";
import { ageString } from "./time-format";
import type { SearchEntry, SearchIndex, SearchStats } from "./web-search-types";

export function webSearchDataDir(): string {
  return process.env.KEYLIME_WEB_SEARCH_DATA_DIR ?? join(homedir(), ".pi", "data", "web-search");
}

export function webSearchPaths(dataDir = webSearchDataDir()) {
  return {
    dataDir,
    searchesDir: join(dataDir, "searches"),
    indexFile: join(dataDir, "index.json"),
    configFile: join(dataDir, "config.json"),
  };
}

export async function ensureWebSearchDirs(dataDir = webSearchDataDir()): Promise<void> {
  await mkdir(webSearchPaths(dataDir).searchesDir, { recursive: true });
}

export async function loadSearchConfig(dataDir = webSearchDataDir()): Promise<Record<string, string>> {
  return readJsonFile(webSearchPaths(dataDir).configFile, {});
}

export async function loadSearchIndex(dataDir = webSearchDataDir()): Promise<SearchIndex> {
  return readJsonFile(webSearchPaths(dataDir).indexFile, { version: 1, entries: [] });
}

export async function saveSearchIndex(index: SearchIndex, dataDir = webSearchDataDir()): Promise<void> {
  await writeJsonFile(webSearchPaths(dataDir).indexFile, index);
}

export async function loadSearchEntry(id: string, dataDir = webSearchDataDir()): Promise<SearchEntry | null> {
  return readJsonFile<SearchEntry | null>(join(webSearchPaths(dataDir).searchesDir, `${id}.json`), null);
}

export async function saveSearchEntry(entry: SearchEntry, dataDir = webSearchDataDir()): Promise<void> {
  await writeJsonFile(join(webSearchPaths(dataDir).searchesDir, `${entry.id}.json`), entry);
}

export async function loadAllSearchEntries(dataDir = webSearchDataDir()): Promise<SearchEntry[]> {
  return readJsonDir<SearchEntry>(webSearchPaths(dataDir).searchesDir);
}

export async function getSearchStats(dataDir = webSearchDataDir()): Promise<SearchStats> {
  const index = await loadSearchIndex(dataDir);
  const allTags = new Set<string>();
  const allCategories = new Set<string>();
  let withKnowledge = 0;
  let newestTs = 0;
  let newestQuery = "";

  for (const entry of index.entries) {
    if (entry.summary) withKnowledge++;
    entry.tags.forEach(tag => allTags.add(tag));
    entry.categories.forEach(category => allCategories.add(category));
    if (entry.timestamp > newestTs) {
      newestTs = entry.timestamp;
      newestQuery = entry.query;
    }
  }

  return {
    total: index.entries.length,
    withKnowledge,
    allTags: [...allTags].sort(),
    allCategories: [...allCategories].sort(),
    newestQuery: newestQuery || undefined,
    newestAge: newestTs === 0 ? undefined : ageString(newestTs),
  };
}
