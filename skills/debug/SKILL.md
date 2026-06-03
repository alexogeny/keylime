---
name: debug
description: >
  Systematic debugging workflow. Use when tracking down a bug, regression, panic, crash, unexpected output, or failing test. Enforces root-cause discipline — reproduce first, isolate second, hypothesise third, fix last. Integrates with repo-map (orientation), fetch_url (reading error docs), git-checkpoint (safe fix attempts), and language-specific skills.
---

# Debug Skill

The failure mode of AI-assisted debugging is **symptom patching**: adding a guard clause that hides the error without understanding why it occurred. This skill enforces root-cause discipline.

**Rule: never write a fix until you can state the root cause in one sentence.**

---

## Workflow

### Step 0 — Read the error completely

Before doing anything else, read the full error output:

- Complete stack trace (not just the last line)
- The exact assertion or panic message
- Any context from surrounding log lines

Common mistake: fixing the last line of the stack trace when the root cause is 20 lines up.

---

### Step 1 — Reproduce reliably

**A bug you cannot reproduce reliably is a bug you cannot verify is fixed.**

```bash
# Minimal reproduction steps:
# 1. Exact command / input that triggers it
# 2. Expected output vs actual output
# 3. Frequency (always / sometimes / once)
```

If it's intermittent (race condition, timing-dependent):
- Add structured logging and run in a loop
- Use `cargo test -- --test-threads=1` (Rust) to serialise async tests
- Check for `RUST_BACKTRACE=1` / `RUST_LOG=debug`

**Do not proceed to hypothesis until you have a reliable reproduction.**

---

### Step 2 — Orient (if the bug is in unfamiliar code)

If the failing code is in a module or codebase you haven't recently worked in:

→ **Run `/skill:repo-map`** with scope limited to the failing area.

Target questions:
- What is the data flow into the failing code path?
- What state does this code depend on?
- What invariants does the caller expect?

If the error message references an external library or framework:
→ **Call `fetch_url(url)`** on the relevant docs page or GitHub issue to read full context without leaving the session.

---

### Step 3 — Form hypotheses (before looking at code)

Write down 2–4 hypotheses for what could cause this symptom:

```
Symptom: NullPointerException in UserRepository.findById
Hypotheses:
  H1: The ID being passed is 0 or negative (invalid)
  H2: The database connection pool is exhausted
  H3: The user was deleted between the check and the fetch (TOCTOU)
  H4: The ORM is mapping NULL from a LEFT JOIN as a missing object
```

Rank them by likelihood. **Check the most likely first.** This prevents spending 30 minutes investigating the least likely cause.

---

### Step 4 — Isolate with the smallest possible change

Binary-search the code, not the symptoms:

```
If the bug is somewhere in the call stack A → B → C → D:
  Test: does it occur if I call C directly with the same input?
  If yes: bug is in C or D
  If no: bug is in A or B (the setup)
```

Isolation tools:
```bash
# Add a single targeted log at the hypothesis boundary
eprintln!("DEBUG: value={:?}", value);   # Rust
console.log("DEBUG:", value);             # TypeScript
print(f"DEBUG: {value=}")                 # Python

# Run just the failing test in isolation
cargo test test_name -- --nocapture      # Rust
npx vitest run -t "test name"            # TypeScript
pytest tests/file.py::test_name -s       # Python
```

**Remove all debug instrumentation before committing the fix.**

---

### Step 5 — State the root cause

Before writing any fix, complete this sentence:

> *"This bug occurs because [specific condition] causes [mechanism] which results in [observed symptom]."*

Examples of good root-cause statements:
- *"This bug occurs because `split_at` receives a byte offset instead of a char index on a multi-byte UTF-8 string, causing a panic at the char boundary."*
- *"This bug occurs because the SIGCHLD handler reaps children before the foreground job table is updated, causing the shell to report job completion before the terminal is restored."*
- *"This bug occurs because the Drizzle query uses `eq(table.id, id)` where `id` is a string but the column is an integer, causing a type mismatch that returns 0 rows."*

**If you cannot state the root cause, you have not isolated it yet. Go back to Step 4.**

---

### Step 6 — Checkpoint before fixing

Before writing the fix:

```
/checkpoint
```

If the fix turns out to be wrong or creates new failures, `/undo` and try a different approach without losing current state.

---

### Step 7 — Write the minimal fix

Fix only the root cause. Do not:
- Add defensive `if (x == null) return;` guards around the symptom
- Refactor surrounding code at the same time
- "Improve" the error handling of adjacent code

If the fix requires a refactor to be clean → **finish the bug fix first, commit it, then do a separate refactor commit** using `/skill:refactor`.

---

### Step 8 — Verify: fix works AND nothing else broke

```bash
# 1. The specific test that was failing now passes
# 2. The full suite still passes (no regressions)
# 3. The symptom is gone in the actual runtime context (not just the test)

cargo test              # Rust — all tests
npx vitest run          # TypeScript
cargo check             # Rust — type system
npx tsc --noEmit        # TypeScript — types
```

If a previously-passing test now fails: **you introduced a regression**. Do not merge. Investigate.

---

## Language-specific patterns

### Rust bugs → `/skill:rust-systems`

```rust
// Panic: index out of bounds
// Always check: is the index from char boundaries or byte boundaries?
let ch = &s[byte_offset..];  // OK only if byte_offset is on a char boundary
let ch = s.chars().nth(n);   // safe char-indexed access

// Panic: unwrap() on None/Err in production code
// Fix: propagate with ? or provide a meaningful default
let val = map.get(&key).ok_or(MyError::NotFound(key))?;

// Deadlock: two threads each holding a Mutex the other needs
// Fix: consistent lock ordering, or use tokio::select! to time out

// Use-after-free in unsafe: verify SAFETY comment invariants
// RUST_BACKTRACE=full gives the full unsafe call chain

// Async task never completes
// Add timeout: tokio::time::timeout(Duration::from_secs(5), fut).await
```

### Shell emulator bugs → `/skill:rust-shell-emulator`

Focus on §5 (process management) and §1 Layer 6 (signal handling).

Common shell emulator bugs:
- SIGCHLD race: handler fires before job table is updated
- PTY fd leak: master fd inherited by child after exec
- Heredoc body consumed from wrong position in input stream
- Word splitting on IFS not applied after command substitution

### TypeScript/Next.js bugs

```typescript
// Hydration mismatch: server and client render different HTML
// Fix: ensure no Date.now(), Math.random(), or window access in SSR

// Drizzle type mismatch: column is integer, query passes string
// Fix: use schema types, not raw strings for IDs

// async/await missing: Promise returned but not awaited
// Fix: TypeScript strict mode + eslint no-floating-promises

// RSC/Client boundary: using useState in a Server Component
// Fix: add "use client" directive or extract to client component
```

---

## Security bugs → think like red team

If the bug involves user input, authentication, or data access:
→ Reference `/skill:red-team` §2 (threat profile) before writing the fix.

Ask:
- Could an attacker trigger this deliberately?
- Does the fix create a new attack surface?
- Is this a symptom of a deeper trust-boundary violation?

---

## Cross-skill integrations

- **Unfamiliar codebase?** → `/skill:repo-map` before Step 3
- **Need to read error docs or a related GitHub issue?** → `fetch_url(url)` in Step 2 or 5
- **Fix requires restructuring code?** → finish the fix, then `/skill:refactor`  
- **Rust panic/unsafe?** → `/skill:rust-systems` §4 (unsafe audit)
- **Shell emulator signal/PTY bug?** → `/skill:rust-shell-emulator` §1 Layer 5–6
- **Security-sensitive bug?** → `/skill:red-team` §2 before fixing
