# Keylime extensions

The extension stack is optimized around two shared layers:

- `intent-router.ts` classifies each user prompt and activates only the relevant tool groups with `pi.setActiveTools()`.
- `turn-context-composer.ts` collects registered context providers and injects one capped per-turn reminder.

Most domain tools are still registered by their own extensions, but the router keeps them out of the provider prompt unless the current intent needs them.

`code-primitives.ts` adds repository-native edit helpers (`inspect_text_matches`, `plan_code_replacements`, `apply_code_replacements`, `inspect_code_structure`) so repetitive TypeScript/Python/Rust edits do not need ad hoc shell or Python scripts. Replacement previews use compact unified diff hunks, and text inspection supports path, glob, and language-scoped searches.

## Environment flags

- `KEYLIME_ENABLE_RESEARCH=1` — allow research tools without a detected provider key.
- `KEYLIME_DISABLE_RESEARCH=1` — force-disable research tools.
- `KEYLIME_DISABLE_SHOES=1` — disable shoe tools even for shoe/running prompts.
- `KEYLIME_AUTO_FETCH_SEARCH_RESULTS=1` — auto-fetch top web-search results.
- `KEYLIME_ENABLE_TRAJECTORY=1` — enable trajectory evaluator/session entries.
- `KEYLIME_ENABLE_ADAPTIVE_POLICY=1` — enable adaptive context policy hints.

Defaults are conservative: research follows provider-key detection, auto-fetch is off, trajectory eval is off, and adaptive policy is off.

## Useful commands

- `/intent-status` — current route and active tools.
- `/context-providers` — registered turn-context providers.
- `/cache-stats` — prompt-cache and context reduction stats.
- `/ace-status` — adaptive policy status if enabled.
- `/traj-status` — trajectory evaluator status if enabled.

## Safety behavior

`git-checkpoint.ts` now checkpoints before side-effectful tools (`write`, `edit`, and mutating-looking `bash` commands), not before every agent turn. Manual `/checkpoint` is still available.
