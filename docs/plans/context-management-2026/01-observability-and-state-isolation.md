# Slice 1 — observability and repository-bound state

## Goal

Make context cost and contamination visible before changing reduction behavior. Extend the existing usage and context diagnostics so later work can attribute prompt growth to tool schemas, providers, history, tool results, and memory. Bind `.pi` project/agent state to the current repository and quarantine stale cross-project state.

## Thesis

Keylime cannot safely optimize context while `extensions/usage-tracker.ts` records only aggregate input/output/cost and repository-local state can be injected without proving it belongs to the current checkout. Category attribution and identity validation will expose the largest costs and prevent demonstrable stale-state injection.

## Red tests — write first

### `tests/repository-identity.test.ts`

1. **`rejects a project file whose stored root fingerprint belongs to another repository`**
   - Create a temporary current repo identity and a state envelope with a different identity.
   - Assert the loader returns `status: "mismatch"`, no injectable state, and the foreign state path for diagnostics.
   - This should fail against the current direct `.pi/project.json` loading behavior.
2. **`accepts the same repository after branch and HEAD changes`**
   - Identity must be based on stable root facts, not only the current commit.
3. **`treats legacy unbound state as quarantined until explicitly adopted`**
   - Do not silently attach an existing unscoped file to the current repository.
4. **`normalizes real paths before calculating identity`**
   - A symlinked cwd and canonical cwd must resolve consistently without permitting path escape.

### `tests/context-ledger.test.ts`

1. **`attributes request context by category without double counting`**
   - Supply a synthetic request containing system text, two tool schemas, guidelines, provider reminder, history, and a compacted tool result.
   - Assert exact character totals per category and total.
2. **`records before and after sizes for each transform`**
   - Record duplicate-read suppression and tool-result reduction; assert saved characters are derivable.
3. **`distinguishes cache savings from active context reduction`**
   - A request with cache-read tokens but no transform must report zero context characters removed.
4. **`uses missing rather than zero when provider token telemetry is unavailable`**
   - Prevent misleading reports from bridges that return partial usage.
5. **`does not persist message bodies or secrets in ledger records`**
   - Feed a sentinel secret; serialized telemetry must include sizes/fingerprints only.

### Extend `tests/turn-context.test.ts`

1. **`reports each provider contribution and stable fingerprint`**.
2. **`unchanged static and session providers retain the same fingerprint on tool-only context passes`**.
3. **`diagnostics identify the provider that exceeded its budget`**.

## Shared types / contracts

Add `extensions/shared/repository-identity.ts`:

```ts
type RepositoryIdentity = {
  version: 1;
  canonicalRoot: string;
  marker: string;       // hash of stable root markers, never secret contents
};

type BoundStateEnvelope<T> = {
  version: 1;
  repository: RepositoryIdentity;
  updatedAt: number;
  payload: T;
};

type BoundStateLoad<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "legacy"; path: string }
  | { status: "mismatch"; path: string; expected: RepositoryIdentity; actual: RepositoryIdentity };
```

Use canonical root plus stable repository markers. Do not make a commit hash the sole identity because state must survive normal commits. Avoid hashing arbitrary repository content.

Add `extensions/shared/context-ledger.ts` with pure functions for:

- category accounting,
- stable fingerprints,
- transform accounting,
- redaction-safe serialization,
- bounded per-session aggregation.

## Runtime changes

### `extensions/usage-tracker.ts`

- Extend records with optional cache read/write, category totals, active-tool fingerprint, and transform savings.
- Keep provider-reported input/output fields unchanged for compatibility.
- Version the appended record (`usage-record-v2`) rather than reinterpret historical v1 entries.
- Add `/usage-report context` output showing:
  - request count,
  - average/peak category sizes,
  - characters removed by transform kind,
  - cache read/write separately,
  - missing-telemetry count.
- Never append full prompts or message content to `.pi/usage/usage.ndjson`.

### `extensions/shared/turn-context.ts`

- Add stable content fingerprints to provider diagnostics.
- Report allocated, produced, retained, and trimmed characters.
- Distinguish `not_applicable`, `empty`, `duplicate`, `budget`, and `unchanged` where relevant.
- Expose diagnostics to the ledger without coupling the pure composer to filesystem persistence.

### `extensions/turn-context-composer.ts`

- Emit one bounded ledger contribution per `context` event.
- Extend `/context-providers` to show stability, current fingerprint, last contribution, and trim state.

### `extensions/project-planner.ts`

- Wrap `.pi/project.json` in a repository-bound envelope.
- Return no provider context on mismatch or legacy state.
- Add an explicit command path to inspect and adopt/migrate legacy state; adoption must require UI confirmation when available.

### `extensions/agent-os.ts`

- Bind `.pi/agent-os.json` to the same repository identity.
- On mismatch, reset in-memory continuity state to defaults and expose a warning/status rather than injecting stale goal/risks/grammar.
- Preserve current checksum/concurrency behavior inside the bound payload.

### Existing concrete contamination fixture

Use sanitized fixtures modeled on the current checkout condition:

- current repo identity: Keylime,
- `.pi/project.json` payload naming another repository,
- `.pi/agent-os.json` payload describing an unrelated completed task.

Do not commit the actual local state contents into tests.

## Correctness rules

- Identity mismatch fails closed for context injection but remains inspectable to the user.
- Legacy files are not deleted automatically.
- Adoption writes a backup before replacing or wrapping legacy state.
- Telemetry contains metrics and hashes, never prompt content, secrets, fetched documents, memory bodies, or tool payloads.
- Unknown token counts remain unknown; character counts are the deterministic comparison baseline.
- Existing v1 usage records remain readable by reports.

## Files touched

```text
extensions/shared/repository-identity.ts
extensions/shared/context-ledger.ts
extensions/usage-tracker.ts
extensions/shared/turn-context.ts
extensions/turn-context-composer.ts
extensions/project-planner.ts
extensions/agent-os.ts
tests/repository-identity.test.ts
tests/context-ledger.test.ts
tests/turn-context.test.ts
tests/agent-os.test.ts
tests/project-planner.test.ts
```

## Acceptance checks

- Loading a foreign project or agent-OS fixture injects zero text and produces a visible mismatch diagnostic.
- A same-repository state file remains valid across commit/branch changes.
- `/usage-report context` separates active-context reductions from cache-read tokens.
- A synthetic turn’s category totals equal the assembled prompt character total within explicitly documented provider-envelope exclusions.
- Existing usage and state tests remain green, and the new tests fail before implementation for the intended reasons.
