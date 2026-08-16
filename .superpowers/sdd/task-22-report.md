# Task 22 Tool Retry Policy

## RED Contract

- `tests/tool-retry-policy.test.ts` defines `invokeWithRetry(input)` for transient Tool failures.
- Network, timeout, HTTP 429, and HTTP 5xx failures retry according to Manifest `retry_policy.max_attempts` and `backoff_seconds`.
- Schema, authentication, safety, and integrity failures do not retry.
- Each provider attempt receives an independent `{ attempt, attemptId }` context and contributes an independent receipt, including failed attempts.
- The active lease is checked before the first provider call, after a retryable failure before backoff, and after backoff before the next provider call.
- Exhaustion returns a structured terminal failure rather than leaking the provider exception.

## Implementation Status

- Added `apps/orchestrator-runtime/src/control/tool-retry-policy.ts` with the typed `invokeWithRetry` contract, constant millisecond backoff, transient failure classification, independent attempt contexts/receipts, lease fences, and structured failures.
- Updated `apps/orchestrator-runtime/src/control/lease-execution-engine.ts` so only the provider invocation is retried. Input/output schema validation, safety blocking, redaction, artifact sealing, and provenance remain outside the retry boundary; lease loss returns through the existing control-plane conflict path.

## Validation

- Per assignment constraints, no test, typecheck, lint, build, formatter, or other validation command was run in this worker.
- No GREEN result, phase-complete claim, or commit is recorded.
