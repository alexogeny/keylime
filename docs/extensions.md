# Extensions

These are the ingredients in the pie: TypeScript modules loaded by Pi that provide tools, commands, context providers, safety hooks, and status indicators.

## Routing and context

### `intent-router.ts`

Classifies each turn and controls active tool exposure with `pi.setActiveTools()`.

Always-on safe repository tools:

- `code_search`
- `inspect_text_matches`
- `inspect_code_structure`
- `inspect_lines`
- `plan_code_replacements`
- `apply_code_replacements`
- `create_file`
- `create_directory`
- `run_checks`
- `commit_history`
- `see_file_commit_history`
- `inspect_at_checkpoint`

Routed or guarded tools include raw `bash`, built-in `read`, research tools, memory mutation tools, project planning tools, and domain-specific shoe tools.

Commands:

- `/intent-status` — show current route and active tools.
- `/tool-policy` — show always-on, routed, locked, and active tools.
- `/switch-intent programming|auto` — force or clear programming intent.

### `turn-context-composer.ts` and `shared/turn-context.ts`

Collect registered context providers into one bounded `<system-reminder>` per turn. This avoids multiple extensions independently injecting prompt text and helps preserve prompt-cache stability.

### `operational-modes.ts`

Provides conversational, code, research, personal, TDD, and review modes. Modes can inject focused instructions and affect active capabilities via the router.

## Repository and code tooling

### `repo-index/index.ts`

Maintains a compact session repo map and provides `code_search`.

Features:

- structural search over declarations,
- lexical search with file:line context,
- scoped `file_glob` search,
- hidden-file handling when requested,
- invalidation after source mutations.

### `code-primitives.ts` and `shared/code-primitives.ts`

Safe repository inspection and mutation primitives.

Tools:

- `inspect_text_matches` — exact/regex matches with line context.
- `inspect_code_structure` — imports and top-level declarations.
- `inspect_lines` — bounded numbered line windows.
- `create_directory` — safe directory creation with recursive/skip options.
- `create_file` — safe file creation, refuses overwrites by default.
- `plan_code_replacements` — dry-run exact/regex replacements.
- `apply_code_replacements` — guarded replacements with count checks and previews.

Safety properties:

- path traversal protection,
- binary-file refusal,
- overwrite refusal for new files,
- replacement count guards,
- broad edit dry-run guidance,
- `normalized_whitespace` disabled to avoid destroying file formatting.

### `test-runner.ts` and `shared/test-runner.ts`

Provides `run_checks` for tests, type checks, and lint commands.

Default detection supports TypeScript/Bun, Rust/Cargo, and Python/Pytest projects. Custom commands are restricted in coding mode to prevent shell or runtime mutation bypasses.

## Git and rollback

### `git-checkpoint.ts`

Creates rollback commits through explicit `/checkpoint` and low-noise auto-checkpointing.

Behavior:

- default `KEYLIME_AUTO_CHECKPOINT=major`,
- auto-checkpoints at agent turn end for major mutations,
- `off|major|any` modes,
- excludes local `.pi` state from staging,
- `/undo` resets to the latest checkpoint.

### `git-tools.ts`

Read-only git inspection layer. Use these instead of raw git commands:

- `commit_history`
- `see_file_commit_history`
- `inspect_at_checkpoint`

Raw git mutation commands are blocked in coding mode; commits should happen only through checkpointing.

## Safety

### `shared/safety-policy.ts`

Central policy module used by danger guards, checkpoints, and run checks.

Centralizes:

- bash mutation classification,
- raw git mutation classification,
- `run_checks` custom command blocking,
- mutation scoring for auto-checkpoints,
- protected write paths,
- write-path extraction per tool.

### `danger-guard.ts`

Runtime guard for destructive operations.

Blocks in coding mode:

- built-in `read`, `write`, `edit`,
- mutation-looking shell commands,
- raw mutating git commands.

Prompts for protected paths such as `.env`, `.git`, `node_modules`, home credential dirs, and system paths.

## Research and web knowledge

### `web-search.ts`

Live search through configured providers such as Tavily, Serper, or Bing. Produces `search_id` values for later distillation.

### `search-memory.ts`

Stores and recalls distilled search knowledge. Supports tools such as `recall_web_knowledge`, `list_search_history`, and `get_search_entry`.

### `search-orchestrator.ts`

Higher-level `research_topic` workflow combining search, recall, and synthesis.

### `fetch.ts`

Provides `fetch_url` for reading web pages, with HTML cleanup and optional browser fallback.

## Memory and project state

### `user-memory/index.ts`

Durable user memory system with entity extraction, recall, update, forget, backup, and restore functionality.

Tools include:

- `remember`
- `recall_memories`
- `update_memory`
- `forget_memory`
- `list_memories`
- `recall_entity`
- `list_entities`

### `project-planner.ts`

Project planning and TDD state stored under `.pi/project.json`.

Tools include:

- `save_project_plan`
- `update_feature_tdd`
- `log_decision`
- `manage_question`

Commands include `/new-project`, `/project-status`, and `/tdd`.

## Domain extensions

### `shoe-database/`

Running shoe catalog and query tools:

- `lookup_shoe`
- `find_shoes_by_spec`
- `compare_shoes`
- `shoe_catalog_stats`
- `add_shoe`
- `query_shoes`

## Observability and policy helpers

- `context-health.ts` — context usage and health signals.
- `cache-guard.ts` — prompt-cache/cache-stability diagnostics.
- `adaptive-context-policy.ts` — optional adaptive context hints.
- `trajectory-eval.ts` — optional trajectory/session evaluation.
- `usage-tracker.ts` — usage/cost logging.
- `signal-footer.ts` — compact session footer/status signal.
- `memory-manager.ts` — memory-management helpers.
