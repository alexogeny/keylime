# keylime

This repository contains a clean copy of my Pi assets:

- `skills/` — all custom Pi skills (SKILL.md-based workflows + helpers)
- `extensions/` — all custom Pi extensions (`.ts`) and supporting files

Node modules and local absolute paths were intentionally omitted/sanitized for portability.

## Install on a new Pi agent

### 1) Install Pi

Install Pi first (if not already):

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### 2) Install this package

Use Pi’s package installer with a local path:

```bash
pi install /ABSOLUTE/PATH/TO/keylime
```

Pi writes the package entry into `~/.pi/agent/settings.json` automatically.

If you plan to run extensions that use Playwright, install extension dependencies once:

```bash
cd /ABSOLUTE/PATH/TO/keylime/extensions
bun install    # or npm install
```

### 3) Confirm load paths

By default, Pi auto-discovers:

- `~/.pi/agent/skills/`
- `~/.pi/agent/extensions/`
- package resources from the `skills/` and `extensions/` folders

### 4) Alternative (manual placement)

If you prefer direct copy only:

```bash
mkdir -p ~/.pi/agent
cp -r /ABSOLUTE/PATH/TO/keylime/skills ~/.pi/agent/skills
cp -r /ABSOLUTE/PATH/TO/keylime/extensions ~/.pi/agent/extensions
```

Then restart Pi.

## What is included

- **Skills**: `blue-team`, `clarify`, `debug`, `memory-validate`, `novel-craft`, `novel-plan`, `novel-review`, `novel-write`, `python-engineering`, `red-team`, `refactor`, `repo-map`, `running-biomechanics`, `rust-shell-emulator`, `rust-systems`, `saas-naming`, `tweet-craft`, `ui-design`
- **Extensions**: `adaptive-context-policy`, `cache-guard`, `context-health`, `danger-guard`, `fetch`, `git-checkpoint`, `intent-router`, `memory-manager`, `operational-modes`, `project-planner`, `search-memory`, `search-orchestrator`, `signal-footer`, `trajectory-eval`, `turn-context-composer`, `usage-tracker`, `web-search`, `repo-index/`, `shoe-database/`, `user-memory/` and related package/test files

## Source docs used for extraction

- `docs/skills.md`
- `docs/extensions.md`
- `docs/packages.md`
- `docs/settings.md`

These were consulted for install/placement details but not copied wholesale into this repo.