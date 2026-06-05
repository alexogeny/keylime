import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import policyToolsExtension from "../extensions/policy-tools";

function registeredTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  policyToolsExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("codemod executor tools", () => {
  test("registers planning and low-risk executor tools", () => {
    const tools = registeredTools();
    expect(Object.keys(tools).sort()).toEqual(expect.arrayContaining([
      "codemod_add_import",
      "codemod_insert_test_case",
      "codemod_plan",
      "codemod_update_json",
      "retrieve_policy",
      "suggest_checks",
    ]));
  });

  test("codemod_update_json previews and applies a nested JSON value", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codemod-json-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }, null, 2), "utf8");
    const tools = registeredTools();

    const dry = await tools.codemod_update_json.execute("id", {
      path: "package.json",
      json_path: "scripts.test",
      value: "bun test tests",
      dry_run: true,
    }, undefined, undefined, { cwd });
    expect(dry.details.dryRun).toBe(true);
    expect(await readFile(join(cwd, "package.json"), "utf8")).toContain("bun test");
    expect(await readFile(join(cwd, "package.json"), "utf8")).not.toContain("bun test tests");

    const applied = await tools.codemod_update_json.execute("id", {
      path: "package.json",
      json_path: "scripts.test",
      value: "bun test tests",
    }, undefined, undefined, { cwd });
    expect(applied.details.path).toBe("package.json");
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts.test).toBe("bun test tests");
  });

  test("codemod_update_json blocks protected paths and creates missing nested objects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codemod-json-"));
    await writeFile(join(cwd, "config.json"), "{}\n", "utf8");
    const tools = registeredTools();

    await tools.codemod_update_json.execute("id", {
      path: "config.json",
      json_path: "compiler.options.strict",
      value: true,
    }, undefined, undefined, { cwd });
    expect(JSON.parse(await readFile(join(cwd, "config.json"), "utf8")).compiler.options.strict).toBe(true);

    await expect(tools.codemod_update_json.execute("id", {
      path: ".env",
      json_path: "x",
      value: "y",
    }, undefined, undefined, { cwd })).rejects.toThrow("blocked by safety policy");
  });

  test("codemod_add_import inserts missing TypeScript import and refuses duplicates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codemod-import-"));
    await writeFile(join(cwd, "x.ts"), "const value = makeThing();\n", "utf8");
    const tools = registeredTools();

    const dry = await tools.codemod_add_import.execute("id", {
      path: "x.ts",
      symbol: "makeThing",
      module: "./things",
      dry_run: true,
    }, undefined, undefined, { cwd });
    expect(dry.content[0].text).toContain("import { makeThing } from \"./things\";");
    expect(await readFile(join(cwd, "x.ts"), "utf8")).not.toContain("import");

    await tools.codemod_add_import.execute("id", {
      path: "x.ts",
      symbol: "makeThing",
      module: "./things",
    }, undefined, undefined, { cwd });
    expect(await readFile(join(cwd, "x.ts"), "utf8")).toBe("import { makeThing } from \"./things\";\nconst value = makeThing();\n");

    await expect(tools.codemod_add_import.execute("id", {
      path: "x.ts",
      symbol: "makeThing",
      module: "./things",
    }, undefined, undefined, { cwd })).rejects.toThrow("already imported");
  });

  test("codemod_insert_test_case appends or inserts test cases with dry-run support", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codemod-test-"));
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, "tests", "x.test.ts"), "import { describe, test } from \"bun:test\";\n\ndescribe(\"math\", () => {\n});\n", "utf8");
    const tools = registeredTools();

    const dry = await tools.codemod_insert_test_case.execute("id", {
      path: "tests/x.test.ts",
      describe_name: "math",
      test_name: "adds numbers",
      body: "expect(1 + 1).toBe(2);",
      dry_run: true,
    }, undefined, undefined, { cwd });
    expect(dry.content[0].text).toContain("test(\"adds numbers\"");
    expect(await readFile(join(cwd, "tests", "x.test.ts"), "utf8")).not.toContain("adds numbers");

    await tools.codemod_insert_test_case.execute("id", {
      path: "tests/x.test.ts",
      describe_name: "math",
      test_name: "adds numbers",
      body: "expect(1 + 1).toBe(2);",
    }, undefined, undefined, { cwd });
    const updated = await readFile(join(cwd, "tests", "x.test.ts"), "utf8");
    expect(updated).toContain("test(\"adds numbers\", () => {");
    expect(updated).toContain("expect(1 + 1).toBe(2);");
  });
});
