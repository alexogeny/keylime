import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { stringEnum } from "./shared/schema";
import { repoRelativePath } from "./shared/path-policy";
import { isProbablyBinary, resolveSafePath } from "./shared/code-primitives";
import { classifyToolMutation } from "./shared/safety-policy";

const MAX_EXTRACT_CHARS = 60_000;
const MAX_PREVIEW_ROWS = 100;

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

function extractPdfRough(buffer: Buffer, pages?: string): string {
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
  const total = Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) ?? []).length);
  const selected = parsePageSpec(pages, total);
  const joined = streams.map((s, i) => `Page-ish ${i + 1}\n${s}`).filter((_, i) => !selected || selected.has(i + 1)).join("\n\n");
  return joined || "PDF text extraction found no embedded text. This may be a scanned/image PDF or use unsupported encoding.";
}

async function extractDocument(path: string, format: Exclude<DocFormat, "auto">, options: { pages?: string; maxChars: number }) {
  const buffer = await readFile(path);
  if (["txt", "md", "html"].includes(format)) {
    if (isProbablyBinary(buffer)) throw new Error(`Refusing to read probable binary as ${format}`);
    return truncate(buffer.toString("utf8"), options.maxChars);
  }
  if (format === "csv") return truncate(rowsToMarkdown(csvRows(buffer.toString("utf8"), MAX_PREVIEW_ROWS)), options.maxChars);
  if (format === "docx") return truncate(extractDocx(buffer), options.maxChars);
  if (format === "xlsx") {
    const sheets = workbookSheets(buffer);
    const text = sheets.map(sheet => `Sheet: ${sheet.name}\n${rowsToMarkdown(extractSheetRows(buffer, sheet.path, MAX_PREVIEW_ROWS))}`).join("\n\n");
    return truncate(text, options.maxChars);
  }
  if (format === "pdf") return truncate(extractPdfRough(buffer, options.pages), options.maxChars);
  throw new Error(`Unsupported format: ${format}`);
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
    promptGuidelines: ["Use for read/summarize document workflows before answering.", "Output is bounded; request pages/max_chars to narrow large documents.", "Do not use bash/python/node snippets to parse everyday documents."],
    parameters: Type.Object({ path: Type.String(), format: Type.Optional(stringEnum(["auto", "pdf", "docx", "xlsx", "csv", "txt", "md", "html"] as const)), pages: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveSafePath(ctx.cwd, params.path);
      const format = detectFormat(path, params.format);
      const maxChars = clamp(params.max_chars, 12_000, 500, MAX_EXTRACT_CHARS);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`Not a file: ${repoRelativePath(ctx.cwd, path)}`);
      const extracted = await extractDocument(path, format, { pages: params.pages, maxChars });
      const text = `Document: ${repoRelativePath(ctx.cwd, path)}\nFormat: ${format}\nBytes: ${info.size}\nTruncated: ${extracted.truncated ? "yes" : "no"}\n\n${extracted.text}`;
      return { content: [{ type: "text", text }], details: { path: repoRelativePath(ctx.cwd, path), format, bytes: info.size, truncated: extracted.truncated } };
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
      const extracted = await extractDocument(path, format, { pages: params.pages, maxChars: clamp(params.max_extract_chars, 18_000, 1000, MAX_EXTRACT_CHARS) });
      const lines = extracted.text.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0);
      const headings = lines.filter(line => line.length < 90 && /^[A-Z0-9][A-Za-z0-9 .:–—-]+$/.test(line)).slice(0, 20);
      const keywords = [...new Set(extracted.text.toLowerCase().match(/\b[a-z][a-z-]{5,}\b/g) ?? [])].slice(0, 40);
      const text = [`Summary scaffold for ${repoRelativePath(ctx.cwd, path)}`, `Purpose: ${params.purpose ?? "general"}`, `Format: ${format}`, `Truncated: ${extracted.truncated ? "yes" : "no"}`, "", "Possible headings:", ...headings.map(h => `- ${h}`), "", "Keyword hints:", keywords.join(", "), "", "Extract:", extracted.text].join("\n");
      return { content: [{ type: "text", text }], details: { path: repoRelativePath(ctx.cwd, path), format, headings, keywords, truncated: extracted.truncated } };
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
