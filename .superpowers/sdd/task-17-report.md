# Task 17 Chart Spec、Evidence Validation、SVG Renderer

## RED Scenarios

- `tests/chart-spec.test.ts`
  - Rejects unsupported chart types.
  - Rejects series value and per-point Evidence arrays whose lengths differ from the category count.
  - Requires at least one Evidence id for every non-null numeric point.
  - Rejects dangling Evidence ids and numeric values that do not match the resolved Evidence value.
  - Uses a deterministic manifest created by the real `EvidenceService`; Chart Evidence resolution delegates to `EvidenceService.resolveEvidenceValue` and its sealed Artifact/hash/JSON Pointer checks.
  - Preserves missing values as `null`, including an empty Evidence list, and proves they are not coerced to zero.
  - Rejects misleading non-zero baselines and zero-baseline comparison/trend charts containing any negative non-null value that would be clipped; negative heatmap values remain valid because heatmap semantics are unchanged.
  - Accepts Evidence-bound comparison, trend, and heatmap specs.
- `tests/chart-renderer.test.ts`
  - Requires deterministic standalone SVG output with no `script`, `foreignObject`, remote `href`/`src`, or remote CSS `url(...)` content.
  - Requires colors derived from stable actor/competitor keys rather than series order.
  - Requires a tabular text alternative carrying the exact values and per-cell Evidence ids.
  - Preserves `null` in the tabular alternative rather than presenting a fabricated zero.
  - Exercises the real `VisualAssetService`: the server SVG must be SEALED as `image/svg+xml`, retain immutable original lineage, and record `{ kind: 'chart_svg', chartId }` derivation metadata.
  - Requires `renderAndSealChartSvg` to accept a verified Evidence resolver and validate the supplied spec before calling `VisualAssetService.derive`; mismatched values and dangling Evidence must leave derive uncalled.
  - Requires the real seal path to publish a SEALED `chart_spec` JSON Artifact with schema `verified-chart-v1`, exact Task/Plan/Attempt binding, exact `spec`/`specHash`/table and sealed SVG Asset/Manifest references, return its Artifact id, propagate the same active lease to all writes, and reject an unsealed Chart Artifact.
- No Web component test was added. The Web workspace has no existing component-test convention or test dependencies, and the RED assignment permits a focused Web test only when those conventions already exist.
- Stage4 report/package/Web consumption is a cross-task gate owned by Tasks 18/19. No wiring test is added to Task17.

## RED Baseline Before Implementation

- `apps/orchestrator-runtime/src/report/chart-spec-validator.ts` was absent, so the Chart Spec suite's expected failure was the missing validator module/API (`ChartSpec`, `ChartEvidenceResolver`, `ChartSpecValidationError`, and `validateChartSpec`).
- `apps/orchestrator-runtime/src/report/chart-renderer.ts` was absent, so the renderer suite's expected failure was the missing renderer module/API (`renderChartSvg`, `stableChartColor`, and `renderAndSealChartSvg`).
- The Task16 Visual Asset contract at that baseline permitted only raster media and `annotation`/`heatmap` derivations, so SVG sealing also required a production contract extension.
- The RED authoring assignment ran no tests, typecheck, lint, build, formatter, dependency installation, production edit, or commit.

## Reviewer Fixes GREEN

- `renderAndSealChartSvg` now requires a `ChartEvidenceResolver` and calls `validateChartSpec` before rendering or invoking `VisualAssetService.derive`; mismatched and dangling Evidence therefore fail before any derive call.
- `validateChartSpec` now rejects negative non-null comparison/trend values when `yAxis.min` is zero, while preserving negative heatmap values.
- Tasks 18/19 now own and implement ReportDocument/package/Stage4 consumption; this Task17 follow-up supplies their production-discoverable sealed Chart input rather than duplicating presentation logic.

## Cross-Task Persisted Chart Implementation

- `renderAndSealChartSvg` now requires an Artifact JSON writer and active lease, propagates that lease to the derived SVG binary, its Visual Asset Manifest, and the Chart input JSON write, and returns `chartSpecArtifactId`.
- After Evidence validation, rendering, and `chart_svg` derivation, it writes the exact Task/Plan/Attempt-bound `verified-chart-v1` payload containing `spec`, canonical `specHash`, table alternative, and the sealed SVG Asset/Manifest reference at `charts/<encoded-chart-id>.json`.
- The Chart JSON result must be `SEALED` with kind `chart_spec`, schema `verified-chart-v1`, and the exact binding; any mismatch fails closed. Chart identity remains solely in the existing `spec.chartId` field rather than a redundant top-level alias.
- `VisualAssetService.derive` accepts an optional active lease and forwards it to both binary and Manifest writes; non-leased existing callers remain unchanged.

## Implementation Facts

- Added the strict `chart-spec-v1` schema and shared Chart Spec contract for comparison, trend, and heatmap charts.
- `validateChartSpec` applies schema validation, exact category/value/Evidence-array lengths, unique series keys, required per-value Evidence, resolved Evidence/value equality, null preservation, non-zero-baseline rejection, and negative-value rejection for zero-baseline comparison/trend charts.
- The server renderer uses ECharts SVG SSR with animation disabled, stable key-derived colors, deterministic local SVG id normalization, executable/remote-content rejection, and an exact Evidence-bearing tabular alternative.
- `renderAndSealChartSvg` validates its raw spec with the supplied Evidence resolver before render or derive, computes one canonical `specHash`, seals the SVG through `VisualAssetService` with immutable original lineage and `{ kind: 'chart_svg', chartId, specHash }` metadata, then seals the matching `chart_spec` JSON Artifact under the same lease.
- The Task16 binary/Manifest contract now accepts `image/svg+xml` only through an explicit trusted-media write used by `chart_svg`; ordinary user upload and remote ingestion paths retain raster-only binary inspection.
- `ChartBlock` uses the ECharts SVG renderer, resizes with its container, disposes the instance on unmount, derives colors from stable series keys, and renders a semantic table preserving exact values, nulls, and Evidence ids. Task19 consumes it for interactive multimodal report presentation while Print/Markdown use the sealed SVG/table.
- Final main-agent verification after the reviewer fixes observed `pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts` at 19/19 pass and `pnpm typecheck` passed. This worker ran no validation command or commit.
- Main-agent verification after the persisted-Chart implementation observed the chart-renderer + lease-execution-engine suite at 48 total / 47 pass / 1 existing provider skip / 0 fail; `pnpm typecheck` passed. This worker ran no validation command or commit.
