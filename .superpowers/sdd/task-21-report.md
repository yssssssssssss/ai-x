# Task 21 Multi-Deliverable Contracts

## RED Contract

- Added `tests/multi-deliverable-contract.test.ts` for the complete five-task mapping set:
  - `user_research_planning -> research_plan`
  - `competitive_research -> competitive_analysis_report`
  - `voc_diagnosis -> voc_diagnosis_report`
  - `design_audit -> design_audit_report`
  - `a11y_audit -> accessibility_audit_report`
- Each task must have exactly one active Registry mapping and an explicit accepted `expected_deliverables` alias. Canonical ids and declared aliases are exercised separately; no fuzzy, localized, or substring compatibility behavior is accepted.
- Each contract must load its payload Schema, synthesis Prompt, review Rubric, report Template, and exact task/deliverable Evidence Policy through production loaders. The Registry linter must accept the resulting complete configuration.
- Payload schemas must be closed at the root with `additionalProperties: false`. Every task-specific critical dimension is required, is an array, and has `minItems: 1`; fixtures also prove undeclared root fields and empty critical arrays are rejected.
- Professional fixtures cover competitive samples/matrix/differences/impact/actions/screenshots; VOC datasets/themes/frequency/sentiment/quotes/severity/priority; design pages/issues/principles/severity/annotations/remediation/retest; and accessibility platform/POUR/components/A-B-C/P0-P3/screen-reader/remediation/verification.
- Production planning is exercised for all five task types and must pass the exact Registry-selected Evidence Policy into the routed planner.
- `CurrentDeliverableService` is exercised for all four new professional payloads with the real `SchemaValidator`, proving the generic generation path selects the task-specific Prompt and validates the task-specific payload before sealing.

## Implementation Status

- Added four closed payload Schemas. Every task-specific critical dimension is required, is an array, and has `minItems: 1`; nested fixture objects are also closed and constrain the required A/B/C, P0-P3, sentiment, and severity values.
- Added four task-specific synthesis Prompts that request only professional payload content, bind claims to evidence/assets, and exclude research-plan and Envelope-only fields.
- Added four seven-dimension Rubrics using the exact `report-review-v1` dimensions and four Composer-compatible ordered 13-section Report Templates.
- Extended the production Registry to five unique active task mappings with explicit exact aliases while retaining `user_research_planning -> research_plan` unchanged.
- Added exact Evidence Policy entries for each new task/deliverable pair; each Registry `evidence_policy` names a requirement in its selected policy.
- Task 20 runtime selection, selected-resource validation, exact alias behavior, and generic `CurrentDeliverableService` code were not modified.

Observed final joint evidence from Main (2026-08-17): the Task 20 + Task 21 eight-file suite completed with 202 total / 201 passed / 1 existing provider skip / 0 failed. `pnpm typecheck`, Registry linter, and Knowledge linter all passed. Review and commit remain pending.

## Test Fixture Clean Cutover

- Migrated competitive Task 20 fixtures to declare the explicit `competitive analysis report` alias.
- Migrated the shared compiler and planning fixtures from research-plan labels/policy expectations to `competitive_analysis_report` and the exact `competitive-analysis-report` Evidence Policy requirement (`public_source` plus `screenshot`, minimum one).
- Migrated competitive lease plans and finalized requirements to the professional deliverable id/alias while preserving custom evidence-minimum fixtures that test execution behavior rather than Registry policy selection.
- Replaced the lease pipeline's fixed research-plan fake payload with a valid competitive-analysis payload so production report composition validates the selected contract instead of a stale shape.
- Added an explicit `JsonSchema | undefined` annotation to the Task 21 critical-dimension lookup to remove the TS7022 inference cycle without weakening runtime assertions.

The later final joint verification covers this fixture clean cutover: 202 total / 201 passed / 1 existing provider skip / 0 failed, with typecheck and both Registry and Knowledge linters passing. No commit was made.
