# Task 20 Deliverable Registry v2 Runtime

## RED Contract

- `tests/deliverable-registry-v2.test.ts` covers missing schema/prompt/rubric/policy/template resources, duplicate active task mappings, unsupported and inactive task types, legacy/malformed registries, unsafe paths, deterministic resolution, service resource selection, and engine non-`research_plan` preflight.

## Implementation Facts

- Task 20 established strict Registry v2 with `user_research_planning -> research_plan`, all five governed resource references, and explicit exact aliases. Task 21 subsequently added the other four active task/deliverable mappings and resources without changing the Task 20 runtime contract, closing the production planning-to-report pipeline gate for all five task types.
- `apps/orchestrator-runtime/src/report/deliverable-registry.ts` separates structural selection from selected-resource validation so task mapping resolves before Evidence Policy lookup. Optional aliases are strict non-empty, trimmed, unique arrays; exact ids and explicit aliases are the only compatibility surface. Localized and substring heuristics are removed, active id/alias ambiguity fails closed, and selected task policies resolve exactly.
- `ResearchPlanningService` resolves finalized `task_type + expected_deliverables` and exact Evidence Policy, then production Control Planning passes an explicit frozen selection into `PlanCompiler`. The compiler does not read global Registry state: it validates and clones the supplied selection, while calls without one retain legacy `research_plan + caller evidence` behavior. The current execution-plan schema accepts safe Registry ids instead of a `research_plan` literal.
- `CurrentDeliverableService` uses the selected payload schema and synthesis prompt. `ReportEvidenceValidator` retains shared envelope, graph, recommendation, coverage, and binding invariants while resolving and validating any active Registry-governed payload.
- `ReportReviewService` resolves and supplies the selected rubric. `ReportCompositionService` and `composeReportDocument` resolve the selected template and payload schema internally, reject frozen id/version/template mismatch, and preserve the research-plan rendering behavior without a research-plan-only gate.
- `LeaseExecutionEngine` resolves the complete active contract and canonical deliverable id before execution, while preserving the plan's explicit evidence requirements for legacy and already-persisted plans. Current planning and revision boundaries validate/freeze Registry policy; review and composition resolve resources from the frozen canonical type. Legacy fixtures without v2 selection fields remain Registry-backed by active declared id.
- `harness/linters/registry-linter.ts` continues to report the runtime Registry diagnostics without maintaining a second validation rule set.

## Verification Status

Main observed the final joint Task 20 + Task 21 eight-file suite at 202 total / 201 pass / 1 existing provider skip / 0 fail. `pnpm typecheck`, `registry-linter`, and `knowledge-linter` all passed. This worker ran no production, test, validation, dependency, or Git command and created no commit.

## Additional RED Coverage

- Planning now has RED contracts requiring `ResearchPlanningService` to resolve `task_type + expected_deliverables` through the Deliverable Registry before selecting Evidence Policy, and requiring `PlanCompiler` to freeze that exact Deliverable id and exact Registry policy. The current execution-plan schema must accept safe Registry ids, while compiler validation must reject a policy that differs from the selected Registry contract.
- A minimal temporary `competitive_analysis_report` contract now exercises the complete report path: `CurrentDeliverableService` payload schema/Prompt selection, generic `ReportEvidenceValidator` envelope binding, `ReportReviewService` Rubric selection, `ReportCompositionService` Template selection, and direct Composer payload-schema/Template validation. The tests reject every fixed `research_plan`, research-plan schema, Rubric, or Template gate.
- Execution fallback now has explicit allowlist tests: an unmapped task may resolve only an exact active Registry id or an explicitly declared Registry alias. Localized labels and generic/substring labels such as `analysis` or `competitive analysis` must be rejected.

The production paths and explicit frozen-selection RED fixtures implement these contracts while preserving pure compiler and legacy execution compatibility. Task 21's four additional mappings/resources close the planning/report pipeline gate over the same Registry-governed runtime. Final joint validation is GREEN; commit remains pending.
