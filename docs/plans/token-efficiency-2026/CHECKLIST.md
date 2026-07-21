# Token-efficiency implementation checklist

Last updated: 2026-07-21

Status key: `[ ]` pending · `[~]` in progress · `[x]` complete · `[!]` blocked

## RED contract

- [x] Document the research-driven roadmap and release gates.
- [x] Add RED spend-accounting contracts.
- [x] Add RED prompt-prefix/cache-stability contracts.
- [x] Add RED trajectory-reduction contracts.
- [x] Add RED compaction and cross-session handoff contracts.
- [x] Add RED successful-task evaluation contracts.
- [x] Verify all 25 tests are discovered and fail for missing production modules.

## Slice 1 — truthful spend accounting

- [x] Create `extensions/shared/spend-accounting.ts`.
- [x] Preserve unknown provider fields as `null`, never inferred zero.
- [x] Separate deterministic character counts from reported token counts.
- [x] Separate active context, current call, current turn, branch, and task totals.
- [x] Include tool-search, compression, routing, retry, and delegation calls in task totals.
- [~] Wire normalized records into `usage-tracker.ts`; passive telemetry remains pending.
- [x] Replace the ambiguous cumulative footer display.
- [ ] Add telemetry migration/backward-compatibility tests.
- [x] Turn `spend-accounting.red.test.ts` green.

## Slice 2 — prompt-prefix profiling

- [x] Create `extensions/shared/prompt-prefix-profiler.ts`.
- [x] Define provider payload adapters without retaining payload bodies.
- [x] Produce order-sensitive reusable-prefix fingerprints.
- [x] Partition system, tools, stable history, and volatile suffix.
- [x] Attribute first cache-significant change and category.
- [x] Measure active tool schema characters and ordering.
- [x] Compare static, preactivated, and deferred tool strategies by successful-task cost.
- [x] Wire observe-only profiling into `before_provider_request`.
- [x] Add privacy tests for persisted prefix diagnostics.
- [x] Turn `prompt-prefix-profiler.red.test.ts` green.

## Slice 3 — deterministic trajectory reduction

- [x] Create `extensions/shared/trajectory-reducer.ts`.
- [~] Define protected/hot/warm/recoverable/superseded/failure states.
- [x] Reuse context-object IDs for recoverable tool results.
- [x] Preserve exact constraints, decisions, mutations, verification, failures, and safety state.
- [x] Fold resolved failures into bounded evidence instead of deleting them.
- [x] Validate tool-call/tool-result pairing after reduction.
- [x] Emit deterministic item-level reduction reasons.
- [ ] Integrate through `context-runtime.ts` as the single context-mutation owner.
- [ ] Add coding, research, debugging, and failed-mutation replay fixtures.
- [x] Turn `trajectory-reducer.red.test.ts` green.

## Slice 4 — compaction and session handoff

- [x] Create `extensions/shared/session-handoff.ts`.
- [~] Base decisions on active pressure, task boundaries, projected cost, and checkpoint quality.
- [x] Keep repository facts, external facts, user intent, and suggestions typed separately.
- [x] Validate checkpoint coverage against protected source IDs.
- [x] Build bounded transcript-free session bootstrap messages.
- [ ] Add an explicit handoff command after the shared contract is green.
- [x] Add a pure cheap-sidecar compression route plan; runtime execution remains pending.
- [ ] Validate sidecar output and preserve the main model selection.
- [ ] Integrate with structured compaction without weakening current fail-closed behavior.
- [x] Turn `session-handoff.red.test.ts` green.

## Slice 5 — evaluation and rollout

- [x] Create `extensions/shared/token-efficiency-evaluation.ts`.
- [x] Count every primary and auxiliary model call supplied by the task ledger.
- [x] Calculate successful-task cost and token/cache/output deltas.
- [x] Gate task success, median turns, and call count independently; runtime safety feeds remain pending.
- [x] Require category-specific replay coverage.
- [x] Persist aggregate-only evaluation samples.
- [ ] Add observe-only reports to the existing context benchmark.
- [ ] Run static-tool versus preactivation versus deferred-tool experiments.
- [ ] Run threshold and task-boundary compaction experiments.
- [ ] Establish baseline confidence intervals from repeated deterministic fixtures where applicable.
- [x] Turn `token-efficiency-evaluation.red.test.ts` green.

## Final release gate

- [x] All 29 token-efficiency RED tests are green.
- [x] Existing harness-thesis, compaction, security, retrieval, and context tests remain green.
- [x] Source and test typechecks pass.
- [ ] Median successful-task cost improves by at least 20% on the agreed corpus.
- [ ] Task-success regression is at most one percentage point.
- [ ] Median turn count does not increase.
- [ ] No protected-state, exact-constraint, mutation, failure, or safety regression.
- [ ] Telemetry contains no prompt, message, source, or tool-output bodies.
- [ ] Default enablement follows observe-only and canary evidence.
