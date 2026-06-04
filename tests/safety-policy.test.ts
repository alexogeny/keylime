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
});
