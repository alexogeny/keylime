# Keylime context-management roadmap (July 2026)

## Goal

Evolve Keylime from transcript-oriented context trimming into a measured, cache-aware, recoverable context runtime for Pi. The implementation should reduce recurring tool-schema and trajectory tokens without dropping exact constraints, code locators, failures, mutation evidence, or safety state.

This roadmap is split into independently testable slices. Each slice starts with red tests that prove its thesis before production behavior changes.

## Repo conventions / constraints

- Extend the existing Pi extensions and shared retrieval primitives; add no dependency unless a later implementation proves the native TypeScript approach inadequate.
- Use Pi 0.80.6 extension seams already available in this repo: `context`, `tool_result`, `session_before_compact`, `message_end`, `provider_payload`, `getAllTools()`, and additive `setActiveTools()`.
- Preserve deterministic safety in `extensions/danger-guard.ts`, `extensions/shared/safety-policy.ts`, and `extensions/shared/tool-policy.ts`. Retrieval or model output must never weaken a hard rule.
- Keep raw `bash`, built-in `read`, `write`, and `edit` locked as documented.
- Keep full evidence recoverable when active context receives a reduced representation.
- Store local operational state under `.pi/`; do not add generated state to normal checkpoint commits.
- Use Bun tests and the existing `tests/helpers/mock-pi.ts` fixture style.
- Keep each implementation and test change narrow enough to verify with targeted `bun test` commands before the full suite.

## Sequencing and dependencies

1. [`01-observability-and-state-isolation.md`](01-observability-and-state-isolation.md)
   - Establishes token attribution, transformation telemetry, and repository-bound state.
   - Must land first because every later token-reduction claim depends on it.
2. [`02-deferred-tools-and-stable-context.md`](02-deferred-tools-and-stable-context.md)
   - Reduces prompt-schema tokens using Pi-native additive tool discovery.
   - Uses the ledger from slice 1 to prove schema reduction and cache-prefix stability.
3. [`03-context-object-lifecycle.md`](03-context-object-lifecycle.md)
   - Replaces overlapping generic compaction with typed, recoverable context objects and reducers.
4. [`04-structured-compaction-and-memory.md`](04-structured-compaction-and-memory.md)
   - Adds validated compaction checkpoints and repository-aware working memory on top of context objects.
5. [`05-retrieval-and-bounded-pipelines.md`](05-retrieval-and-bounded-pipelines.md)
   - Improves relevant-line precision and adds safe aggregation before intermediate data reaches the model.
6. [`06-evaluation-and-release-gates.md`](06-evaluation-and-release-gates.md)
   - Adds trajectory replay and quality gates. Fixture scaffolding can begin earlier, but release gates depend on all prior metrics.

## Shared contracts to converge on

The exact types may be introduced incrementally, but all slices should converge on these concepts rather than create parallel telemetry formats.

```ts
type ContextCategory =
  | "system"
  | "tool_schema"
  | "tool_guideline"
  | "turn_provider"
  | "history"
  | "tool_result"
  | "memory"
  | "compaction";

type ContextTransform = {
  id: string;
  kind: "dedupe" | "reduce" | "fold" | "mask" | "prune" | "compact";
  sourceId?: string;
  beforeChars: number;
  afterChars: number;
  recoverable: boolean;
  reason: string;
};

type ContextLedgerRecord = {
  ts: number;
  turnIndex?: number;
  modelId?: string;
  provider?: string;
  activeToolFingerprint: string;
  categories: Partial<Record<ContextCategory, { chars: number; tokens?: number }>>;
  transforms: ContextTransform[];
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
```

Character counts are the provider-independent baseline. Record exact token counts only when Pi/provider usage exposes them; do not introduce a tokenizer dependency merely to fabricate precision.

## Cross-cutting correctness rules

- A reduction is allowed only when the removed payload is reconstructable or explicitly classified as disposable.
- Failed tool results, blocked safety operations, unresolved user constraints, mutation confirmations, and verification failures must not use generic retention rules.
- A generated summary is not evidence. It must point to source entries or stored context objects.
- Repository-local state must carry a repository identity and must not inject when identity validation fails.
- Tool search may add capabilities but must not remove hard safety tools during an active turn.
- Stable/session context must not be regenerated or relocated merely because a tool result caused another context pass.
- Token reduction cannot pass release gates if task success, safety retention, or exact recovery regresses.

## Primary proof points

The project should be able to demonstrate these statements with tests and fixture reports:

1. A coding request starts with a bounded bootstrap tool set, then loads only matching tools additively.
2. A large test/search/read result becomes a typed compact view and can be recovered by exact section, path, or line range.
3. A failed result keeps causal diagnostics even when much larger than the normal threshold.
4. Compaction preserves goal, constraints, changes, verification, blockers, and evidence IDs in a validated schema.
5. State belonging to another repository is quarantined instead of injected.
6. Context reports distinguish token savings from prompt-cache savings.
7. Fixed-budget repository retrieval improves precision/utilization without reducing required-line recall.

## Files likely added

```text
extensions/context-ledger.ts
extensions/tool-search.ts
extensions/context-object-store.ts
extensions/structured-compaction.ts
extensions/bounded-tool-pipeline.ts
extensions/shared/context-ledger.ts
extensions/shared/context-objects.ts
extensions/shared/tool-catalog.ts
extensions/shared/repository-identity.ts
extensions/shared/compaction-schema.ts
tests/context-ledger.test.ts
tests/tool-search.test.ts
tests/context-object-store.test.ts
tests/structured-compaction.test.ts
tests/repository-identity.test.ts
tests/bounded-tool-pipeline.test.ts
tests/context-evals/
```

Naming can be adjusted during implementation to avoid tiny modules, but functionality should extend existing shared infrastructure instead of duplicating retrieval, JSON storage, retention, or preview helpers.

## Completion definition

The roadmap is complete when the full test suite passes and the context-eval report proves all configured budgets and quality floors. A reduction in raw input characters alone is not completion.
