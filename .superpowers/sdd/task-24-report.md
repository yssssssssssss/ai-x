# Task 24 Execution Recovery and Controlled DAG Scheduler

Status: implementation complete, validation pending.

## Contract

- `ExecutionRecoveryService.recover(now)` pauses expired active executions as `worker_lost`, quarantines/fails STAGING artifacts, invalidates trusted terminal artifacts, leaves active executions untouched, and is idempotent.
- `ExecutionScheduler.schedule(plan, checkpoints)` produces deterministic topological waves, runs independent work with `Promise.allSettled`, blocks dependent work after failure, cancels unstarted downstream of failed Core work, and injects reusable checkpoint outputs.

## Verification

- RED tests cover expired lease, STAGING quarantine, terminal invalidation, idempotency, topological waves, parallel independent work, dependency blocking, Core cancellation, at-most-once execution, and checkpoint injection.
- Fresh targeted suite: `tests/execution-recovery.test.ts` and `tests/execution-scheduler.test.ts` passed.
- `pnpm typecheck` passed.
- Runtime lifecycle timer wiring remains a follow-up integration boundary because this branch's current server composition does not expose the newer ControlRuntime lifecycle port.
