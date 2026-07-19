# Novel Keylime extension theses — giga RED contract

This suite converts the July 2026 pi.dev extension-landscape research into an intentionally failing implementation contract.

## Test-double policy

The suite contains **no mocks, stubs, monkeypatches, fake stores, patched globals, intercepted model calls, or replacement implementations**. It uses:

- real temporary repositories and package manifests;
- real source files, imports, hashes, and filesystem boundaries;
- the real Keylime context-object store;
- the real checkpoint stabilizer, evidence selector, trace IR, and quality-frontier inputs;
- real wall-clock lease expiry;
- the current Keylime repository for self-audit contracts.

Missing production modules are loaded dynamically so every intended behavior remains independently discoverable as RED rather than causing TypeScript compilation to stop at the first missing import.

## Baseline

```text
87 fail
0 pass
bun run typecheck:tests: pass
```

## Thesis map

| Suite | Tests | Production contract |
|---|---:|---|
| `extension-auditor.red.test.ts` | 10 | Package discovery/precedence, resource hashes, hook topology, collisions, capabilities, supply-chain findings, drift, privacy, and bounded scans. |
| `evidence-graph.red.test.ts` | 9 | Claim-to-control/file/object/verification edges, freshness, unsupported claims, graph validity, bounded explanations, and deterministic identities. |
| `context-debugger.red.test.ts` | 9 | Score decomposition, exclusion/displacement causes, counterfactual budgets, mandatory evidence, recovery links, deterministic and bounded TUI output. |
| `capability-leases.red.test.ts` | 11 | Intent-scoped tools/paths/commands, expiry, turn budgets, verification, lifecycle invalidation, repository/session binding, non-escalation, privacy, and memory caps. |
| `change-impact-oracle.red.test.ts` | 10 | Static import graph, dynamic imports, cycles, affected tests, broad-risk files, deletion, explanations, adaptive verification, optional LSP, and scale. |
| `harness-replay.red.test.ts` | 9 | No-model/no-tool structural replay, dependency verification, repository binding, causal diffs, branches, redaction, and replay limits. |
| `delegation-contracts.red.test.ts` | 10 | Exact inherited controls, non-escalation, repository/schema/evidence/path/verification/budget gates, determinism, and transcript-free results. |
| `runtime-canaries.red.test.ts` | 9 | Paired controls, repeated-run confidence, zero-tolerance safety, latency/fallback/token gates, evaluator independence, atomic promotion, rollback, and bounds. |
| `extension-kernel-integration.red.test.ts` | 10 | Shared scans, hashes, repository identity, event normalization, capability policy, metrics, and adapters for MCP/LSP/subagents/external context. |

## Tight integration requirements

Implementation must not become nine isolated feature stacks. The RED contract requires:

1. **One repository snapshot service** for the auditor, impact oracle, evidence graph, replay and handbook.
2. **One content-hash cache** keyed by repository identity, relative path and file metadata.
3. **One repository fingerprint** shared by controls, leases, delegation, replay and evidence.
4. **One canonical context-object store** for Keylime, context-mode, VCC, MCP and subagent evidence.
5. **One capability policy** shared by direct tools, delegation, replay and external adapters.
6. **One structural metrics channel** shared by context debugging, canaries, replay and telemetry.
7. **One normalized lifecycle-event stream** fanned out to bounded consumers.
8. **No full transcript, prompt, response, source, tool payload or absolute repository path** in diagnostics or telemetry.

## Crowded-space integration strategy

- **MCP:** ingest catalogs into deferred discovery; do not create a second MCP runtime.
- **LSP:** consume normalized external signals; do not own language-server lifecycle unless explicitly configured.
- **Subagents/workflows:** validate results through Keylime delegation contracts; do not clone generic orchestration.
- **context-mode/pi-vcc:** import payloads once as canonical context objects; do not create parallel memory stores.
- **routers:** reuse Keylime execution profiles, budgets and circuit-breaker health rather than adding another routing engine.
- **dashboards:** render shared snapshots; do not register redundant event collectors.

## Performance contracts

- Repository scanning is shared and single-pass.
- Expensive scoring and hashing are deduplicated.
- High-volume inputs have explicit file, node, edge, event, lease, fixture and metadata ceilings.
- Hydrated payloads stay behind object references.
- TUI reports are width/row bounded.
- Thousand-file fixture checks use generous wall-clock ceilings to catch algorithmic regressions rather than machine variance.

## Suggested GREEN order after compaction

1. Shared extension kernel: repository snapshot, hash cache, event stream and metrics.
2. Extension auditor and hook topology.
3. Evidence graph and causal context debugger.
4. Capability leases.
5. Change-impact oracle.
6. Replay laboratory.
7. Delegation contracts and ecosystem adapters.
8. Runtime canaries and atomic promotion.

Run:

```sh
bun test tests/novel-extension-theses-red
bun run typecheck:tests
```
