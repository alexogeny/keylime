# 0008. Semantic Git checkpoint metadata

Date: 2026-07-16
Status: Accepted

## Context

Checkpoint safety must not depend on provider availability, but semantic model-generated metadata can substantially improve Git history when context and credentials are available.

## Decision

Generate checkpoint subjects and bodies with Pi's current authenticated model, while making deterministic local generation the mandatory non-blocking fallback.

## Consequences

- Checkpoint history becomes meaningful and machine-identifiable via a trailer.
- Automatic checkpoints may add one bounded model request per eligible turn.
- Provider failures and malformed output do not prevent checkpoint creation.
- Conversation and bounded redacted change metadata may be sent to the active model provider.

## Alternatives Considered

- Derive messages only from the final assistant response; rejected because it can omit concrete file changes.
- Send the entire staged patch; rejected due to privacy, prompt-injection, and context-size risks.
- Keep timestamp-only messages; rejected because they provide no semantic history.
