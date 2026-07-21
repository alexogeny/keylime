# Pi harness token-efficiency roadmap (July 2026)

## Goal

Reduce **successful-task spend** in Keylime's Pi harness without weakening task success, exact constraint retention, mutation evidence, failure recovery, security controls, or repository grounding.

The optimization target is not the footer's cumulative `↑` value. It is the combined cost of uncached input, cache reads/writes, output/reasoning, tool-discovery calls, compression calls, retries, and additional turns required to finish a task successfully.

## Evidence behind the plan

- Pi extensions can transform outbound messages through `context`, compact through `session_before_compact`, inspect final provider payloads through `before_provider_request`, measure usage at `message_end`, bound tool output at `tool_result`, select tools with `setActiveTools`, and persist non-message state with custom entries.
- Anthropic's context-engineering guidance recommends just-in-time retrieval, compact tool results, compaction, and durable external memory rather than filling the available context window.
- AgentDiet reports 39.9–59.7% lower coding-agent input tokens and 21.1–35.9% lower total computational cost in its evaluated setup.
- ACON reports 26–54% lower peak token usage while improving task success over its evaluated compression baselines.
- OpenAI tool search and VS Code's 2026 Copilot work support deferred schemas, but cache-prefix stability and extra discovery turns determine whether deferral is a net saving.

These are hypotheses to reproduce on Keylime's workload, not guaranteed production savings.

## Existing foundation

Do not replace working context infrastructure:

- `extensions/context-runtime.ts` owns deterministic observation lifecycle and context transformation.
- `extensions/tool-result-compactor.ts` stores large outputs and returns bounded previews.
- `extensions/structured-compaction.ts` owns custom structured compaction.
- `extensions/intent-router.ts` and `extensions/policy-tools.ts` own deterministic preactivation and deferred discovery.
- `extensions/shared/context-ledger.ts` records category sizes, fingerprints, and transforms.
- `extensions/usage-tracker.ts`, `extensions/cache-guard.ts`, and `extensions/passive-context-telemetry.ts` record provider and cache telemetry.
- `extensions/turn-context-composer.ts` caps per-turn provider reminders.

New modules are narrow shared decision engines. Extension wiring should call them rather than add additional independent `context` mutation owners.

## Slice 1 — truthful spend accounting

### RED contract

`tests/token-efficiency-red/spend-accounting.red.test.ts`

### Implementation target

Create `extensions/shared/spend-accounting.ts` and wire it into usage/context telemetry and the footer.

### Plan

1. Define nullable normalized usage fields: uncached input, cache read, cache write, output, reasoning where available, and reported cost.
2. Keep deterministic context characters distinct from provider tokens.
3. Separate current active context, current model call, current user turn, branch totals, and task totals.
4. Attribute auxiliary tool-search and compression calls to the same task.
5. Replace ambiguous footer labels with explicit current/turn/branch semantics.
6. Preserve raw provider-reported fields for future adapter corrections.

### Exit criteria

All five accounting tests pass; missing fields remain unknown; old telemetry migrations work; footer and usage tests pass.

## Slice 2 — cache-prefix observability

### RED contract

`tests/token-efficiency-red/prompt-prefix-profiler.red.test.ts`

### Implementation target

Create `extensions/shared/prompt-prefix-profiler.ts`, called read-only from `before_provider_request` and the context ledger.

### Plan

1. Canonically serialize the exact ordered provider prefix, preserving tool order and schema text.
2. Partition system instructions, tools, stable history, and volatile suffix.
3. Record an order-sensitive hash and first changed path without storing message bodies.
4. Attribute cache busts to system, tool set, tool order, schema, stable history, or provider serialization.
5. Compare static, intent-preactivated, and search-deferred strategies by successful-task cost rather than schema size alone.
6. Keep profiling observational until replay evidence supports a routing change.

### Exit criteria

The profiler explains known synthetic cache hits/misses, contains no raw private text in persisted records, and all five prefix tests pass.

## Slice 3 — deterministic trajectory reduction

### RED contract

`tests/token-efficiency-red/trajectory-reducer.red.test.ts`

### Implementation target

Create `extensions/shared/trajectory-reducer.ts` and integrate it through the existing `context-runtime.ts` mutation path.

### Plan

1. Classify trajectory items as protected, hot, warm, recoverable, superseded, or failure evidence.
2. Replace stale recoverable tool results with durable context-object references.
3. Preserve exact user constraints, decisions, mutation results, verification, unresolved failures, and safety state.
4. Fold resolved failures into bounded fingerprints instead of deleting all error evidence.
5. Validate tool-call/tool-result pairing after every transform.
6. Emit deterministic per-item actions and reasons into the context ledger.
7. Add replay fixtures for coding, research, debugging, and failed-mutation trajectories.

### Exit criteria

All five reduction tests and existing context-thesis safety tests pass; measured reduction is positive; no protected-state category regresses.

## Slice 4 — compaction and cross-session handoff

### RED contract

`tests/token-efficiency-red/session-handoff.red.test.ts`

### Implementation target

Create `extensions/shared/session-handoff.ts`, consumed by `structured-compaction.ts` and a later explicit handoff command.

### Plan

1. Base automatic decisions on active-context pressure, task boundaries, projected next-turn cost, and checkpoint quality—not cumulative branch totals.
2. Preserve repository facts, external research, user intent, and suggestions as separate typed sources.
3. Generate a bounded bootstrap from checkpoint state and targeted retrieval, never by replaying the full transcript.
4. Validate required constraints, mutations, failures, and next actions against source IDs.
5. Use an optional cheaper sidecar only for reclaimable prose; keep the main model unchanged and validate sidecar output deterministically.
6. Retain the existing structured-compaction fallback and timeout behavior.

### Exit criteria

All five handoff tests and existing compaction security/control-plane tests pass; continuation evaluation shows no exact-state regression.

## Slice 5 — successful-task release gates

### RED contract

`tests/token-efficiency-red/token-efficiency-evaluation.red.test.ts`

### Implementation target

Create `extensions/shared/token-efficiency-evaluation.ts` and add a deterministic replay report to the existing context benchmark.

### Plan

1. Compare baseline and candidate by task success, total cost, model calls, median turns, input/cache/output mix, and latency where available.
2. Count discovery, compression, routing, retries, and subagent calls.
3. Require category-specific replay coverage: tool schemas, trajectories, compaction continuation, exact constraints, failure recovery, and cross-session handoff.
4. Reject lower-token candidates that exceed quality, turn-count, or call-count tolerances.
5. Persist aggregate numeric records only; never prompts, messages, source bodies, or tool output.
6. Roll out policies in observe-only, canary, then default stages.

### Initial release gates

- At least 20% lower median successful-task cost.
- No more than 1 percentage point task-success regression.
- No increase in median turns.
- No protected-state or safety-category regression.
- No unaccounted auxiliary model calls.
- Privacy inspection confirms aggregate-only telemetry.

## Execution order

1. Spend accounting
2. Prefix profiling in observe-only mode
3. Trajectory reduction in replay, then canary mode
4. Handoff/compaction improvements
5. Evaluation gates and controlled defaults

Do not optimize tool activation or compaction thresholds before slices 1 and 2 can explain whether a change saved uncached spend, improved cache reuse, or merely changed the displayed total.

## Verification commands

During implementation:

```bash
bun test tests/token-efficiency-red/<current-file>
bun run typecheck
bun run typecheck:tests
bun run test:context
bun run bench:context
```

Before enabling a behavior by default:

```bash
bun test tests
```

A RED file becomes a permanent regression contract when green.
