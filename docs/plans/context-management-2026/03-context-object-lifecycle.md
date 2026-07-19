# Slice 3 — typed context-object lifecycle

## Goal

Replace overlapping generic tool-output truncation with typed, recoverable context objects. Reduce each result according to its semantics, preserve exact evidence locators, and support bounded partial recovery.

## Thesis

The current fixed thresholds and keyword/head-tail summaries reduce characters but cannot prove preservation of causal failures, code locations, mutations, or future dependencies. Tool-specific reducers plus recoverable sidecars will produce smaller active results with stronger exact-recovery guarantees.

## Current seams to consolidate

- `extensions/tool-result-compactor.ts` compacts every result over 3,500 characters, including errors, using up to 12 keyword-selected lines plus a head/tail preview.
- `extensions/cache-guard.ts` later truncates older results over 8,000 characters and suppresses identical older file reads.
- `extensions/shared/output-preview.ts` provides bounded preview primitives.
- `.pi/tool-results` already stores recoverable payloads and a manifest.

Keep the working storage and cleanup behavior, but replace duplicate policy layers with one lifecycle service. Leave `cache-guard.ts` responsible for prompt-cache diagnostics after migration.

## Red tests — write first

### `tests/context-object-store.test.ts`

1. **`stores a context object with immutable source metadata and content hash`**.
2. **`retrieves only a requested named section`**.
3. **`retrieves an exact bounded line range with original line numbers`**.
4. **`rejects traversal IDs and paths`**.
5. **`detects a missing or modified sidecar rather than returning unverified content`**.
6. **`cleanup retains pinned objects and removes expired reconstructable objects`**.

### `tests/tool-result-reducers.test.ts`

1. **`failed test output preserves failing test names causal stack exit status and full-result ID`**.
2. **`successful test output keeps totals and command but masks repetitive passing lines`**.
3. **`repository search keeps ranked file line matches and omitted count`**.
4. **`file inspection keeps path requested line range and source hash`**.
5. **`mutation result keeps path operation pre/post hash and verification state`**.
6. **`blocked or denied safety result is never reduced by the generic reducer`**.
7. **`unknown successful output uses a conservative fallback reducer`**.
8. **`unknown failed output stays intact up to the hard emergency limit`**.
9. **`reducer output is deterministic for identical input`**.
10. **`output containing prompt-injection text is stored as evidence and not promoted to lifecycle instructions`**.

### Replace/extend `tests/tool-result-compactor.test.ts`

1. **`default reducer does not compact errors solely because they exceed 3500 chars`**.
2. **`reduced output exposes object ID reduction kind original size and recovery guidance`**.
3. **`inspect_context_object applies caps after selecting the requested section`**.
4. **`duplicate reads fold only when path and content hash match`**.
5. **`a later changed read does not suppress the older distinct version`**.

### `tests/context-lifecycle.test.ts`

1. **`fold replaces a completed tool span with summary plus object reference`**.
2. **`mask removes an active payload but leaves a resolvable reference`**.
3. **`prune is rejected for non-reconstructable or pinned objects`**.
4. **`future dependency pin prevents cleanup`**.

## Shared types / contracts

Add `extensions/shared/context-objects.ts`:

```ts
type ContextObjectKind =
  | "file_read"
  | "repo_search"
  | "test_run"
  | "diagnostic_run"
  | "mutation"
  | "research"
  | "memory_recall"
  | "table"
  | "generic";

type RetentionClass = "pinned" | "foldable" | "maskable" | "reconstructable";

type ContextLocator = {
  path?: string;
  lines?: { start: number; end: number };
  section?: string;
  resultId?: string;
};

type ContextObject = {
  version: 1;
  id: string;
  kind: ContextObjectKind;
  sourceTool: string;
  toolCallId?: string;
  createdAt: string;
  originalChars: number;
  contentHash: string;
  retention: RetentionClass;
  summary: string;
  sections: Record<string, ContextLocator>;
  dependencies: string[];
  sidecarPath: string;
};

type ReducedToolResult = {
  object: ContextObject;
  activeText: string;
  reduction: "none" | "fold" | "mask";
};
```

Store section indexes as byte/line offsets or deterministic extracted sidecars. Do not duplicate a huge payload into the manifest.

## Reducer registry

Use a plain typed registry, not a framework:

```ts
type ToolResultReducer = {
  matches(toolName: string, details: unknown): boolean;
  reduce(input: ReducerInput): ReducedToolResult;
};
```

Initial reducers should target high-volume, high-value tools already in Keylime:

- `run_checks` and test tools,
- `code_search`, `inspect_text_matches`, `list_files`,
- `inspect_lines`, `inspect_document`, spreadsheet/table tools,
- web search/fetch/research,
- mutation primitives,
- generic fallback.

Reuse metadata already returned by tools rather than reparsing rendered text whenever possible. Where current tools omit needed metadata, extend their `details` contracts narrowly.

## Runtime changes

### `extensions/context-object-store.ts`

- Own manifest caching, sidecar writes, validation, cleanup, and recovery.
- Register `inspect_context_object` with selectors:
  - `section`,
  - `path`,
  - `lines`,
  - `max_chars`.
- Keep `inspect_tool_result` temporarily as a compatibility alias for old IDs.
- Version stored files and support bounded legacy reads.

### `extensions/tool-result-compactor.ts`

Either rename this extension or retain the entry point while delegating to the lifecycle service:

1. Classify tool result.
2. Apply error/safety/mutation retention policy.
3. Run the matching reducer.
4. Store original content and structured indexes.
5. Return the active representation and ledger transform.

Remove the generic “interesting keyword” summary once all fallback compatibility tests are replaced.

### `extensions/cache-guard.ts`

- Remove generic large-output truncation after lifecycle behavior is enabled.
- Retain cache accounting.
- Move duplicate-read folding into the file-read reducer using normalized path plus content hash.
- During a compatibility release, add a diagnostic if both old and new reducers would transform the same message; do not transform twice.

### Cleanup and retention

Extend existing cleanup semantics:

- pinned unresolved failures/mutations survive age cleanup,
- reconstructable searches/listings may expire aggressively,
- objects referenced by the current compaction checkpoint cannot be removed,
- manifest entries for missing files are pruned with a diagnostic,
- storage budget applies to original bytes, not only manifest size.

## Correctness rules

- `isError`, safety denial, and mutation state are classification inputs, not mere display metadata.
- Failed results preserve the first causal error, relevant stack, exit status, and exact recovery pointer.
- A sidecar reference is usable only after an atomic successful write.
- Model-visible summaries cannot grant permissions or alter safety state.
- Recovery selectors are validated before filesystem access.
- Every reduced result emits a ledger record with before/after size and recoverability.
- Do not delete legacy `.pi/tool-results` eagerly.

## Files touched

```text
extensions/shared/context-objects.ts
extensions/context-object-store.ts
extensions/tool-result-compactor.ts
extensions/cache-guard.ts
extensions/shared/output-preview.ts
extensions/code-primitives.ts
extensions/test-runner.ts
extensions/web-search.ts
extensions/fetch.ts
extensions/document-primitives.ts
extensions/shared/retention.ts
tests/context-object-store.test.ts
tests/tool-result-reducers.test.ts
tests/context-lifecycle.test.ts
tests/tool-result-compactor.test.ts
tests/security-redteam.test.ts
```

Only extend individual tool files when their `details` lack metadata required by a reducer.

## Acceptance checks

- A 100k-character failing test result yields a compact active result containing causal failure data and an exact recoverable object reference.
- A repeated identical file inspection is folded; a changed version remains separately recoverable.
- Safety denial and mutation confirmation fixtures retain all required fields regardless of normal thresholds.
- `inspect_context_object` can recover one named section or line range without loading the whole payload.
- No tool result is transformed by both the lifecycle manager and legacy cache guard.
