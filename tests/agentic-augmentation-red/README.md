# Agentic augmentation — RED acceptance contract

This suite turns `docs/plans/agentic-augmentation-2026.md` into an intentionally failing, executable implementation checklist.

## Status

Initial verified baseline: **0 pass / 53 fail**.

Current verified status:

```text
10 pass (AA-001–AA-010)
43 fail (AA-011–AA-053)
bun run typecheck: pass
bun run typecheck:tests: pass
```

Production code must make tests green one narrowly scoped slice at a time. Keep green tests as permanent regressions; do not rename the files when they pass.

## Test policy

- Tests call production exports and real filesystem-backed runtimes.
- Missing future modules are imported dynamically so every contract remains independently discoverable.
- A small Pi lifecycle recorder may register and emit hooks; it does not implement production behavior.
- No test may embed a replacement outcome tracker, router, delegation registry, sandbox, canary store, impact oracle, or LSP adapter.
- Do not make tests green by weakening assertions, accepting unverified outcomes, or treating missing provider data as zero.
- Persist only aggregate structural records: no prompts, responses, source bodies, full tool payloads, transcripts, secrets, or absolute repository paths.

## Contract map

| File | Production target | Thesis |
|---|---|---|
| `task-outcomes.red.test.ts` | `extensions/shared/task-outcome.ts`, `usage-tracker.ts` | One settled task outcome joins mutations, verification, usage, recovery, blocking, and privacy-safe persistence. |
| `trajectory-settlement.red.test.ts` | `trajectory-eval.ts` | Evaluate once at `agent_settled`, use Keylime's real evidence tools, and distinguish verified, failed, unverified, and read-only work. |
| `governance-wiring.red.test.ts` | `extension-kernel.ts`, `harness-governance-runtime.ts` | Rich impact policy and verification evidence are used by the live governance runtime. |
| `canary-rollout.red.test.ts` | `runtime-canaries.ts`, governance persistence | Live samples are stable, paired, complete, persistent, independently evaluated, and promotion-ready. |
| `delegation-live.red.test.ts` | delegation contracts plus live registry | Issued contracts are registered, bounded, validated, consumed, and required before delegated evidence is trusted. |
| `process-sandbox.red.test.ts` | `extensions/shared/process-executor.ts` | All subprocesses can share bounded execution, environment filtering, repository scope, audit metadata, and sandbox backends. |
| `routing-and-lsp.red.test.ts` | routing observer and ecosystem adapters | Routing starts observe-only and external LSP evidence becomes bounded, fresh impact edges without process ownership. |

## Intended implementation order

1. AA-001–AA-017: task outcomes and settled trajectory evaluation.
2. AA-018–AA-025: live impact and verification wiring.
3. AA-026–AA-031: evaluable runtime canaries.
4. AA-032–AA-038: live delegation registry and validation.
5. AA-039–AA-045: shared process executor and sandbox seam.
6. AA-046–AA-053: observe-only routing and LSP evidence wiring.

See `docs/plans/agentic-augmentation-2026/RED-MATRIX.md` for the acceptance matrix.

## Run

```sh
bun test tests/agentic-augmentation-red
bun run typecheck:tests
```

A failing test is a checklist item, not permission to bypass an invariant.
