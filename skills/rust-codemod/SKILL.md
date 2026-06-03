---
name: rust-codemod
description: Rust code editing and codemod workflow. Use for Rust refactors, module moves, ownership-safe changes, and repetitive text replacements.
---

# Rust Codemod

Use exact, test-backed edits. Rust syntax is sensitive to lifetimes, generics, and macro contexts, so avoid broad uninspected regex changes.

## Workflow

1. Use `code_search` for functions, structs, traits, impls, and modules.
2. Use `inspect_text_matches` for repeated pattern inspection.
3. Use `apply_code_replacements` with dry-run for repetitive edits.
4. Run `cargo check`, `cargo test`, and `cargo clippy` when applicable.

## Rust style

- Preserve public APIs unless asked to change behavior.
- Prefer explicit error types and small helper functions.
- Keep ownership changes local and compile-check often.
