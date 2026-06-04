# Agentic programming model

{% include nav.md %}

Keylime is built around current context-engineering and harness-engineering practices for coding agents.

## Core idea

Modern agentic programming is not just prompt engineering. It is the design of a compound system around the model:

- stable instructions,
- controlled tool exposure,
- compact context retrieval,
- external state and memory,
- runtime safety enforcement,
- verification loops,
- observability.

## Prompt engineering vs context engineering

Prompt engineering defines the contract:

- inspect before editing,
- use safe mutation tools,
- verify after changes,
- avoid raw shell/git mutation,
- summarize results and risks.

Context engineering controls what information reaches the model:

- active tool schemas,
- repo search results,
- bounded file excerpts,
- memory and project state,
- tool-result summaries,
- current intent and operating mode.

The goal is high-signal context with minimal stale or redundant tokens.

## Harness engineering

The harness is the runtime around the model. In Keylime, the harness includes:

- `intent-router.ts` for active tool policy,
- `turn-context-composer.ts` for bounded reminders,
- `danger-guard.ts` for hard safety enforcement,
- `git-checkpoint.ts` for rollback,
- `repo-index/index.ts` for search-first repo context,
- `code-primitives.ts` for safe file operations,
- `test-runner.ts` for verification,
- memory, research, and project-planning extensions.

## Context-rot prevention

Long coding sessions degrade when stale or bulky context accumulates. Keylime reduces this through:

- search before full file inspection,
- bounded `inspect_lines`,
- compact repo maps,
- external project/memory/search state,
- one composed system reminder per turn,
- route-specific tool exposure,
- disabled broad formatting-destroying replacement modes,
- low-noise checkpoints rather than commit spam.

## Audit checklist

When reviewing Keylime later, check:

1. Are safe repository tools still always-on?
2. Are raw `bash`, `read`, `write`, `edit`, and mutating git commands locked or guarded?
3. Are safety rules centralized in `shared/safety-policy.ts`?
4. Are checkpoints based on successful tool results, not attempted calls?
5. Are context providers bounded and non-duplicative?
6. Are docs and prompt guidance aligned with runtime enforcement?
7. Does the full test suite pass?

For a deeper workflow, invoke `/skill:agentic-programming`.
