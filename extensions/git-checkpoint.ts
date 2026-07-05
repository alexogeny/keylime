/**
 * git-checkpoint — creates rollback commits before side-effectful tool calls.
 * Works in any git repo.
 *
 * Commands:
 *   /checkpoint        — manual checkpoint
 *   /undo              — hard-reset to the last checkpoint
 *   /checkpoint-log    — list checkpoints created this session
 *   /git-auth          — guided remote authentication setup
 *   /git-identity      — repo-local commit author identity setup
 *   /git-push          — confirmed non-interactive push
 *
 * Integrates with danger-guard: that extension checks for "git-checkpoint"
 * custom session entries to show a safety note in its confirmation dialogs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autoCheckpointMode, looksSideEffectfulBash, mutationScoreForTool, mutationScoreForToolResult, shouldAutoCheckpointTurn } from "./shared/safety-policy";
export { autoCheckpointMode, classifyToolMutation, classifyToolResultMutation, looksSideEffectfulBash, mutationScoreForTool, mutationScoreForToolResult, shouldAutoCheckpointTurn } from "./shared/safety-policy";

const CHECKPOINT_EXCLUDED_PATHS = [".pi"];

export function checkpointPathspecs(): string[] {
  return ["--", ".", ...CHECKPOINT_EXCLUDED_PATHS.map(path => `:!${path}`)];
}

export function checkpointAddArgs(): string[] {
  return ["add", "-u", ...checkpointPathspecs()];
}

export function checkpointAddCommand(): string {
  return ["git", ...checkpointAddArgs().map(arg => arg.startsWith(":!") ? `'${arg}'` : arg)].join(" ");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd });
}

export type GitAuthProvider = "github" | "gitlab" | "bitbucket" | "custom";
export type GitAuthMode = "ssh" | "https";

const GIT_AUTH_PROVIDERS: GitAuthProvider[] = ["github", "gitlab", "bitbucket", "custom"];
const GIT_AUTH_DEFAULT_HOSTS: Record<Exclude<GitAuthProvider, "custom">, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};
const GIT_AUTH_SSH_KEY_URLS: Record<Exclude<GitAuthProvider, "custom">, string> = {
  github: "https://github.com/settings/ssh/new",
  gitlab: "https://gitlab.com/-/user_settings/ssh_keys",
  bitbucket: "https://bitbucket.org/account/settings/ssh-keys/",
};
const GIT_AUTH_HTTPS_URLS: Record<Exclude<GitAuthProvider, "custom">, string> = {
  github: "https://github.com/settings/tokens",
  gitlab: "https://gitlab.com/-/user_settings/personal_access_tokens",
  bitbucket: "https://bitbucket.org/account/settings/app-passwords/",
};

export function normalizeGitAuthProvider(value: string): GitAuthProvider {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "gh" || normalized === "github") return "github";
  if (normalized === "gl" || normalized === "gitlab") return "gitlab";
  if (normalized === "bb" || normalized === "bitbucket") return "bitbucket";
  if (normalized === "custom" || normalized === "ssh") return "custom";
  throw new Error(`Unsupported git auth provider: ${value || "<empty>"}`);
}

export function validateGitAuthHost(host: string): string {
  const trimmed = String(host ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(trimmed)) throw new Error(`Unsafe Git auth host: ${host}`);
  if (trimmed.includes("..")) throw new Error(`Unsafe Git auth host: ${host}`);
  return trimmed;
}

export function gitAuthSshKeyPath(provider: GitAuthProvider, host = provider === "custom" ? "custom" : GIT_AUTH_DEFAULT_HOSTS[provider]): string {
  const safeHost = validateGitAuthHost(host).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || provider;
  return join(homedir(), ".ssh", `keylime_${safeHost}_ed25519`);
}

export function gitAuthSshTestCommand(provider: GitAuthProvider, host?: string): string {
  const target = provider === "custom" ? (host || "<git-host>") : `git@${host || GIT_AUTH_DEFAULT_HOSTS[provider]}`;
  return `ssh -T ${target}`;
}

function commandExists(command: string): boolean {
  try { execFileSync(command, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function runInteractive(cwd: string, command: string, args: string[]): void {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "1" } });
}

function openUrl(url: string): boolean {
  const attempts: Array<[string, string[]]> = process.platform === "darwin"
    ? [["open", [url]]]
    : process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : [["xdg-open", [url]], ["gio", ["open", url]]];
  for (const [command, args] of attempts) {
    try { execFileSync(command, args, { stdio: "ignore" }); return true; }
    catch {}
  }
  return false;
}

function generateSshKeyIfMissing(path: string, comment: string): boolean {
  if (existsSync(path) && existsSync(`${path}.pub`)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-t", "ed25519", "-C", comment, "-f", path, "-N", ""], { stdio: "ignore" });
  return true;
}

function publicKeyText(path: string): string {
  return readFileSync(`${path}.pub`, "utf8").trim();
}

function ensureSshConfigHost(host: string, keyPath: string): "added" | "updated" | "unchanged" {
  const safeHost = validateGitAuthHost(host);
  const configPath = join(homedir(), ".ssh", "config");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const hostLine = `Host ${safeHost}`;
  const start = lines.findIndex(line => line.trim() === hostLine);
  const desired = [`  HostName ${safeHost}`, "  User git", `  IdentityFile ${keyPath}`, "  IdentitiesOnly yes"];

  if (start === -1) {
    appendFileSync(configPath, `${current.trim() ? "\n" : ""}${hostLine}\n${desired.join("\n")}\n`, { mode: 0o600 });
    return "added";
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*Host\s+\S+/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const additions = desired.filter(line => !block.some(existing => existing.trim() === line.trim()));
  if (additions.length === 0) return "unchanged";

  lines.splice(end, 0, ...additions);
  writeFileSync(configPath, lines.join("\n"), { mode: 0o600 });
  return "updated";
}

function splitGitAuthArgs(args: string): { provider?: GitAuthProvider; mode?: GitAuthMode; host?: string } {
  const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const result: { provider?: GitAuthProvider; mode?: GitAuthMode; host?: string } = {};
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ssh" || lower === "https") result.mode = lower;
    else if (!result.provider) result.provider = normalizeGitAuthProvider(part);
    else result.host = part;
  }
  return result;
}

function splitNulPaths(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function stageCheckpointChangesForTest(cwd: string): void {
  stageCheckpointChanges(cwd);
}

function stageCheckpointChanges(cwd: string): void {
  // Stage tracked modifications/deletions, excluding volatile local Pi state.
  execFileSync("git", checkpointAddArgs(), { cwd });

  // Then stage only untracked files that Git itself says are non-ignored, again
  // excluding local Pi state. This avoids `git add -A` failing because ignored
  // files exist under .pi or other ignored directories.
  const untracked = splitNulPaths(gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...checkpointPathspecs()]));
  if (untracked.length > 0) execFileSync("git", ["add", "--", ...untracked], { cwd });
}

function validateCheckpointHash(hash: string): string {
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) throw new Error(`Unsafe checkpoint hash: ${hash}`);
  return hash;
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function getCurrentHash(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "HEAD"]); }
  catch { return null; }
}

function getCurrentBranch(cwd: string): string {
  try { return git(cwd, ["branch", "--show-current"]) || "HEAD"; }
  catch { return "unknown"; }
}

function hasChanges(cwd: string): boolean {
  try { return git(cwd, ["status", "--porcelain"]).length > 0; }
  catch { return false; }
}

interface Checkpoint {
  hash: string;
  branch: string;
  cwd: string;
  ts: string;
  hadChanges: boolean;
}

type CheckpointFailureReason = "not-git-repo" | "missing-identity" | "commit-failed" | "no-head";

interface CheckpointAttempt {
  checkpoint: Checkpoint | null;
  reason?: CheckpointFailureReason;
  error?: string;
}

interface GitIdentity {
  name: string;
  email: string;
}

function gitErrorText(error: unknown): string {
  const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return [e?.stderr, e?.stdout, e?.message].map(part => Buffer.isBuffer(part) ? part.toString("utf8") : String(part ?? "")).join("\n");
}

export function isMissingGitIdentityError(error: unknown): boolean {
  const text = gitErrorText(error).toLowerCase();
  return text.includes("author identity unknown") || text.includes("unable to auto-detect email address") || text.includes("please tell me who you are");
}

export function isGitPushAuthError(error: unknown): boolean {
  const text = gitErrorText(error).toLowerCase();
  return text.includes("could not read username")
    || text.includes("authentication failed")
    || text.includes("terminal prompts disabled")
    || text.includes("repository not found")
    || text.includes("permission denied");
}

function getConfiguredGitIdentity(cwd: string): Partial<GitIdentity> {
  const identity: Partial<GitIdentity> = {};
  try { identity.name = git(cwd, ["config", "--get", "user.name"]); } catch {}
  try { identity.email = git(cwd, ["config", "--get", "user.email"]); } catch {}
  return identity;
}

function validateGitIdentity(identity: Partial<GitIdentity>): GitIdentity {
  const name = String(identity.name ?? "").trim();
  const email = String(identity.email ?? "").trim();
  if (!name || name.length > 120 || /[\r\n\0]/.test(name)) throw new Error("Git user.name is required and must be a single line under 120 characters.");
  if (!email || email.length > 254 || /[\s\r\n\0]/.test(email) || !email.includes("@")) throw new Error("Git user.email must be a single email-like value.");
  return { name, email };
}

function setLocalGitIdentity(cwd: string, identity: GitIdentity): void {
  execFileSync("git", ["config", "--local", "user.name", identity.name], { cwd });
  execFileSync("git", ["config", "--local", "user.email", identity.email], { cwd });
}

async function configureGitIdentityWithUserGate(cwd: string, ctx: any, reason: string): Promise<boolean> {
  if (!ctx?.ui?.input || !ctx?.ui?.confirm) {
    ctx?.ui?.notify?.("Git commit identity is missing. Run `git config --local user.name` and `git config --local user.email`, or use a UI that supports prompts.", "error");
    return false;
  }

  const current = getConfiguredGitIdentity(cwd);
  let currentIdentity: GitIdentity | null = null;
  try { currentIdentity = validateGitIdentity(current); } catch {}

  if (currentIdentity) {
    const update = await ctx.ui.confirm(
      "Update local Git commit identity?",
      `This repository already has a local Git commit identity configured:\n\n  ${currentIdentity.name} <${currentIdentity.email}>\n\n/git-identity controls commit author name/email only. It does not configure Git push authentication.\n\nUpdate this repository's local commit identity?`,
      { timeout: 60_000 }
    );
    if (!update) return true;
  }

  const name = await ctx.ui.input("Git user.name", `${reason}\n\nName for local git commits in this repository:`, current.name ?? "");
  const email = await ctx.ui.input("Git user.email", "Email for local git commits in this repository:", current.email ?? "");

  let identity: GitIdentity;
  try {
    identity = validateGitIdentity({ name, email });
  } catch (error) {
    ctx.ui.notify(String((error as Error).message ?? error), "error");
    return false;
  }

  const ok = await ctx.ui.confirm(
    currentIdentity ? "Update local Git commit identity?" : "Configure local Git commit identity?",
    `This will run:\n\n  git config --local user.name ${JSON.stringify(identity.name)}\n  git config --local user.email ${JSON.stringify(identity.email)}\n\nThis changes only this repository's .git/config and affects commit authorship, not push authentication. Continue?`,
    { timeout: 60_000 }
  );
  if (!ok) return false;

  setLocalGitIdentity(cwd, identity);
  ctx.ui.notify(`${currentIdentity ? "Updated" : "Configured"} local Git commit identity as ${identity.name} <${identity.email}>`, "info");
  return true;
}

function makeCheckpointAttempt(cwd: string): CheckpointAttempt {
  if (!isGitRepo(cwd)) return { checkpoint: null, reason: "not-git-repo" };

  const branch = getCurrentBranch(cwd);
  const changed = hasChanges(cwd);

  if (changed) {
    try {
      stageCheckpointChanges(cwd);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      execFileSync("git", ["commit", "-m", `pi: checkpoint ${ts}`, "--no-verify", "--quiet"], { cwd });
    } catch (error) {
      return {
        checkpoint: null,
        reason: isMissingGitIdentityError(error) ? "missing-identity" : "commit-failed",
        error: gitErrorText(error),
      };
    }
  }

  const hash = getCurrentHash(cwd);
  if (!hash) return { checkpoint: null, reason: "no-head" };

  return {
    checkpoint: {
      hash,
      branch,
      cwd,
      ts: new Date().toISOString(),
      hadChanges: changed,
    },
  };
}

function makeCheckpoint(cwd: string): Checkpoint | null {
  return makeCheckpointAttempt(cwd).checkpoint;
}

export function validateGitRemoteName(remote: string): string {
  const trimmed = String(remote ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(trimmed)) throw new Error(`Unsafe git remote: ${remote}`);
  if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.includes("//")) throw new Error(`Unsafe git remote: ${remote}`);
  return trimmed;
}

function currentPushBranch(cwd: string): string {
  const branch = getCurrentBranch(cwd);
  if (!branch || branch === "HEAD" || branch === "unknown") throw new Error("Cannot push from detached HEAD; check out a branch first.");
  return branch;
}

function getUpstreamBranch(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); }
  catch { return null; }
}

function remoteExists(cwd: string, remote: string): boolean {
  try { git(cwd, ["remote", "get-url", validateGitRemoteName(remote)]); return true; }
  catch { return false; }
}

function pushCurrentBranch(cwd: string, remote = "origin"): { branch: string; upstream: string | null; command: string[]; output: string } {
  const safeRemote = validateGitRemoteName(remote);
  const branch = currentPushBranch(cwd);
  const upstream = getUpstreamBranch(cwd);
  if (!upstream && !remoteExists(cwd, safeRemote)) throw new Error(`Git remote not found: ${safeRemote}`);

  const args = upstream ? ["push"] : ["push", "-u", safeRemote, branch];
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  });
  return { branch, upstream, command: ["git", ...args], output: String(output ?? "") };
}

export function shouldCheckpointTool(toolName: string, input: any): boolean {
  return mutationScoreForTool(toolName, input) > 0;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track the most recent checkpoint in memory (also in session for danger-guard)
  let latestCheckpoint: Checkpoint | null = null;
  let mutationScoreThisTurn = 0;
  let lastAutoCheckpointAt = 0;

  function recordCheckpoint(cp: Checkpoint, ctx: any): void {
    latestCheckpoint = cp;
    pi.appendEntry("git-checkpoint", cp);
    const label = cp.hadChanges
      ? `📍 ${cp.hash.slice(0, 7)} (committed ${cp.branch})`
      : `📍 ${cp.hash.slice(0, 7)} (clean)`;
    ctx.ui.setStatus("checkpoint", label);
  }

  // ── Low-noise auto-checkpoint at end of agent turn ───────────────────────

  pi.on("input", async () => {
    mutationScoreThisTurn = 0;
  });

  pi.on("tool_result", async (event: any) => {
    if (event.isError) return;
    mutationScoreThisTurn += mutationScoreForToolResult(event);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const now = Date.now();
    if (!shouldAutoCheckpointTurn(mutationScoreThisTurn, lastAutoCheckpointAt, now, autoCheckpointMode())) return;

    const cwd = ctx.cwd;
    mutationScoreThisTurn = 0;
    if (!isGitRepo(cwd) || !hasChanges(cwd)) return;

    let attempt = makeCheckpointAttempt(cwd);
    if (!attempt.checkpoint && attempt.reason === "missing-identity") {
      lastAutoCheckpointAt = now;
      const configured = await configureGitIdentityWithUserGate(cwd, ctx, "Auto-checkpoint could not create a commit because Git does not know your commit identity.");
      if (!configured) return;
      attempt = makeCheckpointAttempt(cwd);
    }

    const cp = attempt.checkpoint;
    if (!cp?.hadChanges) return;
    lastAutoCheckpointAt = now;
    recordCheckpoint(cp, ctx);
  });

  // ── Restore checkpoint state across session restarts ────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const cpEntries = entries.filter(
      (e: any) => e.type === "custom" && e.customType === "git-checkpoint"
    );
    if (cpEntries.length > 0) {
      latestCheckpoint = (cpEntries[cpEntries.length - 1] as any).data as Checkpoint;
      if (latestCheckpoint) {
        lastAutoCheckpointAt = Date.parse(latestCheckpoint.ts) || 0;
        ctx.ui.setStatus("checkpoint", `📍 ${latestCheckpoint.hash.slice(0, 7)}`);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    latestCheckpoint = null;
  });

  // ── /git-auth ───────────────────────────────────────────────────────────

  pi.registerCommand("git-auth", {
    description: "Guide Git remote authentication setup for GitHub, GitLab, Bitbucket, or a custom SSH host",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("Not a git repository — cannot configure Git remote authentication.", "error");
        return;
      }
      if (!ctx?.ui?.confirm) {
        ctx.ui.notify("Cannot configure Git authentication without an explicit confirmation UI.", "error");
        return;
      }

      let parsed: { provider?: GitAuthProvider; mode?: GitAuthMode; host?: string };
      try {
        parsed = splitGitAuthArgs(String(args ?? ""));
      } catch (error) {
        ctx.ui.notify(String((error as Error).message ?? error), "error");
        return;
      }

      let provider = parsed.provider;
      if (!provider) {
        if (!ctx?.ui?.select) {
          ctx.ui.notify("Usage: /git-auth github|gitlab|bitbucket|custom [ssh|https] [custom-host]", "error");
          return;
        }
        provider = normalizeGitAuthProvider(await ctx.ui.select("Choose Git provider", [...GIT_AUTH_PROVIDERS]));
      }

      let mode = parsed.mode;
      if (!mode) {
        if (provider === "custom") mode = "ssh";
        else if (ctx?.ui?.select) mode = await ctx.ui.select("Choose Git authentication mode", ["ssh", "https"]) as GitAuthMode;
        else mode = "ssh";
      }

      const host = parsed.host || (provider === "custom" ? await ctx.ui.input?.("Custom Git SSH host", "Hostname for SSH, e.g. git.example.com:", "git.example.com") : GIT_AUTH_DEFAULT_HOSTS[provider]);
      try { if (host) validateGitAuthHost(host); } catch (error) {
        ctx.ui.notify(String((error as Error).message ?? error), "error");
        return;
      }
      if (provider === "custom" && !host) {
        ctx.ui.notify("Custom Git authentication requires a host, e.g. /git-auth custom ssh git.example.com", "error");
        return;
      }

      if (provider === "github" && commandExists("gh")) {
        const ok = await ctx.ui.confirm("Authenticate GitHub?", `This will run:\n\n  gh auth login --web --git-protocol ${mode}\n  gh auth setup-git\n\nGitHub CLI owns the browser login and credential storage. Continue?`, { timeout: 60_000 });
        if (!ok) return;
        try {
          runInteractive(cwd, "gh", ["auth", "login", "--web", "--git-protocol", mode]);
          runInteractive(cwd, "gh", ["auth", "setup-git"]);
          ctx.ui.notify("GitHub authentication configured via GitHub CLI.", "info");
          return;
        } catch (error) {
          ctx.ui.notify(`GitHub authentication failed: ${gitErrorText(error).trim() || String(error)}`, "error");
          return;
        }
      }

      if (provider === "gitlab" && commandExists("glab")) {
        const ok = await ctx.ui.confirm("Authenticate GitLab?", `This will run:\n\n  glab auth login --web --git-protocol ${mode}\n\nGitLab CLI owns the browser login and credential storage. Continue?`, { timeout: 60_000 });
        if (!ok) return;
        try {
          runInteractive(cwd, "glab", ["auth", "login", "--web", "--git-protocol", mode]);
          ctx.ui.notify("GitLab authentication configured via GitLab CLI.", "info");
          return;
        } catch (error) {
          ctx.ui.notify(`GitLab authentication failed: ${gitErrorText(error).trim() || String(error)}`, "error");
          return;
        }
      }

      if (mode === "https" && provider !== "custom") {
        const url = GIT_AUTH_HTTPS_URLS[provider];
        const ok = await ctx.ui.confirm("Open HTTPS credential setup?", `No supported provider CLI was detected for automatic browser login.\n\nThis will open:\n  ${url}\n\nUse Git Credential Manager or the provider's token/app-password flow for HTTPS Git credentials. Keylime will not ask for or store tokens. Continue?`, { timeout: 60_000 });
        if (!ok) return;
        const opened = openUrl(url);
        ctx.ui.notify(opened ? `Opened ${url}` : `Open this URL to configure HTTPS Git credentials: ${url}`, opened ? "info" : "warning");
        return;
      }

      const sshHost = host || (provider === "custom" ? "<git-host>" : GIT_AUTH_DEFAULT_HOSTS[provider]);
      const keyPath = gitAuthSshKeyPath(provider, sshHost);
      const keyOk = await ctx.ui.confirm("Set up SSH key for Git?", `This will create a dedicated ed25519 SSH key if missing and ensure ~/.ssh/config uses it for ${sshHost}:\n\n  ${keyPath}\n\nThen Keylime will show the public key so you can add it to ${provider === "custom" ? sshHost : provider}. Continue?`, { timeout: 60_000 });
      if (!keyOk) return;

      try {
        const created = generateSshKeyIfMissing(keyPath, `keylime-${provider}@${sshHost}`);
        const configStatus = ensureSshConfigHost(sshHost, keyPath);
        if (provider !== "custom") {
          const url = GIT_AUTH_SSH_KEY_URLS[provider];
          openUrl(url);
        }
        const pub = publicKeyText(keyPath);
        ctx.ui.notify(`${created ? "Created" : "Using existing"} SSH key:\n${keyPath}\n\nSSH config: ${configStatus} ~/.ssh/config entry for ${sshHost}.\n\nAdd this public key to your Git provider:\n${pub}\n\nTest with: ${gitAuthSshTestCommand(provider, sshHost)}`, "info");
      } catch (error) {
        ctx.ui.notify(`SSH authentication setup failed: ${gitErrorText(error).trim() || String(error)}`, "error");
      }
    },
  });

  // ── /git-identity ───────────────────────────────────────────────────────

  pi.registerCommand("git-identity", {
    description: "Configure this repository's local Git commit user.name and user.email after explicit confirmation",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("Not a git repository — cannot configure Git commit identity.", "error");
        return;
      }
      await configureGitIdentityWithUserGate(cwd, ctx, "Configure the identity Git will use for local commits in this repository.");
    },
  });

  // ── /git-push ────────────────────────────────────────────────────────────

  pi.registerCommand("git-push", {
    description: "Push the current branch to its upstream, or create/set the branch on origin after confirmation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.();
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("Not a git repository — cannot push.", "error");
        return;
      }
      if (!ctx?.ui?.confirm) {
        ctx.ui.notify("Cannot push without an explicit confirmation UI.", "error");
        return;
      }

      let branch: string;
      let remote: string;
      let upstream: string | null;
      try {
        remote = validateGitRemoteName(String(args ?? "").trim() || "origin");
        branch = currentPushBranch(cwd);
        upstream = getUpstreamBranch(cwd);
        if (!upstream && !remoteExists(cwd, remote)) throw new Error(`Git remote not found: ${remote}`);
      } catch (error) {
        ctx.ui.notify(String((error as Error).message ?? error), "error");
        return;
      }

      const command = upstream ? "git push" : `git push -u ${remote} ${branch}`;
      const dirtyNote = hasChanges(cwd) ? "\n\nNote: uncommitted local changes will not be pushed." : "";
      let commitIdentityNote = "\n\nCommit identity: not configured locally for this repository.";
      try {
        const identity = validateGitIdentity(getConfiguredGitIdentity(cwd));
        commitIdentityNote = `\n\nCommit identity: ${identity.name} <${identity.email}>`;
      } catch {}
      const authNote = "\n\nNote: /git-identity configures commit author identity only. Push authentication uses your Git remote credentials.";
      const ok = await ctx.ui.confirm(
        "Push current Git branch?",
        `Repository: ${cwd}\nBranch: ${branch}\n${upstream ? `Upstream: ${upstream}` : `No upstream configured; this will create/set ${remote}/${branch}.`}\n\nCommand:\n  ${command}${dirtyNote}${commitIdentityNote}${authNote}`,
        { timeout: 60_000 }
      );
      if (!ok) return;

      try {
        const pushed = pushCurrentBranch(cwd, remote);
        ctx.ui.notify(`Pushed ${pushed.branch}${pushed.upstream ? ` to ${pushed.upstream}` : ` and set upstream on ${remote}/${pushed.branch}`}.`, "info");
      } catch (error) {
        if (isGitPushAuthError(error)) {
          ctx.ui.notify("Git push failed because remote authentication is not configured. `/git-identity` only sets commit author name/email for this repo. Configure Git credentials, `gh auth login`, a credential helper/PAT, or use an SSH remote/key, then try `/git-push` again.", "error");
          return;
        }
        const text = gitErrorText(error).trim();
        ctx.ui.notify(`Git push failed: ${text.slice(0, 1000) || String(error)}`, "error");
      }
    },
  });

  // ── /checkpoint ─────────────────────────────────────────────────────────

  pi.registerCommand("checkpoint", {
    description: "Create a git checkpoint — commit current state for easy rollback with /undo",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("Not a git repository — nothing to checkpoint.", "error");
        return;
      }
      let attempt = makeCheckpointAttempt(cwd);
      if (!attempt.checkpoint && attempt.reason === "missing-identity") {
        const configured = await configureGitIdentityWithUserGate(cwd, ctx, "Checkpoint could not create a commit because Git does not know your identity.");
        if (configured) attempt = makeCheckpointAttempt(cwd);
      }

      const cp = attempt.checkpoint;
      if (!cp) {
        ctx.ui.notify(attempt.reason === "missing-identity" ? "Checkpoint cancelled: Git commit identity is still missing." : "Failed to create checkpoint.", "error");
        return;
      }
      recordCheckpoint(cp, ctx);
      ctx.ui.notify(
        `Checkpoint created: ${cp.hash.slice(0, 7)} on ${cp.branch}${cp.hadChanges ? " (changes committed)" : " (already clean)"}`,
        "info"
      );
    },
  });

  // ── /undo ────────────────────────────────────────────────────────────────

  pi.registerCommand("undo", {
    description: "Hard-reset to the last git checkpoint created this session",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (!latestCheckpoint) {
        ctx.ui.notify("No checkpoint in this session. Run /checkpoint first.", "error");
        return;
      }

      const { hash, branch, cwd, ts } = latestCheckpoint;
      const ok = await ctx.ui.confirm(
        "↩ Restore checkpoint?",
        `Reset to ${hash.slice(0, 7)} on ${branch}\nCreated: ${ts}\n\nAll uncommitted changes since then will be lost.`
      );
      if (!ok) return;

      try {
        execFileSync("git", ["reset", "--hard", validateCheckpointHash(hash)], { cwd });
        ctx.ui.notify(`Restored to checkpoint ${hash.slice(0, 7)} (${branch})`, "info");
        ctx.ui.setStatus("checkpoint", `↩ restored ${hash.slice(0, 7)}`);
        latestCheckpoint = null; // consumed
      } catch (e) {
        ctx.ui.notify(`Failed to restore: ${String(e)}`, "error");
      }
    },
  });

  // ── /checkpoint-log ──────────────────────────────────────────────────────

  pi.registerCommand("checkpoint-log", {
    description: "List all git checkpoints created in this session",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().filter(
        (e: any) => e.type === "custom" && e.customType === "git-checkpoint"
      );
      if (entries.length === 0) {
        ctx.ui.notify("No checkpoints in this session.", "info");
        return;
      }
      const lines = entries.map((e: any, i: number) => {
        const cp = e.data as Checkpoint;
        return `${i + 1}. ${cp.hash.slice(0, 7)} @ ${cp.branch} — ${cp.ts}`;
      });
      ctx.ui.notify(`Checkpoints this session:\n${lines.join("\n")}`, "info");
    },
  });
}
