import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import repoIndexExtension from "../extensions/repo-index/index";

async function registeredRepoIndexTools(): Promise<Record<string, any>> {
  const tools: Record<string, any> = {};
  await repoIndexExtension({
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: () => {},
    on: () => {},
  } as any);
  return tools;
}

describe("code_search file_glob handling", () => {
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
    expect(result.content[0].text).toContain("extensions/code-primitives.ts");
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

});
