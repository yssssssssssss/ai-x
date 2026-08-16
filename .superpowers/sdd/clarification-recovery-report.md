# Clarification Recovery Regression

## RED

- Added a real PostgreSQL/API regression in `tests/control-api-integration.test.ts` for a planner failure after Requirement activation and before candidate persistence.
- The test refreshes through `GET /api/control-tasks/:id`, verifies the latest `stateVersion` and finalized active `ResearchTaskV2` with zero ambiguities, questions, or blocking issues, then retries with a fresh idempotency key and empty answers/edits.
- The required recovery contract is HTTP 200, exact `depth`/`speed` candidates, `awaiting_selection`, unchanged Requirement-version count, no repeated requirement LLM call, exactly two persisted Plan rows, and a completed fresh command.
- Expected current failure from source inspection: the fresh latest-version request refines again, producing a third Requirement version and a third requirement LLM call instead of reusing the finalized active Requirement. The first RED assertion should report `requirement_versions: 3` where `2` is required.
- Per assignment constraint, no test, typecheck, build, formatter, Git, or other command was run; no GREEN result is claimed.

## Implementation

- `RequirementRefinementService.clarify()` now recognizes only the latest-version, no-new-answers/edits case whose active Requirement id/task/structured task still matches the awaiting-clarification task and no longer needs clarification. It reuses that Requirement and emits an explicit `latest_finalized_requirement` recovery context instead of calling the requirement LLM or activating another Requirement version.
- The agent API and `ControlPlanningService.planExistingTask()` pass that recovery context through without inferring or broadening it.
- `ControlPlaneRepository.persistClarificationCandidatesAndCompleteCommand()` keeps the normal activation-successor `command.expectedVersion + 1` fence. Its separate same-version recovery mode requires the current command version, then atomically locks and verifies the task, pending reservation token/hash/actor, active Requirement id/task, exact task/Requirement/finalized structured-task equality, and empty ambiguities/blocking issues/clarification questions before persisting exactly depth/speed, advancing to `awaiting_selection`, and completing the command.
- Existing completed-command response replay and old-version post-activation retry behavior are unchanged.

## Verification Follow-up

- Main-agent verification reached the new recovery path but reported 38 tests / 37 pass / 1 fail: the fresh-key POST returned 409 `no longer matches the finalized requirement recovery`. Typecheck also reported TS2769 at the empty-edit `Object.keys` call.
- Diagnosis confirmed Requirement activation updates `active_requirement_version_id`, `structured_task`, and `state_version`, but intentionally does not populate `control_tasks.task_type`; successful candidate persistence owns that field. The recovery transaction's pre-check therefore removed only the premature `task_type` column comparison. It still verifies the active Requirement id/task, exact task/Requirement/finalized structured-task equality, zero clarification fields, current state/version, and pending command reservation; the existing finalized input check still requires `structuredTask.task_type === input.taskType` before writes.
- The service's empty-edit guard now explicitly rejects `null` before `Object.keys`, resolving the reported type narrowing defect without changing accepted JSON payloads.

## Validation

- Main-agent automated verification after the corrections passed the clarification/control integration suite at 38/38 and `pnpm typecheck` passed.
- Runtime database observation after hot reload retained exactly seven Requirement versions: the attempted latest-version recovery did not create another Requirement version. The Gateway request remained pending before command reservation, so this observation does not establish an end-to-end runtime candidate-persistence result.
- This worker ran no validation command; no commit was made.
