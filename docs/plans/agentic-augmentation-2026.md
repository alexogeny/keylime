# Agentic augmentation roadmap for Pi and Keylime (July 2026)

## Purpose

This document records the recommendations from the July 2026 review of cutting-edge agent-harness research, Pi's extension/SDK capabilities, and Keylime's current architecture. It is intended as the continuation point after context compaction.

## Executive conclusion

Keylime already implements much of the current context-engineering frontier: deferred tools, typed and recoverable context objects, structured compaction, trajectory reduction, cache-prefix accounting, repository-scoped state, capability leases, deterministic replay, and release gates.

The next gains should not come from adding another generic context layer. The highest-value gaps are:

1. Outcome-grounded live evaluations.
2. Independent verifier/reviewer agents.
3. Selective read-only subagents for decomposable work.
4. OS sandboxing plus trusted-control/untrusted-data separation.
5. Adaptive model and test-time-compute routing.
6. Canary-only self-improving playbooks.
7. Compiler/LSP-backed semantic evidence.

Do **not** build a general-purpose agent swarm. Controlled research shows that multi-agent systems help independent breadth-first work, but can substantially hurt sequential and tool-heavy tasks.

## Current Keylime baseline

Keylime is already strong in the following areas:

- `extensions/context-runtime.ts` owns observation masking, trajectory reduction, adaptive budgets, retrieval credit, and compaction coordination.
- `extensions/tool-result-compactor.ts` and `extensions/context-object-store.ts` provide typed reduction and exact recovery.
- `extensions/structured-compaction.ts` preserves goals, constraints, decisions, failures, verification, and evidence references.
- `extensions/intent-router.ts` and Pi-native deferred loading maintain a small bootstrap tool set.
- `extensions/harness-governance.ts` tracks extension provenance, capability policy, impact, evidence, replay, delegation metadata, and canaries.
- Capability leases bind authority to repository, session, turn, tool, operation, path, command, and time.
- `tests/context-evals/` rejects token savings that lose required facts, recovery, or safety state.
- The token-efficiency roadmap measures successful-task cost rather than raw prompt size.

Important current gaps:

- `docs/plans/token-efficiency-2026/00-roadmap.md` states that empirical corpus experiments and default-enablement evidence are still pending.
- `extensions/trajectory-eval.ts` currently grades mostly with heuristics such as tool errors, evidence-tool use, context pressure, and trajectory length rather than verified task outcomes.
- `extensions/harness-governance.ts` can ingest subagent result metadata, but Keylime has no actual bounded subagent executor.
- Keylime has no OS sandbox integration.
- Thinking level is manually selectable, but there is no automatic model or test-time-compute router.
- LSP results can be normalized by governance adapters, but Keylime has no first-class semantic-code provider.

## Research findings

### Context and trajectory efficiency

- AgentDiet reports 39.9–59.7% lower input tokens and 21.1–35.9% lower total computational cost by removing useless, redundant, and expired trajectory content without reducing measured performance.
- ACON reports 26–54% lower peak token use while improving long-horizon task success over compression baselines. It learns natural-language compression guidelines from failure analysis and can distill compression into a smaller model.
- VS Code's 2026 harness work emphasizes that deferred schemas must be evaluated together with exact prompt-prefix caching, latency, discovery calls, and successful-task cost.

Keylime already embodies most of these principles. Further context changes should remain behind the existing replay and release gates.

### Tool and interface engineering

SWE-agent and Anthropic's tool-engineering work show that agent-computer interface design can produce larger gains than prompt refinement. High-value properties include narrow tools, meaningful errors, bounded output, precise descriptions, and evaluations based on actual agent usage.

Keylime should add automated tool-use evaluations that classify failures as reasoning, routing, schema, diagnostics, or environment failures, then improve tools against those evaluations.

### Long-running work

Anthropic's long-running harnesses use:

- an initializer that decomposes the task;
- incremental feature-sized work;
- explicit progress artifacts;
- clean session handoffs;
- independent evaluators with concrete criteria.

Keylime already has project state, registers, handoffs, checkpoints, and structured compaction. It should add an explicit `initializer -> incremental worker -> verifier` workflow rather than another storage mechanism.

### Multi-agent systems

The 2026 scaling study tested 260 configurations across six benchmarks and found architecture effects strongly depend on task structure. Reported relative changes ranged from +80.8% on decomposable work to -70% on sequential planning. Tool-heavy tasks often incurred coordination overhead, and architectures without centralized verification propagated more errors.

Anthropic's research system similarly uses subagents for breadth-first independent searches, with a lead agent synthesizing compact results.

Recommendation: add selective delegation for scouts, reviewers, and researchers only. Keep the parent agent authoritative and centrally verify all outputs.

### Test-time compute and verifiers

CodeMonkeys generated many candidate patches, generated tests, voted over candidates, and used a final selector trajectory. It reports 57.4% on SWE-bench Verified and 66.2% when selecting over a heterogeneous ensemble, but at high cost.

Recommendation: first add one independent verifier. Add best-of-N candidate patch search only as an opt-in mode for demonstrably difficult tasks and only in isolated workspaces.

### Security

CaMeL separates trusted control flow from untrusted data and enforces capability-based data-flow policy at tool execution. It reports 77% secure AgentDojo completion versus 84% utility for an undefended system.

Keylime's capability leases are a strong base, but should be complemented by:

- OS-level process/filesystem/network isolation;
- provenance labels for retrieved content;
- rules preventing untrusted content from changing control flow or authority;
- explicit exfiltration checks.

### Self-improvement

Agentic Context Engineering treats prompts and memory as evolving playbooks using generation, reflection, and curation, reporting +10.6% on agent benchmarks. A separate self-improving coding-agent paper demonstrates autonomous harness edits and substantial benchmark gains.

Production Keylime must not self-edit directly. Trajectories may propose playbook or tool-guideline changes, but promotion must require holdout replay, canary evidence, explicit review, trust updates, and rollback.

## Recommended implementation sequence

### P0 — Outcome-grounded evaluation corpus

Create 20–50 repository-owned tasks covering:

- exact one-file edits;
- ambiguous debugging;
- multi-file refactors;
- failed replacement recovery;
- long-horizon continuation;
- research with source verification;
- security-sensitive changes;
- blocked operations;
- intentionally impossible tasks.

Measure:

- semantic task success;
- relevant checks selected and passed;
- incorrect or unnecessary mutations;
- turns and model calls;
- uncached input, cache read/write, output, and reasoning tokens;
- latency and reported cost;
- human intervention;
- evidence precision/recall;
- failure recovery;
- security invariant retention.

Extend the existing replay, context ledger, and canary infrastructure. Do not create a parallel telemetry system.

Replace or supplement trajectory heuristics with outcome attribution:

- Did the action move toward a verified outcome?
- Was failure due to model reasoning, context selection, tool design, or environment state?
- Would a different model/tool/verifier have changed the result?
- Did the agent stop early or continue after completion?

### P1 — Independent verifier agent

Trigger for multi-file changes, security-sensitive code, public API changes, migrations, repeated test failures, high governance risk, or explicit user request.

Verifier input should contain only:

- task and exact constraints;
- changed paths and bounded diff;
- relevant checks and output;
- dependency/impact evidence;
- context-object references.

Do not include the author agent's full reasoning. Decision order:

1. Deterministic tests/static checks.
2. Repository invariants.
3. Independent reviewer.
4. Additional targeted checks on disagreement.
5. User escalation if ambiguity remains.

Implementation seam: Pi `createAgentSession()` with an explicit in-memory session and restricted tools. Feed results into the existing governance evidence graph.

### P1 — Selective read-only delegation

Initial roles:

- `scout`: code/dependency/test discovery;
- `reviewer`: independent change inspection;
- `researcher`: independent external research question.

Suggested contract:

```ts
type DelegationContract = {
  role: "scout" | "reviewer" | "researcher";
  objective: string;
  allowedTools: string[];
  maxTurns: number;
  maxCost?: number;
  requiredEvidence: string[];
  repositoryFingerprint: string;
};
```

Return only a bounded summary, file/line locators, context-object IDs, verification results, uncertainty, and contract metadata.

Initial restrictions:

- read-only tools;
- maximum two workers;
- parallel execution only for independent subtasks;
- no recursive delegation;
- no arbitrary project-defined agent prompts;
- no full child transcript in parent context;
- no shared-working-tree mutation.

### P1 — OS sandbox and data-flow security

Use Pi's pluggable tool operation interfaces or a micro-VM backend. Default policy:

- repository writable;
- secrets directories unreadable;
- `.env`, credentials, and keys protected;
- network denied unless capability-authorized;
- subprocess/time/memory limits;
- explicit temporary-directory access;
- structural audit record of granted capabilities.

Add provenance classes such as:

- `trusted_user`;
- `trusted_repository`;
- `untrusted_web`;
- `untrusted_mcp`;
- `untrusted_tool_output`;
- `generated_inference`.

Untrusted data must not issue capabilities, weaken policy, redefine task intent, choose sensitive destinations, authorize exfiltration, or become system instructions.

### P2 — Adaptive compute/model router

Start advisory-only. Estimate task decomposability, risk, uncertainty, context pressure, test failures, reviewer disagreement, and expected value of another attempt.

Candidate policy:

- cheap model for classification/retrieval/compression;
- main model for implementation;
- independent strong model for high-risk verification;
- increased thinking only after uncertainty or failure;
- best-of-N only for expensive, difficult cases.

Gate by total successful-task cost, quality, turns, and latency—not cost per individual call.

### P2 — Controlled evolving playbooks

1. Cluster repeated outcome-linked failures.
2. Generate a proposed skill/tool-guideline/playbook change.
3. Replay against holdout fixtures.
4. Measure cache-prefix and tool-schema effects.
5. Run observe-only canaries.
6. Require explicit review and trust update.
7. Preserve prior version and rollback.

Never learn or rewrite hard safety rules automatically.

### P2 — LSP/compiler-backed semantic evidence

Add bounded tools for definition, references, diagnostics, call hierarchy, rename preview, type relationships, and affected-test hints. Return locations and diagnostics, then use existing source inspection tools for exact text. Record results in the governance evidence graph.

## Things not to build

- Always-on agent councils or swarms.
- Autonomous workers mutating one shared tree.
- Production self-modification.
- Model-as-judge as the sole verifier.
- Full child transcripts in parent context.
- Unrestricted MCP catalogs.
- Automatic promotion of memory into system instructions.
- Additional generic summarizers without outcome evidence.
- Agent-to-agent networking without identity, capability, provenance, and budget controls.

## Pi implementation seams

Pi already provides the necessary extension points:

- lifecycle and provider hooks in `docs/extensions.md`;
- additive deferred tools through `pi.setActiveTools()`;
- `context`, `tool_call`, `tool_result`, `session_before_compact`, and provider-payload hooks;
- in-memory isolated agents through `createAgentSession()` in `docs/sdk.md`;
- process-isolated subagent example under `examples/extensions/subagent/`;
- pluggable tool operation/sandbox examples under `examples/extensions/sandbox/` and `gondolin/`;
- session trees, custom entries, compaction, and exact lifecycle control.

Pi intentionally keeps subagents, MCP, plan mode, and sandboxing out of the core. Keylime should implement only the opinionated, measured versions it needs.

## Primary sources

- AgentDiet: https://arxiv.org/abs/2509.23586
- ACON: https://arxiv.org/abs/2510.00615
- Agentic Context Engineering: https://arxiv.org/abs/2510.04618
- Towards a Science of Scaling Agent Systems: https://arxiv.org/abs/2512.08296
- CodeMonkeys: https://arxiv.org/abs/2501.14723
- SWE-agent / agent-computer interfaces: https://arxiv.org/abs/2405.15793
- CaMeL: https://arxiv.org/abs/2503.18813
- A Self-Improving Coding Agent: https://arxiv.org/abs/2504.15228
- Anthropic long-running harnesses: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic long-running application harness design: https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic tool engineering: https://www.anthropic.com/engineering/writing-tools-for-agents
- VS Code harness token efficiency: https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot
- METR long-task time horizons: https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/

## Executable RED contract

The implementation checklist is encoded as 53 permanent acceptance tests under `tests/agentic-augmentation-red/`. The initial baseline was 0 pass / 53 fail; all 53 contracts are now implemented and green.

- Test policy and implementation order: `tests/agentic-augmentation-red/README.md`
- Requirement-by-requirement checklist: `docs/plans/agentic-augmentation-2026/RED-MATRIX.md`
- Run: `bun run test:agentic:red`

All AA tests are retained permanently as regression contracts. The implementation now provides settled task outcomes, task-level spend and observe-only routing, `agent_settled` trajectory evaluation, rich live impact and verification evidence, persistent aggregate canaries, live delegation validation, a shared process-execution sandbox seam used by `run_checks`, and bounded LSP evidence edges.

## Resume point

Collect live outcome and canary evidence before enabling automatic model switching or mutable subagents. The next implementation expansion should be a separately gated, read-only reviewer/scout executor that consumes the now-live delegation registry; it should receive its own RED contract before production code.
