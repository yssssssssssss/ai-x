# Task 20 Deliverable Registry v2 Runtime

## RED Contract

- `tests/deliverable-registry-v2.test.ts` covers missing schema/prompt/rubric/policy/template resources, duplicate active task mappings, unsupported and inactive task types, legacy/malformed registries, unsafe paths, deterministic resolution, service resource selection, and engine non-`research_plan` preflight.

## Implementation Facts

- `orchestrator/deliverable-registry.yaml` is now strict version 2 with the active `user_research_planning -> research_plan` mapping and all five resource references.
- `apps/orchestrator-runtime/src/report/deliverable-registry.ts` parses and diagnoses Registry v2, enforces unique active task ownership, validates expected-deliverable compatibility, confines file resources to the configured root (including realpath containment), validates referenced resources, and resolves complete contracts deterministically.
- `harness/linters/registry-linter.ts` reports the runtime Registry diagnostics without maintaining a second validation rule set.
- `CurrentDeliverableService` resolves schema, synthesis prompt, review rubric, Evidence Policy, and Report Template through the Registry. Payload validation, prompt selection, envelope version, schema label, and artifact schema version are selected from that contract rather than fixed research-plan paths.
- `LeaseExecutionEngine` resolves complete v2 tasks by `task_type + expected_deliverables`, checks the plan deliverable against that selection, and preserves the selected type in generation input. If a task has no Registry task mapping, execution may use the plan-declared active Registry deliverable only when `expected_deliverables` is compatible with that ID; the public `resolveDeliverable` API remains strict and rejects unsupported task types. Legacy task fixtures without v2 selection fields remain Registry-backed by declared ID.
- Production research-plan Prompt, Review Rubric, and `user_research_planning` Evidence Policy resources were added. No Task 21 deliverable mapping was added.

## Verification Status

Main observed the final Task20 Registry/Current Deliverable/Lease Engine suite at 86 total / 85 pass / 1 existing provider skip / 0 fail, `pnpm typecheck` passing, and `registry-linter: OK`. This worker ran no command. No commit was created; commit remains pending.
