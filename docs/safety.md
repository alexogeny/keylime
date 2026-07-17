# Safety model

{% include nav.md %}

Keylime's safety model is built around runtime enforcement rather than relying only on prompt text. The pie should be tart; the agent should not be allowed to freestyle with `rm`, raw git, or shell redirection.

## Safe mutation path

Repository file changes should use:

- `create_directory` for new directories,
- `create_file` for new files,
- `plan_code_replacements` for previews,
- `apply_code_replacements` for existing-file edits,
- `run_checks` for verification.

Raw shell or native-runtime file mutation is blocked or discouraged.

Repository inspection should use `list_files` for discovery, `inspect_text_matches` instead of `grep`/`rg`, `inspect_json` instead of `jq`/`cat`/built-in `read`, and `inspect_lines` only after focused search/context discovery. `inspect_lines` is capped at 200 lines.

## Locked and guarded tools

Built-in `read`, `write`, and `edit` are blocked in coding mode. Raw `bash` is routed and guarded.

Coding-mode danger guard also blocks native repo inspection through `bash`: `ls`, `find`, `grep`, `egrep`, `fgrep`, `rg`, `jq`, `cat`, `head`, `tail`, and `wc`.

Dangerous shell patterns include:

- output redirection and heredocs,
- `tee` writes,
- `sed -i`, `perl -pi`, `ruby -pi`,
- `python -c`, `node -e`, `bun -e`, `deno eval` file writes,
- `mkdir`, `touch`, `rm`, `cp`, `mv`, `chmod`, `chown`,
- shell command strings such as `bash -c`.

## Git policy

Commits should happen only through checkpointing. Do not use raw git mutation commands such as:

- `git add`
- `git commit`
- `git reset`
- `git restore`
- `git checkout`
- `git switch`
- `git clean`
- `git rebase`
- `git merge`
- `git push`
- `git stash`

Use read-only git inspection tools instead:

- `git_status`
- `git_diff`
- `commit_history`
- `see_file_commit_history`
- `inspect_at_checkpoint`

## Checkpointing

`git-checkpoint.ts` supports explicit `/checkpoint` and low-noise auto-checkpointing.

Auto-checkpoint modes:

- `KEYLIME_AUTO_CHECKPOINT=off` — manual only.
- `KEYLIME_AUTO_CHECKPOINT=major` — default; checkpoint only major mutating turns or small changes after a long interval.
- `KEYLIME_AUTO_CHECKPOINT=any` — checkpoint after any mutating turn.

Auto-checkpoints happen at `agent_end` based on successful tool results and mutation scores. Local `.pi` state is excluded from checkpoint staging.

Checkpoint messages default to `KEYLIME_CHECKPOINT_MESSAGES=metadata-only`: the active Pi model receives bounded, redacted conversation and change metadata but no source patch. Use `semantic` to opt into a bounded redacted diff excerpt or `deterministic` to disable the provider request. Model output is redacted again before commit; errors and timeouts fall back locally.

In Pi's TUI, `KEYLIME_CHECKPOINT_APPROVAL=always` is the default. Each automatic or manual draft can be approved, edited as a complete Git commit message, or skipped before staging. Set it to `manual` to review only `/checkpoint`, or `never` to commit drafts without review. Non-interactive modes cannot display a review and proceed with the generated or fallback message.

## Protected paths

Danger guard prompts before writes to sensitive paths such as:

- `.env*`
- `.git/`
- `node_modules/`
- `~/.ssh/`
- `~/.gnupg/`
- `~/.aws/credentials`
- system paths such as `/etc`, `/usr`, `/bin`, `/sbin`, `/boot`

## Shared policy

Safety classification lives in `extensions/shared/safety-policy.ts` so danger guards, checkpoints, test runners, and file tools do not drift. The shared `classifyToolMutation()` API returns category, severity, score, checkpoint level, write paths, matched policy ids, and allow/confirmation flags; legacy mutation scoring delegates to it for compatibility.

`danger-guard.ts` uses the central classifier first, then retains deterministic bash/path checks as a backstop. If the backstop catches something the classifier did not classify, it appends a small diagnostic row to `.pi/safety-fallbacks.ndjson` so the classifier can be improved later without weakening enforcement.
