# 0012. Provider-independent context accounting baseline

Date: 2026-07-19
Status: Accepted

## Context

Provider bridges expose inconsistent token telemetry, and adding a tokenizer dependency would create false precision. Character counts are deterministic enough for regression tests and can coexist with exact provider usage when available.

## Decision

Use deterministic character counts and content fingerprints as the mandatory context ledger baseline, with provider token/cache counts recorded only when actually reported.

## Consequences

- All context transformations can be compared in tests without provider access.
- Reports must label characters separately from tokens.
- Token-specific production reports remain optional and provider-dependent.
- No tokenizer dependency is added.

## Alternatives Considered

- Estimate all tokens with a bundled tokenizer; rejected due provider/model mismatch and dependency cost.
- Treat missing usage as zero; rejected because it misstates cost and cache behavior.
