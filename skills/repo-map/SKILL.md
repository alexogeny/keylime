---
name: repo-map
description: >
  Rapid codebase orientation skill. Use when entering an unfamiliar repository, resuming a project after a break, or preparing to debug/refactor/audit code you don't currently have in your head. Produces a structured mental model: entry points, data flow, key abstractions, dependencies, test coverage, and build commands. Integrates with fetch_url (reads README and linked docs), and language-specific skills.
---

# Repo-Map Skill

Use this skill to build a reliable mental model of a codebase before doing substantive work. The output is not a document for humans — it's an orientation checklist to ensure the agent doesn't operate on false assumptions.

**Scope this to the area of interest.** If you're about to debug the shell lexer, map the lexer module, not the whole repo.

---

## Workflow

### Step 1 — Project shape

```bash
# What type of project is this?
ls -la                          # root files: Cargo.toml? package.json? pyproject.toml?
cat Cargo.toml                  # Rust: workspace? single crate? edition?
cat package.json                # JS/TS: scripts, main entry, type: "module"?
cat tsconfig.json               # TS config: paths, strict, target
ls src/ app/ lib/ packages/     # Where does code live?

# How big is it?
find src -name "*.rs" | wc -l   # Rust source files
find . -name "*.ts" -not -path "*/node_modules/*" | wc -l
```

Answer: **what kind of project is this, and how large?**

---

### Step 2 — Entry points

Every codebase has entry points — where execution begins, where requests arrive, where data enters.

```bash
# Rust binary
grep -r "fn main" src/           # binary entry points
grep -r "#\[tokio::main\]" src/  # async entry

# Next.js
ls app/                          # App Router: layout.tsx, page.tsx, route.ts
ls pages/                        # Pages Router (if legacy)
ls app/api/                      # API routes

# Library
grep -r "pub fn\|pub struct\|pub trait" src/lib.rs  # Rust public API surface
grep -r "^export" src/index.ts   # TypeScript exports

# Shell emulator specifically
grep -r "fn main\|CommandLoop\|Repl\|Shell::new" src/
```

Answer: **where does the code start, and where do the main data/request paths enter?**

---

### Step 3 — Build, run, test commands

```bash
# Never assume — read the actual scripts
cat Makefile 2>/dev/null || cat justfile 2>/dev/null
grep -A2 '"scripts"' package.json 2>/dev/null
grep -A5 '\[\[bin\]\]' Cargo.toml 2>/dev/null

# Verify you can build it
cargo check 2>&1 | tail -5      # Rust: type errors without building
npx tsc --noEmit 2>&1 | tail -5 # TypeScript: type errors

# Verify tests exist and run
cargo test -- --list 2>/dev/null | head -20   # Rust
npx vitest list 2>/dev/null | head -20         # TypeScript
```

Answer: **what are the exact commands to build, run, and test this project?**

---

### Step 4 — Dependencies and third-party surface

```bash
# Rust
cargo tree --depth 2            # dependency tree (depth-limited)
cargo tree --duplicates         # version conflicts
grep -E "^\[dependencies\]" -A50 Cargo.toml | head -30

# TypeScript/Node
cat package.json | grep -A30 '"dependencies"'
npm ls --depth=1 2>/dev/null

# Look for unfamiliar crates/packages — use fetch_url to read their docs
```

For any dependency you don't recognise: **call `fetch_url` on its docs.rs / npm / GitHub page** to understand what it does before assuming.

Answer: **what are the key dependencies, and are there any you don't recognise?**

---

### Step 5 — Data flow

Trace the path that data takes through the system. Start from an entry point and follow it:

```
For a web request:
  HTTP request → middleware → route handler → service → repository → DB
  DB result → repository → service → serialiser → HTTP response

For a shell command:
  stdin bytes → lexer → token stream → parser → AST → expander → expanded AST
  → executor → process spawn → stdout/stderr → PTY master → terminal display

For a Rust binary:
  main() → arg parse → config load → event loop → handler → output
```

Use `grep` to follow the call chain:
```bash
grep -r "fn handle_\|fn process_\|fn execute_" src/ | head -20
grep -r "struct.*Request\|struct.*Command\|struct.*Event" src/ | head -10
```

Answer: **what is the critical path, and what are the major transformation steps?**

---

### Step 6 — Key abstractions

The key abstractions are the types and traits/interfaces that everything else is built around.

```bash
# Rust: what are the main public types?
grep -r "^pub struct\|^pub enum\|^pub trait" src/ | grep -v "test\|mod " | head -30

# TypeScript: what are the main interfaces/types?
grep -r "^export (interface|type|class|function)" src/ | head -30

# What errors does this system produce?
grep -r "enum.*Error\|type.*Error\|Error {" src/ | head -15
```

For a shell emulator specifically:
```bash
grep -r "enum Token\|struct Token\|enum Node\|struct Ast\|enum Command" src/
grep -r "pub struct Shell\|pub struct Lexer\|pub struct Parser" src/
```

Answer: **what are the 5–10 most important types? What do they represent?**

---

### Step 7 — Test coverage

```bash
# How many tests exist, and where?
find . -name "*.rs" -exec grep -l "#\[test\]\|#\[cfg(test)\]" {} \; | wc -l
find . -name "*.test.ts" -o -name "*.spec.ts" | wc -l
find . -name "test_*.py" | wc -l

# What areas have no tests?
# For Rust: modules without a #[cfg(test)] block
grep -rL "#\[cfg(test)\]" src/**/*.rs 2>/dev/null | head -10

# Run tests to see baseline
cargo test 2>&1 | tail -10
npx vitest run 2>&1 | tail -10
```

Answer: **where are the test gaps? What critical paths have no test coverage?**

---

### Step 8 — Read README and linked docs

```bash
cat README.md 2>/dev/null | head -100
```

If the README references external docs, architecture decisions, or design notes:
→ **Call `fetch_url(url)` on the most relevant links** to read full context.

Also fetch any linked design docs, ADRs, or specification files:
```bash
ls docs/ ADR/ .pi/ 2>/dev/null   # local decision records
```

---

### Step 9 — Orientation summary

After completing Steps 1–8, state:

```
Project: [name and type]
Language/stack: [Rust / TypeScript+Next.js / ...]
Entry point: [main.rs:main() / app/page.tsx / ...]
Critical data path: [A → B → C → D]
Key types: [Type1 (purpose), Type2 (purpose), ...]
Key dependencies: [dep1 (what it does), dep2 ...]
Build: [command]
Test: [command] — [N tests, coverage notes]
Test gaps: [areas with no tests]
Unfamiliar areas: [modules I haven't traced yet]
```

---

## Language-specific orientation

### Rust project → `/skill:rust-systems`
- Check for `unsafe` blocks: `grep -rn "unsafe" src/ | grep -v "^.*//"`
- Check for unwrap/expect: `grep -rn "\.unwrap()\|\.expect(" src/`
- Understand the error type hierarchy — it tells you the failure modes
- `cargo doc --open` for the full API with cross-references

### Shell/terminal emulator → `/skill:rust-shell-emulator`
- Layer the orientation: terminal layer first, then shell engine
- Entry points: the PTY setup and the main read loop
- Key types: Token, AST node, Job, Shell state
- Signal handling: where are SIGCHLD, SIGWINCH, SIGINT caught?

### TypeScript/Next.js SaaS
- App Router: `app/` hierarchy is the route map — read it first
- Server vs Client components: `"use client"` directives mark the boundary
- Auth: where does the session/user object enter the request handler?
- DB: what's the schema file? (`schema.ts` in Drizzle, `prisma/schema.prisma`)
- Key question: where do server actions live, and how do they validate input?

---

## Cross-skill integrations

- **About to debug?** → run this skill scoped to the failing module first → `/skill:debug`
- **About to refactor?** → run this skill to understand the seam → `/skill:refactor`  
- **About to audit a shell emulator?** → this skill + `/skill:rust-shell-emulator` §1
- **Unfamiliar deps?** → `fetch_url(docs_url)` to read without leaving the session
- **Architecture decisions recorded?** → `ls docs/decisions/` for ADRs (from `log_decision`)
