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


## Follow-up compile fix

- Added the missing type-only `PlanCandidate` import from `packages/api-contract/plan.ts` to the server-owned revision driver in `control-runtime.ts`.
- Before the fix, `pnpm typecheck` failed only at `control-runtime.ts:128` and `control-runtime.ts:144` with `TS2304: Cannot find name 'PlanCandidate'`.
- After the fix, `pnpm typecheck` passed.
- Serial targeted verification passed:
  - `pnpm exec tsx --test --test-concurrency=1 tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts tests/lease-execution-engine.test.ts tests/control-plane.test.ts`
  - 60 passed, 0 failed, 1 real-provider skip.
- Follow-up commit message: `fix: complete phase one type wiring`.

## Follow-up files

- `apps/agent-api/src/control-runtime.ts`
- `.superpowers/sdd/phase-1-fix-report.md`
- `.superpowers/sdd/progress.md`
## Revision integrity follow-up

### Findings fixed

- `revisionSteps` now requires the complete six-field frozen step shape, rejects non-object/array `input`, rejects non-boolean `requires_approval`, and rejects unknown step keys before the planner is called.
- Regenerated steps are checked against every preserved pending-input target by `step_no`, `actor_id`/`tool_id`, and input field. A dangling target fails closed before `createPlanRevision`; valid targets continue to revise normally.

### TDD evidence

#### RED

- `pnpm exec tsx --test tests/current-revision-integrity.test.ts`
  - Failed as expected: the new malformed frozen step test reported `Missing expected rejection`.
  - Failed as expected: the new dangling pending-input target test reported `Missing expected rejection`.
  - Existing six tests passed.

#### GREEN

- `pnpm exec tsx --test tests/current-revision-integrity.test.ts`
  - 8 passed, 0 failed, 0 skipped.
- `pnpm exec tsx --test --test-concurrency=1 tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts tests/lease-execution-engine.test.ts tests/control-plane.test.ts`
  - 62 passed, 0 failed, 1 real-provider skip.

### Files

- `apps/agent-api/src/control-runtime.ts`
- `tests/current-revision-integrity.test.ts`
- `.superpowers/sdd/phase-1-fix-report.md`
- `.superpowers/sdd/progress.md`

### Commit

Commit message: `fix: validate regenerated revision bindings`

## Revision driver typing follow-up

### Finding fixed

- `revisionSteps` now exposes its existing runtime validation as the type predicate `value is PlanCandidate['steps']`, narrowing validated `steps` before `.some` without changing behavior.

### Verification

- `pnpm typecheck`
  - Passed.
- `pnpm exec tsx --test tests/current-revision-integrity.test.ts`
  - 8 passed, 0 failed, 0 skipped.
- `pnpm exec tsx --test --test-concurrency=1 tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts tests/lease-execution-engine.test.ts tests/control-plane.test.ts`
  - 62 passed, 0 failed, 1 real-provider skip.

### Files

- `apps/agent-api/src/control-runtime.ts`
- `.superpowers/sdd/phase-1-fix-report.md`
- `.superpowers/sdd/progress.md`

### Commit

Commit message: `fix: complete revision driver typing`