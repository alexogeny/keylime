import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import documentPrimitives from "../extensions/document-primitives";

function registeredDocumentTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  documentPrimitives({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("document primitives", () => {
  test("inspect/summarize documents and inspect csv spreadsheets without boilerplate scripts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-"));
    await writeFile(join(cwd, "notes.md"), "# Topic\n\nAlpha beta gamma.\n\n## Findings\n\nUseful evidence here.\n", "utf8");
    await writeFile(join(cwd, "data.csv"), "Name,Score\nAda,10\nGrace,9\n", "utf8");
    const tools = registeredDocumentTools();

    const doc = await tools.inspect_document.execute("id", { path: "notes.md", max_chars: 1000 }, undefined, undefined, { cwd });
    expect(doc.content[0].text).toContain("Document: notes.md");
    expect(doc.content[0].text).toContain("Alpha beta gamma");

    const summary = await tools.summarize_document.execute("id", { path: "notes.md", purpose: "study_notes" }, undefined, undefined, { cwd });
    expect(summary.content[0].text).toContain("Summary scaffold");
    expect(summary.content[0].text).toContain("Keyword hints");

    const sheet = await tools.inspect_spreadsheet.execute("id", { path: "data.csv" }, undefined, undefined, { cwd });
    expect(sheet.content[0].text).toContain("| Name | Score |");

    const tables = await tools.extract_document_tables.execute("id", { path: "data.csv" }, undefined, undefined, { cwd });
    expect(tables.content[0].text).toContain("| Ada | 10 |");
  });

  test("inspects archives/images, analyzes csv, creates charts, and extracts citations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-"));
    const tools = registeredDocumentTools();
    const tar = Buffer.alloc(1024);
    tar.write("docs/readme.txt", 0, "utf8");
    tar.write("0000644\0", 100, "ascii");
    tar.write("0000000\0", 108, "ascii");
    tar.write("0000000\0", 116, "ascii");
    tar.write("00000000005\0", 124, "ascii");
    tar.write("ustar\0", 257, "ascii");
    await writeFile(join(cwd, "sample.tar"), tar);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000000000000000", "hex");
    await writeFile(join(cwd, "image.png"), png);
    await writeFile(join(cwd, "data.csv"), "Name,Score\nAda,10\nGrace,9\n", "utf8");
    await writeFile(join(cwd, "refs.md"), "See https://example.com/paper and doi:10.1234/ABC.DEF\nSmith (2024). Journal of Examples.\n", "utf8");

    const archive = await tools.inspect_archive.execute("id", { path: "sample.tar" }, undefined, undefined, { cwd });
    expect(archive.content[0].text).toContain("docs/readme.txt");
    const image = await tools.inspect_image_metadata.execute("id", { path: "image.png" }, undefined, undefined, { cwd });
    expect(image.content[0].text).toContain("width: 2");
    expect(image.content[0].text).toContain("height: 3");
    const analysis = await tools.analyze_csv.execute("id", { path: "data.csv" }, undefined, undefined, { cwd });
    expect(analysis.content[0].text).toContain("mean=9.500");
    const chart = await tools.create_chart.execute("id", { path: "chart.svg", title: "Scores", labels: ["Ada", "Grace"], values: [10, 9] }, undefined, undefined, { cwd });
    expect(chart.content[0].text).toContain("Created chart chart.svg");
    expect(await readFile(join(cwd, "chart.svg"), "utf8")).toContain("<svg");
    const citations = await tools.extract_citations.execute("id", { path: "refs.md" }, undefined, undefined, { cwd });
    expect(citations.content[0].text).toContain("https://example.com/paper");
    expect(citations.content[0].text).toContain("10.1234/ABC.DEF");
  });

  test("inspect_document can explicitly inspect read-only documents outside cwd", async () => {
    const parent = await mkdtemp(join(tmpdir(), "document-primitives-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    const outside = join(parent, "outside.md");
    await writeFile(outside, "# Outside\n\nReadable from docs.\n", "utf8");
    const tools = registeredDocumentTools();

    await expect(tools.inspect_document.execute("id", { path: outside }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");

    const doc = await tools.inspect_document.execute("id", {
      path: outside,
      max_chars: 1000,
      allow_outside_cwd: true,
    }, undefined, undefined, { cwd });

    expect(doc.content[0].text).toContain("Document: ../outside.md");
    expect(doc.content[0].text).toContain("Readable from docs.");
    expect(doc.details.path).toBe("../outside.md");
  });

  test("creates reporter-style documents and converts extracted documents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-"));
    await mkdir(join(cwd, "out"));
    await writeFile(join(cwd, "source.md"), "# Source\n\nMaterial to convert.\n", "utf8");
    const tools = registeredDocumentTools();

    const report = await tools.create_reporter_document.execute("id", {
      path: "out/report.html",
      title: "Assessment Brief",
      subtitle: "Reporter style",
      sections: [{ heading: "Overview", body: "This is **important** and *carefully qualified*.\n\n- First result\n- Second result\n\n##### Detailed finding\n\n| Measure | Result |\n|:--------|-------:|\n| Accuracy | 98% |" }],
      references: ["Example reference"],
    }, undefined, undefined, { cwd });
    expect(report.content[0].text).toContain("Created reporter document out/report.html");
    const reportHtml = await readFile(join(cwd, "out", "report.html"), "utf8");
    expect(reportHtml).toContain("--paper:#fff");
    expect(reportHtml).toContain('font-family:"Times New Roman",Times,serif');
    expect(reportHtml).toContain("<strong>important</strong>");
    expect(reportHtml).toContain("<em>carefully qualified</em>");
    expect(reportHtml).toContain("<ul><li>First result</li><li>Second result</li></ul>");
    expect(reportHtml).toContain("<h5>Detailed finding</h5>");
    expect(reportHtml).toContain('<table><thead><tr><th style="text-align:left">Measure</th><th style="text-align:right">Result</th></tr></thead>');
    expect(reportHtml).not.toContain("gradient");
    expect(reportHtml).not.toContain("box-shadow");

    const converted = await tools.convert_document.execute("id", { input_path: "source.md", output_path: "out/source.txt", output_format: "txt" }, undefined, undefined, { cwd });
    expect(converted.content[0].text).toContain("Converted source.md -> out/source.txt");
    expect(await readFile(join(cwd, "out", "source.txt"), "utf8")).toContain("Material to convert");
  });

  test("falls back to cached OCR text for PDFs with no embedded text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-"));
    const tools = registeredDocumentTools();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\n%%EOF\n", "utf8");
    await writeFile(join(cwd, "scan.pdf"), pdf);
    const cacheDir = join(cwd, ".pi", "cache", "pdf-ocr");
    await mkdir(cacheDir, { recursive: true });
    const cacheKey = createHash("sha256").update(pdf).update("\npages=1").digest("hex");
    await writeFile(join(cacheDir, `${cacheKey}.txt`), "Page 1\nOCR fallback text from slide image", "utf8");

    const doc = await tools.inspect_document.execute("id", { path: "scan.pdf", format: "pdf" }, undefined, undefined, { cwd });
    expect(doc.content[0].text).toContain("Extraction method: ocr");
    expect(doc.content[0].text).toContain("OCR fallback text from slide image");
    expect(doc.details.extraction_method).toBe("ocr");
  });
  test("streams CSV analysis while retaining only preview rows", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-streaming-"));
    const tools = registeredDocumentTools();
    const rows = ["Name,Score", ...Array.from({ length: 2_000 }, (_, i) => `item-${i},${i}`)].join("\n");
    await writeFile(join(cwd, "large.csv"), rows, "utf8");
    const analysis = await tools.analyze_csv.execute("id", { path: "large.csv", max_rows: 2_001 }, undefined, undefined, { cwd });
    expect(analysis.details).toMatchObject({ rows: 2000, columns: 2, streaming: true, retainedRows: 12 });
    expect(analysis.content[0].text).toContain("mean=999.500");
  });
});
