---
name: typescript-engineering
description: TypeScript/JavaScript engineering and codemod workflow. Use for TS/JS refactors, extension work, type tightening, module restructuring, and safe multi-file text replacements.
---

# TypeScript Engineering

Use repo search before reads. Prefer exact replacements through `apply_code_replacements` for repetitive edits and `inspect_text_matches` before broad regex changes.

## Workflow

1. Use `code_search` for symbols and declarations.
2. Use `inspect_text_matches` for repeated textual patterns.
3. Use `apply_code_replacements` with `dry_run: true` for broad edits.
4. Apply the smallest safe batch.
5. Run `bun test`, `bun --check`, or the repo-specific test command.

## TypeScript principles

- Prefer narrow exported functions over classes.
- Keep tool schemas terse.
- Keep volatile context out of system prompts.
- Use discriminated unions for routing/state.
- Avoid `any` unless bridging extension APIs.
