import { describe, expect, test } from "bun:test";
import { autoCheckpointMode, checkpointAddArgs, checkpointAddCommand, looksSideEffectfulBash, mutationScoreForTool, shouldAutoCheckpointTurn, shouldCheckpointTool } from "../extensions/git-checkpoint";

describe("git checkpoint tool gating", () => {
  test("checkpoints file-writing tools", () => {
    expect(shouldCheckpointTool("write", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("edit", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("create_file", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("create_directory", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("apply_code_replacements", { edits: [{ path: "x" }] })).toBe(true);
    expect(shouldCheckpointTool("apply_code_replacements", { dry_run: true, edits: [{ path: "x" }] })).toBe(false);
  });

  test("does not checkpoint read-only tools", () => {
    expect(shouldCheckpointTool("read", { path: "x" })).toBe(false);
    expect(shouldCheckpointTool("code_search", { query: "x" })).toBe(false);
  });

  test("detects side-effectful bash commands", () => {
    expect(looksSideEffectfulBash("mkdir -p tmp && touch tmp/a")).toBe(true);
    expect(looksSideEffectfulBash("git add -A && git commit -m test")).toBe(true);
    expect(looksSideEffectfulBash("python scripts/generate.py")).toBe(true);
  });

  test("ignores obviously read-only bash commands", () => {
    expect(looksSideEffectfulBash("ls -la")).toBe(false);
    expect(looksSideEffectfulBash("rg foo src")).toBe(false);
    expect(looksSideEffectfulBash("git status --short")).toBe(false);
  });

  test("checkpoint staging excludes pi local state", () => {
    expect(checkpointAddArgs()).toEqual(["add", "-A", "--", ".", ":!.pi"]);
    expect(checkpointAddCommand()).toContain("git add -A -- .");
    expect(checkpointAddCommand()).toContain("':!.pi'");
  });

  test("scores mutations for low-noise auto-checkpointing", () => {
    expect(mutationScoreForTool("create_directory", { path: "x" })).toBe(1);
    expect(mutationScoreForTool("create_file", { path: "x" })).toBe(2);
    expect(mutationScoreForTool("apply_code_replacements", { edits: [{ path: "x" }] })).toBe(3);
    expect(mutationScoreForTool("apply_code_replacements", { file_glob: "src/**/*.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe(8);
    expect(mutationScoreForTool("bash", { command: "mkdir x" })).toBe(8);
    expect(mutationScoreForTool("code_search", { query: "x" })).toBe(0);
  });

  test("auto-checkpoint mode defaults to major and supports overrides", () => {
    expect(autoCheckpointMode(undefined)).toBe("major");
    expect(autoCheckpointMode("off")).toBe("off");
    expect(autoCheckpointMode("any")).toBe("any");
  });

  test("auto-checkpoint turn policy is low noise by default", () => {
    const now = 1_000_000;
    expect(shouldAutoCheckpointTurn(0, 0, now, "major")).toBe(false);
    expect(shouldAutoCheckpointTurn(2, now - 1_000, now, "major")).toBe(false);
    expect(shouldAutoCheckpointTurn(8, now - 1_000, now, "major")).toBe(true);
    expect(shouldAutoCheckpointTurn(2, now - 46 * 60 * 1000, now, "major")).toBe(true);
    expect(shouldAutoCheckpointTurn(2, now - 1_000, now, "any")).toBe(true);
    expect(shouldAutoCheckpointTurn(8, now - 46 * 60 * 1000, now, "off")).toBe(false);
  });
});
