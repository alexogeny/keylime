# Context-reduction thesis tests (RED)

These tests specify the researched context/token-reduction architecture before implementation. They are intentionally red until the corresponding production modules exist under `extensions/shared/`.

## Run

```sh
bun test tests/context-theses
```

## Thesis modules

- `observation-lifecycle.ts` — hot/warm/cold observation masking with exact recovery.
- `evidence-packets.ts` — intent-aware, budgeted, diverse repository evidence.
- `hierarchical-folding.ts` — proactive granular/deep immutable trajectory folds.
- `context-value-allocator.ts` — utility-per-token context budgeting.
- `cache-stable-context.ts` — deterministic stable-prefix assembly and tool masking.
- `retrieval-credit.ts` — evidence utilization attribution and adaptive budgets.
- `experience-memory.ts` — typed, repository-scoped cross-task experience reuse.
- `provider-compaction-policy.ts` — safe coordination with provider-native compaction.
- `context-efficiency-frontier.ts` — quality-gated end-to-end efficiency evaluation.

The suite deliberately requires safety, continuation-fact survival, exact recovery handles, deterministic output, and task-quality floors. Token reduction by itself is not considered success.
