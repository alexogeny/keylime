/**
 * fetch — gives the agent a fetch_url tool to read web pages, and automatically
 * enriches web_search results by fetching the top sources before the LLM
 * processes the result.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { extractMainContent, summarizeText, type SummaryResult } from "./shared/content-distill";

type FetchOutcome =
  | "ok"
  | "challenge_detected"
  | "blocked_http_status"
  | "non_html_content"
  | "timeout"
  | "network_error"
  | "parse_failed";

type FetchClassification =
  | "ok_content"
  | "challenge_page"
  | "blocked"
  | "soft_error"
  | "timeout";

type FetchPolicy = "none" | "retry_only" | "alt_headers" | "browser" | "browser_first";

type FetchResult = {
  outcome: FetchOutcome;
  classification: FetchClassification;
  title: string;
  content: string;
  links: string[];
  url: string;
  fetchedAt: string;
  status?: number;
  reason?: string;
  reasonCodes: string[];
  timingsMs: { total: number; download: number; extract: number };
  redirectCount: number;
  contentType?: string;
  contentLength: number;
  confidence: { score: number; reasons: string[] };
  decodedEmails?: string[];
  summary?: SummaryResult;
};

type DownloadResult = {
  ok: boolean;
  finalUrl: string;
  status?: number;
  headers?: Headers;
  body?: string;
  reasonCodes: string[];
  timingsMs: number;
  reason?: string;
};

type BrowserFallbackResult = {
  ok: boolean;
  title: string;
  content: string;
  links: string[];
  finalUrl: string;
  reasonCodes: string[];
  reason?: string;
  challenge?: string;
  timingsMs: number;
};

const BROWSER_UAS = [
  // Chromium-compatible desktop UA profiles. Keep these coherent with the Playwright Chromium browser engine.
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
];

type BrowserProfile = {
  engine: "chromium";
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  colorScheme: "light" | "dark" | "no-preference";
  reducedMotion: "reduce" | "no-preference";
};

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function pickUserAgent(url: string): string {
  return BROWSER_UAS[stableHash(url) % BROWSER_UAS.length];
}

function browserProfileForUrl(url: string): BrowserProfile {
  const hash = stableHash(url);
  return {
    engine: "chromium",
    userAgent: pickUserAgent(url),
    locale: "en-AU",
    timezoneId: "Australia/Brisbane",
    viewport: hash % 2 === 0 ? { width: 1365, height: 900 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "no-preference",
  };
}

function browserStateDirForUrl(url: string): string {
  let host = "unknown-host";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || host;
  } catch {}
  const base = process.env.KEYLIME_BROWSER_STATE_DIR ?? join(homedir(), ".pi", "browser-state");
  return join(base, host);
}

function browserSettleMs(): number {
  const raw = Number(process.env.KEYLIME_BROWSER_SETTLE_MS ?? "6000");
  return Number.isFinite(raw) ? Math.max(500, Math.min(raw, 15000)) : 6000;
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
    const token = String(ent).toLowerCase();
    if (token.startsWith("#x")) {
      const cp = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (token.startsWith("#")) {
      const cp = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[token] ?? m;
  });
}

function decodeCloudflareEmailHex(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(key)) return null;

  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    const b = Number.parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(b)) return null;
    out += String.fromCharCode(b ^ key);
  }
  return out.includes("@") ? out : null;
}

function deobfuscateHtml(html: string): { html: string; decodedEmails: string[] } {
  const decodedEmails: string[] = [];

  const anchorPattern = /<a\b[^>]*data-cfemail=["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/a>/gi;
  html = html.replace(anchorPattern, (full, hex) => {
    const decoded = decodeCloudflareEmailHex(String(hex));
    if (!decoded) return full;
    decodedEmails.push(decoded);
    return decoded;
  });

  const attrPattern = /data-cfemail=["']([0-9a-f]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(html)) !== null) {
    const decoded = decodeCloudflareEmailHex(m[1]);
    if (decoded) decodedEmails.push(decoded);
  }

  html = decodeHtmlEntities(html);

  const unique = [...new Set(decodedEmails)];
  if (unique.length > 0) {
    html = html.replace(/\[(?:email\s*)?protected\]/gi, unique[0]);
  }

  return { html, decodedEmails: unique };
}

function htmlToText(html: string, maxChars = 3000): string {
  const extracted = extractMainContent(html, { maxChars });
  return extracted.text;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim().slice(0, 120);
}

function isReadableTextContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "text/plain"
    || mediaType === "text/markdown"
    || mediaType === "text/x-markdown";
}

function extractTextTitle(content: string, url: string): string {
  const heading = content.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "").slice(0, 120);
  } catch {
    return "";
  }
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /href="(https?:\/\/[^\"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.length < 10) {
    try {
      const url = new URL(m[1]);
      const base = new URL(baseUrl);
      if (url.hostname === base.hostname) links.push(url.href);
    } catch {}
  }
  return [...new Set(links)];
}

type FetchTextOptions = {
  summarize?: boolean;
  query?: string;
  maxSummarySentences?: number;
  maxSummaryChars?: number;
};

function formatFetchText(result: FetchResult, options: FetchTextOptions = {}): { text: string; summary?: SummaryResult } {
  const summarize = options.summarize ?? true;
  const summary = summarize
    ? summarizeText(result.content, {
      query: options.query,
      maxSentences: options.maxSummarySentences ?? 4,
      maxChars: options.maxSummaryChars ?? 1200,
    })
    : undefined;

  const body = summarize && summary?.text
    ? [
      `## Deterministic summary (${summary.method}, ${summary.sentences.length}/${summary.candidates} sentences)`,
      summary.text,
      "",
      `_Full extracted content is available in tool details; rerun with summarize:false to print it._`,
    ].join("\n")
    : result.content;

  const text = [
    `# ${result.title || "(no title)"}`,
    `URL: ${result.url}`,
    `Fetched: ${result.fetchedAt}`,
    `Confidence: ${(result.confidence.score * 100).toFixed(0)}%`,
    result.links.length > 0 ? `\nRelated links on same domain:\n${result.links.slice(0, 5).map(l => `- ${l}`).join("\n")}` : "",
    "",
    body,
  ].filter(Boolean).join("\n");

  return { text, summary };
}

const CHALLENGE_MARKERS = [
  "just a moment",
  "verify you are human",
  "checking your browser",
  "cf-chl",
  "cf-mitigated",
  "turnstile",
  "captcha",
  "client challenge",
  "access denied",
  "please enable javascript",
  "attention required",
  "are you a robot",
];

function detectChallenge(html: string, headers: Headers): string | null {
  const lower = html.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  const cfMitigated = headers.get("cf-mitigated");
  if (cfMitigated) return `cf-mitigated:${cfMitigated}`;
  return null;
}

const SKIP_DOMAINS = [
  "youtube.com", "youtu.be", "twitter.com", "x.com",
  "facebook.com", "instagram.com", "tiktok.com",
  "reddit.com", "linkedin.com",
];

const SKIP_EXTENSIONS = /\.(pdf|png|jpg|jpeg|gif|webp|svg|mp4|mp3|zip|tar|gz|exe|dmg)(\?|$)/i;

function shouldSkip(url: string): boolean {
  return SKIP_DOMAINS.some(d => url.includes(d)) || SKIP_EXTENSIONS.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scoreContentQuality(title: string, content: string, html: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (content.length >= 1200) score += 0.45;
  else if (content.length >= 500) score += 0.3;
  else if (content.length >= 180) score += 0.15;
  else reasons.push("low_text_length");

  if (title.length >= 8) score += 0.2;
  else reasons.push("weak_title");

  const lineCount = content.split("\n").filter(l => l.trim().length > 0).length;
  if (lineCount >= 8) score += 0.2;
  else reasons.push("low_structure");

  const bodyLike = /<article|<main|<p|<section/i.test(html);
  if (bodyLike) score += 0.15;
  else reasons.push("weak_dom_signals");

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

function classifyFromOutcome(outcome: FetchOutcome): FetchClassification {
  if (outcome === "ok") return "ok_content";
  if (outcome === "challenge_detected") return "challenge_page";
  if (outcome === "blocked_http_status" || outcome === "non_html_content") return "blocked";
  if (outcome === "timeout") return "timeout";
  return "soft_error";
}

async function downloadPage(url: string, timeoutMs: number, policy: FetchPolicy, attempt: number): Promise<DownloadResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const reasonCodes: string[] = [];

  const headers: Record<string, string> = {
    "User-Agent": pickUserAgent(url),
    "Accept": "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.1",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
  };

  if (policy === "alt_headers" && attempt > 1) {
    headers["Accept-Language"] = "en-AU,en-US;q=0.9,en;q=0.8";
    reasonCodes.push("alt_headers_attempt", "no_synthetic_client_hints");
  }

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers,
    });

    const finalUrl = res.url || url;
    const status = res.status;

    if (!res.ok) {
      reasonCodes.push(`http_${status}`);
      return {
        ok: false,
        finalUrl,
        status,
        reasonCodes,
        timingsMs: Date.now() - started,
        reason: `http_${status}`,
      };
    }

    const body = await res.text();
    return {
      ok: true,
      finalUrl,
      status,
      headers: res.headers,
      body,
      reasonCodes,
      timingsMs: Date.now() - started,
    };
  } catch (err: any) {
    const aborted = err?.name === "AbortError";
    reasonCodes.push(aborted ? "abort_timeout" : "network_failure");
    return {
      ok: false,
      finalUrl: url,
      reasonCodes,
      timingsMs: Date.now() - started,
      reason: aborted ? "abort_timeout" : (err?.message ?? "network_failure"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function browserFallbackFetch(url: string, timeoutMs: number, maxChars: number): Promise<BrowserFallbackResult> {
  const started = Date.now();
  let context: any;
  const profile = browserProfileForUrl(url);
  const stateDir = browserStateDirForUrl(url);
  const reasonCodes = ["browser_engine_chromium", "coherent_browser_profile", "persistent_context"];

  try {
    let chromium: any;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      return {
        ok: false,
        title: "",
        content: "",
        links: [],
        finalUrl: url,
        reasonCodes: ["browser_fallback_unavailable", "missing_playwright"],
        reason: "playwright_not_installed",
        timingsMs: Date.now() - started,
      };
    }

    await mkdir(stateDir, { recursive: true });
    const channel = process.env.KEYLIME_BROWSER_CHANNEL || undefined;
    context = await chromium.launchPersistentContext(stateDir, {
      headless: process.env.KEYLIME_BROWSER_HEADLESS !== "0",
      channel,
      userAgent: profile.userAgent,
      locale: profile.locale,
      timezoneId: profile.timezoneId,
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      colorScheme: profile.colorScheme,
      reducedMotion: profile.reducedMotion,
      extraHTTPHeaders: {
        "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8",
        "DNT": "1",
      },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 12000) });
    await page.waitForSelector("main, article, [role=main], body", { timeout: Math.min(browserSettleMs(), 8000) }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: Math.min(browserSettleMs(), 5000) }).catch(() => undefined);
    await page.evaluate(() => window.scrollBy(0, Math.min(window.innerHeight * 0.8, 900))).catch(() => undefined);
    await page.waitForTimeout(Math.min(browserSettleMs(), 6000));

    let html = await page.content();
    let challenge = detectChallenge(html, new Headers());
    if (challenge) {
      const deadline = Date.now() + browserSettleMs();
      while (Date.now() < deadline) {
        await page.waitForTimeout(750);
        html = await page.content();
        const nextChallenge = detectChallenge(html, new Headers());
        const text = htmlToText(html, 1600);
        if (!nextChallenge && text.length > 250) {
          challenge = null;
          reasonCodes.push("challenge_settled_after_wait");
          break;
        }
        challenge = nextChallenge;
      }
    }

    const finalUrl = page.url();
    const normalized = deobfuscateHtml(html);
    const normalizedHtml = normalized.html;
    const title = (await page.title()).slice(0, 120);
    const content = htmlToText(normalizedHtml, maxChars);
    const links = extractLinks(normalizedHtml, finalUrl);

    await context.close();

    if (challenge) {
      return {
        ok: false,
        title,
        content: htmlToText(normalizedHtml, Math.min(maxChars, 1200)),
        links,
        finalUrl,
        reasonCodes: [...reasonCodes, "browser_fallback_challenge_detected"],
        reason: challenge,
        challenge,
        timingsMs: Date.now() - started,
      };
    }

    return {
      ok: true,
      title,
      content,
      links,
      finalUrl,
      reasonCodes: [...reasonCodes, "browser_fallback_success"],
      timingsMs: Date.now() - started,
    };
  } catch (err: any) {
    try { await context?.close?.(); } catch {}
    return {
      ok: false,
      title: "",
      content: "",
      links: [],
      finalUrl: url,
      reasonCodes: [...reasonCodes, "browser_fallback_failed"],
      reason: err?.message ?? "browser_fallback_failed",
      timingsMs: Date.now() - started,
    };
  }
}

async function fetchPage(
  url: string,
  timeoutMs = 7000,
  maxChars = 3000,
  policy: FetchPolicy = "retry_only"
): Promise<FetchResult> {
  const maxAttempts = policy === "none" || policy === "browser_first" ? 1 : 2;
  const started = Date.now();
  const allowBrowserFallback = policy === "browser" || policy === "browser_first";

  if (policy === "browser_first") {
    const bf = await browserFallbackFetch(url, Math.max(timeoutMs, 12000), maxChars);
    if (bf.ok) {
      const quality = scoreContentQuality(bf.title, bf.content, bf.content);
      return {
        outcome: "ok",
        classification: "ok_content",
        title: bf.title,
        content: bf.content,
        links: bf.links,
        url: bf.finalUrl,
        fetchedAt: new Date().toISOString(),
        reasonCodes: ["browser_first", ...bf.reasonCodes],
        timingsMs: { total: Date.now() - started, download: 0, extract: bf.timingsMs },
        redirectCount: bf.finalUrl === url ? 0 : 1,
        contentLength: bf.content.length,
        confidence: quality,
      };
    }
    const outcome: FetchOutcome = bf.challenge ? "challenge_detected" : "network_error";
    return {
      outcome,
      classification: classifyFromOutcome(outcome),
      title: bf.title,
      content: bf.content,
      links: bf.links,
      url: bf.finalUrl,
      fetchedAt: new Date().toISOString(),
      reason: bf.reason,
      reasonCodes: ["browser_first", ...bf.reasonCodes],
      timingsMs: { total: Date.now() - started, download: 0, extract: bf.timingsMs },
      redirectCount: bf.finalUrl === url ? 0 : 1,
      contentLength: bf.content.length,
      confidence: { score: bf.challenge ? 0.1 : 0, reasons: [bf.challenge ? "challenge_page" : "browser_first_failed"] },
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dl = await downloadPage(url, timeoutMs, policy, attempt);

    if (!dl.ok) {
      const retryableStatus = dl.status && [408, 425, 429, 500, 502, 503, 504].includes(dl.status);
      if (attempt < maxAttempts && (retryableStatus || dl.reason === "abort_timeout" || dl.reason?.includes("network"))) {
        await sleep(250 * attempt);
        continue;
      }

      const outcome: FetchOutcome = dl.reason === "abort_timeout" ? "timeout" : (dl.status ? "blocked_http_status" : "network_error");
      return {
        outcome,
        classification: classifyFromOutcome(outcome),
        title: "",
        content: "",
        links: [],
        url: dl.finalUrl,
        fetchedAt: new Date().toISOString(),
        status: dl.status,
        reason: dl.reason,
        reasonCodes: dl.reasonCodes,
        timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: 0 },
        redirectCount: dl.finalUrl === url ? 0 : 1,
        contentType: dl.headers?.get("content-type") ?? undefined,
        contentLength: 0,
        confidence: { score: 0, reasons: ["download_failed"] },
      };
    }

    const extractStarted = Date.now();
    const contentType = (dl.headers?.get("content-type") ?? "").toLowerCase();
    const html = dl.body ?? "";

    const readableText = isReadableTextContentType(contentType);
    if (!contentType.includes("text/html") && !readableText) {
      const outcome: FetchOutcome = "non_html_content";
      return {
        outcome,
        classification: classifyFromOutcome(outcome),
        title: "",
        content: "",
        links: [],
        url: dl.finalUrl,
        fetchedAt: new Date().toISOString(),
        status: dl.status,
        reason: `content_type:${contentType || "unknown"}`,
        reasonCodes: [...dl.reasonCodes, "non_html_content"],
        timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: Date.now() - extractStarted },
        redirectCount: dl.finalUrl === url ? 0 : 1,
        contentType,
        contentLength: html.length,
        confidence: { score: 0, reasons: ["unsupported_content_type"] },
      };
    }

    if (readableText) {
      const content = html.slice(0, maxChars);
      const title = extractTextTitle(content, dl.finalUrl);
      const quality = scoreContentQuality(title, content, content);
      return {
        outcome: "ok",
        classification: "ok_content",
        title,
        content,
        links: [],
        url: dl.finalUrl,
        fetchedAt: new Date().toISOString(),
        status: dl.status,
        reasonCodes: [...dl.reasonCodes, "readable_text_content"],
        timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: Date.now() - extractStarted },
        redirectCount: dl.finalUrl === url ? 0 : 1,
        contentType,
        contentLength: html.length,
        confidence: quality,
      };
    }

    const challenge = detectChallenge(html, dl.headers!);
    const normalized = deobfuscateHtml(html);
    const normalizedHtml = normalized.html;
    const decodedEmails = normalized.decodedEmails;

    if (challenge) {
      let browserAttemptCodes: string[] = [];
      if (allowBrowserFallback) {
        const bf = await browserFallbackFetch(dl.finalUrl, Math.max(timeoutMs, 12000), maxChars);
        browserAttemptCodes = ["browser_fallback_attempted", ...bf.reasonCodes];
        if (bf.ok) {
          const quality = scoreContentQuality(bf.title, bf.content, bf.content);
          return {
            outcome: "ok",
            classification: "ok_content",
            title: bf.title,
            content: bf.content,
            links: bf.links,
            url: bf.finalUrl,
            fetchedAt: new Date().toISOString(),
            status: dl.status,
            reasonCodes: [...dl.reasonCodes, ...browserAttemptCodes],
            timingsMs: { total: Date.now() - started, download: dl.timingsMs + bf.timingsMs, extract: Date.now() - extractStarted },
            redirectCount: bf.finalUrl === url ? 0 : 1,
            contentType,
            contentLength: bf.content.length,
            confidence: quality,
          };
        }
      }

      const title = extractTitle(normalizedHtml);
      const content = htmlToText(normalizedHtml, Math.min(maxChars, 1200));
      const outcome: FetchOutcome = "challenge_detected";
      return {
        outcome,
        classification: classifyFromOutcome(outcome),
        title,
        content,
        links: extractLinks(normalizedHtml, dl.finalUrl),
        url: dl.finalUrl,
        fetchedAt: new Date().toISOString(),
        status: dl.status,
        reason: challenge,
        reasonCodes: [...dl.reasonCodes, "challenge_marker_detected", ...browserAttemptCodes],
        timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: Date.now() - extractStarted },
        redirectCount: dl.finalUrl === url ? 0 : 1,
        contentType,
        contentLength: html.length,
        confidence: { score: 0.1, reasons: ["challenge_page"] },
        decodedEmails,
      };
    }

    const title = extractTitle(normalizedHtml);
    const content = htmlToText(normalizedHtml, maxChars);
    const quality = scoreContentQuality(title, content, normalizedHtml);

    if (quality.score < 0.35) {
      const outcome: FetchOutcome = "parse_failed";
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }

      let browserAttemptCodes: string[] = [];
      if (allowBrowserFallback) {
        const bf = await browserFallbackFetch(dl.finalUrl, Math.max(timeoutMs, 12000), maxChars);
        browserAttemptCodes = ["browser_fallback_attempted", ...bf.reasonCodes];
        if (bf.ok) {
          const browserQuality = scoreContentQuality(bf.title, bf.content, bf.content);
          return {
            outcome: "ok",
            classification: "ok_content",
            title: bf.title,
            content: bf.content,
            links: bf.links,
            url: bf.finalUrl,
            fetchedAt: new Date().toISOString(),
            status: dl.status,
            reasonCodes: [...dl.reasonCodes, "low_content_confidence", ...quality.reasons, ...browserAttemptCodes],
            timingsMs: { total: Date.now() - started, download: dl.timingsMs + bf.timingsMs, extract: Date.now() - extractStarted },
            redirectCount: bf.finalUrl === url ? 0 : 1,
            contentType,
            contentLength: bf.content.length,
            confidence: browserQuality,
          };
        }
      }

      return {
        outcome,
        classification: classifyFromOutcome(outcome),
        title,
        content,
        links: extractLinks(normalizedHtml, dl.finalUrl),
        url: dl.finalUrl,
        fetchedAt: new Date().toISOString(),
        status: dl.status,
        reason: "low_content_confidence",
        reasonCodes: [...dl.reasonCodes, "low_content_confidence", ...quality.reasons, ...browserAttemptCodes],
        timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: Date.now() - extractStarted },
        redirectCount: dl.finalUrl === url ? 0 : 1,
        contentType,
        contentLength: html.length,
        confidence: quality,
        decodedEmails,
      };
    }

    const outcome: FetchOutcome = "ok";
    return {
      outcome,
      classification: classifyFromOutcome(outcome),
      title,
      content,
      links: extractLinks(normalizedHtml, dl.finalUrl),
      url: dl.finalUrl,
      fetchedAt: new Date().toISOString(),
      status: dl.status,
      reasonCodes: decodedEmails.length ? [...dl.reasonCodes, "decoded_cfemail"] : dl.reasonCodes,
      timingsMs: { total: Date.now() - started, download: dl.timingsMs, extract: Date.now() - extractStarted },
      redirectCount: dl.finalUrl === url ? 0 : 1,
      contentType,
      contentLength: html.length,
      confidence: quality,
      decodedEmails,
    };
  }

  return {
    outcome: "network_error",
    classification: "soft_error",
    title: "",
    content: "",
    links: [],
    url,
    fetchedAt: new Date().toISOString(),
    reason: "unreachable_state",
    reasonCodes: ["unreachable_state"],
    timingsMs: { total: 0, download: 0, extract: 0 },
    redirectCount: 0,
    contentLength: 0,
    confidence: { score: 0, reasons: ["internal_error"] },
  };
}

function extractSearchResultUrls(text: string): string[] {
  const lineUrl = /^\s+(https?:\/\/\S+)/gm;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = lineUrl.exec(text)) !== null) found.push(m[1]);

  if (found.length === 0) {
    const inline = /https?:\/\/[^\s\n)>'"]+/g;
    while ((m = inline.exec(text)) !== null) found.push(m[0]);
  }

  return [...new Set(found)].filter(u => !shouldSkip(u));
}

export const __testables = {
  shouldSkip,
  detectChallenge,
  classifyFromOutcome,
  scoreContentQuality,
  extractSearchResultUrls,
  pickUserAgent,
  BROWSER_UAS,
  browserProfileForUrl,
  browserStateDirForUrl,
  browserSettleMs,
  browserFallbackFetch,
  decodeCloudflareEmailHex,
  deobfuscateHtml,
  decodeHtmlEntities,
  htmlToText,
  extractTitle,
  isReadableTextContentType,
  extractTextTitle,
  extractLinks,
  formatFetchText,
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch a web page and return cleaned text, title, and same-domain links.",
    promptSnippet: "Fetch/read a URL",
    promptGuidelines: ["Use for docs, GitHub READMEs, pasted URLs, or source pages."],
    parameters: Type.Object({
      url: Type.String({ description: "URL" }),
      maxChars: Type.Optional(Type.Number({ description: "Max chars for full extracted content" })),
      summarize: Type.Optional(Type.Boolean({ description: "Return deterministic extractive summary instead of full extracted text (default true)" })),
      query: Type.Optional(Type.String({ description: "Optional query to bias sentence selection when summarizing" })),
      maxSummarySentences: Type.Optional(Type.Number({ description: "Maximum summary sentences", minimum: 1, maximum: 12 })),
      maxSummaryChars: Type.Optional(Type.Number({ description: "Maximum summary characters", minimum: 100, maximum: 5000 })),
      fallback: Type.Optional(Type.Union([
        Type.Literal("none"),
        Type.Literal("retry_only"),
        Type.Literal("alt_headers"),
        Type.Literal("browser"),
        Type.Literal("browser_first"),
      ], { description: "Fallback policy" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });

      if (shouldSkip(params.url)) {
        return {
          content: [{ type: "text", text: `Skipped: ${params.url} (social media / binary / video)` }],
          details: { skipped: true, outcome: "skipped" },
        };
      }

      const result = await fetchPage(params.url, 9000, params.maxChars ?? 3000, (params.fallback as FetchPolicy | undefined) ?? "retry_only");

      if (result.outcome !== "ok") {
        const msg = [
          `Fetch did not return normal page content for ${params.url}`,
          `Outcome: ${result.outcome}`,
          `Class: ${result.classification}`,
          result.status ? `HTTP status: ${result.status}` : "",
          result.reason ? `Reason: ${result.reason}` : "",
          result.reasonCodes.length ? `Reason codes: ${result.reasonCodes.join(", ")}` : "",
          `Final URL: ${result.url}`,
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text", text: msg }],
          details: result,
          isError: true,
        };
      }

      const formatted = formatFetchText(result, {
        summarize: params.summarize as boolean | undefined,
        query: params.query as string | undefined,
        maxSummarySentences: params.maxSummarySentences as number | undefined,
        maxSummaryChars: params.maxSummaryChars as number | undefined,
      });

      return {
        content: [{ type: "text", text: formatted.text }],
        details: { ...result, summary: formatted.summary },
      };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "web_search") return;
    const requestedSummary = (event as any).details?.summarize === true;
    if (!requestedSummary && process.env.KEYLIME_AUTO_FETCH_SEARCH_RESULTS !== "1") return;

    const resultText = event.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text as string)
      .join("\n");

    const urls = extractSearchResultUrls(resultText).slice(0, 2);
    if (urls.length === 0) return;

    ctx.ui.setStatus("fetch-ext", `🔗 Fetching ${urls.length} source${urls.length > 1 ? "s" : ""}…`);
    const results = await Promise.allSettled(urls.map(url => fetchPage(url, 5000, 2200, "browser")));
    ctx.ui.setStatus("fetch-ext", "");

    const sections: string[] = [];
    const matrix: string[] = [];
    const autoFetchedSources: FetchResult[] = [];
    const query = (event as any).details?.query as string | undefined;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        const v = r.value;
        matrix.push(`- ${urls[i]} → ${v.outcome} (${v.classification}), conf=${(v.confidence.score * 100).toFixed(0)}%`);

        autoFetchedSources.push(v);

        if (v.outcome === "ok" && v.content.length > 150) {
          const summary = summarizeText(v.content, { query, maxSentences: 4, maxChars: 1200 });
          v.summary = summary;
          sections.push(
            `### 📄 Source summary: ${urls[i]}\n` +
            `**${v.title || "(no title)"}**\n\n` +
            `${summary.text || v.content.slice(0, 1200)}\n\n` +
            `_Method: ${summary.method}, ${summary.sentences.length}/${summary.candidates} sentences. Full fetched content is in tool details._`
          );
        } else {
          sections.push(
            `### ⚠️ Fetch issue: ${urls[i]}\n` +
            `Outcome: ${v.outcome}\n` +
            `Class: ${v.classification}` +
            `${v.status ? `\nHTTP status: ${v.status}` : ""}` +
            `${v.reason ? `\nReason: ${v.reason}` : ""}` +
            `${v.reasonCodes.length ? `\nReason codes: ${v.reasonCodes.join(", ")}` : ""}`
          );
        }
      }
    }

    if (sections.length === 0) return;

    const injected = `\n\n---\n**Auto-fetched source summaries** (use this when writing save_search_knowledge):\n\n` +
      `### Fetch summary\n${matrix.join("\n")}\n\n---\n\n${sections.join("\n\n---\n\n")}`;

    return {
      content: [...event.content, { type: "text", text: injected }],
      details: { ...(event as any).details, autoFetchedSources },
    };
  });
}
