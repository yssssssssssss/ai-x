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
  - Uses production-realistic Visual Asset Manifest fixtures whose canonical `manifestHash` intentionally differs from the SHA-256 of the pretty-printed JSON Artifact bytes; composition must accept the valid pair and reject a tampered serialized Manifest Artifact hash or byte size.
  - Binds the supplied Deliverable, Evidence Manifest, and Review values to the exact `JSON.stringify(value, null, 2)` bytes sealed by `ControlArtifactStore.writeJson`; changing any value while retaining its SEALED Artifact must fail before composition.
  - Resolves Chart Evidence to the real numeric value and requires Task 17 `validateChartSpec` semantics; a mismatched value is rejected even when the attacker rebinds the SVG Manifest to that changed spec, and a different spec reusing the same `chartId` is rejected by the immutable canonical `specHash` binding.
  - Requires every ReportDocument chart block and schema to carry the validated ChartSpec, canonical `specHash`, and Task 17 tabular text alternative so Task 19 can render `ChartBlock` and its Evidence-linked accessible table without recomputation.
  - Extends `ReportDocumentReferenceContext.charts` with the `specHash` read from the verified `chart_svg` Manifest and rejects a chart block whose inline Spec, digest, and table agree with each other but diverge from that sealed Manifest lineage.
  - After exact sealed-JSON verification, requires composition to reuse `EvidenceService.validateManifest`, `assertValidReportReviewArtifact`, the frozen research-plan payload schema, and `ReportEvidenceValidator`; resealed invalid JSON pointers/Artifact hashes, schema-invalid pass dimensions, malformed Deliverable envelope provenance, invalid payload values, and invalid report graph bindings must still reject.
  - Rejects split Evidence resolution: even when an independent Chart resolver returns `12` and the ChartSpec, `specHash`, sealed SVG lineage, and table consistently claim `12`, the verified Evidence Manifest plus Artifact resolver resolves the same Evidence id to `87`; composition must derive Chart validation from that verified path rather than trust the independent resolver.

## Implementation Facts

- Added strict `report-document-v1` schema coverage for the document, sections, typed content blocks, non-empty executive summary, and Evidence-bearing Fact/Metric blocks.
- Added the fixed `research-plan` template and a strict config-loader entry that rejects unsafe template ids, unknown fields, malformed values, and any section order other than the required 13-section policy.
- Added typed `composeReportDocument` and `assertValidReportDocument` contracts. Composition requires Task/Plan/Attempt-bound SEALED Deliverable, Evidence Manifest, Visual Asset/Manifest, chart SVG Asset/Manifest, and passed Review inputs; the Review must bind the exact final Deliverable Artifact.
- Visual verification binds bytes, media metadata, Asset identity, Manifest identity/self-hash, export policy, and chart derivation to the sealed SVG. Chart lineage must resolve to one of the verified source Visual Assets supplied to composition.
- Semantic document validation enforces globally unique section/block ids, required-question assignment, Evidence references, and exact Asset/Chart references. The composer emits image and chart references for downstream package/print/Markdown consumers and emits no visual blocks or placeholder content when visual inputs are absent.
- Main-agent final verification after the resolver-split fix observed `pnpm exec tsx --test tests/report-document.test.ts tests/chart-spec.test.ts tests/chart-renderer.test.ts tests/current-report-markdown.test.ts` at 44/44 pass and `pnpm typecheck` passed.
- Reference-context Chart identity includes Manifest-sourced `specHash`, post-seal Evidence/Review/payload/report validators are reused, and Chart value validation now has exactly one authority: the verified Evidence Manifest entry resolved through the sealed Artifact resolver. The independent Chart resolver has been removed from the production composition contract.
- Final focused Task18 re-review is pending. Task19 renderer consumption remains pending. This worker ran no command and made no commit.
