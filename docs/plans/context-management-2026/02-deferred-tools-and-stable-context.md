# Slice 2 — deferred tools and cache-stable context

## Goal

Replace broad route-level tool exposure with a small deterministic bootstrap set plus Pi-native additive tool discovery. Keep stable/session context byte-stable across tool continuations and make cache invalidation attributable.

## Thesis

Tool schemas and active-tool-specific `promptGuidelines` are a recurring prompt tax. Keylime’s coarse intent router removes unrelated domains, but still activates full capability groups and many always-on tools. Searching the registered catalog and loading only the few required tools should materially reduce schema characters while preserving task reachability and safety.

## Red tests — write first

### `tests/tool-search.test.ts`

1. **`coding bootstrap excludes non-bootstrap coding tools`**
   - Register the full known catalog.
   - Start a coding route.
   - Assert only the configured bootstrap tools plus `tool_search` and mandatory safety/continuity tools are active.
2. **`tool_search ranks exact capability matches and adds them without removing active tools`**
   - Search for “compare two files”.
   - Assert `compare_files` is loaded, existing tools remain, and unrelated tools are not added.
3. **`tool_search caps loaded results`**
   - A broad query must add at most the configured 3–5 tools.
4. **`tool_search cannot load a locked or unavailable tool`**
   - Requests for built-in `read`, `write`, or `edit` must not bypass policy.
5. **`tool_search respects operational mode and capability gates`**
   - REVIEW cannot discover mutation tools; disabled research cannot discover web tools.
6. **`repeating the same search is idempotent`**
   - Active-tool fingerprint and response remain stable.
7. **`no match returns compact guidance without changing the tool set`**.

### Extend `tests/intent-router.test.ts`

1. **`route changes select bootstrap groups rather than every routed tool`**.
2. **`mandatory safety tools remain available after every route`**.
3. **`continuity tools are retained only when active agent-OS state requires them`**.
4. **`a tool-result continuation does not recalculate or shrink an additive tool set`**.

### Extend `tests/turn-context.test.ts`

1. **`unchanged static and session blocks are byte-identical across repeated context events`**.
2. **`turn-only text changes after the stable prefix`**.
3. **`provider ordering is static then session then turn within priority constraints`**.
4. **`a tool continuation does not duplicate an unchanged reminder`**.

### `tests/tool-schema-budget.test.ts`

1. **`bootstrap schema and guideline characters remain under the checked-in budget`**.
2. **`every custom promptGuideline names its tool and stays under its per-tool cap`**.
3. **`adding a verbose tool description fails the catalog budget fixture`**.

## Shared types / contracts

Add `extensions/shared/tool-catalog.ts`:

```ts
type CatalogTool = {
  name: string;
  label?: string;
  description: string;
  argumentTerms: string[];
  group?: CapabilityGroup;
  risk: ToolRisk;
  bootstrap: boolean;
  searchable: boolean;
};

type ToolSearchMatch = {
  name: string;
  score: number;
  matchedTerms: string[];
};
```

Build catalog entries from `pi.getAllTools()` plus deterministic policy metadata from `shared/tool-policy.ts`. Use existing BM25/hybrid primitives; do not add an embedding or search dependency.

The catalog index is process/session-local and rebuilt only when registered tool metadata changes.

## Runtime changes

### `extensions/tool-search.ts`

Register `tool_search` with a concise schema:

```ts
{
  query: string;
  group?: string;
  limit?: number; // hard maximum 5
}
```

Execution flow:

1. Normalize query using existing retrieval tokenization.
2. Filter catalog through deterministic mode, availability, research, domain, and risk policy.
3. Rank the remaining tools.
4. Add matches with one additive `pi.setActiveTools([...current, ...matches])` call.
5. Return only loaded names and one-line reasons.

The loader must never itself decide that a dangerous tool is safe. It only searches the set allowed by policy.

### `extensions/shared/tool-policy.ts`

- Add explicit `bootstrap` and `searchable` metadata or equivalent resolver functions.
- Reduce `alwaysOn` to the smallest set that prevents routing dead ends.
- Separate:
  - hard mandatory tools,
  - route bootstrap tools,
  - searchable tools,
  - locked tools.
- Keep safety decisions deterministic and testable.

Suggested coding bootstrap intent—not a final mandated list:

```text
list_files
code_search
inspect_text_matches
inspect_lines
run_checks
tool_search
```

Mutation tools can be discovered when the user’s request and operational mode permit them. If removing a currently always-on mutation primitive would strand common tasks, prove that through red tests and retain only that specific primitive.

### `extensions/intent-router.ts`

- Route to bootstrap groups instead of full capability groups.
- On a new user turn, calculate the deterministic bootstrap set.
- During tool-result continuations, preserve additive tools for that turn.
- Reset temporary discoveries at the next user-turn boundary unless continuity state explicitly pins them.
- Record route, bootstrap, discovered tools, and fingerprint in existing diagnostics.

### Stable provider composition

Modify `extensions/shared/turn-context.ts` and `extensions/turn-context-composer.ts`:

- Cache pure static/session provider output by provider ID, repository identity, and explicit dependency fingerprint.
- Do not cache providers that read volatile state without declaring a fingerprint.
- Preserve stable/session block bytes and ordering.
- Append volatile turn context after stable material.
- Avoid appending an identical `<system-reminder>` again on context passes caused only by tool results.

Do not use `provider_payload` to mutate provider-specific cache fields in this slice. First make the provider-independent prompt stable and prove it. Provider controls can be added later behind explicit adapters.

### Schema budget tooling

Add a test helper that serializes active custom tool metadata in the same categories Pi exposes (`tools`, `toolSnippets`, `promptGuidelines`) and measures characters. The goal is regression detection, not a false exact-token model.

## Correctness rules

- Loading tools is additive during an active turn.
- The loader cannot activate tools absent from `pi.getAllTools()`.
- The loader cannot override locked built-ins, operational modes, research disablement, or dangerous-tool approval.
- Search output must not expose full schemas; Pi loads selected definitions through its native mechanism.
- Cache stability must never suppress changed safety, user, repository, or route state.
- Tool descriptions remain sufficient to distinguish similarly named tools; do not optimize solely for character count.

## Files touched

```text
extensions/tool-search.ts
extensions/shared/tool-catalog.ts
extensions/shared/tool-policy.ts
extensions/intent-router.ts
extensions/shared/turn-context.ts
extensions/turn-context-composer.ts
extensions/README.md
docs/extensions.md
tests/tool-search.test.ts
tests/tool-schema-budget.test.ts
tests/tool-policy.test.ts
tests/intent-router.test.ts
tests/intent-stickiness.test.ts
tests/turn-context.test.ts
tests/helpers/mock-pi.ts
```

## Acceptance checks

- A representative coding bootstrap is below the checked-in schema/guideline character budget.
- “Compare these files” discovers `compare_files` in one tool call without activating unrelated research, memory, Linux, or domain tools.
- REVIEW mode cannot discover mutation tools.
- Repeated tool-result context passes preserve the active-tool and stable-provider fingerprints.
- The full existing intent and safety test suites remain green.
