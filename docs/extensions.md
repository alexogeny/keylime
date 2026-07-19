# Extensions

{% include nav.md %}

These are the ingredients in the pie: TypeScript modules loaded by Pi that provide tools, commands, context providers, safety hooks, and status indicators.

## Routing and context

### `intent-router.ts`

Classifies each turn and controls active tool exposure with `pi.setActiveTools()`. It also records retrieval-backed policy evidence from `shared/policy-corpus.ts` for observability without letting retrieval override deterministic safety rules.

The always-on bootstrap is deliberately small:

- `list_files`
- `code_search`
- `inspect_text_matches`
- `inspect_lines`
- `run_checks`
- `tool_search`

`tool_search` ranks registered names, descriptions, guidance, and schemas with the shared retrieval core, then loads at most five matching tools additively for the current turn. Discoveries survive tool-result context passes and reset on the next user input. Operational mode, research availability, locked built-ins, and execution-time guards remain authoritative.

Other safe inspection, mutation, git, document, policy, memory, project, and domain tools are routed or discovered on demand. Raw `bash` and built-in `read`/`write`/`edit` remain guarded or locked.

Commands:

- `/intent-status` — show current route, policy evidence, and active tools.
- `/agent-status` — show intent, active groups/tools, locked tools, policy evidence, context policy, and tool-result compaction status.
- `/tool-policy` — show always-on, routed, locked, policy evidence, and active tools.
- `/switch-intent programming|auto` — force or clear programming intent.

### `turn-context-composer.ts` and `shared/turn-context.ts`

Collect registered context providers into one bounded `<system-reminder>` per turn. This avoids multiple extensions independently injecting prompt text and helps preserve prompt-cache stability.

### `tool-result-compactor.ts`, `context-object-store.ts`, and `shared/context-objects.ts`

Oversized successful outputs are classified and reduced with tool-specific reducers before entering conversation history. Verified payloads are stored as typed context objects under `.pi/context-objects/` with SHA-256 hashes, named sections, exact line selectors, duplicate folding, retention classes, and pinned-aware cleanup. `inspect_context_object` selects first and caps afterward. Errors, safety/recovery results, and mutation evidence bypass generic reduction. Legacy `.pi/tool-results` and `inspect_tool_result` remain available during migration.

`cache-guard.ts` now reports prompt-cache efficiency only; it no longer rewrites trajectory history or applies a second generic truncation layer.

### `structured-compaction.ts` and `shared/compaction-schema.ts`

Intercepts Pi's `session_before_compact` hook and asks the active authenticated model for a strict JSON checkpoint. The checkpoint preserves goal, constraints, acceptance criteria, decisions, active files and locators, changes, verification, failures, blockers, pending actions, safety state, and context-object evidence. Keylime validates and renders the checkpoint, verifies and pins every referenced context object, and passes Pi's `firstKeptEntryId` and `tokensBefore` through unchanged. Invalid output, missing evidence, cancellation, authentication failure, or model failure returns `undefined` so Pi's default compaction remains authoritative.

### `shared/retrieval/`, `shared/policy-corpus.ts`, `shared/policy-actions.ts`, and `policy-tools.ts`

Reusable local retrieval core for BM25, TF-IDF cosine, JMLM query likelihood, hybrid ranking, and metadata-aware policy documents. Candidate ranking retains only a bounded top-K heap instead of sorting every positive result. Current consumers include web-knowledge recall, user-memory lexical retrieval, intent-router policy evidence, low-confidence routing assistance, and the `retrieve_policy`, `suggest_checks`, and `codemod_plan` tools.

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

- `list_files` — repository file/directory discovery with glob, language, recursion, excludes, and result caps.
- `inspect_text_matches` — exact/regex matches with line context; preferred over `grep`/`rg`.
- `inspect_code_structure` — imports and top-level declarations.
- `inspect_lines` — focused numbered line windows, capped at 200 lines.
- `inspect_json` — JSON projection with dot paths, array indexes, wildcard projection, omitted keys, and output caps.
- `create_directory` — safe directory creation with recursive/skip options.
- `create_file` — safe file creation, refuses overwrites by default.
- `plan_code_replacements` — dry-run exact/regex replacements.
- `apply_code_replacements` — guarded replacements with count checks and ANSI-colored diff previews where supported.

Examples:

`list_files`:

```json
{"path":"docs","recursive":true,"file_glob":"*.md","max_results":100}
```

`inspect_json`:

```json
{"path":"settings.example.json","json_path":"permissions.allowedTools","max_chars":2000}
```

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
- `off|major|any` auto-checkpoint modes,
- semantic subjects and bodies generated by Pi's active authenticated model,
- deterministic local fallback when model generation is unavailable, invalid, or times out,
- `KEYLIME_CHECKPOINT_MESSAGES=semantic|metadata-only|deterministic` controls whether bounded redacted diff excerpts, metadata only, or no provider request is used; default `metadata-only`,
- `KEYLIME_CHECKPOINT_APPROVAL=always|manual|never` controls the Pi TUI approve/edit/skip review; default `always`,
- review occurs before staging, so skipping leaves working changes untouched,
- excludes local `.pi` state from staging,
- `/git-auth` guides remote authentication setup for GitHub, GitLab, Bitbucket, and custom SSH hosts without collecting tokens/passwords, ensures SSH key config in `~/.ssh/config`, and offers to switch an HTTPS `origin` remote to SSH,
- `/git-identity` configures repo-local commit author `user.name` and `user.email` only after explicit user confirmation, and asks before updating an existing local commit identity,
- auto-checkpoint commit identity failures prompt for name/email, then require confirmation before writing `.git/config`,
- `/git-push` pushes the current branch after confirmation, using existing upstream or creating/setting `origin/<branch>`; for HTTPS provider remotes it uses native auth tooling (`gh`/`glab`) when installed, otherwise switches the remote to SSH before pushing; push authentication is handled by Git remote credentials, not `/git-identity`,
- `/undo` resets to the latest checkpoint.

### `git-tools.ts`

Read-only git inspection layer. Use these instead of raw git commands:

- `git_status`
- `git_diff`
- `commit_history`
- `see_file_commit_history`
- `inspect_at_checkpoint`

Raw git mutation commands are blocked in coding mode; commits should happen only through checkpointing.

## Linux ops

Linux operations are selected by the `linux_ops` intent and `linux` capability group rather than a separate operational mode. Every tool routed exclusively to Linux checks the active Linux capability again at execution time. Mutations require explicit UI approval; high-impact operations also require a matching, single-use plan token that expires after ten minutes.

### Modules

- `linux-discovery.ts` — bounded grep/find/file-tree discovery and cross-package-manager metadata inspection.
- `linux-packages.ts` — APT and Pacman search/query plus token-bound install and removal plans.
- `linux-systemd.ts` — unit status/logs, timers, and token-bound restart/enable/disable actions; critical SSH, networking, and display units are refused.
- `linux-files.ts` — symlink-resolved allowlisted config inspection, backup/restore, checksum-bound exact patches, validator presets, and privileged install fallback.
- `linux-hardware.ts` — kernel, CPU, memory, block-device, mount, GPU, and interface inspection.
- `linux-logs.ts` — journal inspection and bounded tail/search under resolved `/var/log`, user state, and user cache roots, with secret redaction.
- `linux-network.ts` — listening ports, DNS/HTTP/ping/route probes, routes, resolver state, and firewall status.
- `linux-filesystem.ts` — metadata, disk use, large/recent file discovery, token-bound quarantine deletion, and token-bound archive creation.
- `linux-users.ts` — users, groups, permissions, and token-bound chmod/chown changes.
- `linux-processes.ts` — bounded process inspection and identity-checked, token-bound signaling.
- `linux-checks.ts` — predefined health, package, network, and GPU check suites.
- `linux-diagnostics.ts` — boot analysis, pressure stalls, disk health, deleted-open files, containers, kernel modules, time sync, and available security updates.

### Safety contracts

- User-controlled command operands reject option-like values and are passed without a shell.
- System and log paths are resolved through symlinks before allowlist checks.
- Plan tokens are bound to normalized operation parameters, expire after ten minutes, and are consumed once.
- Destructive deletion is implemented as quarantine under `~/.local/share/keylime/trash`.
- System config edits create backups, retain checksum/count guards, use fixed validator presets, roll back failed validation, and can use reviewed sudo installation for root-owned files.
- `inspect_package_metadata` remains available in coding mode because it is useful for dependency debugging; the system-discovery tools require Linux routing.

## Safety

### `shared/safety-policy.ts`

Central policy module used by danger guards, checkpoints, and run checks.

Centralizes:

- bash mutation and native repo inspection classification,
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
- native repo inspection commands through `bash`: `ls`, `find`, `grep`, `egrep`, `fgrep`, `rg`, `jq`, `cat`, `head`, `tail`, `wc`,
- raw mutating git commands.

Prompts for protected paths such as `.env`, `.git`, `node_modules`, home credential dirs, and system paths. Small exact `apply_code_replacements` batches across a few explicit files stay below the high-risk confirmation threshold; broad globs, regexes, and replace-all edits still require confirmation.

## Research and web knowledge

### `web-search.ts`

Live search through configured providers such as Tavily, Serper, or Bing. Produces `search_id` values for later distillation.

### `search-memory.ts`

Stores and recalls distilled search knowledge using the shared BM25 lexical retrieval core plus optional embedding reranking. Supports tools such as `recall_web_knowledge`, `list_search_history`, and `get_search_entry`.

### `search-orchestrator.ts`

Higher-level `research_topic` workflow combining search, recall, and synthesis.

### `fetch.ts`

Provides `fetch_url` for reading web pages, with HTML cleanup and optional browser fallback.

### `web-content.ts`

Stores content-addressed Markdown with capped body-term frequencies in page metadata. Stored-site search ranks indexed metadata first, reads bodies only for the requested top-K excerpts, limits legacy/body-read concurrency, and lazily remains compatible with pages created before the index field existed.

## Memory and project state

### `user-memory/index.ts`

Durable user memory system with entity extraction, recall, update, forget, backup, and restore functionality. Lexical candidate retrieval and TF-IDF deduplication use the shared retrieval core. Entity recall normalizes prompt words once and performs additive alias lookups rather than nested alias-by-word comparisons.

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
