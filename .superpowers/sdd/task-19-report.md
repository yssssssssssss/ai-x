# Task 19 Web、Print 和 Markdown Bundle Renderer

## RED Scenarios

- `tests/report-bundle.test.ts`
  - Requires `createReportBundle` to emit a deterministic ZIP with `report.md`, `assets/`, `evidence-manifest.json`, `visual-assets.json`, `report-review.json`, and `report-document.json`.
  - Requires deterministic, relative asset filenames; Markdown image/comparison references use those paths, and Chart Markdown references the exact owner-read sealed SVG bytes while preserving the Task 17 table alternative and Evidence ids.
  - Excludes `exportPolicy=block` assets before any owner asset-route read and excludes their bytes, Markdown, and metadata from the ZIP.
  - Sanitizes distribution JSON so storage URIs, internal content/Manifest hashes, Artifact provenance, and secrets do not leak; `visual-assets.json` contains only the exportable presentation fields.
  - Produces identical ZIP bytes and lexical entry order regardless of input Manifest order.
  - Rejects `legacy_text`, `current_text`, and incomplete/mismatched multimodal packages before reading any Asset.
  - Requires a pure `ReportDocumentView` view-model mapping with section navigation and Metric/Table/Chart/Image/Comparison/Evidence/Recommendation/Risk render blocks. Chart uses the inline validated `spec` and `table`; image/comparison blocks retain alt text.
  - Requires immutable interaction state for Finding Evidence expansion, original/annotation selection, and image zoom.
  - Requires Print CSS for A4, cover, TOC, fixed header and footer, page breaks, unbroken SVG, repeated table headings, and monochrome differentiation.
  - Requires Stage4 presentation dispatch to select `ReportDocumentView` for multimodal packages while preserving the current text renderer for `legacy_text` and `current_text`.
  - Requires Web/Print table headers to use the sealed `table.columns` exactly once, with one row-header/data-cell association per column; Markdown header, separator, and every data row must have the same sealed column count without a duplicated `Series` header.
- `tests/report-package.test.ts`
  - Cleanly cuts over the API union to required `reportDocument` plus plural `visualAssetManifests: VisualAssetManifest[]` for multimodal packages; no singular alias remains.
  - Keeps `legacy_text` and `current_text` free of Phase 5 fields.
  - Requires `CurrentReportPackageReader` to read a sealed `report_document`, resolve every image and Chart reference through the exact `assetId`/`manifestArtifactId` pair using verified Visual Asset reads, return only the referenced Manifest values, and never downgrade tampered or incomplete documents to `current_text`.
  - Requires the Web package parser to reject missing/empty/mismatched/extra Manifest sets, missing ReportDocument, the obsolete singular alias, and Phase 5 fields on text modes.
  - Requires full VisualAssetManifest schema validation at the Web boundary, including `exportPolicy` and every required field, plus exact Task/Plan/Attempt binding to the multimodal package.
- `tests/lease-execution-engine.test.ts`
  - Requires a pass Review to invoke production-shaped report composition before lease completion, using the exact sealed final Deliverable, Evidence Manifest/resolver, pass Review, required question ids, verified image, and sealed Chart inputs.
  - Uses the real `composeReportDocument`, `VisualAssetService`, SVG Chart renderer, database-backed `ControlArtifactStore`, and `writeJson(activeLease)` to require a `SEALED report_document` Artifact rather than a mock-only document.
  - Reads the completed attempt through the real `CurrentReportPackageReader` and requires the stored image/Chart references to produce the exact ordered plural Manifest set.
  - Requires production discovery of pre-existing attempt materials: the real Task17 `renderAndSealChartSvg` path must first persist and return a SEALED `verified-chart-v1` `chart_spec` Artifact containing exact `spec/specHash/table` plus its `chart_svg` Asset/Manifest references under the same active lease; `discoverAttemptMaterials` then re-reads that production output instead of relying on a test-only manual Chart input write.
  - Requires foreign-bound, checksum-tampered, or unsealed Visual Asset Manifests to fail discovery rather than be ignored or rendered.
  - Requires terminal lease-loss/CAS recovery to invalidate `report_document` together with Evidence Manifest, Deliverable, and Review, leaving no sealed terminal ReportDocument.
- `tests/control-api-integration.test.ts`
  - Extends the production `buildControlRuntime` + real LeaseExecutionEngine/ArtifactStore/DB/API path: even with no visual Assets or Charts, a pass Review must compose and seal the professional text ReportDocument, and the owner API must return `multimodal` with `visualAssetManifests: []`.
  - Verifies the API ReportDocument is the exact value re-read from the `SEALED`, `report-document-v1` Artifact and contains no synthesized visual blocks.

## RED Baseline (Pre-implementation)

The RED assignment added the focused contracts without running commands. Source inspection identified the absent renderer/bundle modules, text-only Stage4 dispatch, incomplete multimodal response union/reader, and permissive Web parser. The `fflate` package and lock entry were already staged before GREEN implementation. These were inspection findings rather than observed command output.

The remaining production wiring RED is after the pass Review transition: `LeaseExecutionEngine` currently moves to `composing_report` and immediately completes without invoking a ReportDocument composition/persistence dependency. Consequently the real control runtime produces no `report_document`, the owner API remains `current_text`, and the reader's current multimodal branch also rejects the valid zero-visual `visualAssetManifests: []` package.

## Implementation Facts

- `CurrentReportPackageResponse` now cleanly separates text packages from multimodal packages. Multimodal requires a `ReportDocument` and plural `visualAssetManifests`; the obsolete singular field is rejected.
- `CurrentReportPackageReader` reads a sealed, schema-versioned ReportDocument and resolves only its ordered exact Asset/Manifest references through the verified Visual Asset reader. Missing or corrupt document/assets fail without text downgrade.
- The Web response parser rejects Phase 5 fields on text modes and rejects incomplete, duplicate, missing, or extra multimodal Manifest sets.
- `ReportDocumentView`, `ImageBlock`, and `ImageComparisonBlock` provide section navigation, all Task19 block mappings, Evidence disclosure, image variant selection and zoom, inline Chart interaction, sealed tables, and authenticated Asset loading.
- `report-print.css` provides A4 cover/TOC/chrome/page-break/table/SVG/monochrome rules. Print uses owner-read sealed Chart SVG while the screen keeps the interactive Chart.
- `createReportBundle` validates the complete package before reads, excludes blocked Assets and metadata, assigns deterministic sanitized relative paths, projects distribution-safe JSON, preserves sealed SVG and table alternatives, and emits lexically ordered deterministic ZIP entries.
- Stage4 dispatches multimodal packages to the professional document and preserves both text renderers. Workbench widens only the multimodal report surface.
- `fflate` was already present in `apps/web/package.json` and `apps/web/pnpm-lock.yaml`; no dependency command was run.

## Verification Status

Per the GREEN assignment constraint, no test, typecheck, build, lint, formatter, browser, dependency, or Git command was run. No GREEN result is claimed and no commit was created.

### First Main-agent Verification Follow-up

- Main-agent verification after adding the root `fflate` devDependency exposed type-only contract mismatches: the Chart fixture expectation omitted its runtime `chartId`, fixture bytes used generic `Uint8Array`, the historical Markdown test constructed an invalid multimodal package through a cast, Stage4 text dispatch deleted fields through incompatible partial casts, two imports had become unused, and ZIP Blob construction retained an `ArrayBufferLike` view.
- The focused source corrections now use Buffer-backed verified fixture bytes, the exact Chart reference shape, a fully typed multimodal Markdown fixture, directly constructed text dispatch values, cleaned imports, and an owned ArrayBuffer for the ZIP Blob.
- No verification command was rerun in this worker assignment, so these corrections carry no GREEN claim.

### Second Main-agent Verification Follow-up

- Main-agent behavior verification reported no failures. Typecheck then isolated one fixture-only `metadata.contentType` widening, while the Web build passed with a 1.37 MB main-chunk warning caused by the static full-ECharts import.
- The fixture metadata now uses the exact `VisualAssetManifest['mediaType']` union. `ChartBlock` keeps its option builders type-only and dynamically imports ECharts inside the effect, with cancellation, ResizeObserver cleanup, and chart disposal on unmount so the engine can be emitted as a separate lazy chunk.
- These follow-up edits were not rerun in this worker assignment; no new GREEN claim is made.

### Production Composition RED Follow-up

- Main-agent production verification observed a real incomplete path: the Control API returned `current_text` and the engine invoked report composition zero times even after a final pass Review.
- `ReportCompositionService` now accepts the engine's re-read sealed final Deliverable, Evidence Manifest, pass Review, Evidence resolver, verified visuals/Charts, and active lease. It re-verifies supplied visual bytes through `VisualAssetService`, composes the Task18 document, and seals `report_document` at `reports/report-document.json` with schema `report-document-v1`.
- `LeaseExecutionEngine` invokes the injected composition port exactly after a completed pass Review and the `reviewing -> composing_report` transition, while the lease is active. Production runtime wires the real ArtifactStore and VisualAssetService implementation.
- A professional document with no visual references is now still `multimodal` with the exact empty `visualAssetManifests: []`; reader, Web parser, and bundle share this set rule. Referenced image/Chart documents still require their exact ordered verified Manifests.
- No command was run after this production writer implementation in this worker assignment; no GREEN claim is made.

### Production Composition Verification Follow-up

- Main-agent full Task19 behavior verification observed 121 total: 120 pass, 1 existing skip, and 0 failures. The Web build passed with a 242 KB main chunk and ECharts emitted as a separate lazy chunk warning.
- Typecheck isolated one test-query boundary where PostgreSQL row `reportDocumentArtifact.id` remained `unknown`; the integration assertion now explicitly narrows it to `string` before the verified Artifact read.
- No command was rerun after this final narrowing in the worker assignment.

### Final Automated and Browser Evidence

- Main-agent automated evidence: Task19 six-file suite 121 total / 120 pass / 1 existing skip / 0 fail; focused production writer 2/2; `pnpm typecheck` passed; Web build passed with a 242 KB main chunk and a separate lazy ECharts chunk.
- Main-agent browser component evidence at 1280×800 and 1440×900: the report rendered; `#comparison` navigation worked; Finding Evidence `e1`/`e2` expanded; image zoom reached 125%; the interactive Chart and one table rendered.
- Print evidence: report actions and the interactive Chart were hidden, the sealed SVG was shown, and `thead` computed as `table-header-group`.

### Separate Gateway Blocker

- The real Gateway clarification path persisted `ambiguities=[]` while the Task remained `awaiting_clarification`; a clarification retry returned HTTP 500. This blocks a fresh real-task journey before Task19, but is not a Task19 package, renderer, print, bundle, or composition failure.
- No commit was created.

### Reviewer Blocker Fix Follow-up

1. `ReportCompositionService.discoverAttemptMaterials` deterministically enumerates the exact Task/Plan/Attempt report-material kinds, rejects live non-SEALED or foreign/tampered values, re-reads each Manifest through `ControlArtifactStore` and `VisualAssetService`, and reconstructs Charts only from sealed `verified-chart-v1` inputs whose ChartSpec hash, table, `chart_svg` derivation, and original-asset lineage match. `LeaseExecutionEngine` passes those verified visuals and Charts into `composeAndStore`.
2. Terminal invalidation now fails `report_document` together with Evidence Manifest, Deliverable, and Review after lease loss or completion CAS failure.
3. The Web response parser validates every required VisualAssetManifest field, exact allowed fields, scalar ranges, explicit media/export enums, source/derivation/lineage structure, SVG derivation rule, exact referenced Asset set, and Deliverable Task/Plan/Attempt binding before casting.
4. `createReportTableShape` is a pure exported mapper that consumes the complete sealed `table.columns` once, emits unique column/row ids and explicit `headers` associations, and rejects row/header width mismatches; `ChartBlock` follows the same complete-column rule.
5. Markdown uses `table.columns` directly, emits equal header/separator/data column counts, and no longer prepends a duplicate `Series` column.

### Reviewer Fix Final Evidence

- Main-agent verification of the lease execution, report package, report bundle, and ControlPlane suites observed 130 total / 129 pass / 1 existing provider skip / 0 fail.
- `pnpm typecheck` passed. The Web production build passed with a 246 KB main chunk and ECharts retained as a lazy chunk.
- This documentation-only sync ran no production, test, validation, browser, dependency, or Git command. No commit was created.

### Production Chart Publication Follow-up

- Task17 now publishes the production `chart_spec` material consumed by `discoverAttemptMaterials`: a SEALED `verified-chart-v1` JSON Artifact with exact Task/Plan/Attempt binding, canonical `specHash`, exact table, and the matching `chart_svg` Asset/Manifest reference.
- The same active lease is propagated to the SVG binary, Visual Asset Manifest, and Chart JSON writes. A non-SEALED or misbound Chart JSON result fails before an Artifact id is returned.
- Chart identity remains in `spec.chartId` with no redundant top-level alias, matching the existing Task19 `PersistedVerifiedChart` consumer.
- Main-agent verification observed the chart-renderer + lease-execution-engine suite at 48 total / 47 pass / 1 existing provider skip / 0 fail; `pnpm typecheck` passed. This closes the Task19 production Chart discovery gate. This worker ran no validation command or commit.
