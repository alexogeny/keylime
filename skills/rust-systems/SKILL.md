---
name: rust-systems
description: >
  Rust systems programming skill. Use when writing, auditing, or enhancing Rust code involving memory management, ownership/lifetimes, async/concurrency, real-time constraints, kernel/no_std environments, dynamic programming algorithms, or low-level system interfaces. Covers contemporary 2025–2026 Rust idioms, crate ecosystem, and performance patterns.
---

# Rust Systems Programming Skill

Use this skill for any Rust work that goes beyond basic application code — systems-level concerns, correctness proofs, performance auditing, concurrency design, embedded/kernel work, or algorithm implementation.

---

## 1. Ownership, Borrowing & Lifetimes

### The Three Rules (enforced at compile time)
1. **Each value has exactly one owner.** When the owner goes out of scope, the value is dropped (RAII).
2. **You may have either:** one `&mut T` (exclusive mutable reference) **or** any number of `&T` (shared immutable references) — never both simultaneously.
3. **References must not outlive the data they point to.** Lifetimes encode this constraint; the compiler infers most of them.

### Common Patterns
```rust
// Clone to escape borrow conflicts (cheap for small types, expensive otherwise)
let owned = borrowed_str.to_owned();

// Index-based patterns avoid self-referential borrow issues
// Instead of: self.items[i].process(&self.cache)
// Do:
let item = &self.items[i];  // Borrow ends after this block
let result = item.something();
self.cache.insert(key, result);

// Split borrows: borrow disjoint struct fields simultaneously
let (left, right) = slice.split_at_mut(mid);

// Interior mutability (break borrow rules safely at runtime)
use std::cell::RefCell;      // single-threaded
use std::sync::{Mutex, RwLock};  // multi-threaded
use std::sync::atomic::*;   // lock-free primitives

// Rc / Arc for shared ownership
use std::rc::Rc;             // single-threaded reference counting
use std::sync::Arc;          // atomic (thread-safe) reference counting
```

### Lifetime Annotations
```rust
// Lifetime 'a means: the output reference lives at least as long as input 'a
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

// Struct holding a reference — must annotate
struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

// 'static: lives for entire program duration (string literals, leaked memory)
fn global_config() -> &'static Config { ... }
```

### Lifetime Audit Checklist
- [ ] Does any function return a reference? Lifetime must be tied to an input parameter or `'static`
- [ ] Struct holding `&T`? Must have lifetime parameter — consider owning the data instead
- [ ] Using `unsafe { &*ptr }`? Manually verify the pointed-to data outlives the reference
- [ ] `transmute`? Almost certainly wrong — prefer `as` casts or safe conversion traits

---

## 2. Error Handling

Rust's idiomatic error handling is railway-oriented: no exceptions, return `Result<T, E>`.

```rust
// Define domain errors as an enum
#[derive(Debug, thiserror::Error)]
enum ShellError {
    #[error("command not found: {0}")]
    CommandNotFound(String),
    #[error("parse error at position {pos}: {msg}")]
    ParseError { pos: usize, msg: String },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

// Use ? operator to propagate
fn run_command(cmd: &str) -> Result<Output, ShellError> {
    let parsed = parse(cmd)?;  // propagates ParseError
    let output = execute(parsed)?;  // propagates IoError
    Ok(output)
}

// anyhow for application-level error handling (context chains)
use anyhow::{Context, Result};
fn load_config(path: &Path) -> Result<Config> {
    let data = fs::read_to_string(path)
        .with_context(|| format!("reading config from {}", path.display()))?;
    Ok(serde_json::from_str(&data)?)
}
```

**Key crates:** `thiserror` (derive Error for library errors), `anyhow` (context-rich errors for applications), `miette` (fancy diagnostic output with source spans).

---

## 3. Async & Concurrency

### When to Use Async vs Threads

| Scenario | Use |
|---|---|
| Many concurrent I/O operations (thousands of connections) | `async`/Tokio |
| CPU-bound parallel work | `rayon` (work-stealing thread pool) |
| Hard real-time (strict latency, SCHED_FIFO) | Dedicated OS threads, avoid async |
| Shell pipeline stages | Threads or blocking + pipes |
| Terminal I/O + event loop | `crossterm` event loop (sync or async) |

### Tokio Patterns
```rust
// Basic runtime setup
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Tokio runtime with work-stealing multi-thread scheduler
}

// Spawn background task
let handle = tokio::spawn(async move {
    // Runs concurrently on the thread pool
    heavy_work().await
});
let result = handle.await?;

// Race multiple futures — take the first to complete
tokio::select! {
    output = read_from_pty() => handle_output(output),
    cmd    = rx.recv()       => handle_command(cmd),
    _      = shutdown_signal => break,
}

// Channels (choose by pattern)
use tokio::sync::{mpsc, oneshot, broadcast, watch};
// mpsc: N producers → 1 consumer (most common)
// oneshot: 1 response to 1 request
// broadcast: 1 producer → N consumers (each get all messages)
// watch: latest-value channel (like a shared variable with change notification)

// Avoid blocking in async context
tokio::task::spawn_blocking(|| {
    // Runs in a dedicated blocking thread pool
    std::fs::read_to_string("large_file.txt")
}).await?;
```

### Real-Time Concurrency Patterns (Hard RT)
```rust
// Pin thread to a CPU core
use core_affinity;
core_affinity::set_for_current(core_affinity::CoreId { id: 0 });

// Set SCHED_FIFO scheduling priority (Linux)
use libc::{sched_param, sched_setscheduler, SCHED_FIFO};
unsafe {
    let param = sched_param { sched_priority: 80 };
    sched_setscheduler(0, SCHED_FIFO, &param);
}

// Lock-free queue for inter-thread communication
use crossbeam::channel;
let (tx, rx) = channel::bounded(1024);  // bounded = backpressure

// Pre-allocate to avoid runtime allocator
let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);

// Avoid these in RT context:
// - std::sync::Mutex (can block on contention)
// - allocator (use a custom lock-free allocator or pre-alloc)
// - println! (locks stdout)
```

---

## 4. Unsafe Rust

`unsafe` blocks opt out of the borrow checker for specific operations. Use sparingly; always document the invariant being maintained.

### When Unsafe Is Needed
- Raw pointer arithmetic (`*const T`, `*mut T`)
- FFI calls (`extern "C"`)
- Implementing `Send`/`Sync` for types the compiler can't verify
- MMIO/hardware registers
- Calling OS syscalls directly (via `libc` or `nix`)

### Unsafe Audit Checklist
```rust
// Every unsafe block must have a SAFETY comment explaining the invariant
unsafe {
    // SAFETY: ptr is guaranteed non-null and properly aligned because
    // it was obtained from Box::into_raw and has not been freed.
    let val = &*ptr;
}

// Common patterns to CHECK in audit:
// 1. Is the pointer guaranteed non-null?
// 2. Is the pointed-to memory still alive?
// 3. Is alignment correct for the type?
// 4. Is there any aliasing violation?
// 5. Is this Send/Sync safe across threads?
// 6. Are FFI string lifetimes correct (NUL termination, encoding)?
```

---

## 5. Dynamic Programming in Rust

### Tabulation (Bottom-Up) — Preferred

```rust
// Knapsack — tabulation with Vec
fn knapsack(weights: &[usize], values: &[usize], capacity: usize) -> usize {
    let n = weights.len();
    let mut dp = vec![vec![0usize; capacity + 1]; n + 1];
    for i in 1..=n {
        for w in 0..=capacity {
            dp[i][w] = dp[i-1][w];
            if weights[i-1] <= w {
                dp[i][w] = dp[i][w].max(dp[i-1][w - weights[i-1]] + values[i-1]);
            }
        }
    }
    dp[n][capacity]
}

// Edit distance — space-optimised rolling array
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            curr[j+1] = if ca == cb {
                prev[j]
            } else {
                1 + prev[j].min(prev[j+1]).min(curr[j])
            };
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}
```

### Memoization (Top-Down) — HashMap or Vec Cache

```rust
use std::collections::HashMap;

fn fib_memo(n: u64, cache: &mut HashMap<u64, u64>) -> u64 {
    if n <= 1 { return n; }
    if let Some(&v) = cache.get(&n) { return v; }
    let v = fib_memo(n-1, cache) + fib_memo(n-2, cache);
    cache.insert(n, v);
    v
}

// DP state as enum (detect cycles)
#[derive(Clone)]
enum State<T> { Unvisited, InProgress, Done(T) }

// Parallel independent DP fills with rayon
use rayon::prelude::*;
dp_table.par_iter_mut()
    .enumerate()
    .for_each(|(i, cell)| { *cell = compute(i); });
```

### Performance Rules
- Dense state space (integer-indexed): **Vec** — O(1), cache-friendly, 3–10× faster than HashMap
- Sparse state space: **HashMap** or **BTreeMap** (sorted iteration)
- Rolling array when only previous row/column is needed — halves memory
- `rayon::par_iter_mut()` for independent fills across large tables

---

## 6. Key Crates Reference (2025)

### Error Handling
| Crate | Use |
|---|---|
| `thiserror` | Derive `Error` for library error types |
| `anyhow` | Application-level error chaining with context |
| `miette` | Rich diagnostic output with source spans |

### Concurrency & Async
| Crate | Use |
|---|---|
| `tokio` | Async runtime (multi-thread work-stealing) |
| `tokio-uring` | io_uring backend for Linux (higher throughput) |
| `rayon` | CPU-bound parallel iterators |
| `crossbeam` | Lock-free channels, epoch-based memory reclamation |
| `parking_lot` | Faster Mutex/RwLock than std |
| `dashmap` | Concurrent HashMap |

### System Interfaces
| Crate | Use |
|---|---|
| `nix` | Safe wrappers over POSIX syscalls (PTY, signals, fork, wait) |
| `libc` | Raw C bindings for anything nix doesn't cover |
| `signal-hook` | Safe, iterator-based POSIX signal handling |
| `core-affinity` | Pin threads to CPU cores |

### Algorithms & Data Structures
| Crate | Use |
|---|---|
| `indexmap` | HashMap with insertion-order iteration |
| `petgraph` | Graph data structures and algorithms (DFS, BFS, Dijkstra) |
| `slotmap` | Stable handles into a dense Vec (great for arenas) |
| `bumpalo` | Bump allocator (arena allocation, fast, no individual free) |

### Diagnostics & Observability
| Crate / Tool | Use | Production dependency? |
|---|---|---|
| `tracing` | Structured logging + async-aware spans | Yes, when runtime observability is required |
| `tracing-subscriber` | Tracing output formatting and filtering | Usually application/runtime only, not library APIs |
| `criterion` | Statistical benchmarks and regression guards | **Dev-dependency preferred** |
| `pprof` | CPU profiling / profiler export integration | Dev tooling unless production profiling is operationally required |
| `dhat` / `dhat-rs` | Allocation/heap profiling | **Dev-dependency preferred** |
| `flamegraph` / `cargo-flamegraph` | Sampling profiler integration | **Dev tooling preferred** |
| `cargo-bloat` | Binary size and crate contribution analysis | **Dev tooling preferred** |
| `cargo-llvm-lines` | LLVM IR/code-size attribution | **Dev tooling preferred** |
| `heaptrack` | Native heap/allocation profiler | **Dev tooling preferred** |
| `samply` | Firefox profiler-based sampling profiles | **Dev tooling preferred** |

Default preference: keep production/runtime builds dependency-light. Prefer standard library and first-party tooling in production code; add external crates selectively and document why. Profiling/benchmarking tools are acceptable — often recommended — in dev-only pipelines, CI, benchmarking, and analysis stages, but should not become production dependencies without a concrete operational need.

---

## 7. Performance & Optimization Workflow

Treat performance work like debugging:

1. Measure the current behaviour.
2. Form one hypothesis.
3. Optimize one thing.
4. Re-measure with the same workload.
5. Keep the change only if it improves the measured bottleneck without hurting correctness or portability.

Always profile optimized release builds, not debug builds. Debug builds are useful for correctness and diagnostics but can be 10–100× slower and misleading for optimizer-sensitive code.

Recommended release profile for profiler-friendly symbols:

```toml
[profile.release]
debug = "line-tables-only"
```

For better stack traces in sampling profilers, especially on Linux:

```bash
RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release
```

If profiler output contains mangled Rust symbols, use `rustfilt`, or build with `RUSTFLAGS="-C symbol-mangling-version=v0"` where appropriate.

Keep profiling and benchmarking dependencies dev-only by default (`[dev-dependencies]`, cargo subcommands, CI tools, local profilers). Promote them to runtime dependencies only when there is a clear production observability or operational requirement.

### Measurement Ladder

- **End-to-end timing:** `hyperfine`
- **CPU hotspots:** `perf`, `cargo flamegraph`, `samply`, Instruments, VTune, AMD uProf
- **Deterministic instruction/cache analysis:** Cachegrind / Callgrind
- **Heap/allocation profiling:** DHAT, heaptrack, bytehound, jemalloc profiling / `pprof` exporters
- **Binary/code bloat:** `cargo bloat`, `cargo llvm-lines`
- **Regression guard:** Criterion benchmarks or integration performance tests

### Command Cookbook

```bash
cargo build --release
hyperfine --warmup 10 './target/release/app --workload sample'

cargo flamegraph --bin app -- --workload sample
perf record -g ./target/release/app --workload sample
perf report

strace -c ./target/release/app --workload sample
strace -f -c ./target/release/app --workload sample

heaptrack ./target/release/app --workload sample
valgrind --tool=dhat ./target/release/app --workload sample

cargo bench
cargo bench parser

cargo bloat --release --crates
cargo llvm-lines
```

### Optimization Priority Order

1. Algorithmic complexity
2. I/O and syscalls
3. Allocation churn
4. Data layout/cache locality
5. Branch/cache behaviour
6. Lock contention/concurrency
7. Binary/code size

### Rust-Specific Tuning Patterns

- Borrow `&str` / `&[T]` instead of cloning `String` / `Vec<T>` in hot paths.
- Use `Vec::with_capacity`, `String::with_capacity`, and reusable `.clear()` buffers.
- Prefer `write!(&mut String, ...)` over repeated `format!()` in loops.
- Avoid regex for simple parsing/tokenization.
- For tiny maps/sets, sorted `Vec` or arrays can beat `HashMap`.
- For internal non-adversarial maps, `rustc_hash` / `ahash` can be faster than SipHash; avoid them for attacker-controlled keys unless DoS risk is acceptable, and remember the default production dependency preference.
- Use `Cow<'_, str>` when most inputs are borrowed but occasional normalization is needed.
- Watch hidden allocations from `.collect()`.
- Don’t remove dynamic dispatch unless profiles show it matters.
- Use LTO/PGO/`target-cpu=native` only after portability and correctness requirements are clear.

### Shell/Systems Profiling Targets

- Startup latency
- Parser/expansion/completion
- Fork/exec path
- TUI refresh loops
- Sandbox setup
- `/proc` parsing
- `PATH`/env/config filesystem probes

---

## 8. Performance Audit Checklist

When reviewing Rust code for performance:

- [ ] **Measured bottleneck:** is there profile or benchmark evidence for the optimization?
- [ ] **Unnecessary clones:** `clone()` on large types — can it be borrowed as `&str`, `&[T]`, or `&T`?
- [ ] **Box<dyn Trait> in hot paths:** virtual dispatch overhead — only replace with enum dispatch/generics if profiles show it matters
- [ ] **HashMap::new():** default SipHash is security-focused; faster hashers can help internal non-adversarial keys but add production dependency/risk
- [ ] **Allocations in loops:** `Vec::new()` / `String::new()` inside loops — pre-allocate or reuse with `.clear()`
- [ ] **String formatting in hot paths:** `format!()` allocates — use `write!()` into a pre-allocated buffer
- [ ] **Parsing overhead:** regex or allocation-heavy tokenization for simple parsing — can a byte/char scanner do it?
- [ ] **Syscall/I/O overhead:** repeated filesystem/env/PATH probes, `/proc` parsing, `fork`/`exec`, small reads/writes
- [ ] **Mutex contention:** profile with `perf`/flamegraphs; consider narrower critical sections, RwLock, sharding, or lock-free alternatives
- [ ] **Blocking in async:** any `std::fs`, `std::net`, or heavy computation in async fn without `spawn_blocking`
- [ ] **Unnecessary Arc/Rc:** shared ownership has overhead — can lifetime annotations eliminate the need?
- [ ] **Iterator chaining:** lazy evaluation is zero-cost; adding `.collect()` early can allocate and hide work
- [ ] **Release profile:** always benchmark/profile with optimized release builds and comparable workloads

---

## 9. Idiomatic Rust Patterns (2025)

```rust
// Newtype pattern for type safety
struct Pid(u32);
struct Fd(i32);
// Now you can't accidentally pass a Pid where an Fd is expected

// Builder pattern
let cmd = Command::new("ls")
    .arg("-la")
    .env("TERM", "xterm-256color")
    .stdin(Stdio::piped())
    .spawn()?;

// Type-state pattern (encode state machine in types)
struct Shell<State> { inner: Inner, _state: PhantomData<State> }
struct Running;
struct Stopped;
impl Shell<Running> {
    fn stop(self) -> Shell<Stopped> { ... }
}
impl Shell<Stopped> {
    fn resume(self) -> Shell<Running> { ... }
}
// Compiler prevents calling stop() on an already-stopped shell

// From/Into for ergonomic conversions
impl From<io::Error> for ShellError { ... }

// Display + Debug for all error types
#[derive(Debug)]
struct MyError { ... }
impl std::fmt::Display for MyError { ... }

// Iterators as APIs — lazy, zero-cost
fn tokenize(input: &str) -> impl Iterator<Item = Token> + '_ {
    Lexer::new(input)
}
```

---

## 10. Toolchain & Workflow (2025)

```bash
# Essential tools
rustup update                    # Keep toolchain current
cargo clippy -- -D warnings      # Linting; -D = deny (treat as errors)
cargo fmt                        # Format (enforced in CI)
cargo test                       # Unit + integration tests
cargo bench                      # Criterion benchmarks
cargo build --release            # Optimised binary

# Useful cargo subcommands
cargo expand                     # Show macro expansion (cargo-expand)
cargo audit                      # Dependency security audit (cargo-audit)
cargo bloat --release            # Find large functions/crates
cargo machete                    # Find unused dependencies
cargo doc --open                 # Build and open documentation

# Profiling / performance analysis (dev tooling preferred)
cargo flamegraph                 # Sampling profiler (cargo-flamegraph)
RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release
cargo bloat --release            # Binary size attribution
cargo llvm-lines                  # LLVM/code-size attribution
# Prefer [profile.release] debug = "line-tables-only" over globally bloating release artifacts

# Rust editions
# Rust 2024 edition: let-chains, unsafe extern blocks, async closures (stable)
# Set in Cargo.toml: edition = "2024"
```
