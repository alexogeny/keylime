# Skills

Skills are reusable SKILL.md workflows invoked with `/skill:<name>`. Think of them as recipe cards: pull one out when you need the technique, keep it out of the default prompt when you do not.

## Engineering and agent workflows

### `agentic-programming`

Audit and design workflow for coding-agent harnesses. Use for Keylime/Pi extension review, context engineering, tool routing, prompt hygiene, safety guards, checkpointing, repo indexing, and long-running agent workflows.

### `repo-map`

Rapid codebase orientation. Produces a mental model of entry points, data flow, abstractions, dependencies, tests, and build commands.

### `debug`

Systematic debugging workflow: reproduce, isolate, hypothesize, fix, verify.

### `refactor`

Behavior-preserving restructuring workflow. Use for renames, module splitting, abstraction extraction, and cleanup.

### `clarify`

Structured requirements clarification before implementation when scope or success criteria are ambiguous.

### `ui-design`

UX/interface design workflow covering journeys, hierarchy, tokens, accessibility, responsive behavior, and states.

## Language and systems skills

### `typescript-engineering`

TypeScript/JavaScript engineering and codemod guidance.

### `python-codemod`

Python-safe codemod and repetitive edit workflow.

### `python-engineering`

Python performance and engineering optimization workflow.

### `rust-codemod`

Rust code editing/codemod workflow.

### `rust-systems`

Rust systems programming guidance for ownership, concurrency, low-level code, and performance.

### `rust-shell-emulator`

Shell/terminal emulator auditing and enhancement workflow for Rust projects.

## Security skills

### `blue-team`

Defensive security operations: SOC design, detections, hunts, IR playbooks, SIEM/XDR/SOAR, MITRE ATT&CK mapping.

### `red-team`

Adversary simulation and red-team planning, execution, and reporting.

## Writing skills

### `novel-plan`

Novel planning and restructuring workflow.

### `novel-write`

Novel drafting execution workflow.

### `novel-review`

Fiction manuscript revision workflow.

### `novel-craft`

Craft reference for prose, genre expectations, and style critique.

### `tweet-craft`

Tweet and reply drafting in the configured persona voice.

## Domain and personal skills

### `running-biomechanics`

Biomechanics, footwear, gait, training load, and injury-prevention reasoning.

### `saas-naming`

SaaS naming and brand-candidate generation.

### `memory-validate`

Human-in-the-loop validation workflow for the memory detection pipeline.

## Skill design pattern

Keylime skills are deliberately specialized. Prefer loading a skill only when it materially helps the task, rather than including broad instructions in every turn. This keeps the default prompt smaller and reduces context drift.
