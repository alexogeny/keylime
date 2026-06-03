---
name: refactor
description: >
  Systematic refactoring workflow. Use when restructuring existing code without changing behaviour — extracting abstractions, renaming, splitting modules, changing data shapes, or cleaning up accumulated debt. Integrates with git-checkpoint (safe rollback), clarify (scope), repo-map (orientation), and language-specific skills.
---

# Refactor Skill

Refactoring is behaviour-preserving transformation. The constraint is: **tests pass before and after, and the external interface is unchanged** (or intentionally versioned). The goal is making the code easier to understand, test, and extend — not proving cleverness.

---

## Workflow

### Step 0 — Gate: is this actually a refactor?

Before starting, confirm:
- [ ] The behaviour is not changing (if it is, that's a feature, not a refactor — split the work)
- [ ] You understand the current behaviour well enough to assert it won't change

If the scope is ambiguous → **stop and run `/skill:clarify` first**.
If the codebase is unfamiliar → **run `/skill:repo-map` before touching anything**.

---

### Step 1 — Checkpoint

**Always checkpoint before a refactor.**

```
/checkpoint
```

This creates a git commit you can `/undo` to instantly. If the refactor spirals or tests start failing in confusing ways, `/undo` and start smaller.

---

### Step 2 — Characterise current behaviour

Write or verify tests that cover the code being refactored *before* you touch it.

- If tests already exist and pass: run them to confirm the baseline.
- If tests are missing or thin: write **characterisation tests** first — tests that simply assert current behaviour, even if that behaviour is ugly. These are your safety net, not your spec.

```
# Run existing tests to establish baseline
cargo test -- <module>        # Rust
npx vitest run <file>         # TypeScript/Next.js
pytest <file>                 # Python
```

**Do not proceed until you have a passing test baseline.**

---

### Step 3 — Identify the seam

A *seam* is a place where you can change behaviour without modifying the code around it. Refactors work by finding the right seam.

Common seams:
- Function / method boundary (extract function)
- Module / file boundary (extract module)
- Trait / interface boundary (introduce abstraction)
- Data type boundary (change struct shape)
- Layer boundary (move logic between layers — e.g., domain vs. persistence)

Name the seam explicitly: *"I am extracting the validation logic from `handle_request` into a pure function `validate_payload`."*

---

### Step 4 — Make one change at a time

Each atomic refactor step:
1. Make the change
2. Run the test suite
3. If green: commit with a clear message (`refactor: extract validate_payload from handle_request`)
4. If red: revert *that step* (not the whole thing) and try smaller

**Never batch multiple logical changes into one commit.** A refactor commit that touches 20 files for one logical reason is fine. A commit that does two things is not.

---

### Step 5 — Language-specific patterns

#### Rust → use `/skill:rust-systems`
```rust
// Extract to pure function (easiest to test)
// Before: logic inside impl block, touching &mut self unnecessarily
// After: free function taking only what it needs

// Newtype for clarity
struct UserId(u64);  // prevents mixing user/product IDs

// Replace if-let chains with match or combinators
// Before:
if let Some(x) = foo() { if let Some(y) = bar(x) { ... } }
// After:
foo().and_then(bar).map(...)

// Split large modules: move private types to submodule, re-export
pub use inner::MyType;  // keeps public API stable
```

#### TypeScript/Next.js
```typescript
// Extract hook from component
// Before: 80-line component with fetch + transform + render
// After: useMyData() hook (testable) + <MyComponent /> (pure render)

// Replace prop drilling with context or colocated state
// Extract server action to separate file for testability
// Narrow types: replace `any` with union or discriminated union
```

#### General
- One public interface change at a time — update all call sites in the same commit
- Rename in two steps if needed: add alias → migrate call sites → remove alias
- Delete dead code **only after** verifying nothing external references it (`grep -r`, `cargo check`)

---

### Step 6 — Verify nothing drifted

After all steps:

```
# Full test suite — not just the changed module
cargo test          # Rust
npx vitest run      # TypeScript
pytest              # Python

# Type check (catches interface drift)
cargo check
npx tsc --noEmit

# Lint
cargo clippy -- -D warnings
npx eslint .
```

Also: **manually exercise the code path** if the tests don't cover the full runtime behaviour (UI, CLI output, etc.).

---

### Step 7 — Clean commit history

If you committed incrementally (Step 4), review the git log:

```bash
git log --oneline -10
```

If the commits tell a coherent story, you're done. If they're a mess of `wip` and `fix fix fix`, squash them into logical commits before merging:

```bash
git rebase -i HEAD~N
```

---

## Anti-patterns to flag

| Pattern | Problem |
|---|---|
| Refactor + feature in same PR | Can't bisect regressions |
| Tests deleted to make refactor pass | Safety net removed |
| `// TODO: fix this later` left in renamed code | Debt transferred, not paid |
| Abstract base class introduced "for future flexibility" | Premature abstraction (YAGNI) |
| Rename without updating documentation/comments | Docs lie to the next reader |

---

## Cross-skill integrations

- **Scope unclear?** → `/skill:clarify` before starting
- **Codebase unfamiliar?** → `/skill:repo-map` to orient before touching anything
- **Refactoring Rust?** → `/skill:rust-systems` §1 (ownership patterns) and §8 (idiomatic patterns)
- **Refactoring UI components?** → `/skill:ui-design` for component hierarchy and state decisions
- **Refactoring a shell/terminal codebase?** → `/skill:rust-shell-emulator` §1 (audit workflow) to understand the layer being changed
- **Tests start failing mysteriously?** → `/skill:debug` — don't guess, isolate
- **Reading an unfamiliar library to refactor toward?** → `fetch_url(url)` to read its docs/README directly
