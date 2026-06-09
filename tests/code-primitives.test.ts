import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codePrimitivesExtension from "../extensions/code-primitives";
import {
  formatPlanPreview,
  inspectTextMatches,
  isProbablyBinary,
  planReplacement,
  resolveSafePath,
  summarizePlan,
} from "../extensions/shared/code-primitives";

describe("inspectTextMatches", () => {
  test("finds exact matches with line, column, full line, and context", () => {
    const matches = inspectTextMatches("one\ntwo words\nthree two", { query: "two", contextLines: 1 });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ line: 2, column: 1, text: "two", lineText: "two words", before: ["one"], after: ["three two"] });
    expect(matches[1]).toMatchObject({ line: 3, column: 7, lineText: "three two" });
  });

  test("finds regex matches", () => {
    const matches = inspectTextMatches("foo1 foo2 bar", { query: "foo\\d", regex: true });

    expect(matches.map(m => m.text)).toEqual(["foo1", "foo2"]);
  });

  test("rejects empty queries", () => {
    expect(() => inspectTextMatches("abc", { query: "" })).toThrow("query must not be empty");
  });

  test("clamps max matches and context lines", () => {
    const matches = inspectTextMatches("a\na\na", { query: "a", contextLines: -10, maxMatches: 0 });

    expect(matches).toHaveLength(1);
    expect(matches[0].before).toEqual([]);
    expect(matches[0].after).toEqual([]);
  });
});

describe("planReplacement", () => {
  test("applies one exact replacement by default", () => {
    const plan = planReplacement("alpha beta", { path: "x.ts", oldText: "beta", newText: "gamma" });

    expect(plan.after).toBe("alpha gamma");
    expect(plan.replacements).toBe(1);
    expect(plan.previews).toEqual([{ line: 1, before: "alpha beta", after: "alpha gamma" }]);
    expect(summarizePlan(plan)).toContain("x.ts: 1 replacement");
  });

  test("requires specificity for repeated exact matches", () => {
    expect(() => planReplacement("x x", { path: "x.ts", oldText: "x", newText: "y" })).toThrow("matched 2 times");
  });

  test("can replace all exact matches", () => {
    const plan = planReplacement("x x", { path: "x.ts", oldText: "x", newText: "y", replaceAll: true });

    expect(plan.after).toBe("y y");
    expect(plan.replacements).toBe(2);
  });

  test("supports regex replacement", () => {
    const plan = planReplacement("foo1 foo2", { path: "x.ts", regex: "foo\\d", newText: "bar", replaceAll: true });

    expect(plan.after).toBe("bar bar");
    expect(plan.replacements).toBe(2);
  });

  test("rejects regex patterns that can match empty strings", () => {
    expect(() => planReplacement("abc", { path: "x.ts", regex: ".*", newText: "x", replaceAll: true })).toThrow("must not match empty strings");
  });

  test("adds near-match diagnostics for whitespace mismatch", () => {
    expect(() => planReplacement("const x = 1;\nconst y = 2;", {
      path: "x.ts",
      oldText: "const x = 1; const y = 2;",
      newText: "const z = 3;",
    })).toThrow("Possible whitespace/indentation mismatch");
  });

  test("formats dry-run previews", () => {
    const plan = planReplacement("a\nb\nc", { path: "x.ts", oldText: "b", newText: "bee" });

    expect(formatPlanPreview(plan)).toContain("@@ -2 +2 @@");
    expect(formatPlanPreview(plan)).toContain("-b");
    expect(formatPlanPreview(plan)).toContain("+bee");
  });

  test("can color replacement previews for TUI output", () => {
    const plan = planReplacement("a\nb\nc", { path: "x.ts", oldText: "b", newText: "bee" });

    expect(formatPlanPreview(plan, { color: true })).toContain("\x1b[31m-b\x1b[0m");
    expect(formatPlanPreview(plan, { color: true })).toContain("\x1b[32m+bee\x1b[0m");
  });
});

function registeredCodePrimitiveTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  codePrimitivesExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("code primitive extension tools", () => {
  test("registers first-class fs/json tools with prompt guidance", () => {
    const tools = registeredCodePrimitiveTools();

    expect(tools.list_files.promptGuidelines.join("\n")).toContain("instead of bash ls/find");
    expect(tools.inspect_text_matches.promptGuidelines.join("\n")).toContain("instead of bash grep/rg");
    expect(tools.inspect_json.promptGuidelines.join("\n")).toContain("instead of jq");
    expect(tools.inspect_lines.promptGuidelines.join("\n")).toContain("capped at 200 lines");
    expect(tools.inspect_lines.promptGuidelines.join("\n")).toContain("allow_outside_cwd=true");
    expect(tools.list_files.promptGuidelines.join("\n")).toContain("allow_outside_cwd=true");
    expect(tools.inspect_file_metadata.promptGuidelines.join("\n")).toContain("instead of bash stat/file/wc");
    expect(tools.compare_files.promptGuidelines.join("\n")).toContain("instead of bash diff/cmp/comm");
    expect(tools.replace_file.promptGuidelines.join("\n")).toContain("whole-file replacement");
    expect(tools.inspect_runtime_environment.promptGuidelines.join("\n")).toContain("instead of bash pwd/env/which/type");
  });

  test("metadata, compare, replace, lifecycle, and runtime tools cover blocked shell capabilities", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(cwd, "src", "b.txt"), "one\nthree\n", "utf8");
    const tools = registeredCodePrimitiveTools();

    const metadata = await tools.inspect_file_metadata.execute("id", { path: "src/a.txt", include_sha256: true }, undefined, undefined, { cwd });
    expect(metadata.content[0].text).toContain("sha256:");
    const currentSha = metadata.details.sha256;

    const comparison = await tools.compare_files.execute("id", { left_path: "src/a.txt", right_path: "src/b.txt" }, undefined, undefined, { cwd });
    expect(comparison.content[0].text).toContain("-2 | two");
    expect(comparison.content[0].text).toContain("+2 | three");

    await tools.copy_file.execute("id", { from_path: "src/a.txt", to_path: "src/c.txt" }, undefined, undefined, { cwd });
    expect(await readFile(join(cwd, "src", "c.txt"), "utf8")).toBe("one\ntwo\n");
    await tools.move_file.execute("id", { from_path: "src/c.txt", to_path: "src/d.txt" }, undefined, undefined, { cwd });
    expect(await readFile(join(cwd, "src", "d.txt"), "utf8")).toBe("one\ntwo\n");
    await tools.delete_file.execute("id", { path: "src/d.txt" }, undefined, undefined, { cwd });

    const replaced = await tools.replace_file.execute("id", { path: "src/a.txt", expected_sha256: currentSha, content: "replaced\n" }, undefined, undefined, { cwd });
    expect(replaced.content[0].text).toContain("Replaced src/a.txt");
    expect(await readFile(join(cwd, "src", "a.txt"), "utf8")).toBe("replaced\n");

    const runtime = await tools.inspect_runtime_environment.execute("id", {}, undefined, undefined, { cwd });
    expect(runtime.content[0].text).toContain("platform:");
  });

  test("list_files lists sorted files, filters by language, excludes vendor dirs, and caps results", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export {};\n", "utf8");
    await writeFile(join(cwd, "src", "b.js"), "module.exports = {};\n", "utf8");
    await writeFile(join(cwd, "node_modules", "pkg", "ignored.ts"), "export {};\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.list_files.execute("id", {
      language: "typescript",
      max_results: 10,
    }, undefined, undefined, { cwd });

    expect(result.details.entries.map((entry: any) => entry.path)).toEqual(["src/a.ts"]);
    expect(result.content[0].text).toContain("src/a.ts");
    expect(result.content[0].text).not.toContain("ignored.ts");
  });

  test("list_files can include directories and truncate large result sets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "a\n", "utf8");
    await writeFile(join(cwd, "src", "b.ts"), "b\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.list_files.execute("id", {
      include_dirs: true,
      max_results: 1,
    }, undefined, undefined, { cwd });

    expect(result.details.truncated).toBe(true);
    expect(result.details.entries).toHaveLength(1);
    expect(result.content[0].text).toContain("truncated");
  });

  test("list_files can explicitly inspect read-only directories outside cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    const outside = await mkdtemp(join(tmpdir(), "code-primitives-outside-"));
    await writeFile(join(outside, "outside.ts"), "export {};\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.list_files.execute("id", {
      path: outside,
    }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");

    const result = await tools.list_files.execute("id", {
      path: outside,
      allow_outside_cwd: true,
    }, undefined, undefined, { cwd });

    expect(result.details.entries.map((entry: any) => entry.path)).toEqual(["outside.ts"]);
    expect(result.content[0].text).toContain("outside.ts");
  });

  test("inspect_json projects simple paths and omits bulky keys by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "data.json"), JSON.stringify({ memories: [{ content: "hello", embedding: [1, 2, 3] }], profile: { body: { shoe_size: "AU 8" } } }), "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_json.execute("id", {
      path: "data.json",
      json_path: "memories[0]",
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain('"content": "hello"');
    expect(result.content[0].text).not.toContain("embedding");
    expect(result.details.json_path).toBe("memories[0]");
  });

  test("inspect_json supports wildcard array projection and output caps", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "data.json"), JSON.stringify({ memories: Array.from({ length: 30 }, (_, index) => ({ content: `alpha-${index}` })) }), "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_json.execute("id", {
      path: "data.json",
      json_path: "memories[*].content",
      max_chars: 200,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("alpha-0");
    expect(result.content[0].text).toContain("truncated");
  });

  test("inspect_json can explicitly inspect read-only JSON outside cwd", async () => {
    const parent = await mkdtemp(join(tmpdir(), "code-primitives-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    const outside = join(parent, "outside.json");
    await writeFile(outside, JSON.stringify({ ok: true, nested: { value: 42 } }), "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.inspect_json.execute("id", { path: outside }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");

    const result = await tools.inspect_json.execute("id", {
      path: outside,
      json_path: "nested.value",
      allow_outside_cwd: true,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("42");
    expect(result.details.path).toBe("../outside.json");
  });

  test("inspect_text_matches and inspect_code_structure can explicitly inspect outside cwd", async () => {
    const parent = await mkdtemp(join(tmpdir(), "code-primitives-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    const outside = join(parent, "outside.ts");
    await writeFile(outside, "export function outsideThing() {\n  return 'needle';\n}\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.inspect_text_matches.execute("id", { path: outside, query: "needle" }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");
    const matches = await tools.inspect_text_matches.execute("id", { path: outside, query: "needle", allow_outside_cwd: true }, undefined, undefined, { cwd });
    expect(matches.content[0].text).toContain("needle");

    await expect(tools.inspect_code_structure.execute("id", { path: outside, language: "typescript" }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");
    const structure = await tools.inspect_code_structure.execute("id", { path: outside, language: "typescript", allow_outside_cwd: true }, undefined, undefined, { cwd });
    expect(structure.content[0].text).toContain("function outsideThing");
  });

  test("apply_code_replacements uses colored diff previews", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "const value = 1;\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.apply_code_replacements.execute("id", {
      edits: [{ path: "x.ts", oldText: "1", newText: "2" }],
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("\x1b[31m-const value = 1;\x1b[0m");
    expect(result.content[0].text).toContain("\x1b[32m+const value = 2;\x1b[0m");
  });

  test("inspect_text_matches treats regex-looking alternation queries as regex", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "tools.ts"), [
      'pi.registerTool({',
      '  name: "inspect_text_matches",',
      '  promptGuidelines: ["Use before broad replacements."],',
      '});',
      '',
    ].join("\n"), "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_text_matches.execute("id", {
      path: "src/tools.ts",
      query: 'promptGuidelines|name: "inspect_text_matches"',
    }, undefined, undefined, { cwd });

    expect(result.details.count).toBe(2);
    expect(result.content[0].text).toContain('name: "inspect_text_matches"');
    expect(result.content[0].text).toContain("promptGuidelines");
  });

  test("inspect_text_matches falls back to literal search for invalid regex-looking queries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "literal.ts"), "const value = foo(bar;\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_text_matches.execute("id", {
      path: "src/literal.ts",
      query: "foo(bar",
    }, undefined, undefined, { cwd });

    expect(result.details.count).toBe(1);
    expect(result.content[0].text).toContain("foo(bar");
  });

  test("always-on code primitive prompt guidelines stay compact", () => {
    const tools = registeredCodePrimitiveTools();
    for (const name of ["list_files", "inspect_text_matches", "inspect_lines", "inspect_json", "plan_code_replacements", "apply_code_replacements"]) {
      const text = tools[name].promptGuidelines.join("\n");
      expect(text.length).toBeLessThan(800);
    }
  });

  test("source mutation tools warn against native runtime file mutations", () => {
    const tools = registeredCodePrimitiveTools();
    const guidelines = [
      ...tools.inspect_text_matches.promptGuidelines,
      ...tools.plan_code_replacements.promptGuidelines,
      ...tools.apply_code_replacements.promptGuidelines,
    ].join("\n");

    expect(guidelines).toContain("use plan_code_replacements/apply_code_replacements");
    expect(guidelines).toContain("Do not mutate repo files with raw shell/runtime/git commands");
    expect(guidelines).toContain("Verify only the changed behavior with run_checks");
    expect(guidelines).toContain("For new source/config/test/docs/fixtures, use create_file/create_directory");
  });

  test("inspect_text_matches supports file_glob and language filters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "const needle = true;\n", "utf8");
    await writeFile(join(cwd, "src", "b.py"), "needle = True\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_text_matches.execute("id", {
      file_glob: "src/*",
      language: "typescript",
      query: "needle",
    }, undefined, undefined, { cwd });

    expect(result.details.count).toBe(1);
    expect(result.details.files.map((file: any) => file.path)).toEqual(["src/a.ts"]);
    expect(result.content[0].text).toContain("src/a.ts:1:7 needle");
  });

  test("create_directory creates directories recursively and supports skip", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    const result = await tools.create_directory.execute("id", {
      path: "src/generated",
      recursive: true,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("Created directory src/generated");
    const skipped = await tools.create_directory.execute("id", {
      path: "src/generated",
      if_exists: "skip",
    }, undefined, undefined, { cwd });
    expect(skipped.details.skipped).toBe(true);
  });

  test("create_directory refuses existing directories by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "existing"));

    const tools = registeredCodePrimitiveTools();
    await expect(tools.create_directory.execute("id", {
      path: "existing",
    }, undefined, undefined, { cwd })).rejects.toThrow("Directory already exists");
  });

  test("create_file creates a new file with parent dirs and final newline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    const result = await tools.create_file.execute("id", {
      path: "src/new.ts",
      content: "export const value = 1;",
      create_dirs: true,
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "src", "new.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(result.details.path).toBe("src/new.ts");
    expect(result.details.bytes).toBeGreaterThan(0);
    expect(result.content[0].text).toContain("Created src/new.ts");
  });

  test("create_file refuses to overwrite existing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "existing.ts"), "old\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.create_file.execute("id", {
      path: "existing.ts",
      content: "new\n",
    }, undefined, undefined, { cwd })).rejects.toThrow("File already exists");

    expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("old\n");
  });

  test("create_file rejects large content and points to chunked writer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    await expect(tools.create_file.execute("id", {
      path: "large.ts",
      content: "x".repeat(32 * 1024 + 1),
    }, undefined, undefined, { cwd })).rejects.toThrow("Use begin_file_write");
  });

  test("chunked file writer creates a file atomically from ordered chunks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    expect(tools.begin_file_write.promptGuidelines.join("\n")).toContain("larger files");

    const begin = await tools.begin_file_write.execute("id", {
      path: "src/large.ts",
      create_dirs: true,
    }, undefined, undefined, { cwd });

    await tools.append_file_chunk.execute("id", {
      handle: begin.details.handle,
      index: 0,
      content: "export const a = 1;\n",
    }, undefined, undefined, { cwd });
    await tools.append_file_chunk.execute("id", {
      handle: begin.details.handle,
      index: 1,
      content: "export const b = 2;\n",
    }, undefined, undefined, { cwd });

    await expect(readFile(join(cwd, "src", "large.ts"), "utf8")).rejects.toThrow();

    await expect(tools.finish_file_write.execute("id", {
      handle: begin.details.handle,
      sha256: "not-the-real-checksum",
    }, undefined, undefined, { cwd })).rejects.toThrow("Checksum mismatch");
    await expect(readFile(join(cwd, "src", "large.ts"), "utf8")).rejects.toThrow();

    const sha256 = createHash("sha256").update("export const a = 1;\nexport const b = 2;\n").digest("hex");
    const finished = await tools.finish_file_write.execute("id", {
      handle: begin.details.handle,
      expected_chunks: 2,
      sha256,
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "src", "large.ts"), "utf8")).toBe("export const a = 1;\nexport const b = 2;\n");
    expect(finished.details.path).toBe("src/large.ts");
    expect(finished.details.bytes).toBeGreaterThan(0);
    expect(finished.content[0].text).toContain("Created src/large.ts");
  });

  test("chunked file writer validates path before accepting content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    await expect(tools.begin_file_write.execute("id", {
      path: ".env.local",
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");
  });

  test("chunked file writer enforces chunk order, chunk size, and abort cleanup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));

    const tools = registeredCodePrimitiveTools();
    const begin = await tools.begin_file_write.execute("id", {
      path: "large.txt",
    }, undefined, undefined, { cwd });

    await expect(tools.append_file_chunk.execute("id", {
      handle: begin.details.handle,
      index: 1,
      content: "late\n",
    }, undefined, undefined, { cwd })).rejects.toThrow("Expected chunk index 0");

    await expect(tools.append_file_chunk.execute("id", {
      handle: begin.details.handle,
      index: 0,
      content: "x".repeat(begin.details.max_chunk_bytes + 1),
    }, undefined, undefined, { cwd })).rejects.toThrow("Chunk too large");

    const aborted = await tools.abort_file_write.execute("id", {
      handle: begin.details.handle,
    }, undefined, undefined, { cwd });
    expect(aborted.details.aborted).toBe(true);

    await expect(tools.finish_file_write.execute("id", {
      handle: begin.details.handle,
    }, undefined, undefined, { cwd })).rejects.toThrow("Unknown file write handle");
    await expect(readFile(join(cwd, "large.txt"), "utf8")).rejects.toThrow();
  });

  test("file mutation tools enforce central protected-path classification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, ".env"), "SECRET=old\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.create_file.execute("id", {
      path: ".env.local",
      content: "SECRET=new\n",
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");

    await expect(tools.create_directory.execute("id", {
      path: ".git/hooks/generated",
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");

    await expect(tools.apply_code_replacements.execute("id", {
      edits: [{ path: ".env", oldText: "old", newText: "new" }],
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");

    await expect(tools.apply_code_replacements.execute("id", {
      edits: [
        { path: "src/safe.ts", oldText: "old", newText: "new" },
        { path: ".env", oldText: "old", newText: "new" },
      ],
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");

    await expect(tools.create_file.execute("id", {
      path: ".git/hooks/generated",
      content: "hook\n",
      create_dirs: true,
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");

    const dryRun = await tools.apply_code_replacements.execute("id", {
      dry_run: true,
      edits: [{ path: ".env", oldText: "old", newText: "new" }],
    }, undefined, undefined, { cwd });
    expect(dryRun.details.dryRun).toBe(true);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("SECRET=old\n");
  });

  test("create_file skip mode does not overwrite existing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "existing.ts"), "old\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.create_file.execute("id", {
      path: "existing.ts",
      content: "new\n",
      if_exists: "skip",
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("old\n");
    expect(result.details.skipped).toBe(true);
  });

  test("inspect_lines returns a bounded numbered line window", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "one\ntwo\nthree\nfour\nfive\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.inspect_lines.execute("id", {
      path: "x.ts",
      start: 3,
      context: 1,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("x.ts:2-4");
    expect(result.content[0].text).toContain("2 | two");
    expect(result.content[0].text).toContain("3 | three");
    expect(result.content[0].text).toContain("4 | four");
    expect(result.content[0].text).not.toContain("1 | one");
  });

  test("inspect_lines rejects overly large windows", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "one\ntwo\nthree\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.inspect_lines.execute("id", {
      path: "x.ts",
      start: 1,
      end: 100,
      max_lines: 2,
    }, undefined, undefined, { cwd })).rejects.toThrow("Requested line window exceeds max_lines");
  });

  test("inspect_lines can explicitly inspect read-only files outside cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    const outside = await mkdtemp(join(tmpdir(), "code-primitives-outside-"));
    const outsidePath = join(outside, "notes.txt");
    await writeFile(outsidePath, "alpha\nbeta\ngamma\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.inspect_lines.execute("id", {
      path: outsidePath,
      start: 2,
    }, undefined, undefined, { cwd })).rejects.toThrow("outside cwd");

    const result = await tools.inspect_lines.execute("id", {
      path: outsidePath,
      start: 2,
      allow_outside_cwd: true,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("2 | beta");
    expect(result.details.path).toContain("notes.txt");
  });

  test("plan_code_replacements previews without writing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "alpha\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.plan_code_replacements.execute("id", {
      edits: [{ path: "x.ts", oldText: "alpha", newText: "beta" }],
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "x.ts"), "utf8")).toBe("alpha\n");
    expect(result.content[0].text).toContain("Plan:");
    expect(result.content[0].text).toContain("@@ -1 +1 @@");
    expect(result.content[0].text).toContain("x.ts: 1 replacement");
    expect(result.details.dryRun).toBe(true);
    expect(result.details.plans[0].path).toBe("x.ts");
  });

  test("apply_code_replacements applies multiple edits to the same file sequentially", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "alpha beta\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.apply_code_replacements.execute("id", {
      edits: [
        { path: "x.ts", oldText: "alpha", newText: "gamma" },
        { path: "x.ts", oldText: "beta", newText: "delta" },
      ],
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "x.ts"), "utf8")).toBe("gamma delta\n");
    expect(result.details.plans).toHaveLength(1);
    expect(result.details.plans[0].replacements).toBe(2);
  });

  test("apply_code_replacements targets file_glob and language safely", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "alpha\n", "utf8");
    await writeFile(join(cwd, "src", "b.py"), "alpha\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.apply_code_replacements.execute("id", {
      file_glob: "src/*",
      language: "typescript",
      edits: [{ oldText: "alpha", newText: "beta" }],
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "src", "a.ts"), "utf8")).toBe("beta\n");
    expect(await readFile(join(cwd, "src", "b.py"), "utf8")).toBe("alpha\n");
    expect(result.details.plans.map((plan: any) => plan.path)).toEqual(["src/a.ts"]);
    expect(result.content[0].text).toContain("src/a.ts: 1 replacement");
  });

  test("apply_code_replacements accepts multiple whitespace-separated file_glob scopes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, "src", "a.ts"), "alpha\n", "utf8");
    await writeFile(join(cwd, "tests", "a.test.ts"), "alpha\n", "utf8");
    await writeFile(join(cwd, "README.md"), "alpha\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    const result = await tools.apply_code_replacements.execute("id", {
      file_glob: "src/*.ts tests/*.ts",
      edits: [{ oldText: "alpha", newText: "beta" }],
    }, undefined, undefined, { cwd });

    expect(await readFile(join(cwd, "src", "a.ts"), "utf8")).toBe("beta\n");
    expect(await readFile(join(cwd, "tests", "a.test.ts"), "utf8")).toBe("beta\n");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("alpha\n");
    expect(result.details.plans.map((plan: any) => plan.path).sort()).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  test("replacement errors include edit number and target file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "code-primitives-"));
    await writeFile(join(cwd, "x.ts"), "alpha alpha\n", "utf8");

    const tools = registeredCodePrimitiveTools();
    await expect(tools.plan_code_replacements.execute("id", {
      edits: [{ path: "x.ts", oldText: "alpha", newText: "beta", expectedReplacements: 1, replaceAll: true }],
    }, undefined, undefined, { cwd })).rejects.toThrow("Edit 1 failed for x.ts: Expected 1 replacement");
  });
});

describe("path and binary safety", () => {
  test("resolves relative paths inside cwd", () => {
    expect(resolveSafePath("/repo", "src/file.ts")).toBe("/repo/src/file.ts");
  });

  test("rejects path traversal outside cwd", () => {
    expect(() => resolveSafePath("/repo", "../secret.txt")).toThrow("outside cwd");
  });

  test("rejects absolute paths outside cwd", () => {
    expect(() => resolveSafePath("/repo", "/tmp/secret.txt")).toThrow("outside cwd");
  });

  test("detects binary buffers", () => {
    expect(isProbablyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isProbablyBinary(Buffer.from("plain text"))).toBe(false);
  });
});

describe("advanced replacement modes and count guards", () => {
  test("normalized_whitespace is disabled to preserve formatting", () => {
    expect(() => planReplacement("const x = 1;\nconst y = 2;", {
      path: "x.ts",
      oldText: "const x = 1; const y = 2;",
      newText: "const z = 3;",
      matchMode: "normalized_whitespace",
    })).toThrow("normalized_whitespace replacement is disabled");
  });

  test("trimmed_lines ignores common indentation", () => {
    const plan = planReplacement("if (ok) {\n  call();\n}", {
      path: "x.ts",
      oldText: "  if (ok) {\n    call();\n  }",
      newText: "done();",
      matchMode: "trimmed_lines",
    });

    expect(plan.after).toBe("done();");
  });

  test("enforces expected replacement count", () => {
    expect(() => planReplacement("x x", {
      path: "x.ts",
      oldText: "x",
      newText: "y",
      replaceAll: true,
      expectedReplacements: 1,
    })).toThrow("Expected 1 replacement");
  });

  test("enforces min and max replacement counts", () => {
    expect(() => planReplacement("x x x", { path: "x.ts", oldText: "x", newText: "y", replaceAll: true, maxReplacements: 2 })).toThrow("at most 2");
    expect(() => planReplacement("x", { path: "x.ts", oldText: "x", newText: "y", minReplacements: 2 })).toThrow("at least 2");
  });
});

describe("glob/language filtering", () => {
  test("matches simple and recursive globs", async () => {
    const { matchesGlob } = await import("../extensions/shared/code-primitives");

    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/nested/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/nested/a.ts", "src/**/*.ts")).toBe(true);
  });

  test("matches brace alternation and multiple glob scopes", async () => {
    const { matchesGlob } = await import("../extensions/shared/code-primitives");

    expect(matchesGlob("src/a.ts", "src/*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("src/a.tsx", "src/*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("tests/a.test.ts", "src/*.ts tests/*.ts")).toBe(true);
    expect(matchesGlob("README.md", "src/*.ts tests/*.ts")).toBe(false);
  });

  test("default excludes skip vendor and build outputs", async () => {
    const { shouldExcludePath } = await import("../extensions/shared/code-primitives");

    expect(shouldExcludePath("extensions/node_modules/pkg/index.ts")).toBe(true);
    expect(shouldExcludePath("target/debug/main.rs")).toBe(true);
    expect(shouldExcludePath("src/main.rs")).toBe(false);
  });

  test("language extension filters are available", async () => {
    const { extensionsForLanguage } = await import("../extensions/shared/code-primitives");

    expect(extensionsForLanguage("typescript")).toContain(".ts");
    expect(extensionsForLanguage("python")).toEqual([".py"]);
    expect(extensionsForLanguage("rust")).toEqual([".rs"]);
  });
});

describe("lightweight AST primitives", () => {
  test("extracts TypeScript imports and declarations", async () => {
    const { inspectCodeStructure } = await import("../extensions/shared/code-primitives");
    const structure = inspectCodeStructure("import x from 'x';\nexport function run() {}\nclass Thing {}", "typescript");

    expect(structure.imports).toEqual(["x"]);
    expect(structure.declarations.map(d => d.name)).toEqual(["run", "Thing"]);
  });

  test("extracts Python imports and declarations", async () => {
    const { inspectCodeStructure } = await import("../extensions/shared/code-primitives");
    const structure = inspectCodeStructure("import os\nfrom pathlib import Path\ndef run(): pass\nclass Thing: pass", "python");

    expect(structure.imports).toEqual(["os", "pathlib"]);
    expect(structure.declarations.map(d => d.name)).toEqual(["run", "Thing"]);
  });

  test("extracts Rust imports and declarations", async () => {
    const { inspectCodeStructure } = await import("../extensions/shared/code-primitives");
    const structure = inspectCodeStructure("use std::fs;\npub fn run() {}\nstruct Thing;", "rust");

    expect(structure.imports).toEqual(["std::fs"]);
    expect(structure.declarations.map(d => d.name)).toEqual(["run", "Thing"]);
  });
});
