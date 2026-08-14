# Task 11 Report — Sealed Step Bindings and Skill Provenance

## Scope

- Added a pure strict RFC6901 step-input resolver that clones the compiler-owned base input, rejects malformed/duplicate/prototype/array targets, and applies bindings only from unique earlier succeeded steps.
- Bound every source read to a SEALED, hash-verified Artifact with matching task, plan version, attempt, kind, ID, and content hash. Tool Artifact envelopes expose only their verified logical `output`; no binding reads `StepResult.output`.
- Preserved Current step binding fields through execution parsing and preflighted future/unknown/unsafe bindings before actor side effects.
- Resolved Tool and Skill inputs before their input-schema validation. Skill, LLM, and Reviewer contexts receive only verified prior Artifact outputs.
- Added additive Migration 007 with independent `skill_provenance JSONB`; `tool_provenance` remains unchanged.
- Persisted Skill body hash, nullable-only-when-absent input/output schema hashes, resolved input hash, SEALED output hash, prompt hash, trace ID, database model receipt ID, output Artifact ID, and status. Failed provenance capture is best-effort and cannot replace the actor failure or leave the attempt active.
- Changed `ModelCallRecorder.recordModelCall` and `ControlPlaneRepository.recordModelCall` to return the inserted database ID. `ReceiptLLMClient` propagates it as `receiptId` on successful structured and text results; all recorder fixtures migrated without aliases.
- Updated the approved Task11 file list and progress ledger for the migration, receipt seam, repository types, fixture migrations, and report.

## TDD Evidence

### RED

Observed failures before implementation:

- `tests/current-step-bindings.test.ts`: `ERR_MODULE_NOT_FOUND` for `step-input-resolver.ts`.
- Receipt tests: successful results had `receiptId === undefined`; repository `recordModelCall` returned `undefined`.
- Execution/repository suite: 31 pass / 5 fail / 1 skip. Failures were missing Skill provenance persistence, unresolved Tool input rejected during preflight, future binding accepted before actor side effects, dangling pointer accepted before Skill invocation, and missing resolved Skill context/provenance.
- Sensitive Skill regression: persisted provenance output hash differed from the canonical SEALED redacted Skill JSON hash.

### GREEN

- Pure resolver and real Artifact store integration: 9/9 passed.
- Receipt ID and repository persistence: 13/13 passed.
- Engine/repository binding and provenance suite: 36 pass / 1 real-provider skip / 0 fail, followed by the expanded Skill failure-boundary suite at 31 pass / 1 real-provider skip / 0 fail.
- Sensitive Skill output hash regression passed after recomputing provenance at the shared redaction seam.
- Exact required serial suite: 83 tests / 82 pass / 1 real-provider skip / 0 fail.
- `pnpm typecheck`: passed for runtime and web TypeScript projects.

## Requirements Covered

- RFC6901 escaping, array source reads, strict malformed escape rejection, deep cloning, source pointer existence, object-field creation, duplicate decoded target rejection, and prototype/array-target protection.
- Unknown, future, duplicate, non-succeeded, STAGING, tampered, wrong-attempt, and mismatched-hash Artifact rejection.
- Real `ControlArtifactStore.readVerifiedJson` integration for valid, tampered, and unsealed Artifacts.
- Tool and Skill input schema validation after binding; Skill output schema remains required when declared.
- Verified sealed output consumption by subsequent Tool, Skill, LLM, and Reviewer actors.
- Successful and failed Skill provenance, receipt linkage, output Artifact linkage, redacted output hashing, and capture-failure containment.
- Existing lease fencing, optional/core Tool behavior, redaction, evidence manifest construction, deliverable validation, and terminal Artifact invalidation remain covered by the serial regression suite.

## Verification Boundary

- The real Tavily test remains intentionally skipped without `TAVILY_TEST`; all offline real-adapter fixtures passed.
- Per Phase 3 protocol, Task11 ran the exact requested serial suite and typecheck. Main owns the single integrated `pnpm quality` phase gate and review.

## Review Closure

- Independent Task11 review found one Important issue: a Skill output rejected by output-schema validation retained its receipt but persisted `outputHash: null`.
- Added a failing regression that expected the canonical hash of the produced output, then propagated a redacted canonical hash through `SkillOutputSchemaError` and the failed-provenance path. Actor results that fail later during safety or Artifact handling also retain their produced Skill output hash.
- The focused regression passed after the fix; the exact serial suite and typecheck were rerun afterward.
