# Slice 5 — precision-first retrieval and bounded tool pipelines

## Goal

Improve repository-context precision under a fixed line budget and prevent bulky intermediate tool data from entering model context. Reuse Keylime’s BM25, TF-IDF, JMLM, hybrid ranking, bounded top-K, repo index, and safe tool policy.

## Thesis

Keylime can retrieve broadly, but it does not measure whether explored context was actually used. Ranking exact code regions under a fixed budget and aggregating allowlisted read-only tool calls outside model context should reduce explored-versus-utilized waste without lowering required-line recall.

## Red tests — write first

### `tests/repo-retrieval-budget.test.ts`

Create small deterministic repository fixtures with issue text and gold relevant line ranges.

1. **`returns ranked code regions within the fixed line and character budget`**.
2. **`preserves required-line recall when irrelevant files contain more lexical matches`**.
3. **`ranks declaration and import-neighbor evidence above unrelated file-level matches`**.
4. **`reports coverage precision and omitted-candidate counts`**.
5. **`does not count duplicate overlapping ranges twice`**.
6. **`produces deterministic ordering for score ties`**.
7. **`falls back to lexical retrieval when embeddings are unavailable`**.

### `tests/retrieval-utilization.test.ts`

1. **`marks a retrieved region utilized when later cited edited or verified`**.
2. **`does not mark a file utilized merely because it was listed`**.
3. **`records explored versus utilized characters without storing source text`**.
4. **`utilization feedback cannot suppress a hard lexical match below the recall floor`**.
5. **`feedback is repository and task scoped`**.

### `tests/bounded-tool-pipeline.test.ts`

1. **`runs allowlisted read-only tools and returns only the selected aggregate`**.
2. **`rejects mutation stateful dangerous and unknown tools before any execution`**.
3. **`enforces call intermediate-byte output-byte and wall-clock budgets`**.
4. **`filters and top-k selects structured rows deterministically`**.
5. **`stores oversized intermediate results as context objects without injecting them`**.
6. **`propagates tool errors as bounded structured failures`**.
7. **`aborts remaining work when the parent signal is cancelled`**.
8. **`cannot reference output from a failed or skipped step as successful data`**.
9. **`redacts configured sensitive fields before aggregation output`**.

### `tests/research-pipeline-context.test.ts`

1. **`multi-source research returns claims and source IDs rather than concatenated pages`**.
2. **`conflicting source claims remain separate`**.
3. **`source content remains recoverable through stored page or object IDs`**.

## Shared types / contracts

Extend repo-index result contracts:

```ts
type RankedCodeRegion = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  reasons: string[];
  estimatedChars: number;
};

type RetrievalBudget = {
  maxLines: number;
  maxChars: number;
  maxFiles: number;
};

type RetrievalMetrics = {
  candidates: number;
  returnedRegions: number;
  returnedLines: number;
  returnedChars: number;
  omittedCandidates: number;
};
```

Add a utilization record containing identifiers and counts only:

```ts
type ContextUtilization = {
  taskId: string;
  repositoryMarker: string;
  regionId: string;
  retrievedAtTurn: number;
  usedBy: Array<"citation" | "inspection" | "edit" | "verification">;
};
```

For the bounded pipeline:

```ts
type PipelineStep = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
};

type PipelineProjection = {
  from: string;
  select?: string[];
  filters?: Array<{ field: string; op: "eq" | "contains" | "gt" | "lt"; value: unknown }>;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
  limit?: number;
  aggregate?: Array<{ op: "count" | "sum" | "min" | "max"; field?: string; as: string }>;
};
```

Keep operators deliberately small. Do not implement arbitrary JavaScript, expressions, shell, loops, filesystem access, or dynamic tool names.

## Runtime changes

### `extensions/repo-index/index.ts`

- Add region-level ranking and output under explicit line/character/file budgets.
- Combine existing lexical/hybrid score with cheap structural evidence already available from declarations/imports.
- Merge overlapping ranges before budgeting.
- Return reasons and budget metrics in `details`.
- Preserve current repo-map behavior for callers that do not request regions.

### Code primitives

Extend `code_search` or add a narrowly named region-search mode rather than another overlapping general search tool. The model-visible response should include only ranked bounded regions; full candidate data belongs in a context object.

### Utilization tracking

Use existing lifecycle events and tool metadata:

- retrieval creates region IDs,
- later focused inspection references region/path overlap,
- mutation references changed paths/ranges,
- verification references affected files where available.

Treat these as observability signals, not proof that content caused success. Use aggregate feedback only after sufficient samples and never below deterministic recall safeguards.

### `extensions/bounded-tool-pipeline.ts`

Register one tool with strict TypeBox parameters and execute through registered tool APIs only where Pi safely exposes callable operations. If Pi does not expose a safe internal tool invocation API, implement the first proof point as a purpose-built aggregator over existing shared retrieval/store functions rather than simulating model tool calls.

Initial supported use cases:

- merge and top-K several repository searches,
- aggregate document/spreadsheet table previews,
- filter recalled memories by metadata,
- distill stored web-search/page records into claims/source IDs.

Do not include mutation tools, shell, arbitrary fetch targets, memory writes, or project writes.

### Research integration

Update `extensions/search-orchestrator.ts`, `extensions/web-search.ts`, and `extensions/web-content.ts` to prefer stored source IDs and claim records over repeated page text. Keep citations and publication/fetch dates.

## Correctness rules

- Fixed budgets are applied after overlap deduplication and before model-visible rendering.
- Retrieval reasons are deterministic and must not claim semantic certainty.
- Utilization telemetry cannot leak code or user content.
- The bounded pipeline rechecks tool policy at execution time; route-time availability alone is insufficient.
- Intermediate sidecars use the same path, retention, and recovery protections as other context objects.
- Partial pipeline failure cannot be rendered as a complete successful aggregate.
- No dynamic expression evaluator is introduced.

## Files touched

```text
extensions/repo-index/index.ts
extensions/code-primitives.ts
extensions/bounded-tool-pipeline.ts
extensions/shared/retrieval/types.ts
extensions/shared/retrieval/hybrid.ts
extensions/shared/retrieval/bounded-top-k.ts
extensions/shared/context-objects.ts
extensions/shared/tool-policy.ts
extensions/search-orchestrator.ts
extensions/web-search.ts
extensions/web-content.ts
tests/repo-retrieval-budget.test.ts
tests/retrieval-utilization.test.ts
tests/bounded-tool-pipeline.test.ts
tests/research-pipeline-context.test.ts
tests/repo-index.test.ts
tests/retrieval.test.ts
```

## Acceptance checks

- Gold repository fixtures stay within fixed budgets while meeting the configured required-line recall floor.
- Reports expose precision, coverage, returned characters, and explored-versus-utilized ratio.
- A 20-source research/table fixture returns a bounded aggregate and source/object IDs, not concatenated intermediate payloads.
- Any attempt to invoke a mutation or dangerous tool through the pipeline fails before execution.
- Existing lexical-only and no-embedding workflows remain functional.
