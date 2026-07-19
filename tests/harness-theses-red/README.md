# Agent-harness research theses — RED contract

This directory began as the intentionally failing acceptance contract for the agent-harness and token-reduction findings researched for **19 June–19 July 2026**. It remains the regression contract as implementation advances.

## Test-double policy

The suite uses:

- real production exports from `extensions/`;
- the real context runtime, allocator, evidence selector, checkpoint validator, telemetry store, and context-object store;
- real filesystem persistence in isolated temporary directories;
- the current Keylime repository for behavior localization;
- deterministic source entries, trajectories, evidence candidates, and benchmark runs as test data.

It does **not** use mocks, stubs, fake Pi APIs, patched globals, monkeypatches, intercepted model calls, or replacement implementations. Test-data constructors only create input records; they do not replace production behavior.

Some future production modules are loaded dynamically so Bun can discover and run every RED test even while those modules do not yet exist. A missing production module is itself the expected RED failure, rather than a test substitute.

## Thesis coverage

| File | Contract |
|---|---|
| `compaction-control-plane.red.test.ts` | Stable control IDs/hashes; byte-exact active constraints; durable plans, acceptance criteria and safety state; provenance; reference validation; authorized status transitions; active-file hashes. |
| `compaction-security.red.test.ts` | Relinking resistance; compaction-eviction resistance; trust-aware provenance; no permission synthesis; post-compaction security audit. |
| `runtime-durable-state.red.test.ts` | Constraints, plans and unresolved failures survive trajectory/observation bounds and repeated folds; mandatory overflow fails closed; semantic deduplication. |
| `exact-evidence.red.test.ts` | Exact source outranks prose summaries at edit time; content hashes and hydration; semantic diversity; behavioral-test inclusion; bounded clipping with recovery. |
| `quality-flywheel.red.test.ts` | Mandatory raw control; strategy-level repeated-run evaluation; independent evaluator; confidence intervals; non-inferiority; p95/fallback gates; cost per successful task; control-retention and relinking gates. |
| `harness-evolution.red.test.ts` | Static behavior handbook; behavior-guided progressive disclosure; source freshness; trace IR; runtime-to-source attribution; scoped repairs; regression-aware acceptance. |
| `execution-routing.red.test.ts` | Reasoning-off bounded extraction; local deterministic validation; stronger profiles only for ambiguous work; deterministic explainable routing. |
| `compaction-telemetry.red.test.ts` | Aggregate-only validity, fallback, latency, control-retention and security metrics without prompts, responses, source or repository paths. |

## Baseline RED state

At creation, the suite discovers **54 tests**: **53 fail** and **1 existing capability control passes**. The passing controls are not implementations of the missing theses; they demonstrate that the underlying current APIs and real storage paths execute.

```sh
bun test tests/harness-theses-red
bun run typecheck:tests
```

The implementation baseline is now **54 pass, 0 fail**. `typecheck:tests` remained green throughout RED. Tests transitioned to green through production behavior, without weakening assertions or introducing test doubles.

## Research anchors

- [What Context Does a Coding Agent Actually Need to Act?](https://arxiv.org/abs/2607.09691)
- [Safe to Check, Unsafe to Use](https://arxiv.org/abs/2606.21732)
- [Governance Decay](https://arxiv.org/abs/2606.22528)
- [Plans Don’t Persist](https://arxiv.org/abs/2606.22953)
- [ContextSniper](https://arxiv.org/abs/2607.01916)
- [HarnessFix](https://arxiv.org/abs/2606.06324)
- [ToFu](https://arxiv.org/abs/2607.11423)
- [Harness Handbook](https://arxiv.org/abs/2607.13285)
- [Google Agent Quality Flywheel](https://developers.googleblog.com/driving-the-agent-quality-flywheel-from-your-coding-agent/)
