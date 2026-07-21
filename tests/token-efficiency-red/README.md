# Token-efficiency RED contract

This directory is the intentionally failing acceptance contract for the July 2026 token-spend research. It specifies successful-task economics for the Pi harness before production implementation begins.

## Rules

- Tests exercise production module contracts; fixture constructors are data only. The handoff extension tests use a minimal in-memory Pi event recorder but do not implement production behavior.
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
| `telemetry-runtime-integration.red.test.ts` | `usage-tracker.ts`, passive telemetry | Migrations, shared normalization, full task attribution, privacy, and restoration |
| `trajectory-runtime-integration.red.test.ts` | `context-runtime.ts` | Single-owner runtime reduction plus coding, research, debugging, and mutation replays |
| `handoff-compaction-runtime.red.test.ts` | handoff and structured compaction | Projected economics, checkpoint quality, sidecar validation/fallback, and fail-closed continuation |
| `handoff-extension.red.test.ts` | `extensions/session-handoff.ts` | Actual `/handoff` registration, persistence, and one-time bootstrap consumption |
| `evaluation-rollout-runtime.red.test.ts` | evaluator and context report | Observe-only reports, experiments, confidence intervals, release gates, and rollout stages |
| `provider-tool-economics.red.test.ts` | provider economics and prefix profiler | Anthropic/OpenAI/Gemini accounting, cache controls, canonical tool order, and net economics |

## Expected initial result

Run:

```bash
bun test tests/token-efficiency-red
```

The initial suite discovered 25 tests, then expanded to the complete 77-test roadmap contract. The current baseline is **77 pass, 0 fail**. The files retain the `.red.test.ts` suffix as permanent regression contracts; empirical rollout evidence remains separate from contract completion.

Implementation order and exit criteria are documented in:

- `docs/plans/token-efficiency-2026/00-roadmap.md`
- `docs/plans/token-efficiency-2026/CHECKLIST.md`
- `docs/plans/token-efficiency-2026/RED-MATRIX.md`
