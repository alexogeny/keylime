import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyIntent } from "../extensions/shared/intent";
import repoIndexExtension, { isIndexedSourcePath, isRepoIndexDirty, markRepoIndexCleanForTest, shouldInjectRepoSkeleton } from "../extensions/repo-index/index";

async function registeredRepoIndexTools(): Promise<Record<string, any>> {
  const tools: Record<string, any> = {};
  await repoIndexExtension({
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: () => {},
    on: () => {},
  } as any);
  return tools;
}

async function registeredRepoIndexHandlers(): Promise<Record<string, any>> {
  const handlers: Record<string, any> = {};
  await repoIndexExtension({
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, handler: any) => { handlers[name] = handler; },
  } as any);
  return handlers;
}

describe("code_search file_glob handling", () => {
  test("repo skeleton injection is limited to code-oriented routes", () => {
    const chat = classifyIntent("hello how are you");
    expect(shouldInjectRepoSkeleton(chat)).toBe(false);
    expect(shouldInjectRepoSkeleton({ ...chat, primaryIntent: "coding" })).toBe(true);
    expect(shouldInjectRepoSkeleton({ ...chat, primaryIntent: "debugging" })).toBe(true);
    expect(shouldInjectRepoSkeleton({ ...chat, primaryIntent: "review" })).toBe(true);
  });

  test("structural search finds repo-index symbols with a relative file_glob", async () => {
    const tools = await registeredRepoIndexTools();
    const result = await tools.code_search.execute("id", {
      query: "rgRun",
      mode: "structural",
      file_glob: "extensions/repo-index/index.ts",
      max_results: 5,
    }, undefined, undefined, { cwd: process.cwd() });

    expect(result.details.lines).toBeGreaterThan(0);
    expect(result.content[0].text).toContain("extensions/repo-index/index.ts");
    expect(result.content[0].text).toContain("rgRun");
  });

  test("lexical search accepts relative recursive file_glob values", async () => {
    const tools = await registeredRepoIndexTools();
    const result = await tools.code_search.execute("id", {
      query: "resolveRgPath",
      mode: "lexical",
      file_glob: "extensions/**/*.ts",
      max_results: 5,
    }, undefined, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("extensions/repo-index/index.ts");
    expect(result.content[0].text).toContain("resolveRgPath");
  });

  test("hidden file_glob auto-enables hidden search", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-index-"));
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, ".hidden", "secret.ts"), "export function hiddenNeedle() {}\n", "utf8");

    const tools = await registeredRepoIndexTools();
    const result = await tools.code_search.execute("id", {
      query: "hiddenNeedle",
      mode: "structural",
      file_glob: ".hidden/**/*.ts",
      max_results: 5,
    }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain(".hidden/secret.ts");
    expect(result.content[0].text).toContain("hiddenNeedle");
  });

  test("no-match scoped searches point to matches outside the file_glob", async () => {
    const tools = await registeredRepoIndexTools();
    const result = await tools.code_search.execute("id", {
      query: "apply_code_replacements",
      mode: "auto",
      file_glob: "extensions/shared/code-primitives.ts",
      max_results: 5,
    }, undefined, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("No matches inside file_glob");
    expect(result.content[0].text).toContain("Matches exist outside that scope");
    expect(result.content[0].text).toContain("apply_code_replacements");
  });

  test("accepts whitespace-separated file_glob scopes instead of silently missing matches", async () => {
    const tools = await registeredRepoIndexTools();
    const result = await tools.code_search.execute("id", {
      query: "registerTool",
      mode: "lexical",
      file_glob: "extensions/repo-index/** extensions/code-primitives.ts tests/repo-index.test.ts",
      max_results: 5,
    }, undefined, undefined, { cwd: process.cwd() });

    expect(result.details.lines).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('code_search "registerTool"');
    expect(result.content[0].text).toContain("extensions/code-primitives.ts");
    expect(result.content[0].text).toContain("registerTool");
  });

  test("create_file invalidates source repo index", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "create_file", input: { path: "src/new.ts" } });

    expect(isIndexedSourcePath("src/new.ts")).toBe(true);
    expect(isRepoIndexDirty()).toBe(true);
  });

  test("failed and skipped create_file results do not invalidate repo index", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "create_file", input: { path: "src/new.ts" }, isError: true });
    expect(isRepoIndexDirty()).toBe(false);

    await handlers.tool_result({ toolName: "create_file", input: { path: "src/new.ts" }, details: { skipped: true } });
    expect(isRepoIndexDirty()).toBe(false);
  });

  test("finish_file_write invalidates source repo index from result details", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "finish_file_write", input: { handle: "h" }, details: { path: "src/large.ts" } });

    expect(isRepoIndexDirty()).toBe(true);
  });

  test("failed, skipped, and non-source finish_file_write results do not invalidate repo index", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "finish_file_write", input: { handle: "h" }, details: { path: "src/large.ts" }, isError: true });
    await handlers.tool_result({ toolName: "finish_file_write", input: { handle: "h" }, details: { path: "src/large.ts", skipped: true } });
    await handlers.tool_result({ toolName: "finish_file_write", input: { handle: "h" }, details: { path: "notes.txt" } });

    expect(isRepoIndexDirty()).toBe(false);
  });

  test("apply_code_replacements invalidates only successful non-dry-run source edits", async () => {
    const handlers = await registeredRepoIndexHandlers();

    markRepoIndexCleanForTest();
    await handlers.tool_result({ toolName: "apply_code_replacements", input: { dry_run: true, edits: [{ path: "src/a.ts" }] } });
    expect(isRepoIndexDirty()).toBe(false);

    await handlers.tool_result({ toolName: "apply_code_replacements", input: { edits: [{ path: "src/a.ts" }] }, isError: true });
    expect(isRepoIndexDirty()).toBe(false);

    await handlers.tool_result({ toolName: "apply_code_replacements", input: { edits: [{ path: "notes.txt" }] } });
    expect(isRepoIndexDirty()).toBe(false);

    await handlers.tool_result({ toolName: "apply_code_replacements", input: { edits: [{ path: "src/a.ts" }] } });
    expect(isRepoIndexDirty()).toBe(true);
  });

  test("broad successful apply_code_replacements invalidates repo index", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "apply_code_replacements", input: { file_glob: "src/**/*.ts", edits: [] } });

    expect(isRepoIndexDirty()).toBe(true);
  });

  test("create_file ignores non-source files for repo index invalidation", async () => {
    const handlers = await registeredRepoIndexHandlers();
    markRepoIndexCleanForTest();

    await handlers.tool_result({ toolName: "create_file", input: { path: "notes.txt" } });

    expect(isIndexedSourcePath("notes.txt")).toBe(false);
    expect(isRepoIndexDirty()).toBe(false);
  });

});
