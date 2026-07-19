# Slice 6 — context evaluation and release gates

## Goal

Add deterministic trajectory replay and fixture benchmarks that decide whether context reductions are safe to release. Evaluate token/character savings together with constraint retention, evidence recovery, retrieval quality, task outcomes, and safety invariants.

## Thesis

A smaller prompt is not necessarily a better prompt. Keylime needs tests that fail when an optimization saves context but damages future actions. Replay-based no-impact checks and fixed gold-context fixtures can make the roadmap’s central claim falsifiable.

## Evaluation layout

```text
tests/context-evals/
  fixtures/
    tool-selection/
    repository-retrieval/
    tool-results/
    compaction/
    stale-state/
    safety/
  helpers/
    trajectory.ts
    metrics.ts
    assertions.ts
  context-evals.test.ts
```

Fixtures should be synthetic or derived from repository-owned tests. Do not commit user conversations, local `.pi` payloads, secrets, or third-party copyrighted page bodies.

## Red tests — write first

### Tool-selection thesis

1. **`deferred catalog reduces initial schema characters by the configured floor`**.
2. **`every required tool remains discoverable within one loader call`**.
3. **`forbidden tools remain undiscoverable in restricted modes`**.
4. **`tool discovery does not reorder the stable prefix before the loader result`**.

### Context-object thesis

1. **`typed reducers beat generic head-tail on required-field retention`**.
2. **`every removed exact field is recoverable by object selector`**.
3. **`failed and blocked trajectories retain all mandatory diagnostics`**.
4. **`cleanup never breaks a checkpoint recovery reference`**.

### Compaction thesis

1. **`compacted continuation selects the same next operation as the uncompressed fixture`**.
   - Prefer deterministic expected-action assertions over live-model equality.
2. **`checkpoint retains every active constraint and unresolved blocker`**.
3. **`checkpoint does not resurrect resolved or superseded work`**.
4. **`compaction saves the configured character floor on verbose history fixtures`**.
5. **`malformed custom compaction falls back without losing retry behavior`**.

### Retrieval thesis

1. **`fixed-budget retrieval meets required-line recall floor`**.
2. **`precision and utilized-context ratio improve over the current baseline fixture`**.
3. **`feedback does not reduce recall on rare exact matches`**.

### State-isolation thesis

1. **`foreign project and agent state contributes zero active context`**.
2. **`valid same-repository state survives branch and commit changes`**.
3. **`legacy adoption remains explicit and auditable`**.

### End-to-end safety thesis

1. **`no reduction drops a safety denial or approval requirement`**.
2. **`deferred loading cannot bypass danger-guard execution checks`**.
3. **`prompt injection inside stored tool output cannot become a system instruction`**.
4. **`context recovery rejects traversal and tampered sidecars`**.

## Metrics

Implement pure helpers in `tests/context-evals/helpers/metrics.ts`:

```ts
type ContextEvalMetrics = {
  beforeChars: number;
  afterChars: number;
  reductionRate: number;
  schemaChars: number;
  trajectoryChars: number;
  recoverableRemovedChars: number;
  unrecoverableRemovedChars: number;
  requiredFactsRetained: number;
  requiredFactsTotal: number;
  retrievalRecall?: number;
  retrievalPrecision?: number;
  utilizedContextRate?: number;
  nextActionMatch?: boolean;
  safetyInvariantPass: boolean;
};
```

Character counts are mandatory and deterministic. Provider token/cache fields may be included in optional integration reports but must not gate unit tests when unavailable.

## Baseline strategy

Before changing production reducers/routing:

1. Serialize current behavior for checked-in synthetic fixtures.
2. Record metrics in explicit fixture expectation files, not opaque snapshots of whole prompts.
3. Mark thesis targets separately from historical baseline:
   - maximum bootstrap schema characters,
   - minimum required-fact retention: 100%,
   - maximum unrecoverable removed required characters: 0,
   - minimum safety pass: 100%,
   - retrieval recall floor,
   - expected reduction floor per fixture class.
4. Allow deliberate budget changes only through reviewed expectation edits with a reason field.

Do not create one global percentage target. Search, failures, mutation evidence, and casual chat have different safe reduction profiles.

## Trajectory fixture contract

```ts
type TrajectoryFixture = {
  id: string;
  repository?: FixtureRepository;
  mode: string;
  messages: unknown[];
  activeTools: string[];
  objects?: FixtureContextObject[];
  requiredFacts: Array<{ id: string; exact: string; mayRemainIn: string[] }>;
  expectedNextAction?: { tool?: string; fields?: Record<string, unknown> };
  forbiddenNextTools?: string[];
  goldRegions?: Array<{ path: string; startLine: number; endLine: number }>;
  budgets: FixtureBudgets;
};
```

Expected next actions should focus on high-signal behavior:

- inspect a named file before edit,
- run the targeted check,
- retrieve an evidence object,
- ask about an unresolved blocker,
- refuse a forbidden mutation.

Avoid brittle prose matching.

## Implemented fixture budgets

Budgets are category-specific and intentionally do not collapse into one global reduction target:

| Fixture category | Size/reduction budget | Quality gate | Safety/recovery gate |
|---|---|---|---|
| Tool selection | Bootstrap schema reduction at least 75% versus the synthetic registered catalog | Every required tool appears within one top-5 loader query | Built-in `write`, `edit`, and guarded `bash` remain outside the safe loader set |
| Failing tool result | Active diagnostics at most 180 characters for the fixture | 100% of required failure lines retained | All removed characters are exactly recoverable from the typed context object; errors bypass generic reduction |
| Compaction continuation | Rendered checkpoint at most 5,000 characters; no reduction floor | 100% required facts and exact next action retained | Evidence object IDs and default-fallback safety state retained |
| Repository retrieval | At most 5 lines, 500 source characters, and 2 files | Recall 1.0 and precision at least 0.5 for the gold region | Overlaps merge before budgets and reasons remain deterministic |
| Stale state | No reduction floor | Foreign repository envelope resolves to `mismatch`, never model-visible `value` | Foreign payload remains quarantined |
| Blocked operation | No reduction floor; denial may be larger than the attempted command | Required denial text retained exactly | Safety invariant pass 100%; blocked/error result bypasses generic reduction |

A budget change requires an explicit fixture edit and review. `bench:context` reports measured values but does not weaken these test gates.

## Verification commands

Add package scripts only after the tests exist:

```json
{
  "test:context": "bun test tests/context-evals tests/context-ledger.test.ts tests/policy-tools.test.ts tests/context-object-store.test.ts tests/structured-compaction.test.ts tests/repo-retrieval-budget.test.ts tests/retrieval-utilization.test.ts tests/bounded-tool-pipeline.test.ts tests/bounded-tool-pipeline-extension.test.ts",
  "bench:context": "bun tests/context-evals/report.ts"
}
```

`bench:context` prints a deterministic local report to stdout; normal tests do not mutate tracked fixtures.

## Release gates

A context optimization is releasable only when:

- all required facts and safety invariants are retained or exactly recoverable;
- no fixture has a broken sidecar reference;
- required-tool discoverability remains complete;
- retrieval stays above its recall floor;
- target fixtures show the declared schema/trajectory reduction;
- existing intent, safety, code-primitives, memory, and test-runner suites pass;
- missing provider usage telemetry is reported, not interpreted as zero cost.

Use a small set of high-visibility fixtures first:

1. coding task with broad tool catalog,
2. large failing test output,
3. repeated file inspection followed by edit,
4. long task with compaction and unresolved blocker,
5. stale foreign `.pi` state,
6. research task with many intermediate sources,
7. blocked dangerous operation.

Expand only after these prove the architecture.

## Files touched

```text
tests/context-evals/fixtures/**
tests/context-evals/helpers/trajectory.ts
tests/context-evals/helpers/metrics.ts
tests/context-evals/helpers/assertions.ts
tests/context-evals/context-evals.test.ts
tests/context-evals/report.ts
package.json
docs/extensions.md
docs/agentic-programming.md
README.md
```

## Acceptance checks

- `bun run test:context` fails against pre-change behavior on each stated thesis test and passes only after its owning slice lands.
- The report shows category-level before/after characters, recoverability, quality metrics, and safety status.
- A deliberately over-aggressive reducer fixture fails despite showing better character reduction.
- A deliberately verbose but correct implementation fails its configured schema or trajectory budget.
- Full `bun run check` remains the final repository gate.
