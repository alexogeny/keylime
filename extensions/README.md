# Keylime extensions

The extension stack is optimized around two shared layers:

- `intent-router.ts` classifies each user prompt and activates only the relevant tool groups with `pi.setActiveTools()`.
- `turn-context-composer.ts` collects registered context providers and injects one capped per-turn reminder.

Most domain tools are still registered by their own extensions, but the router keeps them out of the provider prompt unless the current intent needs them. Safe repository primitives are always available so intent routing cannot strand inspection or codemod work.

`code-primitives.ts` adds repository-native helpers (`code_search`, `inspect_text_matches`, `inspect_lines`, `inspect_code_structure`, `plan_code_replacements`, `apply_code_replacements`, `create_file`, `create_directory`, `run_checks`, `commit_history`, `see_file_commit_history`, `inspect_at_checkpoint`) so repetitive TypeScript/Python/Rust edits do not need ad hoc shell or Python scripts. Replacement previews use compact unified diff hunks, and text inspection supports path, glob, and language-scoped searches. Built-in `bash`, `read`, `write`, and `edit` remain locked behind routing and safety guards.

## Environment flags

- `KEYLIME_ENABLE_RESEARCH=1` — allow research tools without a detected provider key.
- `KEYLIME_DISABLE_RESEARCH=1` — force-disable research tools.
- `KEYLIME_DISABLE_SHOES=1` — disable shoe tools even for shoe/running prompts.
- `KEYLIME_AUTO_FETCH_SEARCH_RESULTS=1` — auto-fetch top web-search results.
- `KEYLIME_ENABLE_TRAJECTORY=1` — enable trajectory evaluator/session entries.
- `KEYLIME_ENABLE_ADAPTIVE_POLICY=1` — enable adaptive context policy hints.
- `KEYLIME_AUTO_CHECKPOINT=off|major|any` — control auto-checkpointing. Default: `major`.

Defaults are conservative: research follows provider-key detection, auto-fetch is off, trajectory eval is off, and adaptive policy is off.

## Useful commands

- `/intent-status` — current route and active tools.
- `/context-providers` — registered turn-context providers.
- `/cache-stats` — prompt-cache and context reduction stats.
- `/ace-status` — adaptive policy status if enabled.
- `/traj-status` — trajectory evaluator status if enabled.

## Safety behavior

`git-checkpoint.ts` checkpoints at the end of an agent turn only for major mutations by default: broad replacements, mutating bash, legacy writes/edits, or small changes after a long interval. Set `KEYLIME_AUTO_CHECKPOINT=off` for manual-only checkpoints, or `any` to checkpoint after any mutating turn. It excludes `.pi` local state from staging. Manual `/checkpoint` is still available. `git-tools.ts` provides read-only `git_status`, `git_diff`, `commit_history`, `see_file_commit_history`, and `inspect_at_checkpoint` so agents do not need raw git inspection commands.

`danger-guard.ts` blocks built-in `read`/`write`/`edit` in coding mode and blocks mutation-looking shell commands such as redirects, `mkdir`, `touch`, `rm`, `cp`, `mv`, inline runtime writes, shell command strings, and raw git mutation commands. Use `create_file`, `create_directory`, `apply_code_replacements`, checkpoint commands, and safe git inspection tools instead.

`git-tools.ts` provides read-only git inspection tools: `commit_history`, `see_file_commit_history`, and `inspect_at_checkpoint`. Commits should happen only through checkpointing.

`run_checks` is always available, but custom commands are restricted in coding mode to prevent inline runtime or shell-string file mutation bypasses.
