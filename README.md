# Keylime 🥧

Keylime is a Pi package of extensions and skills for safer, lower-noise agentic programming. Think of it as a well-balanced key lime pi(e): tart enough to stop dangerous actions, sweet enough to make daily coding-agent work pleasant, and structured enough that the filling does not collapse under context rot.

This repository contains:

- `extensions/` — Pi extension modules that add tools, commands, context providers, safety hooks, and status indicators.
- `skills/` — SKILL.md workflows for coding, debugging, refactoring, research, security, writing, and domain tasks.
- `docs/` — GitHub Pages documentation for the extension and skill stack.
- `tests/` — Bun tests for routing, safety, code primitives, repo search, checkpoints, and context behavior.

## Documentation

The full documentation site is built from `docs/` and deployed with GitHub Pages.

- [Docs home](docs/index.md)
- [Extensions](docs/extensions.md)
- [Skills](docs/skills.md)
- [Safety model](docs/safety.md)
- [Agentic programming model](docs/agentic-programming.md)

## The recipe

Keylime is designed around current context-engineering and harness-engineering practice:

- **A crisp crust** — stable base instructions, small prompt footprint, and predictable tool policy.
- **A sharp filling** — runtime safety guards that actually block dangerous file, shell, and git paths.
- **A clean slice** — safe, purpose-built tools for search, inspection, edits, tests, checkpoints, and history.
- **No soggy bottom** — context bloat is controlled with compact reminders, repo maps, external memory, and routed tools.

More concretely:

- Safe code/git primitives are always available.
- Dangerous built-ins are locked or guarded.
- Domain tools are routed by intent to reduce prompt pollution.
- Safety is enforced in code, not just requested in prompts.
- Checkpoints are low-noise and rollback-oriented.
- Search knowledge, memory, repo maps, and project state live outside the live prompt until needed.

## Core coding workflow

For repository work, Keylime encourages this loop:

1. Discover files with `list_files`; inspect text with `code_search`, `inspect_text_matches`, `inspect_code_structure`, or capped `inspect_lines`.
2. Inspect JSON with `inspect_json` instead of `jq`, `cat`, or built-in `read`.
3. Plan broad edits with `plan_code_replacements`.
4. Mutate with `apply_code_replacements`, `create_file`, or `create_directory`.
5. Verify with `run_checks`.
6. Use `/checkpoint` for explicit rollback points.
7. Use `git_status`, `git_diff`, `commit_history`, `see_file_commit_history`, and `inspect_at_checkpoint` instead of raw git inspection commands.

In coding mode, danger guard blocks native repo inspection through `bash` (`ls`, `find`, `grep`, `egrep`, `fgrep`, `rg`, `jq`, `cat`, `head`, `tail`, `wc`). Raw mutating git commands should not be used by the agent; commits should happen through checkpointing.

Examples:

- `list_files`: `{"path":"docs","recursive":true,"file_glob":"*.md","max_results":100}`
- `inspect_json`: `{"path":"settings.example.json","json_path":"permissions.allowedTools","max_chars":2000}`

## Extension slices

- `intent-router.ts` — routes capabilities and keeps safe code/git primitives always on.
- `code-primitives.ts` — safe file inspection and mutation tools.
- `repo-index/index.ts` — compact repo map and tiered `code_search`.
- `danger-guard.ts` — runtime blocking/confirmation for risky tools and paths.
- `git-checkpoint.ts` — rollback checkpoints, `/undo`, and explicitly gated local Git identity setup for checkpoint commits.
- `git-tools.ts` — read-only git status, diff, history, and checkpoint inspection tools.
- `test-runner.ts` — safe test/typecheck/lint runner.
- `turn-context-composer.ts` — one bounded reminder per turn.
- `tool-result-compactor.ts` — stores oversized tool results under `.pi/tool-results` and returns compact summaries/previews.
- `policy-tools.ts`, `shared/retrieval/`, `shared/policy-corpus.ts`, `shared/policy-actions.ts` — reusable BM25/TF-IDF/JMLM hybrid retrieval plus policy/codemod/check-recipe tools.
- `user-memory/` — durable memory and entity recall.
- `web-search.ts`, `search-memory.ts`, `search-orchestrator.ts`, `fetch.ts` — research and web knowledge workflow.
- `project-planner.ts` — project plan, TDD state, decisions, and questions.
- `shoe-database/` — running shoe catalog and query tools.

See [docs/extensions.md](docs/extensions.md) for the full extension map.

## Skill slices

- `agentic-programming` — audit/design workflow for coding-agent harnesses.
- `repo-map` — rapid codebase orientation.
- `change-planning` — repo-aware implementation planning.
- `debug` — reproduce/isolate/hypothesize/fix workflow.
- `refactor` — behavior-preserving restructuring workflow.
- `typescript-engineering`, `python-codemod`, `rust-codemod`, `rust-systems` — language-specific engineering workflows.
- `blue-team`, `red-team` — security operations and adversary simulation.
- `novel-*`, `tweet-craft`, `running-biomechanics`, `saas-naming` — domain skills.

See [docs/skills.md](docs/skills.md) for the full skill map.

## Install on a new Pi agent

### 1. Install Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### 2. Install this package

```bash
pi install /ABSOLUTE/PATH/TO/keylime
```

Pi writes the package entry into `~/.pi/agent/settings.json` automatically.

### 3. Install extension dependencies if needed

```bash
cd /ABSOLUTE/PATH/TO/keylime/extensions
bun install
```

### 4. Restart Pi

Restart the Pi session so extension and skill discovery refreshes.

## Useful commands

Inside Pi:

- `/intent-status` — current intent and active tools.
- `/tool-policy` — always-on, routed, locked, and active tools.
- `/context-providers` — registered turn-context providers.
- `/checkpoint` — create rollback checkpoint.
- `/undo` — reset to last checkpoint.
- `/mode` — show or change operational mode.

## Configuration

Important environment flags:

- `KEYLIME_AUTO_CHECKPOINT=off|major|any` — auto-checkpoint policy. Default: `major`.
- `KEYLIME_ENABLE_RESEARCH=1` — allow research tools without provider-key auto-detection.
- `KEYLIME_DISABLE_RESEARCH=1` — force-disable web research tools.
- `KEYLIME_DISABLE_SHOES=1` — force-disable shoe tools.
- `KEYLIME_AUTO_FETCH_SEARCH_RESULTS=1` — auto-fetch top web-search results.
- `KEYLIME_ENABLE_TRAJECTORY=1` — enable trajectory evaluator/session entries.
- `KEYLIME_ENABLE_ADAPTIVE_POLICY=1` — enable adaptive context policy hints.

## System dependencies

PDF OCR fallback in `inspect_document` also needs system binaries available on `PATH`:

- `pdftoppm` from Poppler (`apt install poppler-utils`, `brew install poppler`)
- `tesseract` (`apt install tesseract-ocr`, `brew install tesseract`)

The extension package records these under `extensions/package.json` → `keylime.systemDependencies.pdfOcr`. From `extensions/`, install/verify them with:

```bash
bun run install:ocr-deps:apt   # Debian/Ubuntu
bun run install:ocr-deps:brew  # macOS/Homebrew
bun run check:ocr-deps
```

## Development

Run the full test suite:

```bash
bun test tests
```

The suite covers intent routing, code primitives, danger guards, git tools, checkpoints, repo search, test running, and turn-context composition.

## GitHub Pages

Documentation is deployed from `docs/` by `.github/workflows/pages.yml` using GitHub Actions. Enable GitHub Pages in repository settings with **Source: GitHub Actions**.

## Repo hygiene

Local Pi usage logs are ignored via `.gitignore`:

```gitignore
.pi/usage/
```

Tracked historical `.pi/usage/usage.ndjson` should be removed manually if still present in git history/index.
