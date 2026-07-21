import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import gitCheckpointExtension, { autoCheckpointMode, autoCheckpointSkipStatus, checkpointAddArgs, checkpointAddCommand, checkpointPathspecs, gitAuthSshKeyPath, gitAuthSshRemoteUrl, gitAuthSshTestCommand, isGitPushAuthError, isMissingGitIdentityError, looksSideEffectfulBash, mutationScoreForTool, mutationScoreForToolResult, normalizeGitAuthProvider, shouldAutoCheckpointTurn, shouldCheckpointTool, stageCheckpointChangesForTest, validateGitAuthHost, validateGitRemoteName } from "../extensions/git-checkpoint";

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

  test("staging always locally ignores and unstages .pi state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-checkpoint-ignore-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });

    await mkdir(join(cwd, ".pi", "usage"), { recursive: true });
    await writeFile(join(cwd, ".pi", "usage", "usage.ndjson"), "{}\n", "utf8");
    await writeFile(join(cwd, "tracked.txt"), "one\n", "utf8");

    execFileSync("git", ["add", "--force", ".pi/usage/usage.ndjson"], { cwd });
    stageCheckpointChangesForTest(cwd);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd }).toString();
    expect(staged).toContain("tracked.txt");
    expect(staged).not.toContain(".pi");
    expect(await readFile(join(cwd, ".git", "info", "exclude"), "utf8")).toContain(".pi/");
  });

  test("scoped staging handles tracked and new files without pathspec errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-checkpoint-scoped-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.ts"), "one\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
    await writeFile(join(cwd, "tracked.ts"), "two\n");
    await mkdir(join(cwd, "tests"), { recursive: true });
    await mkdir(join(cwd, "extensions", "shared"), { recursive: true });
    await writeFile(join(cwd, "tests", "performance-regressions.test.ts"), "test\n");
    await writeFile(join(cwd, "extensions", "shared", "bounded-top-k.ts"), "export {};\n");
    await writeFile(join(cwd, "unrelated.txt"), "leave unstaged\n");

    expect(() => stageCheckpointChangesForTest(cwd, [
      "tracked.ts",
      "tests/performance-regressions.test.ts",
      "extensions/shared/bounded-top-k.ts",
    ])).not.toThrow();
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd }).toString().trim().split("\n").sort();
    expect(staged).toEqual(["extensions/shared/bounded-top-k.ts", "tests/performance-regressions.test.ts", "tracked.ts"]);
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

  test("auto-checkpoint mode defaults to any and supports quieter overrides", () => {
    expect(autoCheckpointMode(undefined)).toBe("any");
    expect(autoCheckpointMode("off")).toBe("off");
    expect(autoCheckpointMode("major")).toBe("major");
    expect(autoCheckpointMode("any")).toBe("any");
  });

  test("describes mutating turns that intentionally remain uncommitted", () => {
    expect(autoCheckpointSkipStatus(0, "any")).toBeUndefined();
    expect(autoCheckpointSkipStatus(3, "off")).toBe("checkpoint off · 3 mutation points left uncommitted");
    expect(autoCheckpointSkipStatus(6, "major")).toBe("checkpoint deferred · score 6/8");
  });

  test("auto-checkpoint turn policy supports any, major, and off modes", () => {
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

  test("normalizes git-auth provider helpers", () => {
    expect(normalizeGitAuthProvider("gh")).toBe("github");
    expect(normalizeGitAuthProvider("GitLab")).toBe("gitlab");
    expect(normalizeGitAuthProvider("bb")).toBe("bitbucket");
    expect(normalizeGitAuthProvider("custom")).toBe("custom");
    expect(() => normalizeGitAuthProvider("sourcehut")).toThrow("Unsupported git auth provider");
    expect(gitAuthSshKeyPath("github", "github.com")).toContain("keylime_github.com_ed25519");
    expect(validateGitAuthHost("git.example.com")).toBe("git.example.com");
    expect(() => validateGitAuthHost("bad host\nHost evil")).toThrow("Unsafe Git auth host");
    expect(gitAuthSshKeyPath("custom", "git.example.com")).toContain("keylime_git.example.com_ed25519");
    expect(gitAuthSshTestCommand("github")).toBe("ssh -T git@github.com");
    expect(gitAuthSshTestCommand("bitbucket")).toBe("ssh -T git@bitbucket.org");
    expect(gitAuthSshTestCommand("custom", "git.example.com")).toBe("ssh -T git.example.com");
  });

  test("converts provider HTTPS remotes to SSH", () => {
    expect(gitAuthSshRemoteUrl("github", "https://github.com/alexogeny/keylime")).toBe("git@github.com:alexogeny/keylime.git");
    expect(gitAuthSshRemoteUrl("github", "https://github.com/alexogeny/keylime.git")).toBe("git@github.com:alexogeny/keylime.git");
    expect(gitAuthSshRemoteUrl("github", "https://user@github.com/alexogeny/keylime/")).toBe("git@github.com:alexogeny/keylime.git");
    expect(gitAuthSshRemoteUrl("gitlab", "https://gitlab.com/group/sub/project")).toBe("git@gitlab.com:group/sub/project.git");
    expect(gitAuthSshRemoteUrl("bitbucket", "https://bitbucket.org/team/repo.git")).toBe("git@bitbucket.org:team/repo.git");
    // Already SSH, wrong host, or unrelated URLs return null.
    expect(gitAuthSshRemoteUrl("github", "git@github.com:alexogeny/keylime.git")).toBeNull();
    expect(gitAuthSshRemoteUrl("github", "https://gitlab.com/alexogeny/keylime")).toBeNull();
    expect(gitAuthSshRemoteUrl("github", "https://evil.com/github.com/x")).toBeNull();
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

  test("git-push plans HTTPS to SSH remote switch when no native provider auth tool is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keylime-push-ssh-plan-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://bitbucket.org/team/repo"], { cwd });
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();

    const commands: Record<string, any> = {};
    gitCheckpointExtension({
      on: () => {},
      registerCommand: (name: string, command: any) => { commands[name] = command; },
      appendEntry: () => {},
    } as any);

    const ctx = {
      cwd,
      waitForIdle: async () => {},
      ui: {
        confirm: async (_title: string, message: string) => {
          expect(message).toContain(`git push -u origin ${branch}`);
          expect(message).toContain("will switch origin to SSH before push");
          expect(message).toContain("git remote set-url origin git@bitbucket.org:team/repo.git");
          return false;
        },
        notify: () => {},
        setStatus: () => {},
      },
      sessionManager: { getEntries: () => [] },
    };

    await commands["git-push"].handler("", ctx);

    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd }).toString().trim()).toBe("https://bitbucket.org/team/repo");
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
  test("builds path-scoped staging arguments for known changed files", () => {
    expect(checkpointAddArgs(["src/a.ts", "docs/readme.md"])).toEqual(["add", "-u", "--", "src/a.ts", "docs/readme.md"]);
    expect(checkpointAddArgs([".pi/state.json", "src/a.ts"])).toEqual(["add", "-u", "--", "src/a.ts"]);
  });
});
