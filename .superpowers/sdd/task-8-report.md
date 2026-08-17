# Task 8 Report — ProblemGraph Schema and Planner

## Scope

- Added the strict `problem-graph` JSON Schema and registered it through the runtime schema registry.
- Added exported ProblemGraph types, `ProblemGraphValidationError`, the pure coverage/DAG validator, and `ProblemGraphPlanner.build(task)`.
- Kept Task 8 isolated: no ControlPlanningService, Current plan, compiler, or downstream runtime integration.

## TDD Evidence

### RED

Command:

```bash
pnpm exec tsx --test tests/problem-graph.test.ts
```

Observed expected failure: `ERR_MODULE_NOT_FOUND` for `apps/orchestrator-runtime/src/planners/problem-graph-planner.ts`; 0 passed / 1 failed test file. The production module and schema did not exist.

### GREEN

Commands and results:

```bash
pnpm exec tsx --test tests/problem-graph.test.ts
# 12 passed / 0 failed

pnpm exec tsx --test tests/problem-graph.test.ts tests/model-receipt.test.ts
# 18 passed / 0 failed

pnpm exec tsc --noEmit -p tsconfig.json
# exit 0
```

## Requirements Covered

- Strict graph/question/evidence shape and registry-backed schema object.
- Duplicate question IDs, unknown dependencies, dependency cycles, unknown success criteria, uncovered success criteria, required questions without a success criterion, and required questions without required evidence.
- Typed validation errors carrying the exact offending criterion/question/dependency IDs.
- Planner context contains only the finalized `ResearchTaskV2`, `GuidanceRef[]`, and resolved Evidence Policy.
- Deterministic context manifest hash, `problem_graph` receipt stage, and actual-model pin distinct from the provider routing alias.
- JSON Schema validation runs before semantic validation; neither structurally nor semantically malformed graphs return.
