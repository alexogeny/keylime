# 0011. Repository-bound local context state

Date: 2026-07-19
Status: Accepted

## Context

The current checkout contains project and agent state from unrelated work, demonstrating that path-local files can contaminate context. Canonical repository identity validation is deterministic, survives branch/HEAD changes, and fails closed before model-visible injection.

## Decision

Bind injectable .pi project and agent state to a canonical repository identity and quarantine legacy or mismatched state until explicit adoption.

## Consequences

- Cross-project state will no longer silently enter context.
- Legacy state needs an explicit migration/adoption path.
- Moving a repository to a different canonical root will require re-binding or adoption.
- Identity checks add a small filesystem/hash operation that can be cached per session.

## Alternatives Considered

- Trust any nearest .pi state file; rejected because the observed checkout is already contaminated.
- Bind to commit hash; rejected because normal commits and branch switches would invalidate valid state.
- Let the model judge state relevance; rejected because state isolation is a deterministic safety boundary.
