# Phase 1 Fix Report

## Findings fixed

1. **Malformed frozen revision fields**
   - `control-runtime.ts` now validates every frozen evidence requirement (`id`, supported non-empty `acceptedClasses`, non-negative integer `minimumCount`, boolean `required`) before invoking the planner or reaching `createPlanRevision`.
   - It also validates frozen `pendingInputs` and the active plan step shape. Invalid frozen data fails closed.
   - Regression covers `evidence_requirements: [null]` and malformed pending input data while the replacement steps remain valid; the planner is not called and the plan version does not advance.

2. **Optional tool lease loss**
   - `lease-execution-engine.ts` no longer treats `lease_lost` as an optional-tool skip condition.
   - A lease loss during optional artifact sealing records the step as failed, pauses the task/attempt, and does not execute later plan steps.
   - Regression uses the existing seal-window mechanism and confirms no skipped optional step.

## TDD evidence

### RED

- `pnpm exec tsx --test tests/current-revision-integrity.test.ts`
  - Failed as expected: `production runtime rejects malformed frozen revision fields before repository persistence` with `Missing expected rejection` at the new assertion. This demonstrated malformed frozen fields reached revision persistence.
- `pnpm exec tsx --test tests/lease-execution-engine.test.ts`
  - Failed as expected: `does not skip an optional tool when lease is lost during artifact seal` with `ControlPlaneConflictError` / expired lease before the required failed-step behavior was established.

### GREEN

- `pnpm exec tsx --test tests/current-revision-integrity.test.ts`
  - 6 passed, 0 failed.
- `pnpm exec tsx --test tests/lease-execution-engine.test.ts`
  - 25 passed, 1 skipped, 0 failed.
- Required combined command:
  - `pnpm exec tsx --test tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts tests/lease-execution-engine.test.ts tests/control-plane.test.ts`
  - Concurrent test execution hit the existing PostgreSQL migration advisory-lock race: 45 passed, 15 failed in `control-plane.test.ts` hooks with `migration advisory lock is unavailable`, 1 skipped.
- Deterministic serial rerun of the same required file set:
  - `pnpm exec tsx --test --test-concurrency=1 tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts tests/lease-execution-engine.test.ts tests/control-plane.test.ts`
  - 60 passed, 0 failed, 1 skipped.

## Files

- `apps/agent-api/src/control-runtime.ts`
- `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- `tests/current-revision-integrity.test.ts`
- `tests/lease-execution-engine.test.ts`
- `.superpowers/sdd/phase-1-fix-report.md`

## Commit

Commit message: `fix: close phase one integrity gaps`

## Progress ledger

- Phase 1 blockers fixed.
- Next action: phase review.
