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

The extension handles `session_start`, `resources_discover`, `tool_call`, `tool_result`, `context`, `session_before_compact`, `session_compact`, and `session_shutdown`. Package-agnostic live bridges classify MCP, LSP, subagent/workflow, external-context, and router tools. LSP locations and transcript-free subagent result metadata are normalized into structural governance events without taking over those packages' process lifecycle.

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

## Lease enforcement modes

`KEYLIME_CAPABILITY_LEASE_MODE` controls live enforcement:

- unset or `opt-in`: calls carrying a lease are enforced; legacy calls remain compatible;
- `required-mutations`: every mutating tool call requires a valid lease;
- `required-all`: every tool call requires a valid lease.

Mandatory modes fail closed before tool execution. `/capability-lease` is an explicit user command and is the trusted authority source; model output alone cannot issue a lease.

## Privacy and bounds

Governance persistence and snapshots exclude prompts, responses, source code, hydrated tool output, full transcripts, and absolute repository paths. They retain hashes, relative locators, counts, decisions, object IDs, risk classifications, and bounded command metadata.

All collections have explicit limits: repository files, events, leases, audit history, trust history, evidence nodes/edges, replay dependencies, canary results, runtime tools, and commands.

## Agentic augmentation runtime

The July 2026 augmentation contract is live through the existing shared runtime rather than a parallel agent stack:

- `usage-tracker.ts` opens one aggregate task record at `before_agent_start` and closes it at Pi's `agent_settled` boundary. It persists `task-outcome-v1` and observe-only `agent-routing-observation-v1` entries without prompts, responses, source, or absolute paths.
- `trajectory-eval.ts`, when enabled, also finalizes once at `agent_settled`; intermediate tool-calling messages do not produce partial trajectory grades.
- Live impact treats manifests, lockfiles, deletion, and failed targeted verification as escalation signals while reusing the kernel's one repository snapshot.
- Verification records retain bounded command status, diagnostic paths, changed paths, and context-object references in the governance snapshot.
- Aggregate canary runs persist in `.pi/agentic-canaries-v1.json`, use hashed fixture identities, and require paired raw/candidate evidence before promotion evaluation.
- Delegation contracts issued by the runtime are bounded to two concurrent, non-recursive contracts. Scout, reviewer, and researcher roles are read-only; results are rejected unless their live contract, repository, evidence, budget, expiry, and verification validate.
- External LSP results remain externally owned. Keylime accepts bounded in-repository reference locations and adds fresh reference edges to the shared impact graph without spawning a language-server process.

`run_checks` now uses the shared process executor. Configuration:

- `KEYLIME_PROCESS_SANDBOX_MODE=observe|enforce` (default `observe`)
- `KEYLIME_PROCESS_SANDBOX_BACKEND=native|bubblewrap` (default `native`)
- `KEYLIME_PROCESS_NETWORK=deny|allow` (default `deny`)

Observe mode records the sandbox plan without changing execution. Enforce mode fails closed for unknown backends. Child execution uses argv rather than a shell, repository-bounded working directories, filtered environment variables, timeouts, bounded output, and structural audit metadata.
