# Task 14 Verified Core Report Package

Status: complete

## Implementation

- Added `CurrentReportPackageResponse` with explicit `legacy_text`, `current_text`, and future `multimodal` modes. Phase 4 `current_text` contains only Deliverable, Evidence Manifest, and final Report Review; no document or visual asset placeholders are created.
- New Deliverable Artifacts use `research-deliverable-v1-review-gated` while the JSON envelope remains `research-deliverable-v1`. Historical Artifacts with the old marker return `legacy_text`; unknown markers and incomplete review-gated packages fail closed.
- Added `CurrentReportPackageReader` as the single read-side validation boundary. It invokes `readVerifiedJson()` for Deliverable, Evidence Manifest, every referenced Evidence Artifact, and Review; validates SEALED/schema/Task/Plan/Attempt bindings; then reruns Manifest and Finding Graph validation.
- Review-gated reads require a `report-review-v1` Artifact bound to the selected final Deliverable, `verdict=pass`, and a revision round matching the selected final Review Artifact. Missing, tampered, foreign, malformed, revise, or block Reviews are rejected without legacy downgrade.
- Production Current GET now checks task and conversation ownership before invoking the package reader. Foreign and missing task IDs remain indistinguishable 404 responses.
- Real E2E exposed the Task 13 lease fence still accepting only `executing`; the repository fence now consistently permits the already-declared `reviewing` and `composing_report` execution states for seal, require-active, and heartbeat operations while retaining attempt, owner, token, expiry, task, and plan checks.
- Corrected the Task 14 brief, approved plan, and phase design note so Phase 5 Tasks 16–19—not Phase 4—own ReportDocument and VisualAssetManifest.

## TDD and Verification

- RED: `tests/report-package.test.ts` failed because `current-report-package-reader.ts` did not exist.
- RED integration: the offline Current flow paused because no valid `report-review` fixture existed; after adding it, the real path exposed the review-state lease seal mismatch.
- GREEN package reader: 27/27 passed.
- GREEN production integration: 14/14 passed, including current_text/reportReview response, SEALED Review persistence, and real Review file tamper rejection.
- Deliverable writer regression: 18/18 passed, including the review-gated Artifact marker.
- Required serial suite: 58/58 passed across report package, control API integration, auth isolation, and report review service tests.
- `pnpm typecheck`: passed.
- Lease/database regression: 21/21 passed.

## Phase 4 Integrity Closure

- Tool synthesis material is now EvidenceEntry-scoped: only strict Artifact ID/hash and JSON-pointer-selected values enter `fact_source`, each with its Evidence ID, pointer, and optional source URL. Unreferenced siblings and top-level answers are excluded.
- The package reader resolves the final Review first, revalidates the complete pass invariant, then reads the exact Deliverable named by `review.deliverableArtifactId`; it no longer trusts an arbitrary latest draft. Historical no-Review Deliverables retain explicit legacy compatibility.
- Lease expiry and expired `requireActiveLease`, heartbeat, completion, and seal paths atomically pause the attempt and task from `executing`, `reviewing`, or `composing_report`. Terminal recovery invalidates SEALED/STAGING `evidence_manifest`, `deliverable`, and `report_review` together, so no trusted orphan Review remains.
- Real PostgreSQL and `ControlArtifactStore` regressions cover the state matrix, immutable file collision, final revised API ID, and terminal trusted-artifact invalidation.

- Workflow command-loss recovery uses verified terminal Review content rather than an arbitrary latest draft, preserving the same final Deliverable, Evidence Manifest, Review IDs, and review status across idempotent replay.

### TDD and Verification

- RED: Evidence scoping produced 2 expected failures across 7 tests; report identity/dimension regressions produced 16 expected failures across 71 tests; lease/recovery produced 20 expected failures across 107 tests with one real-provider skip.
- GREEN: `pnpm exec tsx --test --test-concurrency=1 tests/synthesis-materializer.test.ts tests/current-deliverable-service.test.ts tests/report-review-service.test.ts tests/report-package.test.ts tests/lease-execution-engine.test.ts tests/task-workflow.test.ts tests/control-plane.test.ts tests/control-api-integration.test.ts` passed 184/184 runnable tests with one real-provider skip; `pnpm typecheck` passed.
