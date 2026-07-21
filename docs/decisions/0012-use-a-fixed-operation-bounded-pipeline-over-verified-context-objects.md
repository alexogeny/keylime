# 0012. Use a fixed-operation bounded pipeline over verified context objects

Date: 2026-07-19
Status: Accepted

## Context

Pi does not expose a sufficiently narrow internal tool-invocation boundary for safely composing arbitrary registered tools. A fixed context-object operation provides the intended intermediate-context reduction while allowing deterministic preflight safety checks, strict budgets, exact sidecar recovery, and no expression evaluator.

## Decision

Implement the initial bounded aggregation pipeline only over verified context-object JSON rows with fixed projection operators, rather than dynamically invoking registered Pi tools.

## Consequences

- Read-only structured rows can be filtered, sorted, selected, and aggregated without injecting full intermediates.
- Mutation, shell, fetch, dynamic tool names, loops, and arbitrary expressions are unavailable through the pipeline.
- Additional use cases require explicit reviewed operations and schemas rather than automatically composing existing tools.
- The first implementation is narrower than a general tool-composition system.

## Alternatives Considered

- Invoke arbitrary registered Pi tools by name; rejected because execution-time safety and callable API boundaries were insufficiently constrained.
- Implement a JavaScript expression evaluator; rejected because it expands the attack surface and violates deterministic safety requirements.
- Leave aggregation to repeated model-visible tool calls; rejected because bulky intermediates would continue consuming trajectory context.
