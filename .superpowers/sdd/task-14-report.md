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
