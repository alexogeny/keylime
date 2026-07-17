import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readJsonDir, readJsonFile, writeJsonFile } from "./json-store";
import type { StoreWebPageInput, WebContentPage, WebCrawlManifest } from "./web-content-types";

export function webContentDataDir(): string {
  return process.env.KEYLIME_WEB_CONTENT_DATA_DIR ?? join(homedir(), ".pi", "data", "web-content");
}

export function webContentPaths(dataDir = webContentDataDir()) {
  return {
    dataDir,
    pagesDir: join(dataDir, "pages"),
    blobsDir: join(dataDir, "blobs"),
    crawlsDir: join(dataDir, "crawls"),
  };
}

export function stableContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalizeWebUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = "";
  for (const [key, val] of sorted) url.searchParams.append(key, val);
  return url.toString();
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensureContentBlob(path: string, content: string, deps: { access: (path: string) => Promise<unknown>; writeAtomic: (path: string, content: string) => Promise<void> } = { access, writeAtomic: writeTextAtomic }): Promise<void> {
  try {
    await deps.access(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await deps.writeAtomic(path, content);
  }
}

export function contentTermFrequency(content: string): Record<string, number> {
  const frequencies: Record<string, number> = Object.create(null);
  for (const token of content.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    frequencies[token] = Math.min((frequencies[token] ?? 0) + 1, 12);
  }
  return frequencies;
}

export async function saveWebPage(input: StoreWebPageInput, dataDir = webContentDataDir()): Promise<WebContentPage> {
  const canonicalUrl = canonicalizeWebUrl(input.url);
  const contentHash = stableContentHash(input.content);
  const id = `${stableContentHash(canonicalUrl).slice(0, 20)}-${contentHash.slice(0, 16)}`;
  const paths = webContentPaths(dataDir);
  const contentPath = join(paths.blobsDir, `${contentHash}.md`);
  const pagePath = join(paths.pagesDir, `${id}.json`);

  await mkdir(paths.blobsDir, { recursive: true });
  await ensureContentBlob(contentPath, input.content);

  const existing = await readJsonFile<WebContentPage | null>(pagePath, null);
  const page: WebContentPage = {
    id,
    url: input.url,
    canonicalUrl,
    title: input.title?.trim() || existing?.title || basename(new URL(input.url).pathname) || new URL(input.url).hostname,
    provider: input.provider,
    fetchedAt: input.fetchedAt ?? Date.now(),
    contentHash,
    contentPath,
    contentLength: input.content.length,
    links: [...new Set([...(existing?.links ?? []), ...(input.links ?? [])])],
    crawlIds: [...new Set([...(existing?.crawlIds ?? []), ...(input.crawlId ? [input.crawlId] : [])])],
    searchIds: [...new Set([...(existing?.searchIds ?? []), ...(input.searchId ? [input.searchId] : [])])],
    bodyTermFrequency: contentTermFrequency(input.content),
    metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
  };
  await writeJsonFile(pagePath, page);
  return page;
}

export async function loadWebPage(id: string, dataDir = webContentDataDir()): Promise<WebContentPage | null> {
  return readJsonFile<WebContentPage | null>(join(webContentPaths(dataDir).pagesDir, `${id}.json`), null);
}

export async function loadWebPageContent(page: WebContentPage): Promise<string> {
  return readFile(page.contentPath, "utf8");
}

export async function loadAllWebPages(dataDir = webContentDataDir()): Promise<WebContentPage[]> {
  return readJsonDir<WebContentPage>(webContentPaths(dataDir).pagesDir);
}

export async function findLatestWebPage(url: string, dataDir = webContentDataDir()): Promise<WebContentPage | null> {
  const canonicalUrl = canonicalizeWebUrl(url);
  const urlPrefix = `${stableContentHash(canonicalUrl).slice(0, 20)}-`;
  const pages = await readJsonDir<WebContentPage>(webContentPaths(dataDir).pagesDir, { filter: name => name.startsWith(urlPrefix) && name.endsWith(".json") });
  let latest: WebContentPage | null = null;
  for (const page of pages) {
    if (page.canonicalUrl === canonicalUrl && (!latest || page.fetchedAt > latest.fetchedAt)) latest = page;
  }
  return latest;
}

export async function saveCrawlManifest(manifest: WebCrawlManifest, dataDir = webContentDataDir()): Promise<void> {
  await writeJsonFile(join(webContentPaths(dataDir).crawlsDir, `${manifest.id}.json`), manifest);
}

export async function loadCrawlManifest(id: string, dataDir = webContentDataDir()): Promise<WebCrawlManifest | null> {
  return readJsonFile<WebCrawlManifest | null>(join(webContentPaths(dataDir).crawlsDir, `${id}.json`), null);
}

export async function loadAllCrawlManifests(dataDir = webContentDataDir()): Promise<WebCrawlManifest[]> {
  return readJsonDir<WebCrawlManifest>(webContentPaths(dataDir).crawlsDir);
}
