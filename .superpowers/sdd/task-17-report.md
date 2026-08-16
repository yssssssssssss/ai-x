# Task 17 Chart Spec、Evidence Validation、SVG Renderer

## RED Scenarios

- `tests/chart-spec.test.ts`
  - Rejects unsupported chart types.
  - Rejects series value and per-point Evidence arrays whose lengths differ from the category count.
  - Requires at least one Evidence id for every non-null numeric point.
  - Rejects dangling Evidence ids and numeric values that do not match the resolved Evidence value.
  - Uses a deterministic manifest created by the real `EvidenceService`; Chart Evidence resolution delegates to `EvidenceService.resolveEvidenceValue` and its sealed Artifact/hash/JSON Pointer checks.
  - Preserves missing values as `null`, including an empty Evidence list, and proves they are not coerced to zero.
  - Rejects misleading non-zero baselines for comparison and trend charts.
  - Accepts Evidence-bound comparison, trend, and heatmap specs.
- `tests/chart-renderer.test.ts`
  - Requires deterministic standalone SVG output with no `script`, `foreignObject`, remote `href`/`src`, or remote CSS `url(...)` content.
  - Requires colors derived from stable actor/competitor keys rather than series order.
  - Requires a tabular text alternative carrying the exact values and per-cell Evidence ids.
  - Preserves `null` in the tabular alternative rather than presenting a fabricated zero.
  - Exercises the real `VisualAssetService`: the server SVG must be SEALED as `image/svg+xml`, retain immutable original lineage, and record `{ kind: 'chart_svg', chartId }` derivation metadata.
- No Web component test was added. The Web workspace has no existing component-test convention or test dependencies, and the RED assignment permits a focused Web test only when those conventions already exist.

## RED Baseline Before Implementation

- `apps/orchestrator-runtime/src/report/chart-spec-validator.ts` was absent, so the Chart Spec suite's expected failure was the missing validator module/API (`ChartSpec`, `ChartEvidenceResolver`, `ChartSpecValidationError`, and `validateChartSpec`).
- `apps/orchestrator-runtime/src/report/chart-renderer.ts` was absent, so the renderer suite's expected failure was the missing renderer module/API (`renderChartSvg`, `stableChartColor`, and `renderAndSealChartSvg`).
- The Task16 Visual Asset contract at that baseline permitted only raster media and `annotation`/`heatmap` derivations, so SVG sealing also required a production contract extension.
- The RED authoring assignment ran no tests, typecheck, lint, build, formatter, dependency installation, production edit, or commit.

## Implementation Facts

- Added the strict `chart-spec-v1` schema and shared Chart Spec contract for comparison, trend, and heatmap charts.
- `validateChartSpec` applies schema validation, exact category/value/Evidence-array lengths, unique series keys, required per-value Evidence, resolved Evidence/value equality, null preservation, and zero-baseline checks for comparison and trend charts.
- The server renderer uses ECharts SVG SSR with animation disabled, stable key-derived colors, deterministic local SVG id normalization, executable/remote-content rejection, and an exact Evidence-bearing tabular alternative.
- `renderAndSealChartSvg` derives the checked SVG through `VisualAssetService` with immutable original lineage and `{ kind: 'chart_svg', chartId }` metadata.
- The Task16 binary/Manifest contract now accepts `image/svg+xml` only through an explicit trusted-media write used by `chart_svg`; ordinary user upload and remote ingestion paths retain raster-only binary inspection.
- `ChartBlock` uses the ECharts SVG renderer, resizes with its container, disposes the instance on unmount, derives colors from stable series keys, and renders a semantic table preserving exact values, nulls, and Evidence ids.
- Main-agent verification observed: `pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts` => 15/15 pass; `pnpm typecheck` passed; `pnpm --dir apps/web build` passed. This worker ran no validation commands or commit.
