---
name: test-audit
description: Unit-test quality and missing-coverage audit skill. Use when designing tests, reviewing an existing test suite, extending TDD acceptance criteria, or asking what test cases are missing beyond raw coverage percentage. Focuses on behavior contracts, risk-based coverage, mutation-testing thinking, branch/condition/path gaps, property/metamorphic tests, lifecycle/state transitions, and integration seams.
---

# Test Audit Skill

Use this skill when planning, reviewing, or improving tests. The goal is not high coverage percentage; it is high **fault-detection power**:

> tests should fail when important behavior is broken, not merely execute the code

This skill can be invoked directly, and TDD workflows should invoke it before finalizing test cases for a feature or before declaring a suite “comprehensive.”

## Core principles

Good unit tests are:

- **Behavior-focused** — test public contracts and observable outcomes, not implementation trivia.
- **Assertion-strong** — prove important fields/effects, not just “result is defined.”
- **Deterministic** — no real network, uncontrolled wall clock, global env leakage, order dependence, or shared filesystem state.
- **Small but meaningful** — one behavioral concept per test, with enough assertions to define the contract.
- **Boundary-aware** — include empty, one, many, duplicate, malformed, missing, no-op, and max/capped inputs.
- **Negative-aware** — prove bad operations are rejected, not just that happy paths work.
- **Regression-preserving** — every discovered bug becomes a test.
- **Cheap enough to run often** — unit tests should be fast and local; integration/e2e checks can be separate.

Coverage percentage is only a map of code that ran. It does **not** prove that assertions would catch a bug.

## Audit workflow

### 1. Establish the behavior surface

List public contracts:

- exported functions
- registered tools
- registered commands
- lifecycle handlers/events
- persistence files
- context providers
- safety guards
- integration boundaries

For each, ask:

- What should happen?
- What must never happen?
- What state changes?
- What external effects are allowed?
- What observability/status should explain it?

### 2. Build a risk map

Prioritize tests by failure cost, not by line count.

High-risk areas usually include:

- file mutation
- shell/runtime execution
- protected paths and secrets
- auth/security/safety policy
- routing/tool exposure
- persistence/migrations
- checkpoint/rollback
- memory writes/deletes
- context injection and prompt pollution
- network/research behavior
- billing/cost/usage tracking
- data loss or privacy leaks

For Keylime/Pi-style harnesses, especially test:

- `tool_call`, `tool_result`, `agent_end`, `before_agent_start`, `session_start`, `context`, `input`
- active-tool routing and locked tools
- mutation classification and fallback guards
- repo-index invalidation after source mutations
- tool-result compaction and retrieval
- checkpoint scoring from successful results, not attempted calls

### 3. Go beyond coverage percentage

Use these coverage lenses:

#### Branch / condition coverage

For each conditional, test meaningful combinations.

Example matrix:

| protected path | dry run | expected |
|---|---|---|
| false | false | allow + mutate |
| false | true | allow + no mutate |
| true | false | block |
| true | true | allow/no mutate if policy says dry-run is safe |

#### Path / state-transition coverage

For stateful code, test sequences:

```text
initialize → call → fail → retry → reload → call again
```

Agent harness examples:

```text
input → context → tool_call → tool_result → agent_end
```

#### Mutation-testing thinking

Ask whether tests would fail if code were mutated:

- `>=` became `>`
- `&&` became `||`
- `true` became `false`
- a branch was removed
- a score threshold changed
- an allow/deny flag flipped
- one field was omitted from the result

If not, assertions are weak.

#### Property / metamorphic coverage

Use invariants when exact outputs are less important:

- dry-run never mutates files
- duplicate IDs replace, not duplicate
- adding irrelevant corpus docs should not change exact-match top result
- path normalization should not weaken protected-path classification
- rerunning the same query on the same corpus is deterministic
- compaction should reduce context but preserve retrievability

#### Contract matrix coverage

For classifiers/routers/planners, create tables:

```text
input | expected category | allowed | score | reason | side effect
```

Good for:

- intent routing
- mutation classification
- check suggestion
- policy retrieval
- codemod planning
- path safety
- command blocking

### 4. Look for missing negative tests

Missing negative tests are often the biggest suite gap.

Ask:

- What invalid input should be rejected?
- What dangerous action should be blocked?
- What ambiguous request should **not** be hijacked?
- What no-op should remain a no-op?
- What failed dependency should not corrupt state?
- What should not be logged, persisted, injected, or exposed?

Examples:

- memory prompt should not route to coding
- dry-run should not write files
- error tool results should not be compacted if policy says skip errors
- protected path should not be writable through alternate path spelling
- custom check command should not bypass shell guards

### 5. Inspect edge-case classes

Use this checklist:

- empty input
- whitespace-only input
- all-stopword query
- one item
- many items
- duplicate ids/items
- mixed valid + invalid items
- malformed object shape
- missing optional fields
- unknown enum value
- unicode / emoji / non-ASCII
- path-like strings with `.`, `..`, `/`, `\\`, `_`, `-`, `:`
- absolute path vs relative path
- symlink or alias path where relevant
- max caps and truncation
- failed write/read/network call
- repeated call / idempotency
- reload/session reset
- environment variable cleanup
- clock/time-window boundary

### 6. Check integration seams

Unit tests can pass while wiring is broken. Add smoke or integration tests for:

- extension registers expected tools/commands/handlers
- router exposes intended tools in intended modes
- dangerous tools remain locked
- tool middleware actually modifies results
- persistence files are written/read
- indexes invalidate after successful mutation
- status commands report current policy
- docs/prompt snippets do not reference stale tools

### 7. Evaluate assertion strength

Red flags:

- only checks `toBeDefined()` or length
- snapshots giant output without semantic assertions
- happy path only
- tests internal implementation rather than contract
- no assertion that state did **not** change
- no assertion on error message/reason for important failures
- test name says more than assertions prove

Better assertions include:

- exact category/type/status
- important booleans (`allowed`, `mutates`, `requiresConfirmation`)
- important side effects present or absent
- persisted file contents
- command/tool exposure lists
- explanation/reason fields for observability

### 8. Produce a test-gap report

When auditing, output:

1. **Current baseline** — what tests exist and what was run.
2. **High-risk missing tests** — safety/data-loss/privacy/routing gaps.
3. **Behavior matrix gaps** — untested condition combinations.
4. **Negative test gaps** — missing reject/no-op/not-hijacked cases.
5. **Integration gaps** — registration, lifecycle, persistence, index invalidation.
6. **Mutation-testing targets** — code likely to survive weak assertions.
7. **Recommended patch order** — highest value tests first.

## TDD integration

During TDD, use this skill at two points:

### Before RED

Convert acceptance criteria into a test matrix:

- happy path
- boundary cases
- negative cases
- state/lifecycle cases
- risk-based cases

Then write the smallest failing test that proves the next behavior.

### Before declaring GREEN complete

Audit the new suite:

- Would a one-line bug survive?
- Are important branches/conditions covered?
- Are dangerous failures rejected?
- Did we test no-mutation/no-leak/no-hijack properties?
- Are integration seams covered if this is an extension/tool/lifecycle change?

## Keylime-specific prompts

For Keylime/Pi work, ask:

- Does this tool/command/event handler have a registration smoke test?
- Does routing expose it only where intended?
- Does safety classification cover both allow and deny paths?
- Does fallback logging prove classifier gaps are visible?
- Does `run_checks` block shell/runtime bypasses?
- Does repo index invalidate only after successful source mutations?
- Does tool-result compaction preserve retrievability without recursive compaction?
- Does context injection remain bounded and stable?
- Does checkpointing score successful tool results, not attempted calls?
- Does a dry-run prove no files changed?

## Useful test types to recommend

- table-driven tests for classifiers and routing
- property/metamorphic tests for invariants
- smoke tests for extension registration
- lifecycle tests for event-driven harness behavior
- persistence roundtrip tests for stores/indexes
- negative tests for dangerous tools and malformed inputs
- regression tests for every bug found during review
