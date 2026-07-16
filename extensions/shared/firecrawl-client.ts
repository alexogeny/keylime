import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { loadSearchConfig } from "./web-search-store";

export interface FirecrawlPage {
  url: string;
  title: string;
  markdown: string;
  links: string[];
  metadata: Record<string, unknown>;
}

export interface FirecrawlCrawlRequest {
  url: string;
  includePaths?: string[];
  excludePaths?: string[];
  maxDiscoveryDepth?: number;
  limit?: number;
  allowSubdomains?: boolean;
  delay?: number;
}

export interface FirecrawlCrawlStatus {
  id: string;
  status: "scraping" | "completed" | "failed" | "cancelled";
  total?: number;
  completed?: number;
  creditsUsed?: number;
  next?: string;
  pages: FirecrawlPage[];
  errors: string[];
}

type FirecrawlConfig = { apiUrl: string; apiKey?: string };

function normalizeApiUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v2`;
}

export async function firecrawlConfig(): Promise<FirecrawlConfig> {
  const config = await loadSearchConfig();
  const apiKey = process.env.FIRECRAWL_API_KEY || config.FIRECRAWL_API_KEY || undefined;
  const apiUrl = normalizeApiUrl(process.env.FIRECRAWL_API_URL || config.FIRECRAWL_API_URL || "https://api.firecrawl.dev");
  return { apiUrl, apiKey };
}

export function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

export async function assertSafeFirecrawlTarget(value: string): Promise<void> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Firecrawl only accepts http(s) URLs");
  if (url.username || url.password) throw new Error("Credential-bearing URLs cannot be sent to Firecrawl");
  if (process.env.KEYLIME_FIRECRAWL_ALLOW_PRIVATE === "1") return;
  if (url.hostname === "localhost" || isPrivateAddress(url.hostname)) throw new Error("Private-network URLs cannot be sent to Firecrawl");
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(entry => isPrivateAddress(entry.address))) throw new Error("Private-network URLs cannot be sent to Firecrawl");
}

function headers(config: FirecrawlConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

async function apiRequest<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500).replace(/\s+/g, " ");
    throw new Error(`Firecrawl ${response.status}: ${message || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function normalizePage(data: any): FirecrawlPage {
  const metadata = data?.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  return {
    url: String(metadata.sourceURL ?? metadata.url ?? data?.url ?? ""),
    title: String(metadata.title ?? data?.title ?? ""),
    markdown: String(data?.markdown ?? ""),
    links: Array.isArray(data?.links) ? data.links.filter((link: unknown): link is string => typeof link === "string") : [],
    metadata,
  };
}

export async function scrapeWithFirecrawl(url: string, signal?: AbortSignal): Promise<FirecrawlPage> {
  await assertSafeFirecrawlTarget(url);
  const config = await firecrawlConfig();
  const response = await apiRequest<any>(`${config.apiUrl}/scrape`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      url,
      formats: ["markdown", "links"],
      onlyMainContent: true,
      storeInCache: false,
      ...(process.env.KEYLIME_FIRECRAWL_ZERO_DATA_RETENTION === "1" ? { zeroDataRetention: true } : {}),
    }),
  }, signal);
  if (response?.success === false) throw new Error(`Firecrawl scrape failed: ${String(response.error ?? "unknown error")}`);
  const page = normalizePage(response?.data ?? response);
  if (!page.markdown.trim()) throw new Error("Firecrawl returned no Markdown content");
  if (!page.url) page.url = url;
  return page;
}

export async function startFirecrawlCrawl(request: FirecrawlCrawlRequest, signal?: AbortSignal): Promise<string> {
  await assertSafeFirecrawlTarget(request.url);
  const config = await firecrawlConfig();
  if (!config.apiKey) throw new Error("FIRECRAWL_API_KEY is required for whole-site crawls");
  const response = await apiRequest<any>(`${config.apiUrl}/crawl`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      url: request.url,
      includePaths: request.includePaths,
      excludePaths: request.excludePaths,
      maxDiscoveryDepth: request.maxDiscoveryDepth,
      limit: Math.min(request.limit ?? 100, 500),
      allowSubdomains: request.allowSubdomains ?? false,
      delay: request.delay,
      scrapeOptions: {
        formats: ["markdown", "links"],
        onlyMainContent: true,
        storeInCache: false,
        ...(process.env.KEYLIME_FIRECRAWL_ZERO_DATA_RETENTION === "1" ? { zeroDataRetention: true } : {}),
      },
    }),
  }, signal);
  const id = response?.id ?? response?.data?.id;
  if (!id) throw new Error(`Firecrawl did not return a crawl id: ${String(response?.error ?? "unknown error")}`);
  return String(id);
}

export async function getFirecrawlCrawl(id: string, nextUrl?: string, signal?: AbortSignal): Promise<FirecrawlCrawlStatus> {
  const config = await firecrawlConfig();
  if (!config.apiKey) throw new Error("FIRECRAWL_API_KEY is required for whole-site crawls");
  const url = nextUrl || `${config.apiUrl}/crawl/${encodeURIComponent(id)}`;
  if (nextUrl && !url.startsWith(config.apiUrl)) throw new Error("Refusing an unexpected Firecrawl pagination URL");
  const response = await apiRequest<any>(url, { method: "GET", headers: headers(config) }, signal);
  return {
    id,
    status: response.status ?? "scraping",
    total: typeof response.total === "number" ? response.total : undefined,
    completed: typeof response.completed === "number" ? response.completed : undefined,
    creditsUsed: typeof response.creditsUsed === "number" ? response.creditsUsed : undefined,
    next: typeof response.next === "string" ? response.next : undefined,
    pages: Array.isArray(response.data) ? response.data.map(normalizePage).filter((page: FirecrawlPage) => page.markdown.trim()) : [],
    errors: Array.isArray(response.errors) ? response.errors.map(String) : [],
  };
}

export const __testables = { normalizeApiUrl, normalizePage, isPrivateAddress };
