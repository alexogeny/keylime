import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});

function registeredCodePrimitiveTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  codePrimitivesExtension({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("code primitive extension tools", () => {
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
  test("normalized_whitespace replaces equivalent text across line breaks", () => {
    const plan = planReplacement("const x = 1;\nconst y = 2;", {
      path: "x.ts",
      oldText: "const x = 1; const y = 2;",
      newText: "const z = 3;",
      matchMode: "normalized_whitespace",
    });

    expect(plan.after).toBe("const z = 3;");
    expect(plan.replacements).toBe(1);
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
