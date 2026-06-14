import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { stringEnum } from "./shared/schema";
import { repoRelativePath } from "./shared/path-policy";
import { isProbablyBinary, resolveSafePath } from "./shared/code-primitives";
import { classifyToolMutation } from "./shared/safety-policy";

const MAX_EXTRACT_CHARS = 60_000;
const MAX_PREVIEW_ROWS = 100;
const PDF_EMPTY_TEXT_MESSAGE = "PDF text extraction found no embedded text. This may be a scanned/image PDF or use unsupported encoding.";

const execFileAsync = promisify(execFile);

type DocFormat = "auto" | "pdf" | "docx" | "xlsx" | "csv" | "txt" | "md" | "html";
type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };

function clamp(n: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : fallback));
}

function detectFormat(path: string, requested?: DocFormat): Exclude<DocFormat, "auto"> {
  if (requested && requested !== "auto") return requested;
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".csv") return "csv";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".html" || ext === ".htm") return "html";
  return "txt";
}

function decodeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function stripXml(text: string): string {
  return decodeXml(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

type ExtractionMethod = "embedded_text" | "ocr" | "mixed" | "none";
type ExtractedDocument = { text: string; truncated: boolean; extraction_method?: ExtractionMethod; warnings?: string[] };

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n… truncated (${text.length - maxChars} chars omitted)`, truncated: true };
}

function parsePageSpec(spec: string | undefined, total: number): Set<number> | null {
  if (!spec) return null;
  const pages = new Set<number>();
  for (const part of spec.split(",").map(s => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`Invalid page range: ${part}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    for (let page = start; page <= end; page += 1) if (page >= 1 && page <= total) pages.add(page);
  }
  return pages;
}

function parseZip(buffer: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Unsupported or corrupt zip container");
  const count = buffer.readUInt16LE(eocd + 10);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let offset = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Invalid zip local header for ${entry.name}`);
  const nameLen = buffer.readUInt16LE(offset + 26);
  const extraLen = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const compressed = buffer.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

function zipText(buffer: Buffer, name: string): string | null {
  const entry = parseZip(buffer).find(item => item.name === name);
  return entry ? readZipEntry(buffer, entry).toString("utf8") : null;
}

function extractDocx(buffer: Buffer): string {
  const xml = zipText(buffer, "word/document.xml");
  if (!xml) throw new Error("DOCX missing word/document.xml");
  return xml
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n").replace(/<\/w:tc>/g, "\t")
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_m, text) => decodeXml(text))
    .replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function sharedStrings(buffer: Buffer): string[] {
  const xml = zipText(buffer, "xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.matchAll(/<si[\s\S]*?<\/si>/g)].map(match => stripXml(match[0]));
}

function workbookSheets(buffer: Buffer): Array<{ name: string; id: string; path: string }> {
  const workbook = zipText(buffer, "xl/workbook.xml") ?? "";
  const rels = zipText(buffer, "xl/_rels/workbook.xml.rels") ?? "";
  const relMap = new Map([...rels.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
  return [...workbook.matchAll(/<sheet[^>]+name="([^"]+)"[^>]+r:id="([^"]+)"/g)].map(match => {
    const target = relMap.get(match[2]) ?? `worksheets/sheet${match[2].replace(/\D/g, "")}.xml`;
    return { name: decodeXml(match[1]), id: match[2], path: `xl/${target.replace(/^\//, "")}` };
  });
}

function extractSheetRows(buffer: Buffer, sheetPath: string, maxRows: number): string[][] {
  const xml = zipText(buffer, sheetPath);
  if (!xml) return [];
  const strings = sharedStrings(buffer);
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const values: string[] = [];
    for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      values.push(attrs.includes('t="s"') ? strings[Number(raw)] ?? raw : decodeXml(raw));
    }
    rows.push(values);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function csvRows(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line && rows.length > 0) continue;
    const values: string[] = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { values.push(value); value = ""; }
      else value += ch;
    }
    values.push(value);
    rows.push(values);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(row => row.length));
  const norm = rows.map(row => Array.from({ length: width }, (_, i) => row[i] ?? ""));
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return [
    `| ${norm[0].map(esc).join(" | ")} |`,
    `| ${norm[0].map(() => "---").join(" | ")} |`,
    ...norm.slice(1).map(row => `| ${row.map(esc).join(" | ")} |`),
  ].join("\n");
}

function pdfPageCount(raw: string): number {
  return Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) ?? []).length);
}

function extractPdfRough(buffer: Buffer, pages?: string): { text: string; totalPages: number } {
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  for (const match of raw.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const dict = match[1];
    let data = Buffer.from(match[2], "latin1");
    if (/FlateDecode/.test(dict)) {
      try { data = inflateRawSync(data); } catch { continue; }
    }
    const text = data.toString("latin1");
    const pieces = [
      ...[...text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map(m => m[1]),
      ...[...text.matchAll(/\[((?:\s*\((?:\\.|[^\\)])*\)\s*-?\d*)+)\]\s*TJ/g)].map(m => [...m[1].matchAll(/\((?:\\.|[^\\)])*\)/g)].map(x => x[0].slice(1, -1)).join("")),
    ].map(s => s.replace(/\\([nrtbf()\\])/g, (_m, c) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] ?? c)));
    if (pieces.length) streams.push(pieces.join(" "));
  }
  const totalPages = pdfPageCount(raw);
  const selected = parsePageSpec(pages, totalPages);
  const text = streams.map((s, i) => `Page-ish ${i + 1}\n${s}`).filter((_, i) => !selected || selected.has(i + 1)).join("\n\n");
  return { text, totalPages };
}

async function ocrPdfWithExternalTools(path: string, buffer: Buffer, pages: string | undefined, totalPages: number, cacheDir: string): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  const selected = parsePageSpec(pages, totalPages);
  const pageNumbers = selected ? [...selected].sort((a, b) => a - b) : Array.from({ length: totalPages }, (_, i) => i + 1);
  const cacheKey = createHash("sha256").update(buffer).update(`\npages=${pageNumbers.join(",")}`).digest("hex");
  const cachePath = join(cacheDir, `${cacheKey}.txt`);
  try {
    const cached = await readFile(cachePath, "utf8");
    if (cached.trim()) return { text: cached, warnings };
  } catch { /* cache miss */ }

  const tmp = await mkdtemp(join(tmpdir(), "pi-pdf-ocr-"));
  try {
    const pageTexts: string[] = [];
    for (const page of pageNumbers) {
      const prefix = join(tmp, `page-${page}`);
      try {
        await execFileAsync("pdftoppm", ["-r", "200", "-png", "-f", String(page), "-l", String(page), path, prefix], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        const images = (await readdir(tmp)).filter(name => name.startsWith(`page-${page}`) && name.endsWith(".png")).sort();
        if (images.length === 0) {
          warnings.push(`Page ${page}: pdftoppm produced no image.`);
          continue;
        }
        const { stdout, stderr } = await execFileAsync("tesseract", [join(tmp, images[0]), "stdout", "--psm", "6"], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
        if (stderr?.trim()) warnings.push(`Page ${page}: ${stderr.trim().split(/\r?\n/)[0]}`);
        const pageText = stdout.trim();
        if (pageText) pageTexts.push(`Page ${page}\n${pageText}`);
        else warnings.push(`Page ${page}: OCR returned no text.`);
      } catch (error: any) {
        const code = error?.code ? ` (${error.code})` : "";
        warnings.push(`Page ${page}: OCR failed${code}. Ensure pdftoppm/poppler and tesseract are installed.`);
        break;
      }
    }
    const text = pageTexts.join("\n\n");
    if (text.trim()) {
      try { await mkdir(cacheDir, { recursive: true }); await writeFile(cachePath, text, "utf8"); } catch { /* best-effort cache */ }
    }
    return { text, warnings };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function extractDocument(path: string, format: Exclude<DocFormat, "auto">, options: { pages?: string; maxChars: number; ocr?: boolean; cacheDir?: string }): Promise<ExtractedDocument> {
  const buffer = await readFile(path);
  if (["txt", "md", "html"].includes(format)) {
    if (isProbablyBinary(buffer)) throw new Error(`Refusing to read probable binary as ${format}`);
    return { ...truncate(buffer.toString("utf8"), options.maxChars), extraction_method: "embedded_text" };
  }
  if (format === "csv") return { ...truncate(rowsToMarkdown(csvRows(buffer.toString("utf8"), MAX_PREVIEW_ROWS)), options.maxChars), extraction_method: "embedded_text" };
  if (format === "docx") return { ...truncate(extractDocx(buffer), options.maxChars), extraction_method: "embedded_text" };
  if (format === "xlsx") {
    const sheets = workbookSheets(buffer);
    const text = sheets.map(sheet => `Sheet: ${sheet.name}\n${rowsToMarkdown(extractSheetRows(buffer, sheet.path, MAX_PREVIEW_ROWS))}`).join("\n\n");
    return { ...truncate(text, options.maxChars), extraction_method: "embedded_text" };
  }
  if (format === "pdf") {
    const embedded = extractPdfRough(buffer, options.pages);
    const warnings: string[] = [];
    let text = embedded.text;
    let method: ExtractionMethod = text.trim() ? "embedded_text" : "none";
    if ((options.ocr === true || !text.trim()) && options.ocr !== false) {
      const ocr = await ocrPdfWithExternalTools(path, buffer, options.pages, embedded.totalPages, options.cacheDir ?? join(dirname(path), ".pi", "cache", "pdf-ocr"));
      warnings.push(...ocr.warnings);
      if (ocr.text.trim()) {
        method = text.trim() ? "mixed" : "ocr";
        text = text.trim() ? `${text}\n\n${ocr.text}` : ocr.text;
      }
    }
    if (!text.trim()) text = PDF_EMPTY_TEXT_MESSAGE;
    return { ...truncate(text, options.maxChars), extraction_method: method, warnings };
  }
  throw new Error(`Unsupported format: ${format}`);
}

function inspectArchiveBuffer(buffer: Buffer, maxEntries: number): Array<{ name: string; bytes: number; method?: number }> {
  const extZip = (() => {
    try { return parseZip(buffer).map(entry => ({ name: entry.name, bytes: entry.compressedSize, method: entry.method })); } catch { return null; }
  })();
  if (extZip) return extZip.slice(0, maxEntries);
  const entries: Array<{ name: string; bytes: number }> = [];
  for (let offset = 0; offset + 512 <= buffer.length && entries.length < maxEntries; offset += 512) {
    const block = buffer.slice(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    const name = block.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = block.slice(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeOctal || "0", 8) || 0;
    if (name) entries.push({ name, bytes: size });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function imageMetadata(buffer: Buffer): Record<string, unknown> {
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { format: "jpeg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
    return { format: "jpeg", width: null, height: null };
  }
  if (buffer.slice(0, 6).toString("ascii") === "GIF87a" || buffer.slice(0, 6).toString("ascii") === "GIF89a") {
    return { format: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return { format: "unknown", width: null, height: null };
}

function analyzeRows(rows: string[][]): string {
  const headers = rows[0] ?? [];
  const data = rows.slice(1);
  const lines = [`Rows: ${data.length}`, `Columns: ${headers.length}`, ""];
  for (let col = 0; col < headers.length; col += 1) {
    const values = data.map(row => row[col] ?? "");
    const missing = values.filter(value => value.trim() === "").length;
    const nums = values.map(Number).filter(Number.isFinite);
    lines.push(`Column: ${headers[col] || `column_${col + 1}`}`);
    lines.push(`- missing: ${missing}`);
    if (nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0);
      lines.push(`- numeric: count=${nums.length} min=${Math.min(...nums)} max=${Math.max(...nums)} mean=${(sum / nums.length).toFixed(3)}`);
    } else {
      const counts = new Map<string, number>();
      for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
      lines.push(`- top values: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v} (${n})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function chartSvg(title: string, type: string, labels: string[], values: number[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const width = 800, height = 460, left = 70, bottom = 70, top = 60;
  const max = Math.max(...values, 1);
  const plotH = height - top - bottom;
  const plotW = width - left - 40;
  const points = values.map((v, i) => [left + (plotW * (i + 0.5)) / values.length, top + plotH - (v / max) * plotH]);
  const body = type === "line"
    ? `<polyline fill="none" stroke="#4f46e5" stroke-width="3" points="${points.map(p => p.join(",")).join(" ")}"/>${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="#4f46e5"/>`).join("")}`
    : values.map((v, i) => { const barW = plotW / values.length * 0.72; const h = (v / max) * plotH; const x = left + (plotW * i) / values.length + barW * 0.2; const y = top + plotH - h; return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="#4f46e5"/>`; }).join("");
  const axis = `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#334155"/><line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#334155"/>`;
  const labelsSvg = labels.map((label, i) => `<text x="${points[i][0]}" y="${height - 28}" text-anchor="middle" font-size="12" fill="#475569">${esc(label).slice(0, 16)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="${left}" y="34" font-size="24" font-family="Inter,Arial" font-weight="700" fill="#172033">${esc(title)}</text>${axis}${body}${labelsSvg}</svg>`;
}

function extractCitationHints(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)\]]+/g)) hits.add(m[0].replace(/[.,;]+$/, ""));
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi)) hits.add(m[0]);
  for (const line of text.split("\n")) {
    if (/\(\d{4}\)|\bdoi\b|\bjournal\b|\bproceedings\b/i.test(line) && line.length < 300) hits.add(line.trim());
  }
  return [...hits].slice(0, 100);
}

function reporterHtml(title: string, subtitle: string | undefined, author: string | undefined, sections: any[], references: string[] = []): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = sections.map(section => {
    const level = clamp(section.level, 2, 1, 4);
    return `<section><h${level}>${esc(section.heading)}</h${level}>${section.body.split("\n\n").map((p: string) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n")}</section>`;
  }).join("\n");
  const refs = references.length ? `<section><h2>References</h2><ol>${references.map(ref => `<li>${esc(ref)}</li>`).join("")}</ol></section>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
:root{--ink:#172033;--muted:#617085;--accent:#4f46e5;--paper:#fff;--wash:#f5f7fb}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{max-width:920px;margin:40px auto;background:var(--paper);padding:56px 64px;box-shadow:0 20px 60px #11182720;border-radius:18px}header{border-bottom:4px solid var(--accent);padding-bottom:24px;margin-bottom:34px}h1{font-size:42px;line-height:1.1;margin:0 0 10px}h2{font-size:25px;margin-top:34px;border-left:5px solid var(--accent);padding-left:12px}h3{font-size:20px;margin-top:26px}.subtitle,.meta{color:var(--muted)}section{break-inside:avoid}ol{padding-left:1.4rem}code{background:#eef2ff;padding:2px 5px;border-radius:5px}@media print{body{background:white}.page{box-shadow:none;margin:0;border-radius:0}}
</style></head><body><main class="page"><header><h1>${esc(title)}</h1>${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ""}${author ? `<div class="meta">${esc(author)}</div>` : ""}</header>${body}${refs}</main></body></html>`;
}

export default function documentPrimitivesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "inspect_document",
    label: "Inspect Document",
    description: "Extract bounded text from PDF, DOCX, XLSX, CSV, Markdown, HTML, or text documents. Use instead of ad-hoc PDF/Word parsing scripts.",
    promptSnippet: "Inspect document text",
    promptGuidelines: ["Use for read/summarize document workflows before answering.", "Output is bounded; request pages/max_chars to narrow large documents.", "Do not use bash/python/node snippets to parse everyday documents.", "Set allow_outside_cwd=true only for explicit read-only inspection outside cwd."],
    parameters: Type.Object({ path: Type.String(), format: Type.Optional(stringEnum(["auto", "pdf", "docx", "xlsx", "csv", "txt", "md", "html"] as const)), pages: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()), ocr: Type.Optional(Type.Boolean()), allow_outside_cwd: Type.Optional(Type.Boolean({ description: "Allow read-only inspection outside cwd when explicitly requested" })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = params.allow_outside_cwd
        ? (isAbsolute(params.path) ? resolve(params.path) : resolve(ctx.cwd, params.path))
        : resolveSafePath(ctx.cwd, params.path);
      const format = detectFormat(path, params.format);
      const maxChars = clamp(params.max_chars, 12_000, 500, MAX_EXTRACT_CHARS);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`Not a file: ${repoRelativePath(ctx.cwd, path)}`);
      const extracted = await extractDocument(path, format, { pages: params.pages, maxChars, ocr: params.ocr, cacheDir: join(ctx.cwd, ".pi", "cache", "pdf-ocr") });
      const warnings = extracted.warnings?.length ? `\nWarnings:\n${extracted.warnings.map(w => `- ${w}`).join("\n")}` : "";
      const text = `Document: ${repoRelativePath(ctx.cwd, path)}\nFormat: ${format}\nBytes: ${info.size}\nExtraction method: ${extracted.extraction_method ?? "embedded_text"}\nTruncated: ${extracted.truncated ? "yes" : "no"}${warnings}\n\n${extracted.text}`;
      return { content: [{ type: "text", text }], details: { path: repoRelativePath(ctx.cwd, path), format, bytes: info.size, truncated: extracted.truncated, extraction_method: extracted.extraction_method, warnings: extracted.warnings ?? [] } };
    },
  });

  pi.registerTool({
    name: "summarize_document",
    label: "Summarize Document Scaffold",
    description: "Extract document text and return a high-signal summary scaffold. The model writes the final prose summary.",
    promptSnippet: "Extract document summary scaffold",
    promptGuidelines: ["Use when asked to read/summarize a PDF, Word document, spreadsheet, or notes file.", "Do not invent details beyond extracted text."],
    parameters: Type.Object({ path: Type.String(), purpose: Type.Optional(stringEnum(["general", "study_notes", "research", "meeting_brief", "assignment"] as const)), pages: Type.Optional(Type.String()), max_extract_chars: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const format = detectFormat(path, "auto");
      const extracted = await extractDocument(path, format, { pages: params.pages, maxChars: clamp(params.max_extract_chars, 18_000, 1000, MAX_EXTRACT_CHARS), cacheDir: join(ctx.cwd, ".pi", "cache", "pdf-ocr") });
      const lines = extracted.text.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0);
      const headings = lines.filter(line => line.length < 90 && /^[A-Z0-9][A-Za-z0-9 .:–—-]+$/.test(line)).slice(0, 20);
      const keywords = [...new Set(extracted.text.toLowerCase().match(/\b[a-z][a-z-]{5,}\b/g) ?? [])].slice(0, 40);
      const warningLines = extracted.warnings?.length ? ["", "Warnings:", ...extracted.warnings.map(w => `- ${w}`)] : [];
      const text = [`Summary scaffold for ${repoRelativePath(ctx.cwd, path)}`, `Purpose: ${params.purpose ?? "general"}`, `Format: ${format}`, `Extraction method: ${extracted.extraction_method ?? "embedded_text"}`, `Truncated: ${extracted.truncated ? "yes" : "no"}`, ...warningLines, "", "Possible headings:", ...headings.map(h => `- ${h}`), "", "Keyword hints:", keywords.join(", "), "", "Extract:", extracted.text].join("\n");
      return { content: [{ type: "text", text }], details: { path: repoRelativePath(ctx.cwd, path), format, headings, keywords, truncated: extracted.truncated, extraction_method: extracted.extraction_method, warnings: extracted.warnings ?? [] } };
    },
  });

  pi.registerTool({
    name: "inspect_spreadsheet",
    label: "Inspect Spreadsheet",
    description: "Inspect CSV/XLSX workbook sheets, schema-ish headers, and bounded row previews. Use instead of ad-hoc Excel parsing scripts.",
    promptSnippet: "Inspect spreadsheet",
    promptGuidelines: ["Use for Excel/CSV inspection before analysis.", "Keep max_rows bounded."],
    parameters: Type.Object({ path: Type.String(), sheets: Type.Optional(Type.Array(Type.String())), max_rows: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const maxRows = clamp(params.max_rows, 25, 1, MAX_PREVIEW_ROWS);
      const buffer = await readFile(path);
      const format = detectFormat(path, "auto");
      let blocks: string[] = [];
      let sheetNames: string[] = [];
      if (format === "csv") {
        const rows = csvRows(buffer.toString("utf8"), maxRows);
        sheetNames = ["csv"];
        blocks = [`Sheet: csv\nColumns: ${(rows[0] ?? []).join(", ")}\n${rowsToMarkdown(rows)}`];
      } else if (format === "xlsx") {
        const wanted = new Set((params.sheets ?? []).map((s: string) => s.toLowerCase()));
        const sheets = workbookSheets(buffer).filter(sheet => wanted.size === 0 || wanted.has(sheet.name.toLowerCase()));
        sheetNames = sheets.map(sheet => sheet.name);
        blocks = sheets.map(sheet => {
          const rows = extractSheetRows(buffer, sheet.path, maxRows);
          return `Sheet: ${sheet.name}\nColumns: ${(rows[0] ?? []).join(", ")}\n${rowsToMarkdown(rows)}`;
        });
      } else throw new Error(`inspect_spreadsheet supports CSV/XLSX, got ${format}`);
      return { content: [{ type: "text", text: `Spreadsheet: ${repoRelativePath(ctx.cwd, path)}\nSheets: ${sheetNames.join(", ")}\n\n${blocks.join("\n\n")}` }], details: { path: repoRelativePath(ctx.cwd, path), format, sheets: sheetNames } };
    },
  });

  pi.registerTool({
    name: "inspect_archive",
    label: "Inspect Archive",
    description: "Inspect bounded ZIP/TAR archive listings. Use instead of unzip -l or tar -tf.",
    promptSnippet: "Inspect archive contents",
    promptGuidelines: ["Use instead of bash unzip/tar listing commands.", "Only lists archive entries; does not extract files."],
    parameters: Type.Object({ path: Type.String(), max_entries: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const entries = inspectArchiveBuffer(await readFile(path), clamp(params.max_entries, 50, 1, 500));
      const lines = entries.map(entry => `${entry.name} (${entry.bytes} bytes${entry.method !== undefined ? `, method ${entry.method}` : ""})`);
      return { content: [{ type: "text", text: `Archive: ${repoRelativePath(ctx.cwd, path)}\nEntries: ${entries.length}\n${lines.join("\n")}` }], details: { path: repoRelativePath(ctx.cwd, path), entries } };
    },
  });

  pi.registerTool({
    name: "inspect_image_metadata",
    label: "Inspect Image Metadata",
    description: "Inspect basic image metadata such as format and dimensions. Use instead of file/identify/exiftool for simple checks.",
    promptSnippet: "Inspect image metadata",
    promptGuidelines: ["Use instead of shell image metadata commands for PNG/JPEG/GIF dimensions."],
    parameters: Type.Object({ path: Type.String(), include_sha256: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const buffer = await readFile(path);
      const meta: any = { path: repoRelativePath(ctx.cwd, path), bytes: buffer.byteLength, ...imageMetadata(buffer) };
      if (params.include_sha256) meta.sha256 = createHash("sha256").update(buffer).digest("hex");
      return { content: [{ type: "text", text: Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n") }], details: meta };
    },
  });

  pi.registerTool({
    name: "analyze_csv",
    label: "Analyze CSV",
    description: "Analyze CSV columns, missing values, numeric summaries, category counts, and sample rows.",
    promptSnippet: "Analyze CSV",
    promptGuidelines: ["Use instead of ad-hoc pandas/python snippets for basic CSV profiling."],
    parameters: Type.Object({ path: Type.String(), max_rows: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const rows = csvRows((await readFile(path)).toString("utf8"), clamp(params.max_rows, MAX_PREVIEW_ROWS, 2, 10_000));
      const text = `CSV analysis: ${repoRelativePath(ctx.cwd, path)}\n${analyzeRows(rows)}\n\nPreview:\n${rowsToMarkdown(rows.slice(0, 12))}`;
      return { content: [{ type: "text", text }], details: { path: repoRelativePath(ctx.cwd, path), rows: Math.max(0, rows.length - 1), columns: rows[0]?.length ?? 0 } };
    },
  });

  pi.registerTool({
    name: "create_chart",
    label: "Create Chart",
    description: "Create a simple SVG chart from labels and numeric values for reports/docs.",
    promptSnippet: "Create SVG chart",
    promptGuidelines: ["Use for repeatable report charts instead of hand-writing SVG each time."],
    parameters: Type.Object({ path: Type.String(), title: Type.String(), chart_type: Type.Optional(stringEnum(["bar", "line"] as const)), labels: Type.Array(Type.String()), values: Type.Array(Type.Number()), create_dirs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("create_chart", params);
      if (!classification.allowed) throw new Error(`create_chart blocked by safety policy: ${classification.reasons.join(", ")}`);
      if (params.labels.length !== params.values.length) throw new Error("labels and values must have the same length");
      const path = resolveSafePath(ctx.cwd, params.path);
      if (params.create_dirs) await mkdir(dirname(path), { recursive: true });
      const svg = chartSvg(params.title, params.chart_type ?? "bar", params.labels, params.values);
      await writeFile(path, svg, { encoding: "utf8", flag: "wx" });
      return { content: [{ type: "text", text: `Created chart ${repoRelativePath(ctx.cwd, path)} (${params.labels.length} points)` }], details: { path: repoRelativePath(ctx.cwd, path), chart_type: params.chart_type ?? "bar", points: params.labels.length } };
    },
  });

  pi.registerTool({
    name: "extract_citations",
    label: "Extract Citations",
    description: "Extract URLs, DOIs, and citation-like reference lines from documents/text.",
    promptSnippet: "Extract citation hints",
    promptGuidelines: ["Use for research/report workflows before formatting references."],
    parameters: Type.Object({ path: Type.String(), max_extract_chars: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const extracted = await extractDocument(path, detectFormat(path, "auto"), { maxChars: clamp(params.max_extract_chars, 30_000, 1000, MAX_EXTRACT_CHARS) });
      const citations = extractCitationHints(extracted.text);
      return { content: [{ type: "text", text: citations.length ? citations.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No citation hints detected." }], details: { path: repoRelativePath(ctx.cwd, path), citations } };
    },
  });

  pi.registerTool({
    name: "extract_document_tables",
    label: "Extract Document Tables",
    description: "Extract bounded table previews from CSV/XLSX/DOCX-like document content as Markdown tables.",
    promptSnippet: "Extract document tables",
    promptGuidelines: ["Use instead of manual cut/sort/Excel parsing shell snippets."],
    parameters: Type.Object({ path: Type.String(), max_rows: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const format = detectFormat(path, "auto");
      const maxRows = clamp(params.max_rows, 50, 1, MAX_PREVIEW_ROWS);
      if (format === "csv") {
        const rows = csvRows((await readFile(path)).toString("utf8"), maxRows);
        return { content: [{ type: "text", text: rowsToMarkdown(rows) || "No table rows detected." }], details: { path: repoRelativePath(ctx.cwd, path), format, rows: rows.length } };
      }
      if (format === "xlsx") {
        const buffer = await readFile(path);
        const blocks = workbookSheets(buffer).map(sheet => `Sheet: ${sheet.name}\n${rowsToMarkdown(extractSheetRows(buffer, sheet.path, maxRows))}`);
        return { content: [{ type: "text", text: blocks.join("\n\n") || "No workbook tables detected." }], details: { path: repoRelativePath(ctx.cwd, path), format, sheets: blocks.length } };
      }
      const extracted = await extractDocument(path, format, { maxChars: 20_000 });
      const tableish = extracted.text.split("\n").filter(line => line.includes("\t") || line.split(/\s{2,}/).length >= 3).slice(0, maxRows);
      return { content: [{ type: "text", text: tableish.length ? tableish.join("\n") : "No obvious text tables detected." }], details: { path: repoRelativePath(ctx.cwd, path), format, rows: tableish.length } };
    },
  });

  pi.registerTool({
    name: "create_reporter_document",
    label: "Create Reporter Document",
    description: "Create a styled work/uni report document from semantic sections using the reporter visual style. Outputs HTML or Markdown.",
    promptSnippet: "Create reporter-style document",
    promptGuidelines: ["Agent supplies title/sections; tool owns layout/style boilerplate.", "Use for repeatable work/uni docs instead of hand-writing CSS each time."],
    parameters: Type.Object({ path: Type.String(), title: Type.String(), subtitle: Type.Optional(Type.String()), author: Type.Optional(Type.String()), sections: Type.Array(Type.Object({ heading: Type.String(), body: Type.String(), level: Type.Optional(Type.Number()) })), references: Type.Optional(Type.Array(Type.String())), format: Type.Optional(stringEnum(["html", "md"] as const)), create_dirs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("create_reporter_document", params);
      if (!classification.allowed) throw new Error(`create_reporter_document blocked by safety policy: ${classification.reasons.join(", ")}`);
      const path = resolveSafePath(ctx.cwd, params.path);
      const rel = repoRelativePath(ctx.cwd, path);
      const format = params.format ?? (extname(path).toLowerCase() === ".md" ? "md" : "html");
      const content = format === "md"
        ? [`# ${params.title}`, params.subtitle ? `_${params.subtitle}_` : "", params.author ? `**${params.author}**` : "", ...params.sections.map((s: any) => `${"#".repeat(clamp(s.level, 2, 1, 4))} ${s.heading}\n\n${s.body}`), ...(params.references?.length ? [`## References\n\n${params.references.map((r: string, i: number) => `${i + 1}. ${r}`).join("\n")}`] : [])].filter(Boolean).join("\n\n")
        : reporterHtml(params.title, params.subtitle, params.author, params.sections, params.references ?? []);
      if (params.create_dirs) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
      return { content: [{ type: "text", text: `Created reporter document ${rel} (${content.length} chars)` }], details: { path: rel, format } };
    },
  });

  pi.registerTool({
    name: "convert_document",
    label: "Convert Document",
    description: "Convert supported documents to txt/md/html using native extract/render primitives.",
    promptSnippet: "Convert document",
    promptGuidelines: ["Use for lightweight txt/md/html conversion. PDF/DOCX export backends can be added later without schema churn."],
    parameters: Type.Object({ input_path: Type.String(), output_path: Type.String(), output_format: stringEnum(["txt", "md", "html"] as const), create_dirs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const classification = classifyToolMutation("convert_document", { path: params.output_path });
      if (!classification.allowed) throw new Error(`convert_document blocked by safety policy: ${classification.reasons.join(", ")}`);
      const input = resolveSafePath(ctx.cwd, params.input_path);
      const output = resolveSafePath(ctx.cwd, params.output_path);
      const extracted = await extractDocument(input, detectFormat(input, "auto"), { maxChars: MAX_EXTRACT_CHARS });
      const rel = repoRelativePath(ctx.cwd, output);
      const content = params.output_format === "html" ? reporterHtml(repoRelativePath(ctx.cwd, input), undefined, undefined, [{ heading: "Extracted Text", body: extracted.text, level: 2 }]) : extracted.text;
      if (params.create_dirs) await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content, { encoding: "utf8", flag: "wx" });
      return { content: [{ type: "text", text: `Converted ${repoRelativePath(ctx.cwd, input)} -> ${rel}` }], details: { input_path: repoRelativePath(ctx.cwd, input), output_path: rel, output_format: params.output_format } };
    },
  });
}
