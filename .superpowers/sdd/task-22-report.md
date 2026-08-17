# Task 22 Tool Retry Policy

## RED Contract

- `tests/tool-retry-policy.test.ts` defines `invokeWithRetry(input)` for transient Tool failures.
- Network, timeout, HTTP 429, and HTTP 5xx failures retry according to Manifest `retry_policy.max_attempts` and `backoff_seconds`.
- Schema, authentication, safety, and integrity failures do not retry.
- Each provider attempt receives an independent `{ attempt, attemptId }` context and contributes an independent receipt, including failed attempts.
- The active lease is checked before the first provider call, after a retryable failure before backoff, and after backoff before the next provider call.
- Exhaustion returns a structured terminal failure rather than leaking the provider exception.

## Review RED Additions

- Successful Tool provenance must retain `toolTier` together with `attemptReceipts`, so the required core Tool entry can reach the sealed Evidence Manifest.
- If a transient provider failure is followed by a terminal schema-invalid response, both the terminal failure details and failed-step provenance must retain every attempt receipt, including the first failed attempt.
- Added integration coverage in `tests/lease-execution-engine.test.ts` for receipt and lease-boundary behavior.

## Implementation Status

- `apps/orchestrator-runtime/src/control/lease-execution-engine.ts` now returns `toolResolution` on successful Tool `StepResult`s, defaults an unspecified ToolRegistry tier to `optional`, and preserves only successful Tool attempt receipts when the outer lease heartbeat fence detects lease loss.
- Successful Tool provenance preserves `toolTier` alongside all `attemptReceipts`; terminal Tool failures preserve receipts in failure records and failed provenance across retry exhaustion, lease loss, output schema failure, safety blocking, and later integrity failures without changing existing failure kinds or pause semantics.
- Retry receipts are carried from `invokeWithRetry` through the actor result and receipts-only lease error details, so post-invocation validation, sealing, and the terminal lease fence cannot discard provider-attempt history or persist unsanitized actor output.
- Added `apps/orchestrator-runtime/src/control/tool-retry-policy.ts` with the typed retry contract, transient failure classification, independent attempt contexts/receipts, lease fences, and structured failures.
- Only provider invocation is inside the retry boundary; input/output validation, safety blocking, redaction, artifact sealing, and provenance remain outside it.

## Validation

- Per assignment constraints, no test, typecheck, lint, build, formatter, or other validation command was run in this worker.
- No commit was created.
