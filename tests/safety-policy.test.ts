import { describe, expect, test } from "bun:test";
import { classifyToolMutation, mutationScoreForTool, runChecksCommandBlockReason } from "../extensions/shared/safety-policy";

describe("central mutation classification", () => {
  test("classifies read-only tools as non-mutating", () => {
    const c = classifyToolMutation("inspect_lines", { path: "src/a.ts" });
    expect(c).toMatchObject({ mutates: false, category: "readonly", severity: "none", score: 0, allowed: true, checkpointScore: "none" });
    expect(c.reasons).toEqual([]);
  });

  test("classifies targeted and broad replacements with checkpoint severity", () => {
    const targeted = classifyToolMutation("apply_code_replacements", { edits: [{ path: "src/a.ts" }] });
    expect(targeted).toMatchObject({ mutates: true, category: "file_replace", severity: "medium", score: 3, checkpointScore: "minor" });

    const broad = classifyToolMutation("apply_code_replacements", { file_glob: "src/**/*.ts", edits: [] });
    expect(broad).toMatchObject({ mutates: true, category: "file_replace", severity: "high", score: 8, requiresConfirmation: true, checkpointScore: "major" });
  });

  test("classifies create operations and keeps mutationScoreForTool compatible", () => {
    expect(classifyToolMutation("create_file", { path: "src/new.ts" })).toMatchObject({ category: "file_create", score: 2 });
    expect(classifyToolMutation("create_directory", { path: "src/new" })).toMatchObject({ category: "directory_create", score: 1 });
    expect(mutationScoreForTool("create_file", { path: "src/new.ts" })).toBe(2);
  });

  test("classifies shell runtime eval, shell mutation, and git mutation", () => {
    expect(classifyToolMutation("bash", { command: "node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'" })).toMatchObject({ category: "runtime_eval", score: 8 });
    expect(classifyToolMutation("bash", { command: "mkdir tmp" })).toMatchObject({ category: "shell_mutation", score: 8 });
    expect(classifyToolMutation("bash", { command: "git commit -m x" })).toMatchObject({ category: "git_mutation", score: 8 });
  });

  test("escalates protected paths and marks them disallowed", () => {
    const c = classifyToolMutation("create_file", { path: ".env" });
    expect(c).toMatchObject({ category: "protected_path", severity: "critical", score: 10, allowed: false, checkpointScore: "major" });
    expect(c.matchedPolicies).toContain("mutation.protected-path");
  });

  test("run_checks still blocks runtime and shell-string bypasses", () => {
    expect(runChecksCommandBlockReason("bash", ["-c", "echo hi"])).toContain("command string");
    expect(runChecksCommandBlockReason("python", ["-c", "print(1)"])).toContain("inline execution");
    expect(runChecksCommandBlockReason("bun", ["test", "tests"])).toBeNull();
  });

  test.each([
    ["sh", ["-c", "echo hi"]],
    ["zsh", ["-c", "echo hi"]],
    ["fish", ["-c", "echo hi"]],
    ["bash", ["-lc", "echo hi"]],
  ])("run_checks blocks shell command strings through %s", (command, args) => {
    expect(runChecksCommandBlockReason(command, args)).toContain("command string");
  });

  test.each([
    ["node", ["-e", "console.log(1)"]],
    ["bun", ["-e", "console.log(1)"]],
    ["python", ["-c", "print(1)"]],
    ["python3", ["-c", "print(1)"]],
    ["perl", ["-e", "print 1"]],
    ["ruby", ["-e", "puts 1"]],
    ["deno", ["eval", "console.log(1)"]],
  ])("run_checks blocks inline runtime execution through %s", (command, args) => {
    expect(runChecksCommandBlockReason(command, args)).toMatch(/inline execution|deno eval/);
  });

  test.each([
    ["npm install left-pad"],
    ["pnpm add zod"],
    ["yarn add zod"],
    ["bun add zod"],
    ["cargo add serde"],
    ["pip install requests"],
  ])("classifies package-manager side effects: %s", (command) => {
    const c = classifyToolMutation("bash", { command });
    expect(c.mutates).toBe(true);
    expect(c.score).toBeGreaterThanOrEqual(8);
  });

  test.each([
    ["cat > file.ts"],
    ["printf hi >> file.ts"],
    ["grep foo src 2> errors.log"],
    ["echo hi &> all.log"],
    ["cat <<EOF\nhello\nEOF"],
    ["tee output.txt"],
    ["true && rm file.ts"],
    ["echo ok; touch file.ts"],
    ["git reset --hard"],
  ])("classifies shell mutation form: %s", (command) => {
    const c = classifyToolMutation("bash", { command });
    expect(c.mutates).toBe(true);
    expect(c.score).toBeGreaterThanOrEqual(8);
    expect(c.requiresConfirmation).toBe(true);
  });

  test.each([
    ["./.env"],
    ["src/../.env"],
    [".git/../.env"],
    [".git\\hooks\\post-commit"],
    [".env.local"],
    [".git/hooks/post-commit"],
    ["node_modules/pkg/index.js"],
  ])("classifies normalized protected path: %s", (path) => {
    const c = classifyToolMutation("create_file", { path });
    expect(c.category).toBe("protected_path");
    expect(c.allowed).toBe(false);
  });

  test("classifies multi-edit protected replacement even when other edits are safe", () => {
    const c = classifyToolMutation("apply_code_replacements", {
      edits: [
        { path: "src/safe.ts", oldText: "a", newText: "b" },
        { path: ".env", oldText: "a", newText: "b" },
      ],
    });
    expect(c.category).toBe("protected_path");
    expect(c.writePaths).toContain(".env");
  });
});
