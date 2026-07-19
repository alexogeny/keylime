# Slice 4 — structured compaction and unified working memory

## Goal

Use Pi’s `session_before_compact` hook to create validated, evidence-linked checkpoints. Preserve recent coherent turns while moving older state into structured, incremental working memory that combines conversation and repository facts without importing stale cross-project data.

## Thesis

Prose-only compaction and repeatedly rewritten project summaries are vulnerable to brevity bias and context collapse. A schema-validated checkpoint with exact object references and delta-updated memory will retain constraints and editable evidence more reliably than generic summaries at comparable or lower active size.

## Pi constraints

Pi compaction requires:

- `summary`,
- `preparation.firstKeptEntryId`,
- `preparation.tokensBefore`.

Do not cut at a tool result independently from its tool call. Preserve Pi’s selected recent suffix unless tests demonstrate a safe alternate boundary. Return `undefined` to fall back to default compaction on any custom failure.

## Red tests — write first

### `tests/structured-compaction.test.ts`

1. **`builds a checkpoint containing every required section`**
   - Goal, user constraints, acceptance criteria, decisions, active files, changes, verification, failures, blockers, pending actions, safety state, and evidence IDs.
2. **`preserves exact paths line locators hashes error codes and result IDs`**.
3. **`keeps unresolved constraints while omitting resolved conversational chatter`**.
4. **`returns Pi preparation firstKeptEntryId and tokensBefore unchanged`**.
5. **`rejects a generated checkpoint missing a user constraint`**.
6. **`rejects an evidence reference absent from the context-object manifest`**.
7. **`falls back to default compaction on timeout abort malformed output or validation failure`**.
8. **`never separates a tool call from its result at the kept boundary`**.
9. **`manual threshold and overflow reasons produce the same schema`**.
10. **`overflow retry does not duplicate completed mutations`**.

### `tests/compaction-retention.test.ts`

1. **`checkpoint-referenced objects become pinned`**.
2. **`superseded checkpoint releases objects no longer referenced or otherwise pinned`**.
3. **`cleanup cannot remove unresolved failure evidence`**.
4. **`checkpoint round trip restores pending actions and verification state exactly`**.

### `tests/unified-working-memory.test.ts`

1. **`retrieval combines conversational constraint and repository symbol evidence`**.
2. **`foreign repository memories are excluded`**.
3. **`delta update adds supersedes resolves and expires without rewriting unrelated entries`**.
4. **`conflicting facts remain explicit with provenance rather than silently merging`**.
5. **`sensitive user memory still obeys existing sensitivity gates`**.
6. **`working-set output obeys a fixed character budget and includes source IDs`**.

### Extend `tests/agent-os.test.ts` and `tests/project-planner.test.ts`

1. **`compaction checkpoint updates registers through typed deltas`**.
2. **`completed prior task state is not injected into a new unrelated goal`**.

## Shared types / contracts

Add `extensions/shared/compaction-schema.ts` using existing TypeBox conventions:

```ts
type CompactionCheckpoint = {
  version: 1;
  goal: string;
  constraints: EvidenceClaim[];
  acceptanceCriteria: EvidenceClaim[];
  decisions: EvidenceClaim[];
  activeFiles: Array<{
    path: string;
    relevance: string;
    contentHash?: string;
    locators?: ContextLocator[];
  }>;
  changes: EvidenceClaim[];
  verification: EvidenceClaim[];
  failures: EvidenceClaim[];
  blockers: EvidenceClaim[];
  pendingActions: EvidenceClaim[];
  safetyState: EvidenceClaim[];
  objectIds: string[];
};

type EvidenceClaim = {
  text: string;
  sourceEntryIds?: string[];
  objectIds?: string[];
  status?: "active" | "resolved" | "superseded";
};
```

Keep the serialized model-visible summary readable Markdown, but derive it from the validated typed checkpoint. Store typed details in the compaction entry where Pi permits extension details; otherwise store a sidecar keyed by compaction entry/session identity.

Add a delta contract:

```ts
type WorkingMemoryDelta =
  | { op: "add"; item: WorkingMemoryItem }
  | { op: "supersede"; id: string; replacement: WorkingMemoryItem }
  | { op: "resolve"; id: string; evidence?: string[] }
  | { op: "expire"; id: string; reason: string };
```

## Runtime changes

### `extensions/structured-compaction.ts`

Register `session_before_compact`:

1. Convert `branchEntries` and preparation data into a bounded summarization input.
2. Prefer already reduced context-object summaries and typed metadata over raw tool payloads.
3. Include prior checkpoint state as structured items, not an unbounded prose prefix.
4. Ask the active model or an explicitly configured cheaper model for the checkpoint shape.
5. Parse and validate.
6. Verify critical facts against deterministic source extraction:
   - user constraints,
   - unresolved blockers,
   - mutation and test state,
   - referenced object IDs.
7. Pin referenced context objects atomically.
8. Return Pi’s required compaction structure.
9. On any failure, notify diagnostically and return `undefined` for default behavior.

Do not silently accept an empty model response. Do not let model output select a different kept-entry boundary.

### Threshold behavior

- Keep existing 85% warning initially.
- Add a lightweight deterministic checkpoint readiness snapshot around 60–70% context pressure; this does not itself compact.
- At threshold compaction, reuse that snapshot only if its source fingerprint still matches.
- Avoid repeated proactive model calls solely to maintain summaries.

### Working memory integration

Extend existing systems rather than create a new user-memory database:

- `extensions/agent-os.ts`: current-task registers and grammar.
- `extensions/project-planner.ts`: durable repository decisions/features/questions.
- `extensions/user-memory/*`: user facts/preferences with sensitivity and expiry.
- `extensions/repo-index/index.ts`: repository symbols and structure.
- context-object store: exact trajectory evidence.

Add a shared retrieval adapter that produces one bounded working set from these sources. It should return typed source IDs and preserve each source’s authorization/sensitivity rules.

### Incremental curation

- Apply explicit deltas after successful turns or compaction, not full rewrites.
- Preserve conflicting claims until one is resolved with evidence.
- Decay or expire inferred operational lessons; do not decay explicit user constraints during the active task.
- Associate repository knowledge with repository identity and optional source hash/commit metadata.

## Correctness rules

- Generated summaries never replace exact evidence without a recoverable reference.
- Every active user constraint from the compacted span must appear in the checkpoint or remain in the kept suffix.
- Repository and user memory maintain separate sensitivity/retention policies even when retrieved together.
- Foreign repository state is excluded before ranking, not filtered only after model-visible assembly.
- Compaction failure cannot block Pi’s default compaction or overflow recovery.
- Checkpoint pin updates and compaction return must not leave half-applied retention state.
- Historical checkpoints are immutable; later deltas supersede rather than rewrite them.

## Files touched

```text
extensions/structured-compaction.ts
extensions/shared/compaction-schema.ts
extensions/shared/context-objects.ts
extensions/agent-os.ts
extensions/project-planner.ts
extensions/user-memory/context-provider.ts
extensions/user-memory/retrieval.ts
extensions/user-memory/types.ts
extensions/repo-index/index.ts
extensions/adaptive-context-policy.ts
extensions/context-health.ts
tests/structured-compaction.test.ts
tests/compaction-retention.test.ts
tests/unified-working-memory.test.ts
tests/agent-os.test.ts
tests/project-planner.test.ts
tests/user-memory-context.test.ts
```

## Acceptance checks

- A fixture containing a user constraint, two edits, one failed check, one successful check, and an unresolved blocker compacts into a valid checkpoint retaining each item and its evidence.
- Invalid or incomplete generated output causes deterministic fallback, not partial compaction.
- Resuming from the checkpoint restores pending work without reloading raw historical tool payloads.
- A foreign repository memory fixture contributes zero working-set characters.
- Repeated curation updates only changed items and preserves unrelated evidence IDs.
