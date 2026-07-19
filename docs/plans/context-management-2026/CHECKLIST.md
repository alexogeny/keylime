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
- [ ] Extend usage tracking with v2 context/cache records without message bodies.
- [ ] Bind project-planner state to repository identity with explicit legacy adoption.
- [ ] Bind agent-OS state to repository identity and quarantine mismatches.
- [ ] Run targeted slice-1 tests.
- [ ] Run full typecheck and test suite.

## Slice 2 — deferred tools and stable context

- [ ] Write red tests for bootstrap tools, additive discovery, policy gates, and schema budgets.
- [ ] Implement shared tool catalog using existing retrieval primitives.
- [ ] Implement Pi-native `tool_search` loader.
- [ ] Split mandatory/bootstrap/searchable tool policy.
- [ ] Preserve additive tools during a turn and reset at the next user boundary.
- [ ] Memoize declared-stable context providers by dependency fingerprint.
- [ ] Add schema/guideline character regression budgets.
- [ ] Verify intent, safety, and context tests.

## Slice 3 — typed context-object lifecycle

- [ ] Write red tests for storage, selectors, tamper detection, reducers, and lifecycle operations.
- [ ] Add shared context-object contracts.
- [ ] Implement atomic context-object store and bounded recovery tool.
- [ ] Add typed reducers for tests, searches, reads, mutations, research, and fallback output.
- [ ] Exempt failures, safety denials, and mutation evidence from generic reduction.
- [ ] Move duplicate-read folding out of cache guard.
- [ ] Remove overlapping generic cache-guard truncation.
- [ ] Add pinned/reference-aware cleanup and legacy result compatibility.
- [ ] Verify lifecycle, compactor, cache, and security tests.

## Slice 4 — structured compaction and unified working memory

- [ ] Write red tests for checkpoint schema, evidence validation, fallback, retention, and memory deltas.
- [ ] Add TypeBox compaction checkpoint schema.
- [ ] Implement `session_before_compact` extension with deterministic fallback.
- [ ] Pin context objects referenced by checkpoints.
- [ ] Add repository-bound unified working-set retrieval adapters.
- [ ] Add incremental add/supersede/resolve/expire memory deltas.
- [ ] Add pressure readiness snapshot without proactive repeated model calls.
- [ ] Verify compaction, agent-OS, project, and memory tests.

## Slice 5 — precision-first retrieval and bounded pipelines

- [ ] Write gold-region retrieval budget and utilization tests.
- [ ] Add ranked code-region contracts and overlap-aware budgets.
- [ ] Add structural evidence to existing hybrid ranking.
- [ ] Track explored-versus-utilized identifiers without source bodies.
- [ ] Write red tests for allowlists, budgets, cancellation, redaction, and partial failure.
- [ ] Implement bounded read-only aggregation pipeline without arbitrary execution.
- [ ] Integrate compact source/object references into research workflows.
- [ ] Verify retrieval, repo-index, pipeline, and research tests.

## Slice 6 — evaluation and release gates

- [ ] Add synthetic trajectory fixture contract and helpers.
- [ ] Add tool-selection thesis fixtures.
- [ ] Add typed-reducer and exact-recovery fixtures.
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
