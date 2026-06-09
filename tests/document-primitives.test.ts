import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("creates reporter-style documents and converts extracted documents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "document-primitives-"));
    await mkdir(join(cwd, "out"));
    await writeFile(join(cwd, "source.md"), "# Source\n\nMaterial to convert.\n", "utf8");
    const tools = registeredDocumentTools();

    const report = await tools.create_reporter_document.execute("id", {
      path: "out/report.html",
      title: "Assessment Brief",
      subtitle: "Reporter style",
      sections: [{ heading: "Overview", body: "This is the body." }],
      references: ["Example reference"],
    }, undefined, undefined, { cwd });
    expect(report.content[0].text).toContain("Created reporter document out/report.html");
    expect(await readFile(join(cwd, "out", "report.html"), "utf8")).toContain("--accent");

    const converted = await tools.convert_document.execute("id", { input_path: "source.md", output_path: "out/source.txt", output_format: "txt" }, undefined, undefined, { cwd });
    expect(converted.content[0].text).toContain("Converted source.md -> out/source.txt");
    expect(await readFile(join(cwd, "out", "source.txt"), "utf8")).toContain("Material to convert");
  });
});
