# Task 3 Report

Status: DONE

Commit: pending

## RED

Command: `pnpm exec tsx --test tests/cutover-cli.test.ts`

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../apps/orchestrator-runtime/src/cutover/cutover-cli.ts'
# pass 5
# fail 2
```

## GREEN

Command: `pnpm exec tsx --test tests/cutover-cli.test.ts`

```text
# tests 7
# pass 7
# fail 0
```

## Changed Files

- `apps/orchestrator-runtime/src/cutover/cutover-cli.ts`
- `package.json`
- `tests/cutover-cli.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Concerns

- None.

---

# Phase 1 Task 3 Report

Status: DONE

Commit message: `fix: make current plan revisions server-owned`

## RED

Command: `pnpm exec tsx --test tests/current-revision-integrity.test.ts`

Result: expected failure (1 passed, 4 failed). The HTTP route accepted a forged client plan/hash with status 200, workflow revision bypassed the injected driver, repository required a caller-supplied hash, and production runtime had no revision driver.

## GREEN

Command: `pnpm exec tsx --test tests/current-revision-integrity.test.ts tests/task-workflow.test.ts tests/control-api-integration.test.ts`

Result: passed (19 passed, 0 failed).

## Delivered

- Replaced the revision request contract with `revisionInstruction`; the HTTP route rejects any `plan` or `planHash` field.
- Added `WorkflowPlanRevisionDriver`; revision idempotency hashes include the instruction and existing owner/state checks remain in force.
- Made `ControlPlaneRepository.createPlanRevision` canonicalize the persisted plan and compute its hash internally.
- Wired the production runtime to replan from `structuredTask.research_goal` plus the instruction, keep the active depth/speed candidate, frozen deliverable/evidence requirements, and pending inputs, and sanitize new steps.
- Fail closed before creating a revision when task, active plan, candidate, research goal, frozen plan fields, pending inputs, or planning output are missing or malformed.
- Migrated the existing workflow revision test caller to the clean server-driver contract.

## Concerns

The repository-root checkout contains an unrelated stale `.superpowers/sdd/task-3-brief.md`; the authoritative brief inside `.worktrees/current-trusted-research-flow` is refreshed and matches this task. The root checkout was not modified. Formatter, linter, `pnpm quality`, and project-wide tests were intentionally not run per the task brief.
