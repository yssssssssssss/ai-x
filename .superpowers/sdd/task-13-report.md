# Task 13 ReportReviewService

Status: complete

## Implementation

- Added typed `ReportReviewArtifact` and strict `schemas/report-review.schema.json`.
- Added `ReportReviewService` with injected LLM, evidence, artifact, validator, and deliverable revision seams.
- Deterministic coverage no longer scans arbitrary report strings. A strict typed `coverage` graph binds each required ProblemGraph question to real Summary IDs and each finalized success criterion to real Conclusion and Recommendation IDs; missing, duplicate, empty, extra-property, and dangling bindings block before reviewer LLM.
- Semantic review uses `schemaName=report-review`, `stage=deliverable_review`, and expected actual-model receipt pin through the injected `ReceiptLLMClient`.
- `revise` runs exactly once; a second revise or block pauses. Review artifacts are written with the active lease and must return `SEALED`.
- Integrated review into `LeaseExecutionEngine` with `executing -> reviewing -> composing_report -> completed` transitions and result propagation through workflow/API contracts. Review-gated CurrentDeliverable v1 envelopes now require the typed coverage graph; only the historical Artifact marker retains no-coverage compatibility.

## Verification

- RED: `pnpm exec tsx --test tests/report-review-service.test.ts` failed with expected missing-module error before implementation.
- GREEN: `pnpm exec tsx --test tests/report-review-service.test.ts` — 8 passed.
- Required suite: `pnpm exec tsx --test tests/report-review-service.test.ts tests/current-deliverable-service.test.ts tests/model-receipt.test.ts` — 32 passed.
- Engine/workflow regression: `pnpm exec tsx --test tests/lease-execution-engine.test.ts tests/task-workflow.test.ts` — 49 passed, 1 existing skip.
- Receipt regression: `pnpm exec tsx --test tests/model-receipt.test.ts tests/gateway-llm-receipt.test.ts` — 8 passed.
- Typecheck: `pnpm typecheck` — passed.
 - Added `CurrentDeliverableService.revise()` and engine composer injection so production review revisions regenerate through the existing deliverable path with review issues as the revision instruction.
 - Final rerun after revision seam: required suite 32 passed; engine/workflow 49 passed / 1 skipped; `pnpm typecheck` passed.

## Phase 4 Integrity Closure

- Deliverable generation now takes an explicit revision round and seals immutable `deliverables/final-r0.json` and `deliverables/final-r1.json` paths. A real `ControlArtifactStore` regression proves round 1 no longer collides with round 0 and round 0 remains readable.
- `REPORT_REVIEW_DIMENSION_IDS` is the single seven-dimension contract. Schema, service, and package read validation require every dimension exactly once; `pass` additionally requires every dimension to pass with no issues.
- Production execution passes finalized `success_criteria` IDs and required ProblemGraph question IDs to review. A paused deterministic block, semantic block, or second revise records one deterministic `report_review` failed step with `retryable=false` and `allowedActions=['abort']`; workflow retry is rejected and abort succeeds. A caller-supplied `failedStepNo` that does not identify a failed step is rejected immediately without changing paused state.
- The engine returns the Review-bound final revised Deliverable Artifact ID for both pass and pause outcomes.
- Command-loss replay verifies the SEALED final Review, follows its exact `deliverableArtifactId`, verifies the Evidence Manifest, and reconstructs all terminal IDs without rerunning the execution driver. Overall execution state remains independently paused after a later failure, while `reviewStatus` is `completed` exactly when the verified Review verdict is pass.

### TDD and Verification

- RED: report identity/dimension regressions produced 16 expected failures across 71 tests; lease/recovery regressions produced 20 expected failures across 107 tests with one real-provider skip.
- GREEN: the exact Phase 4 serial suite passed 184/184 runnable tests with one real-provider skip and zero failures; `pnpm typecheck` passed.

## Final Gate Blocker Closure

- RED: the five focused files ran 122 tests with 21 expected failures, including risk text containing false coverage IDs, missing/duplicate/dangling bindings, forged positive `failedStepNo`, and paused command-loss replay of a SEALED pass Review.
- GREEN: the exact requested eight-file serial suite ran 177 tests: 176 passed, one real-provider test skipped, zero failed. `pnpm typecheck` passed.

