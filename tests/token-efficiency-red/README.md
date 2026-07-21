# Token-efficiency RED contract

This directory is the intentionally failing acceptance contract for the July 2026 token-spend research. It specifies successful-task economics for the Pi harness before production implementation begins.

## Rules

- Tests exercise production module contracts; fixture constructors are data only.
- Missing production modules are loaded dynamically so every RED test is independently discoverable.
- Do not make a test green by weakening its assertion, embedding a replacement implementation in the test, or treating missing provider data as zero.
- Character accounting remains the deterministic provider-independent baseline. Provider token and cost fields remain nullable when not reported.
- Savings never override exact constraints, mutation evidence, unresolved failures, security state, or task-success gates.
- Once a file is green, it remains in this directory as a regression contract, matching `tests/harness-theses-red/` convention.

## Contract map

| File | Expected production target | Contract |
|---|---|---|
| `spend-accounting.red.test.ts` | `extensions/shared/spend-accounting.ts` | Separate active context, current-turn traffic, cache traffic, cumulative branch totals, auxiliary calls, and display semantics |
| `prompt-prefix-profiler.red.test.ts` | `extensions/shared/prompt-prefix-profiler.ts` | Order-sensitive reusable-prefix fingerprints, cache-bust attribution, category accounting, and tool-strategy economics |
| `trajectory-reducer.red.test.ts` | `extensions/shared/trajectory-reducer.ts` | Deterministic role-aware reduction with recoverable references, protected state, valid tool pairs, and audit reasons |
| `session-handoff.red.test.ts` | `extensions/shared/session-handoff.ts` | Pressure/boundary compaction decisions, typed checkpoints, bounded cross-session bootstrap, and validated sidecar compression |
| `token-efficiency-evaluation.red.test.ts` | `extensions/shared/token-efficiency-evaluation.ts` | Release gates based on successful-task cost, quality, model calls, category coverage, and privacy |

## Expected initial result

Run:

```bash
bun test tests/token-efficiency-red
```

The initial suite discovered **25 tests** and failed because the five production modules did not exist. Integration contracts were then added as each slice reached runtime wiring. The current baseline is **29 pass, 0 fail**. The files retain the `.red.test.ts` suffix as permanent regression contracts, matching `tests/harness-theses-red/`. Extension wiring and rollout gates remain tracked in the checklist.

Implementation order and exit criteria are documented in:

- `docs/plans/token-efficiency-2026/00-roadmap.md`
- `docs/plans/token-efficiency-2026/CHECKLIST.md`
