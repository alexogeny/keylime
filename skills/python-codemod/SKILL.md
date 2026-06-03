---
name: python-codemod
description: Python code editing and codemod workflow. Use for Python refactors, typing modernization, performance-safe replacements, and avoiding ad hoc Python scripts for repository edits.
---

# Python Codemod

Use repository-native primitives instead of one-off scripts when editing this repo.

## Workflow

1. Use `code_search` before full reads.
2. Use `inspect_text_matches` to inspect target patterns.
3. Use `apply_code_replacements` with exact `oldText` when possible.
4. For regex edits, dry-run first and keep the regex narrow.
5. Run `pytest`, `ruff`, `mypy`, or the project-specific checks.

## Python style

- Prefer Python 3.11+ typing: `list[str]`, `dict[str, X]`.
- Prefer small pure functions.
- Avoid broad regex codemods over syntax-sensitive code unless tests cover it.
