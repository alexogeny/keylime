# Complete token-efficiency RED test matrix

Last updated: 2026-07-21

This matrix is the executable checklist for the entire researched token-efficiency roadmap. A roadmap item is not implementation-ready unless it has a test here. Green means production behavior exists; RED means implementation remains.

## Baseline

```text
77 tests discovered
29 green shared/initial integration contracts
48 RED runtime, migration, experiment, and rollout contracts
```

Run with:

```bash
bun run test:token-efficiency:red
```

The repository-wide suite is intentionally RED while these contracts are open. Source and test typechecks must remain green.

## Foundation contracts — currently green

| Area | File | Tests | Coverage |
|---|---|---:|---|
| Spend accounting | `spend-accounting.red.test.ts` | 6 | Active/current/branch/task separation, nullable usage, cache fields, auxiliary costs, footer semantics, usage snapshot |
| Prefix profiling | `prompt-prefix-profiler.red.test.ts` | 8 | Prefix boundaries, order sensitivity, schema changes, category size, strategy comparison, provider adaptation, privacy, safe prior diff |
| Trajectory reducer | `trajectory-reducer.red.test.ts` | 5 | Recoverable references, protected state, tool pairing, bounded failures, deterministic audit |
| Handoff decisions | `session-handoff.red.test.ts` | 5 | Pressure/boundary decisions, typed facts, bounded bootstrap, sidecar route plan, checkpoint validation |
| Evaluation primitives | `token-efficiency-evaluation.red.test.ts` | 5 | Quality gates, auxiliary calls, acceptance, coverage, aggregate privacy |

## Runtime and completion contracts — currently RED

### Telemetry migration and attribution

| ID | Test | Resolves |
|---|---|---|
| TE-030 | Migrate v1 without invented cache/cost | Backward compatibility |
| TE-031 | Migrate v2 preserving provider/context fields | Backward compatibility |
| TE-032 | Normalize passive telemetry with shared vocabulary | Passive telemetry wiring |
| TE-033 | Attribute main/search/compression/retry/delegation calls | Complete task economics |
| TE-034 | Keep task open through queued follow-ups | Task lifecycle attribution |
| TE-035 | Strip prompt/response/source/tool bodies before persistence | End-to-end telemetry privacy |
| TE-036 | Restore branch totals and safe prefix state | Cross-session telemetry continuity |

File: `telemetry-runtime-integration.red.test.ts`

### Context-runtime trajectory integration and replay corpus

| ID | Test | Resolves |
|---|---|---|
| TE-040 | One context mutation owner | Integrate through `context-runtime.ts` |
| TE-041 | Full protected/hot/warm/recoverable/superseded/failure states | Complete lifecycle model |
| TE-042 | Exact protected controls survive runtime transform | Constraint safety |
| TE-043 | Recoverable context-object references remain resolvable | Object lifecycle integration |
| TE-044 | Runtime tool pairs remain valid | Provider message validity |
| TE-045 | Coding replay preserves changes/checks | Coding fixture |
| TE-046 | Research replay preserves typed fact separation | Research fixture |
| TE-047 | Debug replay preserves failed-attempt evidence | Debugging fixture |
| TE-048 | Failed mutation replay preserves rollback state | Failed-mutation fixture |

File: `trajectory-runtime-integration.red.test.ts`

### Economic compaction and handoff

| ID | Test | Resolves |
|---|---|---|
| TE-050 | Projected-cost compaction before pressure limit | Projected cost decision |
| TE-051 | Block compaction with inadequate checkpoint | Checkpoint quality decision |
| TE-052 | Build durable explicit handoff command plan | Handoff command contract |
| TE-053 | Consume bootstrap exactly once | Destination-session semantics |
| TE-054 | Validate sidecar retained source IDs | Sidecar output validation |
| TE-055 | Preserve main model and deterministic fallback | Sidecar execution safety |
| TE-056 | Merge handoff into structured typed compaction | Structured compaction integration |
| TE-057 | Fail closed on protected-state loss | Continuation safety |
| TE-058 | Register `/handoff` and session consumer | Pi extension registration |
| TE-059 | Persist checkpoint without transcript replay | Pi command behavior |
| TE-059b | Inject one bounded bootstrap | Pi session behavior |

Files: `handoff-compaction-runtime.red.test.ts`, `handoff-extension.red.test.ts`

### Experiments, benchmark reporting, and rollout

| ID | Test | Resolves |
|---|---|---|
| TE-060 | Observe-only report does not apply policy | Observe-only mode |
| TE-061 | Controlled tool strategy matrix | Static/preactivated/deferred experiment |
| TE-062 | Controlled threshold/boundary matrix | Compaction experiment |
| TE-063 | Confidence intervals from repeated fixtures | Statistical baseline |
| TE-064 | At least 20% cost reduction | Cost release gate |
| TE-065 | At most 1pp success regression | Quality release gate |
| TE-066 | No median-turn increase | Turn-count release gate |
| TE-067 | Independent runtime safety feeds | Protected-state release gates |
| TE-068 | Reject body-bearing reports | Evaluation privacy gate |
| TE-069 | Require observe-only evidence | Rollout stage 1 |
| TE-070 | Require passing canary evidence | Rollout stage 2 |
| TE-071 | Default only after both stages pass | Default enablement |
| TE-072 | Render economics in existing context report | Benchmark integration |

File: `evaluation-rollout-runtime.red.test.ts`

### Provider and tool economics

| ID | Test | Resolves |
|---|---|---|
| TE-080 | Anthropic cache-read/write normalization | Provider accounting |
| TE-081 | OpenAI cached-token normalization without double count | Provider accounting |
| TE-082 | Gemini cached-content normalization | Provider accounting |
| TE-083 | Unknown provider fields remain unknown | Provider-independent safety |
| TE-084 | Cache controls preserve stable prompt content | Provider cache integration |
| TE-085 | Respect implicit provider caching | Provider cache integration |
| TE-086 | Canonical tool order despite discovery order | Cache-prefix stability |
| TE-087 | Compare schemas, cache loss, discovery calls, success, and cost | Tool strategy economics |

File: `provider-tool-economics.red.test.ts`

## Roadmap-to-test completeness

| Roadmap deliverable | Test coverage |
|---|---|
| Truthful current/turn/branch/task spend | Foundation spend tests, TE-030–TE-036 |
| Provider-independent and provider-specific accounting | Foundation spend tests, TE-080–TE-083 |
| Prefix fingerprinting and cache-bust diagnosis | Foundation prefix tests, TE-084–TE-087 |
| Static/preactivated/deferred tools | Foundation strategy test, TE-061, TE-087 |
| Deterministic trajectory reduction | Foundation reducer tests, TE-040–TE-048 |
| Coding/research/debug/failure replays | TE-045–TE-048 |
| Pressure/boundary/projected-cost/checkpoint decisions | Foundation handoff tests, TE-050–TE-051 |
| Explicit cross-session handoff | TE-052–TE-053, TE-058–TE-059b |
| Cheap sidecar validation and fallback | TE-054–TE-055 |
| Structured compaction fail-closed integration | TE-056–TE-057 |
| Observe-only benchmark reporting | TE-060, TE-072 |
| Controlled tool and compaction experiments | TE-061–TE-062 |
| Repeated-run confidence intervals | TE-063 |
| Cost, success, turns, and safety release gates | TE-064–TE-067 |
| Aggregate-only privacy | Foundation privacy tests, TE-035, TE-068 |
| Observe-only → canary → default rollout | TE-069–TE-071 |

## Completion rule

The roadmap is complete only when all 77 tests are green without weakening assertions, all existing harness/security/context suites remain green, both typechecks pass, and the measured release gates pass on the agreed corpus. New roadmap scope must add a RED row here before production implementation.
