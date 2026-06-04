# Keylime 🥧

Keylime is a curated Pi package for agentic programming, research, memory, and domain workflows. It combines custom Pi extensions with SKILL.md workflows to make coding-agent sessions safer, lower-noise, and more reliable over long tasks.

The theme is exactly what it sounds like: a key lime pi(e). A crisp crust of stable prompt policy, a sharp filling of runtime safety guards, and a clean slice of tools that help agents do useful work without making a mess.

## What Keylime optimizes for

The short version: less prompt sludge, fewer unsafe shortcuts, more deliciously boring reliability.

- **Intent-aware tool exposure**: domain tools appear only when useful; safe repository primitives stay available.
- **Prompt-cache stability**: stable reminders, compact context providers, and fewer active tools by default.
- **Context engineering**: repo search, bounded file inspection, memory, project state, and search knowledge live outside the main prompt until needed.
- **Harness-enforced safety**: dangerous shell/git/file mutation paths are blocked or guarded at runtime, not merely discouraged in text.
- **Agentic programming ergonomics**: codemod tools, checkpoints, git inspection, test runners, repo indexing, and audit skills work together.

## Documentation

- [Extensions](extensions.html) — runtime tools, safety guards, routing, memory, research, and domain extensions.
- [Skills](skills.html) — reusable workflows invoked with `/skill:<name>`.
- [Safety model](safety.html) — locked tools, safe mutation paths, checkpointing, and raw git policy.
- [Agentic programming model](agentic-programming.html) — context/harness engineering principles behind Keylime.

## Core workflow

For repository work, Keylime encourages this loop:

1. Search/inspect with `code_search`, `inspect_text_matches`, `inspect_code_structure`, or `inspect_lines`.
2. Plan edits with `plan_code_replacements` for risky or broad changes.
3. Mutate with `apply_code_replacements`, `create_file`, or `create_directory`.
4. Verify with `run_checks`.
5. Use checkpoints for rollback and safe git inspection tools for history.

Raw `bash`, built-in `read`, built-in `write`, built-in `edit`, and mutating git commands are intentionally constrained.
