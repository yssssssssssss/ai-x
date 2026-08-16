# Task 25 Report

## Scope

Implemented the honest five-profile Current real-provider smoke runner and corrected its TypeScript contracts.

## Delivered

- Exported `runCurrentRealSmoke({ fixturePath, profiles })` from `scripts/current-real-smoke.ts`.
- Each requested profile is loaded from the semantic Gold fixture and executed through the real RequirementRefinement, Current planning persistence, workflow selection/confirmation/execution, sealed Evidence/Deliverable package, and report-review path.
- Receipt identity is sourced from the executed Task, Plan Version, Attempt, Deliverable Package, and Evidence Manifest; identity mismatches fail closed.
- Receipt gates require Gateway provider/model pin, real Tavily core Tool provenance, sealed artifacts, passed independent report review, HTTPS evidence, positive finding/recommendation counts, and finite Tool latency. Secret and raw-input fields are not emitted.
- Confirmation uses `ResearchTaskV2.clarification_questions` and `inputValues`, avoiding legacy `ResearchTaskData`/`inputRoles` typing.
- CLI remains single-profile via `CURRENT_SMOKE_PROFILE`; the exported runner supports the five-profile suite and closes the database in `finally`.
- Real smoke tests skip only when the complete command-level provider configuration is absent or does not match the required real gate; no runner invocation occurs in that case.

## Verification status

Per assignment constraints, no validation command was run and no real-provider success is claimed. No commit was created.
