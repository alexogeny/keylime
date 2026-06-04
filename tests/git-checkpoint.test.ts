import { describe, expect, test } from "bun:test";
import { checkpointAddCommand, looksSideEffectfulBash, shouldAutoCheckpointTool, shouldCheckpointTool } from "../extensions/git-checkpoint";

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

  test("checkpoint staging excludes pi usage logs", () => {
    expect(checkpointAddCommand()).toContain("git add -A --");
    expect(checkpointAddCommand()).toContain("':!.pi/usage/usage.ndjson'");
  });

  test("auto-checkpoint runs only once per user input", () => {
    expect(shouldAutoCheckpointTool("create_file", { path: "x" }, false)).toBe(true);
    expect(shouldAutoCheckpointTool("create_file", { path: "x" }, true)).toBe(false);
    expect(shouldAutoCheckpointTool("code_search", { query: "x" }, false)).toBe(false);
  });
});
