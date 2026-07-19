# Integrated harness governance

Keylime's governance layer connects extension provenance, repository impact, evidence, context selection, capabilities, replay, delegation, and runtime canaries through one repository-bound runtime.

## Runtime topology

`extensions/harness-governance.ts` owns the Pi lifecycle integration. It creates one `harness-governance-runtime` per session and publishes it through the bounded governance bus for cross-extension consumers such as `suggest_checks`.

The runtime shares:

- one repository fingerprint and initial repository snapshot;
- one content-hash inventory with incremental mutation refresh;
- one capability policy across direct tools, leases, replay, and delegation;
- one structural metrics channel;
- canonical context-object references for verification and external context;
- bounded lifecycle events suitable for deterministic replay.

The extension handles `session_start`, `resources_discover`, `tool_call`, `tool_result`, `context`, `session_before_compact`, `session_compact`, and `session_shutdown`.

## Commands

| Command | Purpose |
|---|---|
| `/extension-audit` | Fresh source/resource, hook, tool, command, origin-hash, capability, and fingerprint audit. |
| `/extension-diff` | Compare the live harness with the explicitly trusted repository baseline. |
| `/extension-trust [reason]` | Persist an explicit, repository-bound trust decision. |
| `/hook-topology` | Show bounded lifecycle-hook ownership. |
| `/change-impact <paths...>` | Compute reverse dependencies, affected tests, risk, and verification commands. |
| `/evidence` | Verify live mutation paths and canonical verification objects as a provenance graph. |
| `/why-context` | Render the latest causal retrieval-selection explanation. |
| `/harness-replay` | Replay structural events without model calls or tool execution. |
| `/capability-lease <json>` | Issue a bounded lease from an explicit user command. |
| `/capability-leases` | Show aggregate lease state. |
| `/canary-status` | Show canary registry and promotion state. |
| `/governance-status` | Show the integrated bounded runtime snapshot. |

## Cross-module flows

### Mutation to verification

1. `tool_call` is classified by the shared safety policy.
2. If a capability lease is supplied, the call must match its tool, operation, path, command, repository, session, time, and turn bounds.
3. A successful mutation incrementally refreshes the shared hash and import graph.
4. `suggest_checks` consumes the active governance runtime and includes change-impact tests and commands.
5. Tool-result context-object IDs become canonical evidence references.
6. `/evidence` validates current file bytes and context-object hashes.

### Context selection to explanation

`context-runtime` uses the scored evidence selector and records a structural explanation. The governance runtime exposes only selected IDs, score decisions, relative paths, recovery object IDs, and bounded statistics—not hydrated source payloads.

### Compaction to canaries

Capability leases are invalidated before compaction. Structured compaction outcomes flow through the aggregate metrics channel into the governance canary registry. `session_compact` records whether Pi used an extension summary and whether an overflow retry follows.

### Supply chain and trust

At startup, Keylime hashes extension source plus the live Pi tool/command surface and origin resources. Trust state is:

- bound to the canonical repository identity;
- checksum protected;
- atomically replaced;
- guarded by a cross-process lock;
- permissioned to `0600` where supported;
- bounded to a fixed history;
- free of source, prompts, tool payloads, and absolute paths.

Trust is never inferred from model output. Only `/extension-trust` creates a new baseline.

## Privacy and bounds

Governance persistence and snapshots exclude prompts, responses, source code, hydrated tool output, full transcripts, and absolute repository paths. They retain hashes, relative locators, counts, decisions, object IDs, risk classifications, and bounded command metadata.

All collections have explicit limits: repository files, events, leases, audit history, trust history, evidence nodes/edges, replay dependencies, canary results, runtime tools, and commands.
