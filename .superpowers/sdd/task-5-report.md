# Task 5 Report

Status: DONE

Commit: pending

## Verification

Focused cutover tests:

```text
pnpm exec tsx --test tests/cutover-cli.test.ts tests/cutover-service.test.ts tests/cutover-sensors.test.ts
# tests 18
# pass 18
# fail 0
```

Migration dry-run:

```text
pnpm db:migrate -- --dry-run
# migrations 001, 002, 003 listed with sha256
```

Web build:

```text
cd apps/web && pnpm install --no-lockfile && pnpm build
# vite build succeeded
```

Full quality:

```text
pnpm quality
# tests 257
# pass 251
# fail 0
# skipped 6
```

Diff check:

```text
git diff --check
# no output
```

## Changed Files

- `apps/orchestrator-runtime/src/cutover/cutover-input.ts`
- `helloagents/CHANGELOG.md`
- `docs/superpowers/plans/2026-08-09-cutover-operator-cli.md`
- `.superpowers/sdd/task-5-report.md`

## Concerns

- `cutover-input.ts` type guard fix was discovered by full `pnpm quality`; focused tests already covered runtime behavior.

---

# Task 5 Report — Version Current Research Requirements

## Status

- Task: complete.
- Commit: `feat: version current research requirements` (to be created after this report is staged).
- Scope: Migration 004, ResearchTaskV2 schema/contracts, schema registry registration, control-plane requirement-version repository methods, requirement/schema tests, progress ledger.
- No refinement service, API route, or UI changes.

## TDD evidence

### RED

Command:

```text
pnpm exec tsx --test --test-concurrency=1 tests/requirement-version.test.ts tests/schema.test.ts
```

Result: expected failure. The requirement test failed during setup because the pre-004 `control_tasks_state_check` rejected `awaiting_clarification`; the V2 schema was not yet available. Existing legacy schema tests passed, proving the new failure was isolated to the missing Task 5 behavior.

### GREEN

Command:

```text
pnpm exec tsx --test --test-concurrency=1 tests/requirement-version.test.ts tests/schema.test.ts tests/migration-runner.test.ts
```

Result: 23 passed, 0 failed, 0 skipped.

Additional verification:

```text
pnpm exec tsc --noEmit -p tsconfig.json
```

Result: passed with no diagnostics.

```text
pnpm exec tsx database/run-migrations.ts --dry-run
```

Result: migration runner planned 4 files and recognized `004_requirement_and_media.sql` with checksum `sha256:92f2658f23021f31d010225f61385e4a774d7a8922750fb691758d564e2a2896`.

## Implemented contract

- `ResearchTaskV2` uses the approved snake_case JSON contract, including required `success_criteria`, `ambiguities`, and `clarification_questions`; legacy `ResearchTaskData` remains unchanged.
- `ControlWorkflowState` and `ControlTaskState` accept `awaiting_clarification`, `reviewing`, and `composing_report`.
- `ControlRequirementVersion` exposes task/version/hash/clarification/structured-task/model-call/created-at fields.
- Existing schema registry resolves `research-task-v2` to `schemas/research-task-v2.schema.json`.

## Migration 004

`database/migrations/004_requirement_and_media.sql` is additive:

- Adds `control_tasks.active_requirement_version_id` and a deferrable FK.
- Expands the Current task state CHECK constraint with the three new states.
- Creates `control_requirement_versions` with FK to `control_tasks`, positive version constraint, raw input hash, clarification JSON, structured task JSON, nullable model call FK, timestamp, and `UNIQUE (task_id, version)`.
- Adds nullable `control_artifacts.media_type` and `control_artifacts.metadata_json`.
- Adds a task/version index.
- No `DROP TABLE`, `DELETE`, `TRUNCATE`, or `DROP COLUMN` operations were found. Legacy tables/rows are not touched.

## Repository guarantees

- `createRequirementVersion`, `getActiveRequirementVersion`, and `activateRequirementVersion` each use the repository transaction helper.
- Creation explicitly checks task existence before insert; the database FK remains the final guard.
- Activation locks the task, verifies owner and conversation-owner identity, verifies expected `stateVersion`, locks/checks the requirement belongs to the same task, and performs a guarded CAS update that increments `stateVersion`.
- Stale CAS and cross-task activation fail with `ControlPlaneConflictError`.
- Existing legacy read paths were not changed.

## Known concerns

- There is intentionally no destructive/down migration: rollback means stopping before applying 004; after application, the migration ledger/checksum protects the applied schema and additive compatibility is preserved.
- Full `pnpm quality` and formatter/linter were intentionally not run per Task 5 instructions; Phase-level quality remains the integration gate.
