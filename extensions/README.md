# Keylime extensions

The extension stack is optimized around two shared layers:

- `intent-router.ts` classifies each user prompt, uses policy-corpus evidence for observability and low-confidence routing assistance, and activates only the relevant tool groups with `pi.setActiveTools()`.
- `turn-context-composer.ts` collects registered context providers and injects one capped per-turn reminder.

Most domain tools are still registered by their own extensions, but the router keeps them out of the provider prompt unless the current intent needs them. Safe repository primitives are always available so intent routing cannot strand inspection or codemod work.

`code-primitives.ts` adds repository-native helpers (`list_files`, `code_search`, `inspect_text_matches`, `inspect_lines`, `inspect_json`, `inspect_code_structure`, `plan_code_replacements`, `apply_code_replacements`, `create_file`, `create_directory`, `run_checks`, `retrieve_policy`, `suggest_checks`, `codemod_plan`, `inspect_tool_result`, `commit_history`, `see_file_commit_history`, `inspect_at_checkpoint`) so repetitive TypeScript/Python/Rust edits do not need ad hoc shell or Python scripts. Replacement previews use compact unified diff hunks with ANSI color where supported, and inspection supports path, glob, language-scoped, and JSON-projection workflows. Built-in `bash`, `read`, `write`, and `edit` remain locked behind routing and safety guards.

## Environment flags

- `KEYLIME_ENABLE_RESEARCH=1` — allow research tools without a detected provider key.
- `KEYLIME_DISABLE_RESEARCH=1` — force-disable research tools.
- `KEYLIME_DISABLE_SHOES=1` — disable shoe tools even for shoe/running prompts.
- `KEYLIME_AUTO_FETCH_SEARCH_RESULTS=1` — auto-fetch top web-search results.
- `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` — configure hosted or self-hosted Firecrawl scraping and crawling.
- `KEYLIME_FIRECRAWL_MODE=fallback` — use Firecrawl when direct `fetch_url` extraction fails; explicit provider selection remains available without it.
- `KEYLIME_FIRECRAWL_ZERO_DATA_RETENTION=1` — opt into ZDR only when enabled for the Firecrawl team; free teams may otherwise receive HTTP 403.
- `KEYLIME_WEB_CONTENT_DATA_DIR` — override the content-addressed Markdown and crawl-manifest store (default `~/.pi/data/web-content`).
- `KEYLIME_STORE_SEARCH_CONTENT=0` — disable persistence of auto-fetched search sources.
- `KEYLIME_ENABLE_TRAJECTORY=1` — enable trajectory evaluator/session entries.
- `KEYLIME_ENABLE_ADAPTIVE_POLICY=1` — enable adaptive context policy hints.
- `KEYLIME_AUTO_CHECKPOINT=off|major|any` — control auto-checkpointing. Default: `major`.
- `KEYLIME_CHECKPOINT_MESSAGES=semantic|metadata-only|deterministic` — use the active Pi model with bounded redacted context, omit diff excerpts, or stay fully local. Default: `semantic`.
- `KEYLIME_CHECKPOINT_APPROVAL=always|manual|never` — review every draft in the Pi TUI, review manual `/checkpoint` drafts only, or commit without review. Default: `always`.
- `KEYLIME_WEB_SEARCH_DATA_DIR=/path/to/data` — override persisted web-search knowledge location for tests or isolated runs.

Defaults are conservative: research follows provider-key detection, auto-fetch is off, trajectory eval is off, and adaptive policy is off.

## Useful commands

- `/intent-status` — current route, policy evidence, and active tools.
- `/agent-status` — current intent, active/locked tools, routing evidence, context, and tool-result compaction status.
- `/context-providers` — registered turn-context providers.
- `/cache-stats` — prompt-cache and context reduction stats.
- `/ace-status` — adaptive policy status if enabled.
- `/traj-status` — trajectory evaluator status if enabled.

## Safety behavior

`git-checkpoint.ts` checkpoints at the end of an agent turn only for major mutations by default: broad replacements, mutating bash, legacy writes/edits, or small changes after a long interval. It asks Pi's active authenticated model for a semantic subject and body, validates the structured result, and falls back to a deterministic local message on timeout, malformed output, or missing model access. In TUI mode the default review dialog lets you approve, edit, or skip before anything is staged. Set `KEYLIME_AUTO_CHECKPOINT=off` for manual-only checkpoints, or `any` to checkpoint after any mutating turn. It excludes `.pi` local state from staging. Manual `/checkpoint` is still available. `git-tools.ts` provides read-only `git_status`, `git_diff`, `commit_history`, `see_file_commit_history`, and `inspect_at_checkpoint` so agents do not need raw git inspection commands.

`danger-guard.ts` blocks built-in `read`/`write`/`edit` in coding mode and blocks mutation-looking shell commands such as redirects, `mkdir`, `touch`, `rm`, `cp`, `mv`, inline runtime writes, shell command strings, and raw git mutation commands. It also blocks native repo inspection through `bash` (`ls`, `find`, `grep`, `egrep`, `fgrep`, `rg`, `jq`, `cat`, `head`, `tail`, `wc`). Central mutation classification is primary; deterministic legacy checks remain as a backstop and log classifier misses to `.pi/safety-fallbacks.ndjson`. Use `list_files`, `inspect_text_matches`, `inspect_json`, `create_file`, `create_directory`, `apply_code_replacements`, checkpoint commands, and safe git inspection tools instead.

`git-tools.ts` provides read-only git inspection tools: `commit_history`, `see_file_commit_history`, and `inspect_at_checkpoint`. Commits should happen only through checkpointing.

`run_checks` is always available, but custom commands are restricted in coding mode to prevent inline runtime or shell-string file mutation bypasses.

## System dependencies

PDF OCR fallback in `document-primitives.ts` uses two external binaries when embedded PDF text is empty or when `inspect_document` is called with `ocr: true`:

- `pdftoppm` from Poppler (`apt install poppler-utils`, `brew install poppler`)
- `tesseract` (`apt install tesseract-ocr`, `brew install tesseract`)

These are recorded in `package.json` under `keylime.systemDependencies.pdfOcr`. From this `extensions/` directory, use `bun run install:ocr-deps:apt` or `bun run install:ocr-deps:brew`, then validate the local environment with `bun run check:ocr-deps`. PDF page ranges are rendered in one `pdftoppm` process before per-page OCR, avoiding a renderer subprocess and directory scan for every page.
