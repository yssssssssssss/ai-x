# Task 6 Report — Requirement Refinement Service

## Status

- Task: complete.
- Scope: `RequirementRefinementService`, ResearchPlanningService V2 integration seam, runtime ConversationAdapter wiring, behavior tests, progress ledger.
- No Clarify route, SSE, or Web UI changes.

## TDD evidence

### RED

Command:

```text
pnpm exec tsx --test tests/requirement-refinement-service.test.ts
```

Result: 5 expected failures. Every scenario failed because `apps/orchestrator-runtime/src/control/requirement-refinement-service.ts` did not exist (`ERR_MODULE_NOT_FOUND`), confirming the tests exercised the missing Task 6 module rather than an implementation typo.

### GREEN

Command:

```text
pnpm exec tsx --test tests/requirement-refinement-service.test.ts tests/research-planning-service.test.ts
```

Result: 12 passed, 0 failed, 0 skipped.

Additional verification:

```text
pnpm exec tsc --noEmit -p tsconfig.json
```

Result: passed with no diagnostics.

## Implemented contract

- `RequirementRefinementService.understand()` and `.clarify()` return the typed `clarification_required` / `ready_to_plan` result with finalized `ResearchTaskV2`.
- Conversation ownership is checked before reading or appending; the default runtime adapter rechecks owner scope for history and message writes.
- Refinement LLM calls use `research-task-v2`, `SchemaValidator`, and the production `ReceiptLLMClient` with the configured expected model pin.
- Requirement versions are created and activated before a ready result can invoke the planner. Clarification creates the next version from the active version and answer context.
- Planner invocation is skipped when a blocking ambiguity, blocking issue, or clarification question remains.
- `ResearchPlanningService` accepts a finalized V2 requirement and routes it directly into existing planning strategies without a second understanding call.
- `ControlRuntime` exposes `requirementRefinement` and wires the expanded conversation adapter while preserving legacy planning adapter callers.

## Test scenarios

- Explicit requirement returns `ready_to_plan` and passes finalized requirement to planner.
- Ambiguous requirement returns `clarification_required` and does not invoke planner.
- Clarification persists version 2, clears blocking ambiguity/questions in the generated V2, and invokes planner only after persistence/activation.
- Only owner-scoped conversation messages enter the LLM context.
- Model drift records a failed receipt and prevents requirement creation/activation.

## Concerns

- Existing runtime overrides that only implement the original create/require conversation methods remain accepted for non-refinement flows; invoking refinement with such an override fails closed with a clear missing-history/append error. Production default wiring implements all required methods.
- Task 7 must expose the returned `ready_to_plan` requirement and call the existing planner seam; no HTTP/UI behavior was added here by design.
- Full quality/lint/formatter commands were intentionally not run per Task 6 instructions; phase-level quality remains the integration gate.
