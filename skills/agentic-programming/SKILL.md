---
name: agentic-programming
description: Agentic programming and coding-agent harness review skill. Use when auditing, designing, or improving AI coding agents, Pi extensions, context/tool routing, prompt hygiene, safety guards, checkpointing, repo indexing, memory/compaction, or long-running agent workflows. Grounded in 2026 context-engineering, harness-engineering, and terminal coding-agent practices.
---

# Agentic Programming Skill

Use this skill when reviewing or improving a coding-agent system such as Keylime/Pi. The goal is not just better prompts; it is better **context engineering + harness engineering**: tool exposure, context lifecycle, runtime safety, memory/state, verification, and observability.

Core principle:

> small stable instructions + narrow high-signal context + safe tool schemas + external state + runtime guards + explicit verification loops

## Research baseline: March–June 2026

Modern agentic programming guidance has shifted from prompt engineering alone to managing the whole runtime information state:

- system/developer instructions
- tool schemas and active tool set
- message history
- tool results
- repo/index context
- project plans and decisions
- memory and search knowledge
- compaction/clearing policies
- safety enforcement
- test/check feedback

Key source themes:

- Anthropic: context engineering manages system instructions, tools, MCP/external data, message history, memory, and tool results across long-running agents.
- Sourcegraph: context engineering is a production pipeline for curating the optimal token set, especially concrete for coding agents.
- OpenDev/arXiv 2603.05344: terminal coding agents are compound systems with scaffolding and harness layers, not a single prompt.
- LangChain Deep Agents: large tool results should be offloaded/compacted, with filesystem pointers and previews rather than raw context bloat.

## Review workflow

### 1. Establish current harness shape

Inspect:

- extension entry points
- tool registration
- active-tool routing
- context providers
- lifecycle events: `input`, `context`, `tool_call`, `tool_result`, `agent_end`, `before_agent_start`, `session_start`
- tests covering routing/safety/context behavior

Answer:

- What tools are always on?
- What tools are routed by intent?
- What dangerous tools are locked or guarded?
- What state lives outside context?
- What is injected into every turn?

### 2. Audit tool exposure

Preferred policy for coding agents:

Always available safe code primitives:

- code search
- bounded text/line inspection
- structure inspection
- dry-run replacement planning
- guarded replacement application
- safe file creation
- safe directory creation
- test/check runner

Routed/guarded:

- bash
- raw read
- write/edit
- web search
- memory writes
- project mutation
- domain tools

Check for:

- routing mistakes that strand safe inspection/editing tools
- too many active domain tools causing prompt pollution
- dangerous built-ins exposed during coding
- tool schemas with vague or overbroad mutation powers
- missing promptGuidelines for risky tools

### 3. Audit context lifecycle

Look for context-rot risks:

- repeated large tool outputs
- full-file dumps where search/line windows would suffice
- stale plan text repeatedly injected
- multiple context providers saying the same thing
- dynamic reminders that change every turn and bust prompt cache
- unbounded memory/search recall

Preferred mitigations:

- search-first file inspection
- bounded line windows
- compact repo skeletons
- file-backed project state
- memory/search knowledge outside context
- context pressure budgets
- tool-result clearing or summarization
- stable prompt prefixes

### 4. Audit prompt hygiene

Good coding-agent prompts are:

- short
- stable
- procedural
- enforceable by tools
- explicit about stop conditions

Check for:

- duplicate instructions across system/developer/tool prompts
- prompt guidelines that fight each other
- excessive tool descriptions
- stale references to removed tools
- policy written only as text but not enforced in code

Useful prompt contracts:

- inspect before editing
- search before line windows
- use safe codemod tools for repository mutation
- verify after edits
- do not fabricate test results
- summarize changed files and risks

### 5. Audit runtime safety

Safety should be enforced by the harness, not only the prompt.

Check for:

- blocked raw `read/write/edit` in coding mode if replacement tools exist
- protected path checks for every mutating tool
- path traversal guards
- binary-file guards
- shell mutation detection
- native runtime bypasses: `python -c`, `node -e`, `bun -e`, `deno eval`, `perl -e`, `ruby -e`
- shell command-string bypasses: `bash -c`, `sh -c`, `zsh -c`, `fish -c`
- `run_checks` custom command bypasses
- checkpointing and rollback behavior

Mutation classification should be centralized in one shared module to avoid drift between danger guards, checkpoints, and test runners.

### 6. Audit checkpointing

Good checkpointing is low-noise and semantically meaningful.

Prefer:

- manual `/checkpoint` as primary explicit control
- automatic checkpoint at end of agent turn, not before each tool
- scoring based on successful `tool_result`, not attempted `tool_call`
- major-change heuristic by default
- env overrides: `off | major | any`
- exclusion of volatile logs such as usage ndjson

Watch for:

- checkpoint spam after every small file change
- checkpointing failed/blocked/no-op tools
- not restoring last checkpoint time after session reload
- staging generated logs/secrets/vendor files

### 7. Audit verification loop

Agentic programming needs reliable feedback.

Check:

- tests/checks run through a safe `run_checks` tool
- custom check commands cannot mutate files through shell/runtime bypasses
- failing output is compact and actionable
- test commands stop after meaningful failure unless requested
- agent reports exactly what was run

### 8. Audit repo index and file tools

Check:

- repo index invalidates on all source mutations: create, replace, future move/delete
- index does not scan vendor/build dirs
- search tools never dump whole files by default
- create-file refuses overwrite
- create-directory refuses existing paths unless skip requested
- replacements have exact-match/count guards
- dangerous replacement modes do not destroy formatting

Avoid normalized-whitespace replacement modes that compact and rewrite whole files unless they are plan-only or explicitly dangerous.

### 9. Audit observability

A coding-agent harness should explain its own policy.

Useful commands/status:

- current intent and active tool groups
- always-on tools
- routed tools
- locked tools
- checkpoint mode and last checkpoint
- context providers and budgets
- repo-index status
- research/tool availability

If debugging routing requires reading source, add a command.

## Keylime-specific checklist

When reviewing Keylime, inspect at least:

- `extensions/intent-router.ts`
- `extensions/code-primitives.ts`
- `extensions/shared/code-primitives.ts`
- `extensions/shared/safety-policy.ts`
- `extensions/danger-guard.ts`
- `extensions/git-checkpoint.ts`
- `extensions/test-runner.ts`
- `extensions/repo-index/index.ts`
- `extensions/turn-context-composer.ts`
- `extensions/shared/turn-context.ts`
- tests under `tests/`

Run targeted tests after changes, then full suite:

```bash
bun test tests
```

Use `run_checks` rather than bash when operating inside Pi.

## Common findings to look for

High priority:

- safety policy duplicated across files
- mutation scoring on attempted calls instead of successful results
- new safe tools not added to always-on/router/domain tool sets
- protected paths missing for new mutation tools
- context providers injecting unstable or redundant reminders
- tracked `.pi/usage` or other volatile files

Medium priority:

- disabled tests for critical surfaces such as fetch/research
- operational modes that cannot be changed after first turn unless intended
- default check commands using shell strings where argv would do
- missing tests for command/status observability
- stale docs after policy changes

## Output format for audits

When presenting an audit, use:

1. **Baseline** — tests run and current pass/fail state.
2. **Critical bugs** — likely incorrect behavior or safety holes.
3. **Integration opportunities** — places to unify policy or reduce drift.
4. **Prompt/context hygiene** — cache, prompt pollution, context rot issues.
5. **Recommended patch order** — smallest safe sequence.
6. **Research needed** — only if external API/framework behavior is uncertain.

Be concrete: cite file paths and exact functions where possible.
