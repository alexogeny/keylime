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

- [ ] Create `extensions/shared/spend-accounting.ts`.
- [ ] Preserve unknown provider fields as `null`, never inferred zero.
- [ ] Separate deterministic character counts from reported token counts.
- [ ] Separate active context, current call, current turn, branch, and task totals.
- [ ] Include tool-search, compression, routing, retry, and delegation calls in task totals.
- [ ] Wire normalized records into `usage-tracker.ts` and passive telemetry.
- [ ] Replace the ambiguous cumulative footer display.
- [ ] Add telemetry migration/backward-compatibility tests.
- [ ] Turn `spend-accounting.red.test.ts` green.

## Slice 2 — prompt-prefix profiling

- [ ] Create `extensions/shared/prompt-prefix-profiler.ts`.
- [ ] Define provider payload adapters without retaining payload bodies.
- [ ] Produce order-sensitive reusable-prefix fingerprints.
- [ ] Partition system, tools, stable history, and volatile suffix.
- [ ] Attribute first cache-significant change and category.
- [ ] Measure active tool schema characters and ordering.
- [ ] Compare static, preactivated, and deferred tool strategies by successful-task cost.
- [ ] Wire observe-only profiling into `before_provider_request`.
- [ ] Add privacy tests for persisted prefix diagnostics.
- [ ] Turn `prompt-prefix-profiler.red.test.ts` green.

## Slice 3 — deterministic trajectory reduction

- [ ] Create `extensions/shared/trajectory-reducer.ts`.
- [ ] Define protected/hot/warm/recoverable/superseded/failure states.
- [ ] Reuse context-object IDs for recoverable tool results.
- [ ] Preserve exact constraints, decisions, mutations, verification, failures, and safety state.
- [ ] Fold resolved failures into bounded evidence instead of deleting them.
- [ ] Validate tool-call/tool-result pairing after reduction.
- [ ] Emit deterministic item-level reduction reasons.
- [ ] Integrate through `context-runtime.ts` as the single context-mutation owner.
- [ ] Add coding, research, debugging, and failed-mutation replay fixtures.
- [ ] Turn `trajectory-reducer.red.test.ts` green.

## Slice 4 — compaction and session handoff

- [ ] Create `extensions/shared/session-handoff.ts`.
- [ ] Base decisions on active pressure, task boundaries, projected cost, and checkpoint quality.
- [ ] Keep repository facts, external facts, user intent, and suggestions typed separately.
- [ ] Validate checkpoint coverage against protected source IDs.
- [ ] Build bounded transcript-free session bootstrap messages.
- [ ] Add an explicit handoff command after the shared contract is green.
- [ ] Add optional cheap-sidecar compression for reclaimable prose only.
- [ ] Validate sidecar output and preserve the main model selection.
- [ ] Integrate with structured compaction without weakening current fail-closed behavior.
- [ ] Turn `session-handoff.red.test.ts` green.

## Slice 5 — evaluation and rollout

- [ ] Create `extensions/shared/token-efficiency-evaluation.ts`.
- [ ] Count every primary and auxiliary model call.
- [ ] Calculate successful-task cost and token/cache/output deltas.
- [ ] Gate task success, median turns, call count, and safety categories independently.
- [ ] Require category-specific replay coverage.
- [ ] Persist aggregate-only evaluation samples.
- [ ] Add observe-only reports to the existing context benchmark.
- [ ] Run static-tool versus preactivation versus deferred-tool experiments.
- [ ] Run threshold and task-boundary compaction experiments.
- [ ] Establish baseline confidence intervals from repeated deterministic fixtures where applicable.
- [ ] Turn `token-efficiency-evaluation.red.test.ts` green.

## Final release gate

- [ ] All 25 token-efficiency RED tests are green.
- [ ] Existing harness-thesis, compaction, security, retrieval, and context tests remain green.
- [ ] Source and test typechecks pass.
- [ ] Median successful-task cost improves by at least 20% on the agreed corpus.
- [ ] Task-success regression is at most one percentage point.
- [ ] Median turn count does not increase.
- [ ] No protected-state, exact-constraint, mutation, failure, or safety regression.
- [ ] Telemetry contains no prompt, message, source, or tool-output bodies.
- [ ] Default enablement follows observe-only and canary evidence.
