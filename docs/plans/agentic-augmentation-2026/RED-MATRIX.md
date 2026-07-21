# Agentic augmentation RED matrix

This matrix is the executable checklist for `../agentic-augmentation-2026.md`.

The tests intentionally describe desired production behavior before implementation. A RED result proves the gap is observable; a GREEN result is retained permanently as a regression contract.

## Slice 1 — settled task outcomes

| ID | Acceptance condition | Test |
|---|---|---|
| AA-001 | A task settles exactly once. | `task-outcomes.red.test.ts` |
| AA-002 | Usage aggregates across all model turns. | `task-outcomes.red.test.ts` |
| AA-003 | Mutation plus passing checks is `verified`. | `task-outcomes.red.test.ts` |
| AA-004 | Mutation without checks is `unverified_mutation`. | `task-outcomes.red.test.ts` |
| AA-005 | Final failed checks are `failed_verification`. | `task-outcomes.red.test.ts` |
| AA-006 | Failed then passing verification records recovery. | `task-outcomes.red.test.ts` |
| AA-007 | Read-only evidence work can complete successfully. | `task-outcomes.red.test.ts` |
| AA-008 | Policy blocking is a distinct outcome. | `task-outcomes.red.test.ts` |
| AA-009 | Paths and verification records are bounded and repository-relative. | `task-outcomes.red.test.ts` |
| AA-010 | Persisted outcomes exclude prompts, responses, source, and absolute paths. | `task-outcomes.red.test.ts` |

## Slice 2 — trajectory lifecycle

| ID | Acceptance condition | Test |
|---|---|---|
| AA-011 | Intermediate `message_end` does not finalize a trajectory. | `trajectory-settlement.red.test.ts` |
| AA-012 | `agent_settled` finalizes exactly once. | `trajectory-settlement.red.test.ts` |
| AA-013 | Multi-turn tool work produces one task report. | `trajectory-settlement.red.test.ts` |
| AA-014 | Keylime inspection tools count as concrete evidence. | `trajectory-settlement.red.test.ts` |
| AA-015 | Discussion-only work is not penalized for using no tools. | `trajectory-settlement.red.test.ts` |
| AA-016 | Recovery is judged by final verification. | `trajectory-settlement.red.test.ts` |
| AA-017 | Unverified mutation is explicitly reported. | `trajectory-settlement.red.test.ts` |

## Slice 3 — live governance wiring

| ID | Acceptance condition | Test |
|---|---|---|
| AA-018 | Package manifest changes are repository-wide high risk. | `governance-wiring.red.test.ts` |
| AA-019 | Lockfile changes select full tests. | `governance-wiring.red.test.ts` |
| AA-020 | Deleted dependencies are high risk. | `governance-wiring.red.test.ts` |
| AA-021 | Passing checks appear in the governance snapshot. | `governance-wiring.red.test.ts` |
| AA-022 | Failed checks preserve diagnostics and are not generic errors. | `governance-wiring.red.test.ts` |
| AA-023 | Failed targeted checks widen impact and verification. | `governance-wiring.red.test.ts` |
| AA-024 | Verification evidence links to changed paths and context objects. | `governance-wiring.red.test.ts` |
| AA-025 | Rich impact reuses the one shared repository scan. | `governance-wiring.red.test.ts` |

## Slice 4 — promotion-grade runtime canaries

| ID | Acceptance condition | Test |
|---|---|---|
| AA-026 | Live canary samples retain complete aggregate metrics. | `canary-rollout.red.test.ts` |
| AA-027 | Equivalent runs share a stable fixture fingerprint. | `canary-rollout.red.test.ts` |
| AA-028 | Every candidate fixture has a raw baseline. | `canary-rollout.red.test.ts` |
| AA-029 | Active-control loss is zero tolerance. | `canary-rollout.red.test.ts` |
| AA-030 | Optimizer and evaluator must be independent. | `canary-rollout.red.test.ts` |
| AA-031 | Aggregate runs persist across sessions without private payloads. | `canary-rollout.red.test.ts` |

## Slice 5 — live delegation validation

| ID | Acceptance condition | Test |
|---|---|---|
| AA-032 | Issued contracts enter bounded live registry state. | `delegation-live.red.test.ts` |
| AA-033 | Read-only roles cannot return mutations. | `delegation-live.red.test.ts` |
| AA-034 | Unissued contract results are rejected. | `delegation-live.red.test.ts` |
| AA-035 | Valid evidence-only results are accepted without transcripts. | `delegation-live.red.test.ts` |
| AA-036 | One-use contracts are consumed after acceptance. | `delegation-live.red.test.ts` |
| AA-037 | Expired contracts are rejected before evidence ingestion. | `delegation-live.red.test.ts` |
| AA-038 | Initial live roles cannot recursively delegate and concurrency is bounded. | `delegation-live.red.test.ts` |

## Slice 6 — shared subprocess sandbox seam

| ID | Acceptance condition | Test |
|---|---|---|
| AA-039 | Commands use argv execution and structural audit metadata. | `process-sandbox.red.test.ts` |
| AA-040 | Child cwd cannot escape the repository. | `process-sandbox.red.test.ts` |
| AA-041 | Secrets are removed from the child environment by default. | `process-sandbox.red.test.ts` |
| AA-042 | Stdout/stderr are bounded with truncation metadata. | `process-sandbox.red.test.ts` |
| AA-043 | Timeout enforcement terminates children promptly. | `process-sandbox.red.test.ts` |
| AA-044 | Observe mode reports the enforce-mode sandbox plan. | `process-sandbox.red.test.ts` |
| AA-045 | Enforce mode fails closed when its backend is unavailable. | `process-sandbox.red.test.ts` |

## Slice 7 — observe-only routing and LSP evidence

| ID | Acceptance condition | Test |
|---|---|---|
| AA-046 | Routing records recommendation versus actual without applying it. | `routing-and-lsp.red.test.ts` |
| AA-047 | Routing is deterministic and explained. | `routing-and-lsp.red.test.ts` |
| AA-048 | Routing observations join settled outcomes and successful-task cost. | `routing-and-lsp.red.test.ts` |
| AA-049 | Routing telemetry excludes prompts, responses, and absolute paths. | `routing-and-lsp.red.test.ts` |
| AA-050 | LSP adapters normalize all bounded reference locations. | `routing-and-lsp.red.test.ts` |
| AA-051 | Find-references responses produce dependency edges. | `routing-and-lsp.red.test.ts` |
| AA-052 | Unproven external locations are rejected. | `routing-and-lsp.red.test.ts` |
| AA-053 | Fresh LSP edges affect live impact without Keylime owning an LSP process. | `routing-and-lsp.red.test.ts` |

## Commands

```sh
bun test tests/agentic-augmentation-red
bun run typecheck:tests
```

## Green-order rule

Implement in ID order unless an earlier slice exposes a prerequisite. Each production change should cite the AA IDs it turns green, and targeted checks should run only the affected file plus `typecheck:tests` before broader verification.
