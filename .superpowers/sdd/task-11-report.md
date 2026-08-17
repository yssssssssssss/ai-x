# Task 11 Report — Sealed Step Bindings and Skill Provenance

## Scope

- Added a pure strict RFC6901 step-input resolver that clones the compiler-owned base input, rejects malformed/duplicate/prototype/array targets, and applies bindings only from unique earlier succeeded steps.
- Bound every source read to a SEALED, hash-verified Artifact with matching task, plan version, attempt, kind, ID, and content hash. Tool Artifact envelopes expose only their verified logical `output`; no binding reads `StepResult.output`.
- Preserved Current step binding fields through execution parsing and preflighted future/unknown/unsafe bindings before actor side effects.
- Resolved Tool and Skill inputs before their input-schema validation. Skill, LLM, and Reviewer contexts receive only verified prior Artifact outputs.
- Added additive Migration 007 with independent `skill_provenance JSONB`; `tool_provenance` remains unchanged.
- Persisted Skill body hash, nullable-only-when-absent input/output schema hashes, resolved input hash, SEALED output hash, prompt hash, trace ID, database model receipt ID, output Artifact ID, and status. Failed provenance capture is best-effort and cannot replace the actor failure or leave the attempt active.
- Changed `ModelCallRecorder.recordModelCall` and `ControlPlaneRepository.recordModelCall` to return the inserted database ID. `ReceiptLLMClient` propagates it as `receiptId` on successful structured and text results; all recorder fixtures migrated without aliases.
- Updated the approved Task11 file list and progress ledger for the migration, receipt seam, repository types, fixture migrations, and report.

## TDD Evidence

### RED

Observed failures before implementation:

- `tests/current-step-bindings.test.ts`: `ERR_MODULE_NOT_FOUND` for `step-input-resolver.ts`.
- Receipt tests: successful results had `receiptId === undefined`; repository `recordModelCall` returned `undefined`.
- Execution/repository suite: 31 pass / 5 fail / 1 skip. Failures were missing Skill provenance persistence, unresolved Tool input rejected during preflight, future binding accepted before actor side effects, dangling pointer accepted before Skill invocation, and missing resolved Skill context/provenance.
- Sensitive Skill regression: persisted provenance output hash differed from the canonical SEALED redacted Skill JSON hash.

### GREEN

- Pure resolver and real Artifact store integration: 9/9 passed.
- Receipt ID and repository persistence: 13/13 passed.
- Engine/repository binding and provenance suite: 36 pass / 1 real-provider skip / 0 fail, followed by the expanded Skill failure-boundary suite at 31 pass / 1 real-provider skip / 0 fail.
- Sensitive Skill output hash regression passed after recomputing provenance at the shared redaction seam.
- Exact required serial suite: 83 tests / 82 pass / 1 real-provider skip / 0 fail.
- `pnpm typecheck`: passed for runtime and web TypeScript projects.

## Requirements Covered

- RFC6901 escaping, array source reads, strict malformed escape rejection, deep cloning, source pointer existence, object-field creation, duplicate decoded target rejection, and prototype/array-target protection.
- Unknown, future, duplicate, non-succeeded, STAGING, tampered, wrong-attempt, and mismatched-hash Artifact rejection.
- Real `ControlArtifactStore.readVerifiedJson` integration for valid, tampered, and unsealed Artifacts.
- Tool and Skill input schema validation after binding; Skill output schema remains required when declared.
- Verified sealed output consumption by subsequent Tool, Skill, LLM, and Reviewer actors.
- Successful and failed Skill provenance, receipt linkage, output Artifact linkage, redacted output hashing, and capture-failure containment.
- Existing lease fencing, optional/core Tool behavior, redaction, evidence manifest construction, deliverable validation, and terminal Artifact invalidation remain covered by the serial regression suite.

## Verification Boundary

- The real Tavily test remains intentionally skipped without `TAVILY_TEST`; all offline real-adapter fixtures passed.
- Per Phase 3 protocol, Task11 ran the exact requested serial suite and typecheck. Main owns the single integrated `pnpm quality` phase gate and review.

## Review Closure

- Independent Task11 review found one Important issue: a Skill output rejected by output-schema validation retained its receipt but persisted `outputHash: null`.
- Added a failing regression that expected the canonical hash of the produced output, then propagated a redacted canonical hash through `SkillOutputSchemaError` and the failed-provenance path. Actor results that fail later during safety or Artifact handling also retain their produced Skill output hash.
- The focused regression passed after the fix; the exact serial suite and typecheck were rerun afterward.

### Phase 3 Integrated Review Wave

- Pending Input confirmation now carries `inputValues` rather than value-less roles. Owner/idempotency-bound gate rows preserve the value, and `LeaseExecutionEngine` applies it only to a cloned in-memory plan after validating every role, target step, actor, and schema field. The immutable persisted plan and canonical hash are never changed.
- Compiler preflight now shares the execution resolver's target invariants, rejects optional Tool binding sources and undeployed fallbacks, requires each task success criterion to be covered by an executable required question, and enforces every frozen high-risk Skill/Tool approval authority.
- Deterministic direct Current plans prepend every required Tool with schema-valid input, remap Skill/reviewer dependencies and bindings, and never call the routed candidate LLM. Resume skip remaps every surviving Pending Input target and rejects targets on the removed step.
- ProblemGraph receipt ID/model/prompt/trace provenance is frozen into every Current plan and revision. Failed Skill capture retains its already-persisted receipt even when configuration reads fail, while Current API and Web execution state preserve `skillProvenance`.
- TDD RED: the exact Phase 3 serial suite reported 115 pass / 39 fail / 1 real-provider skip. GREEN: the same suite reported 154 pass / 0 fail / 1 skip; strict-field adjacent regressions reported 41/41; `pnpm typecheck` passed.
- Phase 5 migration boundary: image `dataUrl` values remain internal gate/actor input under the existing 12 MB API body limit (10 MB upload plus base64 expansion). They are not added to command responses, logs, provenance receipts, or unrelated prompts; Phase 5 must migrate binary payloads to sealed upload Artifacts rather than extend inline transport.


## Phase 3 Final-Gate Closure

- A: Current execution preflight now derives required public-source evidence coverage from the frozen Evidence Policy and registry-qualified real Core Tools; no Tool ID is hardcoded. Direct plans without a required eligible Core Tool fail closed with a generic policy error before side effects.
- B/G: Skill, LLM, and Reviewer prompts/contexts carry `question_ids`, `acceptance_criteria`, `expected_outputs`, `actor_type`, and `actor_id`; verified prior outputs are scoped to declared dependencies/bindings. Direct Skill output pointers derive from the declared output schema, while context-only reviewers have no fabricated `/result` binding.
- C/D: Compiler pending roles require own fields in frozen Skill inputs; confirmation rejects extra `inputValues` before gate writes or state transition; Web upload serialization filters to selected pending roles. Real PostgreSQL confirm-to-execute fixtures preserve explicit asset/role values without changing plan hashes.
- E: Failed Skill provenance reuses the exact verified prior-output context and contract used by dispatch, preserving receipt/prompt/trace/output hashes through capture failures.
- F: PostgreSQL migrations persist `model_version`; candidate and revision transactions lock `control_model_calls` by receipt ID and require `attempt_id IS NULL`, `stage=problem_graph`, `status=succeeded`, and an exact actual-model/version/prompt/trace tuple before any plan insert.
- TDD evidence: RED reproduced pending own-field acceptance and extra-role gate persistence; GREEN exact Phase 3 serial suite reached 165 pass / 1 real-provider skip / 0 fail, with PostgreSQL fixture receipt migrations and offline Current flow covered. `pnpm typecheck` passed after the final engine/preflight changes.