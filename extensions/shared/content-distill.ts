import { BM25Index, tokenize } from "./retrieval";
import { jaccardTokens } from "./similarity";

export type ExtractMainContentOptions = {
  maxChars?: number;
};

export type ExtractMainContentResult = {
  text: string;
  confidence: number;
  method: "density" | "fallback";
  candidates: number;
};

export type SummaryOptions = {
  query?: string;
  maxSentences?: number;
  maxChars?: number;
  lambda?: number;
};

export type SummaryResult = {
  text: string;
  sentences: string[];
  method: "bm25+mmr" | "generic+mmr" | "none";
  candidates: number;
};

export type MMRCandidate<T = unknown> = T & {
  id: string;
  text: string;
  relevance: number;
};

export type MMROptions = {
  limit: number;
  lambda?: number;
};

const BAD_BLOCK_RE = /<(script|style|nav|header|footer|aside|noscript|svg|canvas|form|button|select|option|iframe)[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_RE = /<(article|main|section|div|body)[^>]*>([\s\S]*?)<\/\1>/gi;
const ABBREVIATION_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, " ");
}

function htmlFragmentToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linkDensity(html: string, textLength: number): number {
  if (textLength <= 0) return 1;
  let linked = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) linked += htmlFragmentToText(m[1]).length;
  return Math.min(1, linked / textLength);
}

function scoreBlock(tag: string, html: string, text: string): number {
  const words = tokenize(text, { minLength: 2 }).length;
  const chars = text.length;
  if (words < 8 || chars < 40) return -1;
  const punctuation = (text.match(/[.!?]/g) ?? []).length;
  const paragraphs = (html.match(/<p\b/gi) ?? []).length;
  const headings = (html.match(/<h[1-6]\b/gi) ?? []).length;
  const listItems = (html.match(/<li\b/gi) ?? []).length;
  const density = words / Math.max(1, html.replace(/<[^>]+>/g, " ").length / 80);
  const linkPenalty = linkDensity(html, chars) * 140;
  const tagBoost = tag === "article" ? 120 : tag === "main" ? 80 : tag === "section" ? 30 : 0;
  const listPenalty = Math.max(0, listItems - paragraphs) * 8;
  return tagBoost + chars * 0.18 + words * 1.7 + punctuation * 12 + paragraphs * 20 + headings * 12 + density * 8 - linkPenalty - listPenalty;
}

export function extractMainContent(html: string, options: ExtractMainContentOptions = {}): ExtractMainContentResult {
  const maxChars = options.maxChars ?? 5000;
  const cleaned = html.replace(BAD_BLOCK_RE, " ");
  const candidates: Array<{ text: string; score: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = BLOCK_RE.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const text = htmlFragmentToText(inner);
    const score = scoreBlock(tag, inner, text);
    if (score > 0) candidates.push({ text, score });
  }

  candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const best = candidates[0];
  if (best) {
    const scoreRatio = best.score / Math.max(1, best.text.length);
    return {
      text: best.text.slice(0, maxChars),
      confidence: Math.max(0.2, Math.min(0.95, scoreRatio)),
      method: "density",
      candidates: candidates.length,
    };
  }

  const fallback = htmlFragmentToText(cleaned).slice(0, maxChars);
  return {
    text: fallback,
    confidence: fallback.length > 200 ? 0.35 : 0.15,
    method: "fallback",
    candidates: 0,
  };
}

export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = normalized[i + 1] ?? "";
    if (next && !/\s/.test(next)) continue;
    const candidate = normalized.slice(start, i + 1).trim();
    if (ABBREVIATION_RE.test(candidate)) continue;
    if (candidate) out.push(candidate);
    start = i + 1;
  }
  const tail = normalized.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(s => s.length >= 8 || /[.!?]$/.test(s));
}

export function mmrSelect<T>(candidates: Array<MMRCandidate<T>>, options: MMROptions): Array<MMRCandidate<T>> {
  const limit = Math.max(0, Math.min(options.limit, candidates.length));
  const lambda = options.lambda ?? 0.7;
  if (limit === 0) return [];
  const maxRel = Math.max(...candidates.map(c => c.relevance), 1);
  const remaining = [...candidates].sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
  const selected: Array<MMRCandidate<T>> = [];
  const tokenSets = new Map(candidates.map(candidate => [candidate.id, new Set(tokenize(candidate.text))]));

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const rel = candidate.relevance / maxRel;
      const candidateTokens = tokenSets.get(candidate.id)!;
      let redundancy = 0;
      for (const prior of selected) redundancy = Math.max(redundancy, jaccardTokens(candidateTokens, tokenSets.get(prior.id)!));
      const score = lambda * rel - (1 - lambda) * redundancy;
      if (score > bestScore || (score === bestScore && candidate.id.localeCompare(remaining[bestIdx].id) < 0)) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

function genericSentenceScores(sentences: string[]): Array<MMRCandidate<{ index: number }>> {
  const docTokens = new Map<string, number>();
  for (const sentence of sentences) {
    for (const t of tokenize(sentence)) docTokens.set(t, (docTokens.get(t) ?? 0) + 1);
  }
  return sentences.map((sentence, index) => {
    const tokens = tokenize(sentence);
    const centrality = tokens.reduce((sum, t) => sum + (docTokens.get(t) ?? 0), 0) / Math.max(1, tokens.length);
    const lead = index === 0 ? 8 : Math.max(0, 4 - index * 0.6);
    const punctuation = /[.!?]$/.test(sentence) ? 1 : 0;
    const lengthScore = Math.min(6, sentence.length / 35);
    return { id: String(index), index, text: sentence, relevance: lead + centrality + lengthScore + punctuation };
  });
}

export function summarizeText(text: string, options: SummaryOptions = {}): SummaryResult {
  const maxSentences = options.maxSentences ?? 3;
  const maxChars = options.maxChars ?? 900;
  const sentences = splitSentences(text).filter(s => tokenize(s).length >= 3);
  if (sentences.length === 0 || maxSentences <= 0 || maxChars <= 0) {
    return { text: "", sentences: [], method: "none", candidates: 0 };
  }

  let candidates: Array<MMRCandidate<{ index: number }>>;
  let method: SummaryResult["method"];
  const query = options.query?.trim();

  if (query) {
    const index = new BM25Index();
    sentences.forEach((sentence, i) => index.add(String(i), sentence));
    const scores = new Map(index.search(query, sentences.length).map(r => [r.id, r.score]));
    candidates = sentences.map((sentence, i) => ({
      id: String(i),
      index: i,
      text: sentence,
      relevance: scores.get(String(i)) ?? 0,
    })).filter(c => c.relevance > 0);
    if (candidates.length < maxSentences) {
      const existing = new Set(candidates.map(c => c.id));
      const supplement = genericSentenceScores(sentences)
        .filter(c => !existing.has(c.id))
        .map(c => ({ ...c, relevance: Math.max(0.01, c.relevance * 0.25) }));
      candidates = [...candidates, ...supplement];
    }
    if (candidates.length === 0) candidates = genericSentenceScores(sentences);
    method = "bm25+mmr";
  } else {
    candidates = genericSentenceScores(sentences);
    method = "generic+mmr";
  }

  const picked = mmrSelect(candidates, { limit: Math.min(maxSentences, candidates.length), lambda: options.lambda ?? 0.7 })
    .sort((a, b) => a.index - b.index);
  const kept: string[] = [];
  let total = 0;
  for (const p of picked) {
    const nextLen = p.text.length + (kept.length ? 1 : 0);
    if (kept.length > 0 && total + nextLen > maxChars) continue;
    kept.push(p.text);
    total += nextLen;
    if (total >= maxChars) break;
  }

  return {
    text: kept.join(" ").slice(0, maxChars).trim(),
    sentences: kept,
    method,
    candidates: sentences.length,
  };
}
