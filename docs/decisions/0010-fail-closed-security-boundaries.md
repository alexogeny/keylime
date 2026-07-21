# 0010. Fail-closed security boundaries

Date: 2026-07-17
Status: Accepted

## Context

The agent processes adversarial repository and web content, so convenience fallbacks at trust boundaries create exploitable confused-deputy behavior.

## Decision

Filesystem, privileged operations, network targets, parser limits, and control-plane access will fail closed when validation or approval cannot be established.

## Consequences

- Some previously accepted symlinked paths, private URLs, complex regexes, and headless mutations will be rejected.
- Control-plane clients must use an authentication token.
- Security regression tests can assert blocked operations deterministically.

## Alternatives Considered

- Keep permissive defaults and rely on model judgment; rejected because prompt injection bypasses judgment.
- Warn but continue; rejected for high-impact boundaries.
