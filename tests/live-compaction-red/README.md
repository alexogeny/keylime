# Live compaction hardening — RED-to-GREEN contract

This suite began with **17 failing real integration tests**. A persistent-state bound was then added and observed failing, followed by a trusted-transition inference test that was also observed failing. All tests transitioned through production implementation only.

No mocks, stubs, monkeypatches, fake stores, intercepted model calls, or patched globals are used. Tests exercise real temporary repositories, real files and hashes, the real context-object store, atomic persistent state, aggregate telemetry writes, and real wall-clock circuit-breaker cooldowns.

## Covered behavior

- Live semantic checkpoint finalization with trusted provenance.
- Relinking and synthesized-permission rejection.
- Real repository-relative path and symlink-safe file hashing.
- Rejection of fabricated or stale model-provided hashes.
- Real context-object existence verification.
- Stable source-entry extraction from Pi-shaped messages.
- Repository- and session-bound persistent control state.
- Atomic writes, checksums, corruption quarantine, and a 50-file lifecycle bound.
- Explicit and inferred trusted-user control transitions.
- Provider/model-isolated timeout and network circuit breakers.
- Half-open probes and recovery after cooldown.
- Privacy-filtered live compaction metrics delivered to the real telemetry store.

## Current baseline

```text
19 pass
0 fail
```

Run with:

```sh
bun test tests/live-compaction-red
bun run typecheck
bun run typecheck:tests
```
