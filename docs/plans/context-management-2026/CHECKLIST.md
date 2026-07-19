# Context-management implementation checklist

Last updated: 2026-07-19

Status key: `[ ]` pending · `[~]` in progress · `[x]` complete · `[!]` blocked

## Slice 1 — observability and repository-bound state

- [x] Add persistent implementation checklist.
- [x] Write red tests for repository identity matching, mismatch, legacy state, and canonical paths.
- [x] Implement `extensions/shared/repository-identity.ts`.
- [x] Write red tests for context category and transform accounting.
- [x] Implement `extensions/shared/context-ledger.ts`.
- [x] Add provider fingerprints and contribution diagnostics to turn context.
- [x] Extend usage tracking with v2 context/cache records without message bodies.
- [x] Bind project-planner state to repository identity with explicit legacy adoption.
- [x] Bind agent-OS state to repository identity and quarantine mismatches.
- [x] Run targeted slice-1 tests.
- [x] Run full typecheck and test suite.

## Slice 2 — deferred tools and stable context

- [x] Write red tests for bootstrap tools, additive discovery, policy gates, and schema budgets.
- [x] Implement shared tool catalog using existing retrieval primitives.
- [x] Implement Pi-native `tool_search` loader.
- [x] Split mandatory/bootstrap/searchable tool policy.
- [x] Preserve additive tools during a turn and reset at the next user boundary.
- [x] Memoize declared-stable context providers by dependency fingerprint.
- [x] Add schema/guideline character regression budgets.
- [x] Verify intent, safety, and context tests.

## Slice 3 — typed context-object lifecycle

- [x] Write red tests for storage, selectors, tamper detection, reducers, and lifecycle operations.
- [x] Add shared context-object contracts.
- [x] Implement atomic context-object store and bounded recovery tool.
- [x] Add typed reducers for tests, searches, reads, mutations, research, and fallback output.
- [x] Exempt failures, safety denials, and mutation evidence from generic reduction.
- [x] Move duplicate-read folding out of cache guard.
- [x] Remove overlapping generic cache-guard truncation.
- [x] Add pinned/reference-aware cleanup and legacy result compatibility.
- [x] Verify lifecycle, compactor, cache, and security tests.

## Slice 4 — structured compaction and unified working memory

- [x] Write red tests for checkpoint schema, evidence validation, fallback, retention, and memory deltas.
- [x] Add TypeBox compaction checkpoint schema.
- [x] Implement `session_before_compact` extension with deterministic fallback.
- [x] Pin context objects referenced by checkpoints.
- [x] Add repository-bound unified working-set retrieval adapters.
- [x] Add incremental add/supersede/resolve/expire memory deltas.
- [x] Add pressure readiness snapshot without proactive repeated model calls.
- [x] Verify compaction, agent-OS, project, and memory tests.

## Slice 5 — precision-first retrieval and bounded pipelines

- [x] Write gold-region retrieval budget and utilization tests.
- [x] Add ranked code-region contracts and overlap-aware budgets.
- [x] Add structural evidence to existing hybrid ranking.
- [x] Track explored-versus-utilized identifiers without source bodies.
- [x] Write red tests for allowlists, budgets, cancellation, redaction, and partial failure.
- [x] Implement bounded read-only aggregation pipeline without arbitrary execution.
- [x] Integrate compact source/object references into research workflows.
- [x] Verify retrieval, repo-index, pipeline, and research tests.

## Slice 6 — evaluation and release gates

- [x] Add synthetic trajectory fixture contract and helpers.
- [x] Add tool-selection thesis fixtures.
- [x] Add typed-reducer and exact-recovery fixtures.
- [ ] Add compaction continuation and constraint-retention fixtures.
- [ ] Add repository retrieval quality fixtures.
- [ ] Add stale-state and end-to-end safety fixtures.
- [ ] Add `test:context` and local `bench:context` scripts.
- [ ] Document per-fixture quality and reduction budgets.
- [ ] Run full release gates and update roadmap documentation.

## Current work log

- 2026-07-19: Research and six implementation slices documented.
- 2026-07-19: Began slice 1; repository identity and context-ledger pure contracts are the first TDD target.
- 2026-07-19: Repository identity, context ledger, and provider fingerprint tests reached green; state and usage integration remain.
- 2026-07-19: Slice 1 complete: project/agent state quarantine and explicit adoption, v2 cache/context usage records, 30 targeted tests, typecheck, and full 445-test suite pass.
- 2026-07-19: Began slice 2 red-test reconnaissance for deferred tools and schema budgets.
- 2026-07-19: Extended existing `policy-tools.ts` tool search to add up to five available matches additively, exclude locked built-ins, and honor disabled research; policy tests and typecheck pass.
- 2026-07-19: Slice 2 complete: six-tool bootstrap, shared retrieval-backed catalog, mode/research gates, per-turn discovery continuity/reset, stable-provider memoization contract, schema budget, docs, and full 454-test suite pass.
- 2026-07-19: Began slice 3 red-test planning for typed context objects and exact recovery selectors.
- 2026-07-19: Added typed context-object contracts with SHA-256 verification, named/line selectors, original line numbers, and selector validation; 3 focused tests and typecheck pass.
- 2026-07-19: Slice 3 complete: atomic verified store, exact bounded recovery, typed test/search reducers, protected errors/mutations, duplicate folding, transitive pinned cleanup, legacy result compatibility, cache-guard separation, docs, and full 468-test suite pass.
- 2026-07-19: Began slice 4 red-test planning for validated structured compaction checkpoints.
- 2026-07-19: Added the first structured-checkpoint RED tests; they initially failed because `shared/compaction-schema.ts` did not exist.
- 2026-07-19: Slice 4 complete: TypeBox checkpoint schema plus deterministic validation/rendering, Pi hook with active-model JSON generation and default fallback, evidence verification/pinning, 65% readiness snapshots, repository-filtered working-set retrieval, incremental deltas, checkpoint adapters, docs, and full 477-test suite pass.
- 2026-07-19: Began slice 5 red-test planning for overlap-aware fixed-budget code-region ranking.
- 2026-07-19: Added overlap-aware ranked regions, ripgrep match/context parsing, optional `code_search` line/character/file budgets with metrics, and repository/task-scoped utilization contracts that retain identifiers and counts but no source text; focused tests and typecheck pass.
- 2026-07-19: Added the fixed-operation `bounded_tool_pipeline` over verified context-object JSON rows with deterministic filter/sort/select/aggregate operators, preflight safety checks, cancellation/wall-clock/call/intermediate/output budgets, recoverable oversized sidecars, and structured partial failures. Web research now returns compact claims, source URLs, fetch timestamps, and exact object IDs while preserving raw results in the verified store.
- 2026-07-19: Slice 5 complete: region ranking and metrics, identifier-only utilization, bounded aggregation, compact research references, docs, typecheck, and full 494-test suite pass.
- 2026-07-19: Began Slice 6 with deterministic trajectory/metrics/release-gate helpers, category-specific failure checks for over-aggressive and over-budget output, tool-selection discovery/schema fixtures, and typed failing-test reduction with exact verified section recovery; focused tests and typecheck pass.
