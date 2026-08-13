# Task 4 Report: Step Artifact Lease Fence

- Scope: `LeaseExecutionEngine` Step Artifact writes and the targeted lease-engine regression test.
- RED: `pnpm exec tsx --test --test-name-pattern="step Artifact.*lease" tests/lease-execution-engine.test.ts` failed as expected. With the Step write missing `activeLease`, the test observed a `succeeded` execution step after the lease was expired immediately before seal.
- Change: Step `writeJson` now passes `activeLease: input.lease`; existing Evidence Manifest and deliverable lease fences were preserved.
- Race coverage: the regression wraps the real repository seal call, expires the lease immediately before invoking the original seal, and asserts the Step Artifact is `FAILED` (not `SEALED`), the step is not `succeeded`, and task/attempt state is `paused`. This window is deterministic; no timing concern remains.
- GREEN: `pnpm exec tsx --test tests/lease-execution-engine.test.ts tests/control-plane.test.ts` passed: 39 passed, 1 real-provider skip, 0 failed.
- `pnpm quality` was not run in Task 4; it remains a Phase gate command.
