# Phase 6 Final Integrated Review

## RED Scenarios

1. **Evidence Policies must be achievable by the production collector**
   - `tests/multi-deliverable-contract.test.ts` builds a fully validated `EvidenceManifest` through `EvidenceService` and requires every configured task/deliverable pair's required policy minimum to be satisfiable by the collector class.
   - `tests/lease-execution-engine.test.ts` runs one real core Tool path, requires a SEALED same-Task/Plan/Attempt Manifest, then applies every production Evidence Policy to the classes actually emitted by that collector path.
   - Expected RED: VOC, design-audit, and accessibility policies accept only classes the current collector does not emit, so both the policy assertions and the real collector Manifest matrix expose the mismatch.

2. **Professional payloads must survive ReportDocument composition**
   - `tests/report-document.test.ts` composes all four professional payload fixtures and requires task-specific values in the template sections that name those dimensions.
   - Competitive retains matrix/differences, impacts, prioritized actions, and screenshot comparison captions; VOC retains themes, representative quotes, severity, and priority; design audit retains issues, annotation text, remediation, and retest; accessibility retains POUR/component findings, screen-reader behavior, remediation, and verification.
   - Expected RED: the composer currently projects only the generic finding graph/recommendations and research-plan payload fields, so the unique professional payload values are absent.

3. **Localized expected deliverables must be canonicalized at the understanding/planning boundary**
   - `tests/requirement-refinement-service.test.ts` supplies Chinese LLM labels for all five task types and requires the canonical Registry id before persistence and planner invocation. Existing explicit and hydrated-recovery fixtures also expect canonical `competitive_analysis_report`. Initial understanding keeps exactly one Requirement row; clarification keeps exactly v1/v2, with every returned, stored, and planned task remaining `research-task-v2`.
   - `tests/multi-deliverable-contract.test.ts` requires direct current planning to normalize the same five localized labels before strict Registry resolution.
   - The strict Registry resolver is separately required to reject arbitrary external labels; normalization is a task-type boundary operation, not fuzzy Registry matching.
   - Expected RED: refinement persists localized labels unchanged, while direct planning rejects them as incompatible.

4. **Task-specific visual references must be restricted to the verified attempt inventory**
   - `tests/multi-deliverable-contract.test.ts` covers competitive `screenshotComparisons` and design `annotatedScreenshots`.
   - Generation must reject referenced ids absent from the supplied verified inventory after the LLM returns but before any Artifact write/seal, reject a supplied inventory item with a foreign Task, Plan, or Attempt binding before LLM invocation, accept the exact same binding tuple, and expose only verified ids in synthesis prompt/context. The lease pass-Review fixture derives and re-verifies a real PNG annotation with exact original lineage, binds its competitive screenshot comparison to the verified original/annotation Asset ids, keeps the verified chart separate for Chart block assertions, and rewrites every competitive payload/finding Evidence reference to the exact collected Manifest id before sealing. Its final document must contain the exact original→annotation image-comparison and chart without duplicating either paired image as a standalone block; the completion assertion serializes the execution result as its failure diagnostic without changing the expected status.
   - Generic professional generation supplies an empty inventory only for non-visual VOC/A11y and exact same-binding original+annotation pairs for competitive/design; the payload Asset references match those pairs.
   - Expected RED: `CurrentDeliverableService` currently has no verified visual inventory input or payload-reference validation and does not provide a verified-id allowlist to synthesis.

5. **Persisted plan execution must honor the declared historical deliverable contract**
   - `tests/multi-deliverable-contract.test.ts` executes a persisted `competitive_research` requirement whose selected plan declares `research_plan`, and asserts the `research_plan` contract plus its `public-market-evidence` policy; a newly compiled competitive plan must still resolve to `competitive_analysis_report`.
   - Expected RED: execution remaps the persisted plan by task type, selecting `competitive_analysis_report` or rejecting before the declared `research_plan` contract is consumed.

6. **Visual Evidence Policy and payload schema must agree when no visual inventory exists**
   - `tests/multi-deliverable-contract.test.ts` runs competitive generation with an explicit empty visual inventory and requires a clear visual preflight failure before LLM invocation or Artifact sealing.
   - Expected RED: the public-source-only collector reaches a payload that requires screenshot references, invents or accepts impossible Asset ids, and only fails after synthesis or sealing.

7. **Visual references must carry typed source and lineage roles**
   - `tests/multi-deliverable-contract.test.ts` requires competitive screenshot comparisons to contain an exact original/annotation pair, design `annotatedScreenshots` to reference an annotation whose `derivedFrom` is the exact original, and rejects raw-source or foreign-bound inventory before LLM/seal while accepting the exact pair.
   - Expected RED: ID-only allowlisting accepts an original without its annotation, a raw source as a deliverable visual, or an annotation with the wrong lineage role.

 
## Integrated Production Fixes

1. Required VOC, design-audit, and accessibility Evidence Policies retain their specialized accepted classes and now also accept the production collector's factual `public_source` class.
2. `ReportDocument` composition deterministically projects every professional payload contract into its named template sections: facts/lists/metrics/actions; payload-captioned competitive visuals pair each verified annotation with its exact payload-listed original by Asset/Manifest/hash lineage and omit duplicate standalone rendering; design annotation comparisons retain the same exact lineage requirement.
3. Server-owned `canonicalizeExpectedDeliverables()` validates the LLM-provided list and maps it through the task type's unique active Registry entry to one canonical id. Requirement understanding, clarification, legacy requirement planning, and Current direct planning all canonicalize before persistence, messages, or planner invocation; no natural-language label is added as a Registry alias, and the public resolver remains strict.
4. `LeaseExecutionEngine` performs one verified same-Task/Plan/Attempt visual-material discovery before Deliverable synthesis, passes the exportable Asset allowlist to `CurrentDeliverableService`, and reuses that same discovery result for post-Review composition. Synthesis context contains only verified ids; foreign inventory bindings fail before LLM invocation, and generated competitive/design payload references fail before Artifact sealing unless present in the allowlist. Design composition additionally requires exact annotation-to-original lineage.

5. Final-review follow-up hardens the boundary: a persisted plan ID wins only when its declared deliverable is supported by the persisted expectedDeliverables; typed visual inventory validation rejects raw/foreign roles before synthesis, requires competitive original-plus-annotation or design annotation lineage, and checks generated references before sealing. This follow-up was production-edited without new validation evidence.

6. Deliverable resource resolution selects exactly one Evidence Policy by `(task_type, deliverable_type)`. Canonical task mappings still require the Registry `evidence_policy` requirement id; persisted `competitive_research` plans explicitly declaring `research_plan` use the unique historical `public-market-evidence` policy without adding aliases or duplicate policy entries. This production correction has no new validation evidence.
7. Phase6 test fixtures now provide one shared exact-lineage annotation builder and same-binding original+annotation pairs for generic professional and visual-reference cases; duplicate helper drift and nullable binding fixture values were removed. No new validation evidence is claimed.

## Verification Status

Main observed the final Phase 6 integrated suite at 127 total / 126 passed / 1 existing provider skip / 0 failed. `pnpm typecheck`, Registry linter, and Knowledge linter passed. The final competitive projection correction pairs payload-listed original and annotation Assets by exact Asset/Manifest/content-hash/Manifest-hash lineage, emits one payload-captioned image comparison, and does not duplicate the paired annotation as a standalone image. No commit has been created; this evidence is recorded without a pre-commit GREEN or phase-complete claim.

8. Legacy compatibility correction (2026-08-17): `CurrentDeliverableService` and `LeaseExecutionEngine` now treat structured tasks as Registry v2 only when `version === 'research-task-v2'`. Legacy `ResearchTaskData` with task-type-only input resolves the persisted `plan.deliverable_type` through the historical exact Evidence Policy/Registry contract; v2 still rejects missing or malformed paired `task_type`/`expected_deliverables`, with no broad fallback for malformed v2. This was a production edit only; no tests, typecheck, lint, build, formatter, or commit was run.
9. Legacy/current package compatibility correction (2026-08-17): Report Package reads now preserve binding, evidence, historical-marker, and Review error ordering without applying selected Registry payload schemas; payload schema validation is explicit for genuine v2 deliverable generation only. Shared CurrentDeliverable success fixtures now carry complete canonical v2 selection metadata, while malformed v2 RED fixtures remain fail-closed. Production and stale-fixture edits only; no tests, typecheck, lint, build, formatter, or commit was run.


## Focused 14-failure canonical Registry sweep (2026-08-17)

- The fresh quality log exposed 14 failures, all attributable to stale Phase6 Registry assumptions rather than a confirmed production regression: research-plan fixtures used `competitive_research`, revision fixtures expected the pre-cutover candidate/resource shape, nonresearch Composer fixtures supplied research-plan payload blocks, generic optional/provenance fixtures selected competitive evidence requirements, and policy assertions assumed one mapping.
- Updated stale fixtures in `tests/control-planning-service.test.ts`, `tests/current-revision-integrity.test.ts`, `tests/deliverable-registry-v2.test.ts`, `tests/lease-execution-engine.test.ts`, and `tests/research-plan-deliverable.test.ts`. Canonical planning fixtures now use `user_research_planning`/`research_plan`; explicit competitive and historical compatibility cases remain competitive.
- Registry policy coverage now distinguishes the five canonical active mappings from the retained historical `competitive_research → research_plan` policy. Composer fixtures use a complete competitive payload and same-binding verified visual assets; optional retry expectations preserve the existing retry contract.
- Validation was intentionally not run for this sweep; no production regression was confirmed and no commit was created.

## Follow-up stale-fixture correction (artifact 2161, 2026-08-17)

- Canonicalization returns the Registry id in `ResearchTaskV2.expected_deliverables`; the planning and revision fixtures now use `['research_plan']` rather than the localized `['研究计划']` label while retaining `user_research_planning`.
- Nonresearch Composer fixtures now construct sealed visual Assets with real byte/content hashes, canonical Manifest hashes, sealed Manifest Artifact digests, and a same-binding `readVerified` reader for the composition-service path.
- The follow-up is fixture-only; no production change, validation command, or commit was made.