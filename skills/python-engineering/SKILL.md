---
name: python-eng
description: Surgical Python performance optimization for requests like 'optimize this code'. Finds hot paths, syscall-heavy patterns, CPU/memory waste, and rewrites code using vanilla, readable techniques first; provides concise rationale and measurable before/after checks.
---

# Python Engineering (python-eng)

Use this skill when the user asks to speed up existing Python code, especially with prompts like:
- "optimize this function/module"
- "this is too slow"
- "reduce memory/CPU/syscalls"

## Command usage
- `/skill:python-eng optimize <function_or_module>`
- `/skill:python-eng <paste code and ask for optimization>`

## Operating mode
Default to **surgical optimization**:
- Prefer direct rewrites over long diagnostic reports.
- Keep explanations short and efficient.
- Write declarative, readable Python.
- Do **not** preserve old code unless user asks.
- Keep traceability: include a minimal before/after measurement snippet.

---

## Workflow

### 1) Fast triage (spot likely hotspots immediately)
Check for:
- Python loops over large sequences doing per-item work.
- Repeated conversions/copies (`list(...)`, slicing in loops, `+` on large strings/lists).
- Tiny repeated I/O ops (`read(1)`, per-line small writes, frequent flushes).
- Per-item heavy parsing (regex/json/datetime) inside loops.
- Blocking sync I/O in async paths.
- N+1 patterns around DB/network/file calls.

### 2) Lightweight evidence (only what’s needed)
Use minimal measurement unless user asks deeper profiling:
- Add quick `time.perf_counter()` timing around suspect block.
- If needed, run `cProfile` to rank hot functions.
- Suggest `py-spy` only for live/long-running processes.

### 3) Vanilla-first optimization order
Apply in this order:
1. Simplify algorithm and data flow.
2. Replace manual loops with builtins/stdlib (`sum`, `any`, `all`, `join`, `Counter`, `defaultdict`, `itertools`).
3. Reduce allocations/copies (streaming, generators, in-place updates where clear).
4. Reduce syscall count (batch reads/writes, buffering, chunked processing).
5. Improve data layout with stdlib tools (`array`, `memoryview`, `deque`, `heapq`) when simple.
6. Stay in vanilla Python by default. Mention NumPy/Numba/Cython only as optional follow-ups when explicitly requested.

### 4) Output contract (always)
Return:
1. **Slow points** (1–3 bullets)
2. **Optimized code** (final code only unless asked)
3. **Why faster** (cpu/memory/syscall rationale, concise)
4. **Expected impact** (low/med/high)
5. **Quick verify snippet** (before/after timing)

---

## Style constraints

### Explanation style
- Minimal, direct language.
- No long perf essays unless requested.

### Code style
- Declarative and readable.
- Clear names, small functions, obvious control flow.
- Avoid clever micro-optimizations that hurt maintainability.

---

## Worked examples

### A) CPU loop → builtin aggregation
Before:
```python
total = 0
for x in values:
    total += x * x
```

After:
```python
total = sum(x * x for x in values)
```

Why: reduces Python bytecode overhead in loop bookkeeping.

---

### B) Many small writes → single buffered write
Before:
```python
for line in lines:
    f.write(line + "\n")
```

After:
```python
f.write("".join(f"{line}\n" for line in lines))
```

Why: fewer write calls, lower syscall overhead.

---

### C) Repeated parsing in loop → hoist/cache
Before:
```python
out = []
for row in rows:
    dt = datetime.strptime(row["ts"], "%Y-%m-%d")
    out.append(dt.year)
```

After:
```python
from functools import lru_cache
from datetime import datetime

@lru_cache(maxsize=4096)
def parse_day(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%d")

out = [parse_day(row["ts"]).year for row in rows]
```

Why: avoids repeated parse cost for recurring values.

---

### D) Async path with mmap risk → explicit buffered reads
Before:
```python
mm = mmap.mmap(fd, 0, access=mmap.ACCESS_READ)
chunk = mm[offset:offset+size]
```

After:
```python
with open(path, "rb", buffering=1024 * 1024) as f:
    f.seek(offset)
    chunk = f.read(size)
```

Why: avoids hidden page-fault blocking behavior that can hurt async concurrency.

---

### E) List materialization → streaming generator
Before:
```python
valid = [parse(x) for x in records if is_valid(x)]
return sum(valid)
```

After:
```python
return sum(parse(x) for x in records if is_valid(x))
```

Why: avoids building a large temporary list; lowers peak memory and allocator work.

---

### F) N+1 network calls → batched fetch
Before:
```python
profiles = []
for user_id in user_ids:
    profiles.append(api.get_profile(user_id))
```

After:
```python
profiles = api.get_profiles_batch(user_ids)
```

Why: fewer round trips/syscalls and lower per-request overhead.

---

### G) Bytes copies in protocol parser → memoryview slicing
Before:
```python
def parse_frame(buf: bytes) -> tuple[int, bytes]:
    size = int.from_bytes(buf[:4], "big")
    payload = bytes(buf[4:4+size])
    return size, payload
```

After:
```python
def parse_frame(buf: bytes) -> tuple[int, memoryview]:
    view = memoryview(buf)
    size = int.from_bytes(view[:4], "big")
    payload = view[4:4+size]
    return size, payload
```

Why: avoids extra byte copies on hot parsing paths.

---

## Contemporary CPU-time + SIMD notes (optional, non-default)
- Default approach is still vanilla Python + stdlib optimizations.
- SIMD-oriented approaches are optional and usually require third-party numeric stacks.
- If user opts in, prefer minimal-surface changes (small isolated hot kernels) over broad rewrites.
- Validate with realistic input sizes; SIMD wins may disappear on small data.
- Treat free-threaded CPython builds as workload-specific: benchmark before adoption.

---

## Quick verification template

```python
from time import perf_counter

def bench(fn, *args, n=5, **kwargs):
    best = float("inf")
    for _ in range(n):
        t0 = perf_counter()
        fn(*args, **kwargs)
        best = min(best, perf_counter() - t0)
    return best

print("before:", bench(before_fn, data))
print("after :", bench(after_fn, data))
```

Report as: `before Xs → after Ys (Z% faster)`.

---

## Escalation policy
Escalate only when the user asks or when vanilla cannot meet a clear target:
- First escalation: native stdlib-friendly options (algorithmic changes, multiprocessing, `concurrent.futures`, C-implemented stdlib modules).
- Second escalation (optional): third-party numeric/compiled paths (NumPy/Numba/Cython) with explicit opt-in.
- Keep these as proposals, not default rewrites.

---

## Evidence anchors
- NumPy SIMD dispatch model: https://numpy.org/doc/2.2/reference/simd/index.html
- NEP-38 SIMD design: https://numpy.org/neps/nep-0038-SIMD-optimizations.html
- mmap async blocking hazard context: https://huonw.github.io/blog/2024/08/async-hazard-mmap
- py-spy (low-overhead sampling): https://github.com/benfred/py-spy
