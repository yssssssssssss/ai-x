# Task 10 Report — PlanCompiler and CurrentPlanStep

## Scope

- Added an independent strict `CurrentPlanStep` and `CurrentExecutionPlan` contract. Legacy `PlanStep`, Legacy candidate generation, and Legacy execution-plan schema remain unchanged.
- Added the registered strict `current-execution-plan` JSON Schema and a pure `PlanCompiler` that rebuilds server step numbers, validates question/DAG/binding/evidence/capability/tool-order references, derives Pending Inputs, and emits the frozen Current plan object.
- Integrated Task8 `ProblemGraphPlanner` and Task9 `CapabilityResolver` into finalized-V2 Current planning before candidate generation and persistence.
- Wired production ToolRouter adapter resolution into capability health and real-adapter qualification; owner authority is injected as the available approval capability.
- Added deterministic finalized `$skill` Current proposals: speed executes the selected eligible Skill; depth executes the same Skill plus reviewer; neither path invokes routed candidate LLM generation.
- Replaced the former Current sanitizer persistence path with PlanCompiler. Malformed LLM candidates fail before every candidate repository call.
- Added a repository-level revision gate: strict V2/Current schema validation, PlanCompiler semantic recompilation, frozen-plan equality, and derived Pending Input equality all run after locking the task and before canonical hashing/insertion. Workflow, production revision driver, and direct repository calls cannot bypass it.
- Updated the approved Task10 file list to include the required runtime assembly, revision gate, fixture migrations, report, and progress files.

## TDD Evidence

### RED

Commands and observed failures:

```bash
pnpm exec tsx --test --test-concurrency=1 tests/plan-compiler.test.ts
# ERR_MODULE_NOT_FOUND: plan-compiler.ts
```

After the pure compiler existed, integration regressions failed as expected:

- persisted plans had no `problem_graph` or `capability_decisions`;
- an unknown LLM `question_id` reached the repository;
- `planCurrentFromRequirement` did not exist;
- finalized `$skill` Current planning threw `Current direct planning is not available through RoutedPlanner`;
- `createPlanRevision` accepted and inserted a schema-valid plan whose step referenced an unknown question.

### GREEN

Verified behavior during implementation:

- PlanCompiler/Current planning integration: 15/15 passed.
- ControlPlanningService integration: 8/8 passed.
- Production Current API integration: 14/14 passed.
- Current revision integrity: 9/9 passed.
- Repository revision semantic-gate regression passed against real PostgreSQL.
- Exact required serial suite: 79/79 passed, 0 failed, 0 skipped.
- `pnpm typecheck`: exit 0 for runtime and web TypeScript projects.
- Current revision integrity suite: 9/9 passed against real PostgreSQL.

## Requirements Covered

- Cycle, dangling/late dependency, orphan required question, and unknown question rejection.
- Missing/late Skill-required Tool rejection.
- Future/dangling input binding and unknown JSON pointer rejection.
- Missing Core Evidence policy rejection.
- Rejected/unknown capability actor and invalid fallback rejection.
- Exact depth/speed compilation with server-owned `step_no`, graph, capability decisions, candidate metadata, activated nodes, evidence policy, and derived Pending Inputs.
- Task8 receipt/model pin preserved; Task9 eligible/rejected decisions frozen into each canonical plan.
- Current candidate actor IDs constrained to the Task9 eligible Skill/required-Tool shortlist; rejected actor IDs cannot persist.
- Strict snake_case Current step fields and `additionalProperties: false`; Legacy `purpose`/minimal-step drift is rejected instead of sanitized.
- Canonical database hash covers the repository-injected `task_id` plus every compiler-frozen plan field.
- No client plan/hash mutation and no Task11 execution binding implementation.

## Verification Boundary

- Tool health uses the current ToolRouter’s actual adapter resolution: unresolved adapters are unhealthy; only matching `executionMode: real` adapter resolutions qualify Core real-adapter availability. No separate live-health provider exists in the current runtime.
- PlanCompiler validates binding references but does not resolve step outputs into later inputs; execution-time binding remains Task11.
