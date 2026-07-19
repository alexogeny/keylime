# Performance theses — RED-to-GREEN contract

These tests cover CPU work, retained memory, wall-clock latency, retrieval ranking, telemetry lifecycle, and compaction preparation. They use real production modules, real filesystem persistence, and deterministic high-volume inputs; no mocks, stubs, monkeypatches, or intercepted model calls.

## Contracts

- Compaction traverses at most 4,096 structured nodes, copies bounded string slices, retains bounded head/tail buffers, and preserves both earliest and newest state.
- Incremental compaction uses at most 80,000 conversation characters when a previous checkpoint exists; first compaction remains capped at 120,000.
- Active controls are content-deduplicated and fail closed above a 40,000-character durable budget.
- Evidence retrieval performs one expensive relevance evaluation per admitted candidate and supports an explicit prefilter ceiling.
- Runtime observations and durable controls expose measurable entry/character ceilings and reject overflow before mutation.
- Permanent telemetry remains on disk rather than accumulating one in-memory object per day; latency histograms have fixed cardinality.
- Wall-clock checks use deliberately generous ceilings and primarily guard algorithmic regressions, not machine-specific micro-optimizations.

## Verified implementation baseline

```text
14 pass
0 fail
```

Representative local timings at implementation:

- Logical 200 MB compaction-string workload: approximately 6 ms
- Pathological 100,000-node structured message: approximately 6 ms
- 10,000-candidate retrieval ranking: approximately 10 ms
- 50,000-candidate bounded prefilter: approximately 25 ms
- 10,000 runtime observations under caps: approximately 61 ms
- 1,000 locked atomic compaction telemetry writes: approximately 266 ms

Run with:

```sh
bun test tests/performance-theses-red
bun run typecheck
bun run typecheck:tests
```
