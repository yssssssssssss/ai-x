# Task 23 Checkpoint Resume 和 Retry Lineage

## Implementation

- Added `checkpoint-resolver.ts` with idempotent resume replay, seven-field fingerprint matching, SEALED artifact checks, dependency/downstream invalidation, reusable output injection, and retry attempt persistence seam.
- `ControlPlaneRepository.claimExecution` accepts/derives `retryOf`, validates same-task lineage, and persists `retry_of` on the new attempt.
- Workflow passes the paused attempt lineage through claim and lease objects.
- Execution steps persist output artifact linkage; lease engine verifies unchanged sealed Tool checkpoint prefixes and resumes from the first invalid step.
- API execution-step contract exposes `outputArtifactId`.

## Validation

Per assignment constraints, no tests, typecheck, lint, build, formatter, or other validation command was run. No commit was created.
