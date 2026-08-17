# Phase 5 Final Integrated Review

## RED Scenarios

1. **Hydrated clarification assumptions are unchanged values**
   - `tests/requirement-refinement-service.test.ts` requires a finalized active Requirement to resume planning when `assumption_edits` contains the same editable key/value pairs hydrated from that Requirement. The recovery must not create Requirement v3 or invoke the requirement LLM again.
   - `tests/control-api-integration.test.ts` extends the real PostgreSQL/API refresh recovery with the exact hydrated editable assumption map and preserves the existing two-Requirement/two-Plan/LLM-call assertions.
2. **Multimodal package replay revalidates Chart integrity**
   - `tests/report-package.test.ts` uses a valid Evidence-bound Chart fixture, then independently requires rejection of a ChartSpec value that disagrees with verified Evidence, a ReportDocument `specHash` that disagrees with the verified `chart_svg` Manifest, and a sealed table that disagrees with its ChartSpec.
   - `tests/report-package.test.ts` also builds a schema-valid sealed image-comparison from two exact same-attempt verified Assets. The valid pair is accepted only when the `after` Manifest is an `annotation` whose `derivedFrom` asset id, Manifest Artifact id, content hash, and Manifest hash exactly equal the `before` Asset/Manifest; an unrelated image and each tampered lineage field must be rejected.
3. **Annotation lineage is composed for the production view**
   - `tests/report-document.test.ts` supplies a sealed derived annotation whose `derivedFrom` exactly names the original image, requires one `image-comparison` block with the original/annotation order, and maps that block through production `createReportDocumentViewModel`.
4. **Blocked discovery material is not composable**
   - `tests/lease-execution-engine.test.ts` ingests a real `exportPolicy=block` screenshot through `VisualAssetService` and requires production discovery to return no visible visual material without aborting.
5. **Bundle Evidence text is distribution-safe**
   - `tests/report-bundle.test.ts` requires both `report-document.json` and `report.md` to retain the safe Evidence id and human-readable class while removing internal Artifact ids and provenance embedded in an appendix list item.
6. **Multimodal package replay revalidates image-comparison lineage**
   - `tests/report-package.test.ts` requires the verified after Manifest to be an annotation whose `derivedFrom` asset id, Manifest Artifact id, content hash, and Manifest hash exactly identify the verified before Asset/Manifest; an unrelated image or any single-field lineage tamper must be rejected.


## Integrated Production Fixes (unverified)

1. Hydrated `assumption_edits` whose editable key/value pairs equal the active finalized Requirement are normalized as unchanged and reuse the existing latest-version recovery path; genuinely changed values remain on normal refinement.
2. Multimodal replay rebuilds Chart Evidence resolution from verified Evidence Artifacts, revalidates ChartSpec values, requires ReportDocument/verified `chart_svg` Manifest `specHash` and `chartId` equality, checks the sealed table against the deterministic table alternative, and runs full ReportDocument semantic validation before return.
3. Composer validates annotation `derivedFrom` against the exact verified original and emits an original-first `image-comparison` block without a duplicate standalone annotation block; package replay independently requires the verified after annotation's complete lineage tuple to match the verified before Asset/Manifest.
4. Production material discovery still verifies blocked assets for internal lineage needs but excludes `exportPolicy=block` assets from composer-visible visual and Chart projections.
5. Bundle JSON and Markdown rebuild Evidence list content from the verified Manifest's safe id/class projection, removing internal Artifact/model/provenance metadata without applying broad text rewriting to report prose.

## Progress

- Main previously observed the six-file Phase 5 integrated suite at 137 total / 136 pass / 1 existing provider skip / 0 fail; after the pure ReportDocument view-model extraction, the focused report-document + report-bundle suite was 32/32 and the Web production build passed.
- After the additional verified image-comparison lineage replay correction, Main observed `report-package` at 43/43 and `pnpm typecheck` passed.
- Final Phase 5 re-review remains pending; no phase-complete/final-approval or commit claim is made.
