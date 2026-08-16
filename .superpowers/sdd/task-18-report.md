# Task 18 ReportDocument and Professional Template Composer

## RED Scenarios

- `tests/report-document.test.ts`
  - Rejects a ReportDocument without a non-empty `executiveSummary`.
  - Rejects every `fact` block whose `evidenceIds` list is empty.
  - Rejects dangling visual Asset and Chart references against the verified reference context.
  - Rejects duplicate section ids and duplicate block ids, including duplicates across sections.
  - Rejects a required question that is not assigned to any ReportDocument section.
  - Rejects a Review whose verdict is not `pass` and a passed Review bound to a different Deliverable Artifact.
  - Rejects Deliverable, Evidence Manifest, Visual Asset, Chart Manifest, or Review inputs whose Artifact is not `SEALED`.
  - Rejects a Chart Spec whose sealed `chart_svg` Visual Asset derivation names a different Chart id.
  - Omits image, image-comparison, and chart blocks when no verified visual data exists; it must not synthesize placeholder content.
  - Composes the professional `research-plan` template in the required order: `cover`, `executive-summary`, `background`, `scope-method`, `key-metrics`, `findings`, `question-analysis`, `visual-evidence`, `comparison`, `conclusion`, `recommendations`, `risks`, `appendix`.
  - Requires the happy-path document to pass the ReportDocument schema and semantic reference validation, cover every required question, keep every Fact bound to Evidence, and carry the exact sealed Asset/Manifest and Chart/Asset/Manifest references needed by Task 19.

## Implementation Facts

- Added strict `report-document-v1` schema coverage for the document, sections, typed content blocks, non-empty executive summary, and Evidence-bearing Fact/Metric blocks.
- Added the fixed `research-plan` template and a strict config-loader entry that rejects unsafe template ids, unknown fields, malformed values, and any section order other than the required 13-section policy.
- Added typed `composeReportDocument` and `assertValidReportDocument` contracts. Composition requires Task/Plan/Attempt-bound SEALED Deliverable, Evidence Manifest, Visual Asset/Manifest, chart SVG Asset/Manifest, and passed Review inputs; the Review must bind the exact final Deliverable Artifact.
- Visual verification binds bytes, media metadata, Asset identity, Manifest identity/self-hash, export policy, and chart derivation to the sealed SVG. Chart lineage must resolve to one of the verified source Visual Assets supplied to composition.
- Semantic document validation enforces globally unique section/block ids, required-question assignment, Evidence references, and exact Asset/Chart references. The composer emits image and chart references for downstream package/print/Markdown consumers and emits no visual blocks or placeholder content when visual inputs are absent.
- Main-agent final verification observed `pnpm exec tsx --test tests/report-document.test.ts tests/current-report-markdown.test.ts` at 15/15 pass and `pnpm typecheck` passed after the minimal RED-fixture `ReportDocument['sections']` annotation. The Task17 chart-to-ReportDocument producer gate is closed: composed Chart blocks carry the sealed Chart/Asset/Manifest references required downstream. Task19 Stage4, Markdown bundle, and Print rendering remain pending.
- This worker ran no command and made no commit.
