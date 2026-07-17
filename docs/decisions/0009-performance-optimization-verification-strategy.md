# 0009. Performance optimization verification strategy

Date: 2026-07-16
Status: Accepted

## Context

Call counts and bounded-work invariants are stable across machines, while timing assertions are noisy and can produce false regressions.

## Decision

Verify performance refactors with deterministic operation-count tests and semantic equivalence tests rather than wall-clock thresholds.

## Consequences

- Tests can prove fewer subprocesses, file reads, scans, and full sorts.
- Absolute speedups still require benchmark runs outside correctness tests.
- Production code needs narrow dependency-injection or testable helper seams.

## Alternatives Considered

- Use timing thresholds in unit tests; rejected as flaky.
- Optimize without regression tests; rejected because syscall and complexity claims would be unproven.
