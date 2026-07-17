import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCheckpointAttemptForTest, reviewCheckpointMessage } from "../extensions/git-checkpoint";
import {
  buildCheckpointPrompt,
  checkpointApprovalMode,
  deterministicCheckpointMessage,
  parseCheckpointMessage,
  parseEditedCheckpointMessage,
  redactCheckpointText,
} from "../extensions/shared/checkpoint-message";

describe("semantic checkpoint messages", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("builds a meaningful deterministic fallback from changed paths", () => {
    expect(deterministicCheckpointMessage({
      userRequest: "Improve checkpoint commit messages",
      assistantSummary: "Implemented semantic generation and approval UI.",
      changedPaths: ["extensions/git-checkpoint.ts", "extensions/shared/checkpoint-message.ts", "tests/checkpoint-message.test.ts"],
      diffStat: "3 files changed, 120 insertions(+)",
    })).toEqual({
      subject: "feat(checkpoint): implement semantic generation and approval ui",
      body: "- Update git-checkpoint and checkpoint-message\n- Add checkpoint-message coverage\n\nKeylime-Checkpoint: true",
      source: "deterministic",
    });
  });

  test("uses completed work rather than parroting a vague user request", () => {
    const message = deterministicCheckpointMessage({
      userRequest: "please implement these using tests to prove the thesis",
      assistantSummary: "Implemented bounded top-K retrieval and batched PDF rendering.",
      changedPaths: ["extensions/shared/retrieval/bm25.ts", "extensions/document-primitives.ts", "tests/performance-regressions.test.ts"],
    });
    expect(message.subject).toBe("perf: implement bounded top-k retrieval and batched pdf rendering");
    expect(message.subject).not.toContain("please");
    expect(message.subject).not.toContain("chore(checkpoint)");
  });

  test("parses and sanitizes fenced model JSON", () => {
    const parsed = parseCheckpointMessage('```json\n{"subject":"feat(checkpoints): add semantic names\\nignored","body":["Generate useful subjects","Let users edit drafts"]}\n```');
    expect(parsed).toEqual({
      subject: "feat(checkpoints): add semantic names ignored",
      body: "- Generate useful subjects\n- Let users edit drafts\n\nKeylime-Checkpoint: true",
      source: "llm",
    });
  });

  test("rejects malformed or generic model output", () => {
    expect(parseCheckpointMessage("not json")).toBeNull();
    expect(parseCheckpointMessage('{"subject":"pi: checkpoint","body":[]}')).toBeNull();
  });

  test("redacts likely secrets and marks repository text as untrusted", () => {
    const prompt = buildCheckpointPrompt({
      userRequest: "Use token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      assistantSummary: "Updated auth handling",
      changedPaths: ["src/auth.ts"],
      diffStat: "API_KEY=super-secret-value",
    });
    expect(prompt).toContain("untrusted repository and conversation data");
    expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(prompt).not.toContain("super-secret-value");
    expect(redactCheckpointText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: [REDACTED]");
  });

  test("parses a user-edited subject and body", () => {
    expect(parseEditedCheckpointMessage("fix(router): preserve routes\n\nKeep explicit route precedence.\n\nKeylime-Checkpoint: false")).toEqual({
      subject: "fix(router): preserve routes",
      body: "Keep explicit route precedence.\n\nKeylime-Checkpoint: true",
      source: "edited",
    });
    expect(parseEditedCheckpointMessage("\n\n")).toBeNull();
  });

  test("defaults TUI approval to always and supports explicit modes", () => {
    expect(checkpointApprovalMode(undefined)).toBe("always");
    expect(checkpointApprovalMode("manual")).toBe("manual");
    expect(checkpointApprovalMode("never")).toBe("never");
    expect(checkpointApprovalMode("unexpected")).toBe("always");
  });

  test("lets TUI users edit and then approve a checkpoint draft", async () => {
    const choices = ["Edit message", "Approve and commit"];
    const notifications: string[] = [];
    const result = await reviewCheckpointMessage({
      subject: "chore(checkpoint): initial draft",
      body: "- Initial body\n\nKeylime-Checkpoint: true",
      source: "deterministic",
    }, {
      hasUI: true,
      mode: "tui",
      ui: {
        select: async () => choices.shift(),
        editor: async () => "feat(checkpoints): approve semantic drafts\n\n- Add an editable TUI review step",
        notify: (message: string) => notifications.push(message),
      },
    }, false);

    expect(result).toEqual({
      subject: "feat(checkpoints): approve semantic drafts",
      body: "- Add an editable TUI review step\n\nKeylime-Checkpoint: true",
      source: "edited",
    });
    expect(notifications).toEqual([]);
  });

  test("commits the reviewed semantic subject and body", () => {
    const cwd = mkdtempSync(join(tmpdir(), "keylime-checkpoint-message-"));
    tempDirs.push(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["config", "user.name", "Keylime Test"], { cwd });
    execFileSync("git", ["config", "user.email", "keylime@example.test"], { cwd });
    writeFileSync(join(cwd, "feature.txt"), "semantic checkpoints\n");

    const attempt = makeCheckpointAttemptForTest(cwd, undefined, {
      subject: "feat(checkpoints): save reviewed metadata",
      body: "- Commit the approved TUI draft\n\nKeylime-Checkpoint: true",
      source: "edited",
    });
    expect(attempt.checkpoint?.subject).toBe("feat(checkpoints): save reviewed metadata");
    const commit = execFileSync("git", ["log", "-1", "--format=%s%n%b"], { cwd }).toString();
    expect(commit).toContain("feat(checkpoints): save reviewed metadata");
    expect(commit).toContain("- Commit the approved TUI draft");
    expect(commit).toContain("Keylime-Checkpoint: true");
  });

  test("lets TUI users skip a checkpoint without committing", async () => {
    const result = await reviewCheckpointMessage({
      subject: "chore(checkpoint): initial draft",
      body: "Keylime-Checkpoint: true",
      source: "deterministic",
    }, {
      hasUI: true,
      mode: "tui",
      ui: { select: async () => "Skip checkpoint" },
    }, false);
    expect(result).toBeNull();
  });
});
