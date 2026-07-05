import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import gitCheckpointExtension, { autoCheckpointMode, checkpointAddArgs, checkpointAddCommand, checkpointPathspecs, isGitPushAuthError, isMissingGitIdentityError, looksSideEffectfulBash, mutationScoreForTool, mutationScoreForToolResult, shouldAutoCheckpointTurn, shouldCheckpointTool, stageCheckpointChangesForTest, validateGitRemoteName } from "../extensions/git-checkpoint";

describe("git checkpoint tool gating", () => {
  test("checkpoints file-writing tools", () => {
    expect(shouldCheckpointTool("write", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("edit", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("create_file", { path: "x" })).toBe(true);
    expect(shouldCheckpointTool("begin_file_write", { path: "x" })).toBe(false);
    expect(mutationScoreForToolResult({ toolName: "finish_file_write", details: { path: "x.ts" } })).toBe(2);
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
    expect(checkpointPathspecs()).toEqual(["--", ".", ":!.pi"]);
    expect(checkpointAddArgs()).toEqual(["add", "-u", "--", ".", ":!.pi"]);
    expect(checkpointAddCommand()).toContain("git add -u -- .");
    expect(checkpointAddCommand()).toContain("':!.pi'");
  });

  test("staging ignores .pi even when ignored files exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-checkpoint-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });

    await writeFile(join(cwd, ".gitignore"), ".pi/\n", "utf8");
    await writeFile(join(cwd, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });

    await writeFile(join(cwd, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(cwd, "new.txt"), "new\n", "utf8");
    await mkdir(join(cwd, ".pi", "usage"), { recursive: true });
    await writeFile(join(cwd, ".pi", "usage", "usage.ndjson"), "{}\n", "utf8");

    expect(() => stageCheckpointChangesForTest(cwd)).not.toThrow();
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd }).toString();
    expect(staged).toContain("tracked.txt");
    expect(staged).toContain("new.txt");
    expect(staged).not.toContain(".pi");
    expect(await readFile(join(cwd, ".pi", "usage", "usage.ndjson"), "utf8")).toBe("{}\n");
  });

  test("scores mutations for low-noise auto-checkpointing", () => {
    expect(mutationScoreForTool("create_directory", { path: "x" })).toBe(1);
    expect(mutationScoreForTool("create_file", { path: "x" })).toBe(2);
    expect(mutationScoreForTool("apply_code_replacements", { edits: [{ path: "x" }] })).toBe(3);
    expect(mutationScoreForTool("apply_code_replacements", { file_glob: "src/**/*.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe(8);
    expect(mutationScoreForTool("bash", { command: "mkdir x" })).toBe(8);
    expect(mutationScoreForTool("begin_file_write", { path: "src/x.ts" })).toBe(0);
    expect(mutationScoreForToolResult({ toolName: "finish_file_write", details: { path: "src/x.ts" } })).toBe(2);
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

  test("detects missing git identity errors", () => {
    expect(isMissingGitIdentityError({ stderr: "Author identity unknown\n*** Please tell me who you are." })).toBe(true);
    expect(isMissingGitIdentityError({ stderr: "fatal: unable to auto-detect email address" })).toBe(true);
    expect(isMissingGitIdentityError({ stderr: "fatal: not a git repository" })).toBe(false);
  });

  test("detects git push authentication errors", () => {
    expect(isGitPushAuthError({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" })).toBe(true);
    expect(isGitPushAuthError({ stderr: "remote: Repository not found." })).toBe(true);
    expect(isGitPushAuthError({ stderr: "Permission denied (publickey)." })).toBe(true);
    expect(isGitPushAuthError({ stderr: "fatal: not a git repository" })).toBe(false);
  });

  test("validates git remote names for push", () => {
    expect(validateGitRemoteName("origin")).toBe("origin");
    expect(validateGitRemoteName("team/upstream-1")).toBe("team/upstream-1");
    expect(() => validateGitRemoteName("origin;rm -rf .")).toThrow("Unsafe git remote");
    expect(() => validateGitRemoteName("../origin")).toThrow("Unsafe git remote");
  });

  test("git-identity command requires prompt values and explicit confirmation before configuring local repo", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-identity-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });

    const commands: Record<string, any> = {};
    gitCheckpointExtension({
      on: () => {},
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: () => {},
    } as any);

    const prompts: string[] = [];
    const notifications: string[] = [];
    const ctx = {
      cwd,
      ui: {
        input: async (title: string) => {
          prompts.push(title);
          return title.includes("email") ? "agent@example.com" : "Keylime Agent";
        },
        confirm: async (_title: string, message: string) => {
          expect(message).toContain("git config --local user.name");
          expect(message).toContain("git config --local user.email");
          return true;
        },
        notify: (text: string) => notifications.push(text),
        setStatus: () => {},
      },
      sessionManager: { getEntries: () => [] },
    };

    await commands["git-identity"].handler("", ctx);

    expect(prompts).toEqual(["Git user.name", "Git user.email"]);
    expect(execFileSync("git", ["config", "--local", "user.name"], { cwd }).toString().trim()).toBe("Keylime Agent");
    expect(execFileSync("git", ["config", "--local", "user.email"], { cwd }).toString().trim()).toBe("agent@example.com");
    expect(notifications.join("\n")).toContain("Configured local Git commit identity");
  });

  test("git-identity warns and asks before updating an existing local commit identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-identity-update-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "--local", "user.name", "Existing User"], { cwd });
    execFileSync("git", ["config", "--local", "user.email", "existing@example.com"], { cwd });

    const commands: Record<string, any> = {};
    gitCheckpointExtension({
      on: () => {},
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: () => {},
    } as any);

    const prompts: Array<{ title: string; initial?: string }> = [];
    const confirms: string[] = [];
    const notifications: string[] = [];
    const ctx = {
      cwd,
      ui: {
        input: async (title: string, _message: string, initial?: string) => {
          prompts.push({ title, initial });
          return title.includes("email") ? "updated@example.com" : "Updated User";
        },
        confirm: async (_title: string, message: string) => {
          confirms.push(message);
          return true;
        },
        notify: (text: string) => notifications.push(text),
        setStatus: () => {},
      },
      sessionManager: { getEntries: () => [] },
    };

    await commands["git-identity"].handler("", ctx);

    expect(confirms[0]).toContain("already has a local Git commit identity configured");
    expect(confirms[0]).toContain("Existing User <existing@example.com>");
    expect(confirms[0]).toContain("does not configure Git push authentication");
    expect(confirms[1]).toContain("affects commit authorship, not push authentication");
    expect(prompts).toEqual([
      { title: "Git user.name", initial: "Existing User" },
      { title: "Git user.email", initial: "existing@example.com" },
    ]);
    expect(execFileSync("git", ["config", "--local", "user.name"], { cwd }).toString().trim()).toBe("Updated User");
    expect(execFileSync("git", ["config", "--local", "user.email"], { cwd }).toString().trim()).toBe("updated@example.com");
    expect(notifications.join("\n")).toContain("Updated local Git commit identity");
  });

  test("git-push requires confirmation and creates upstream branch on remote", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-push-work-"));
    const remote = await mkdtemp(join(tmpdir(), "keylime-push-remote-"));
    execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd });
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();

    const commands: Record<string, any> = {};
    gitCheckpointExtension({
      on: () => {},
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: () => {},
    } as any);

    const notifications: string[] = [];
    const ctx = {
      cwd,
      waitForIdle: async () => {},
      ui: {
        confirm: async (_title: string, message: string) => {
          expect(message).toContain(`git push -u origin ${branch}`);
          expect(message).toContain("Commit identity: Test <test@example.com>");
          expect(message).toContain("/git-identity configures commit author identity only");
          expect(message).toContain("Push authentication uses your Git remote credentials");
          return true;
        },
        notify: (text: string) => notifications.push(text),
        setStatus: () => {},
      },
      sessionManager: { getEntries: () => [] },
    };

    await commands["git-push"].handler("", ctx);

    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd }).toString().trim()).toBe(`origin/${branch}`);
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).toString().trim()).toHaveLength(40);
    expect(notifications.join("\n")).toContain("Pushed");
  });
});
