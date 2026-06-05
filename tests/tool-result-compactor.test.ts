import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import toolResultCompactorExtension, { compactToolResultContent } from "../extensions/tool-result-compactor";

describe("tool result compaction", () => {
  test("leaves small outputs unchanged", () => {
    const result = compactToolResultContent([{ type: "text", text: "short output" }], { thresholdChars: 100 });
    expect(result.shouldCompact).toBe(false);
    expect(result.compactedText).toBe("short output");
    expect(result.originalChars).toBe(12);
  });

  test("compacts large text with summary and head/tail preview", () => {
    const large = [
      "start line",
      "Error: failing assertion",
      ...Array.from({ length: 40 }, (_, i) => `boring line ${i}`),
      "tail line with final result",
    ].join("\n");
    const result = compactToolResultContent([{ type: "text", text: large }], { thresholdChars: 120, previewChars: 80 });
    expect(result.shouldCompact).toBe(true);
    expect(result.summary[0]).toMatch(/Original output:/);
    expect(result.summary.some(line => line.includes("Error: failing assertion"))).toBe(true);
    expect(result.compactedText).toContain("start line");
    expect(result.compactedText).toContain("tail line with final result");
    expect(result.compactedText.length).toBeLessThan(large.length);
  });

  test("serializes non-text content safely", () => {
    const result = compactToolResultContent([{ type: "json", value: { ok: true } }], { thresholdChars: 5, previewChars: 40 });
    expect(result.shouldCompact).toBe(true);
    expect(result.compactedText).toContain("json");
  });

  test("caps number of interesting summary lines", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Error ${i}: failed`).join("\n");
    const result = compactToolResultContent(text, { thresholdChars: 20, maxSummaryLines: 3 });
    expect(result.summary).toHaveLength(4);
  });

  test("tool_result middleware stores oversized successful output and inspect_tool_result retrieves it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-results-"));
    const handlers: Record<string, any> = {};
    const tools: Record<string, any> = {};
    toolResultCompactorExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
    } as any);

    const huge = `start\n${"x".repeat(7000)}\nError: final failure`;
    const patch = await handlers.tool_result({
      toolName: "run_checks",
      toolCallId: "call-1",
      input: { suite: "test" },
      content: [{ type: "text", text: huge }],
      details: { ok: true },
      isError: false,
    }, { cwd });

    expect(patch.details.compacted).toBe(true);
    expect(patch.details.resultId).toBeString();
    expect(patch.content[0].text).toContain("Tool result compacted for run_checks");
    expect(existsSync(join(cwd, patch.details.resultPath))).toBe(true);

    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      const full = await tools.inspect_tool_result.execute("id", { result_id: patch.details.resultId, max_chars: 50000 });
      expect(full.content[0].text).toContain("Error: final failure");
      expect(full.content[0].text).toContain("call-1");

      const listed = await tools.list_tool_results.execute("id", { limit: 10 });
      expect(listed.details.results[0]).toMatchObject({ id: patch.details.resultId, toolName: "run_checks", originalChars: huge.length });
      expect(listed.content[0].text).toContain("run_checks");
    } finally {
      process.chdir(oldCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tool_result middleware skips errors, small outputs, and inspect_tool_result recursion", async () => {
    const handlers: Record<string, any> = {};
    toolResultCompactorExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerTool: () => {},
    } as any);

    await expect(handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: "small" }], isError: false }, { cwd: process.cwd() })).resolves.toBeUndefined();
    await expect(handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: "x".repeat(8000) }], isError: true }, { cwd: process.cwd() })).resolves.toBeUndefined();
    await expect(handlers.tool_result({ toolName: "inspect_tool_result", content: [{ type: "text", text: "x".repeat(8000) }], isError: false }, { cwd: process.cwd() })).resolves.toBeUndefined();
  });

  test("list_tool_results prunes manifest entries whose payload files disappeared", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-results-"));
    const handlers: Record<string, any> = {};
    const tools: Record<string, any> = {};
    toolResultCompactorExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
    } as any);

    const patch = await handlers.tool_result({
      toolName: "code_search",
      content: [{ type: "text", text: "z".repeat(8000) }],
      isError: false,
    }, { cwd });
    await unlink(join(cwd, patch.details.resultPath));

    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      const listed = await tools.list_tool_results.execute("id", { limit: 10 });
      expect(listed.details.results).toEqual([]);
      expect(listed.content[0].text).toContain("No compacted tool results");
    } finally {
      process.chdir(oldCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("cleanup_tool_results removes old and overflow payloads and rewrites the manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-results-"));
    const tools: Record<string, any> = {};
    toolResultCompactorExtension({ on: () => {}, registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
    const base = join(cwd, ".pi", "tool-results");
    const day = join(base, "2026-01-01");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "old.json"), "old", "utf8");
    await writeFile(join(day, "keep.json"), "keep", "utf8");
    await writeFile(join(base, "index.json"), JSON.stringify([
      { id: "old", toolName: "bash", createdAt: "2020-01-01T00:00:00.000Z", path: ".pi/tool-results/2026-01-01/old.json", originalChars: 10, summary: [] },
      { id: "keep", toolName: "bash", createdAt: "2026-01-01T00:00:00.000Z", path: ".pi/tool-results/2026-01-01/keep.json", originalChars: 10, summary: [] },
    ]), "utf8");

    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await tools.cleanup_tool_results.execute("id", { max_age_days: 30, now: "2026-01-15T00:00:00.000Z" });
      expect(result.details.deleted).toBe(1);
      expect(existsSync(join(day, "old.json"))).toBe(false);
      expect(existsSync(join(day, "keep.json"))).toBe(true);
      const listed = await tools.list_tool_results.execute("id", { limit: 10 });
      expect(listed.details.results.map((entry: any) => entry.id)).toEqual(["keep"]);
    } finally {
      process.chdir(oldCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("inspect_tool_result rejects invalid ids and truncates retrieved payloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-results-"));
    const handlers: Record<string, any> = {};
    const tools: Record<string, any> = {};
    toolResultCompactorExtension({
      on: (name: string, handler: any) => { handlers[name] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
    } as any);

    const patch = await handlers.tool_result({
      toolName: "code_search",
      content: [{ type: "text", text: "z".repeat(8000) }],
      isError: false,
    }, { cwd });

    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      await expect(tools.inspect_tool_result.execute("id", { result_id: "../../etc/passwd" })).rejects.toThrow("Invalid result_id");
      const capped = await tools.inspect_tool_result.execute("id", { result_id: patch.details.resultId, max_chars: 500 });
      expect(capped.content[0].text).toContain("[truncated");
      expect(capped.content[0].text.length).toBeLessThan(900);
    } finally {
      process.chdir(oldCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
