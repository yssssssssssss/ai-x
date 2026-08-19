import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type {
  ChartSeries,
  ChartSpec,
  VisualAssetExportPolicy,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  ArtifactInvalidationError,
  mergeArtifactInvalidationErrors,
  type ArtifactPublicationGroup,
} from '../control/artifact-publication-group.ts';
import {
  ArtifactIntegrityError,
  type ControlArtifactStore,
} from '../control/artifact-store.ts';
import type { VisualAssetService, VisualAssetResult } from './visual-asset-service.ts';
import {
  chartSpecHash,
  validateChartSpec,
  type ChartEvidenceResolver,
} from './chart-spec-validator.ts';

export interface ChartTableAlternative {
  caption: string;
  columns: string[];
  rows: Array<{
    key: string;
    label: string;
    cells: Array<number | null>;
    evidenceIds: string[][];
  }>;
}

export interface RenderedChartSvg {
  svg: string;
  table: ChartTableAlternative;
}

export class ChartRendererUnavailableError extends Error {
  constructor(readonly rendererCause: unknown) {
    super('Chart renderer is unavailable');
    this.name = 'ChartRendererUnavailableError';
  }
}

interface ChartDimensions {
  width: number;
  height: number;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hueToHex(hue: number): string {
  const saturation = 0.68;
  const lightness = 0.43;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1
    ? [chroma, secondary, 0]
    : section < 2
      ? [secondary, chroma, 0]
      : section < 3
        ? [0, chroma, secondary]
        : section < 4
          ? [0, secondary, chroma]
          : section < 5
            ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function stableChartColor(key: string): string {
  const hash = fnv1a(key);
  const hue = key.startsWith('actor:')
    ? 205 + (hash % 50)
    : key.startsWith('competitor:')
      ? 5 + (hash % 170)
      : hash % 360;
  return hueToHex(hue);
}

function baseOption(spec: ChartSpec): EChartsOption {
  return {
    animation: false,
    backgroundColor: '#ffffff',
    title: {
      text: spec.title,
      left: 'center',
      textStyle: { color: '#172033', fontSize: 16, fontWeight: 600 },
    },
    grid: { left: 56, right: 32, top: 64, bottom: 48, containLabel: true },
    tooltip: { trigger: 'axis' },
  };
}

function cartesianSeries(spec: ChartSpec, type: 'bar' | 'line'): EChartsOption {
  const series = type === 'bar'
    ? spec.series.map((item) => ({
        type: 'bar' as const,
        name: item.label,
        data: item.values,
        itemStyle: { color: stableChartColor(item.key) },
      }))
    : spec.series.map((item) => ({
        type: 'line' as const,
        name: item.label,
        data: item.values,
        itemStyle: { color: stableChartColor(item.key) },
        connectNulls: false,
        lineStyle: { color: stableChartColor(item.key), width: 3 },
        symbolSize: 7,
      }));
  return {
    ...baseOption(spec),
    legend: { top: 34 },
    xAxis: {
      type: 'category',
      data: spec.categories,
      axisLabel: { color: '#4b5563' },
    },
    yAxis: {
      type: 'value',
      ...(spec.yAxis ? { min: spec.yAxis.min } : {}),
      axisLabel: { color: '#4b5563' },
    },
    series,
  };
}

function heatmapSeries(spec: ChartSpec): EChartsOption {
  const presentValues = spec.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
  const minimum = presentValues.length > 0 ? Math.min(...presentValues) : 0;
  const maximum = presentValues.length > 0 ? Math.max(...presentValues) : 0;
  return {
    ...baseOption(spec),
    tooltip: { position: 'top' },
    grid: { left: 80, right: 72, top: 64, bottom: 56, containLabel: true },
    xAxis: { type: 'category', data: spec.categories, splitArea: { show: true } },
    yAxis: { type: 'category', data: spec.series.map((series) => series.label), splitArea: { show: true } },
    visualMap: spec.series.map((series, seriesIndex) => ({
      type: 'continuous' as const,
      min: minimum,
      max: maximum === minimum ? minimum + 1 : maximum,
      seriesIndex,
      dimension: 2,
      show: false,
      inRange: { color: ['#f8fafc', stableChartColor(series.key)] },
    })),
    series: spec.series.map((series, seriesIndex) => ({
      type: 'heatmap',
      name: series.label,
      data: series.values.map((value, categoryIndex) => [categoryIndex, seriesIndex, value]),
      label: { show: true },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0, 0, 0, 0.2)' } },
    })),
  };
}

function chartOption(spec: ChartSpec): EChartsOption {
  if (spec.type === 'comparison') return cartesianSeries(spec, 'bar');
  if (spec.type === 'trend') return cartesianSeries(spec, 'line');
  return heatmapSeries(spec);
}

export function chartTableAlternative(spec: ChartSpec): ChartTableAlternative {
  return {
    caption: spec.title,
    columns: ['Series', ...spec.categories],
    rows: spec.series.map((series: ChartSeries) => ({
      key: series.key,
      label: series.label,
      cells: [...series.values],
      evidenceIds: series.evidenceIds.map((ids) => [...ids]),
    })),
  };
}

function normalizeRuntimeTokens(svg: string): string {
  const tokens = new Map<string, string>();
  const normalizedClasses = svg.replace(/zr\d+-(?:cls|ani)-\d+/g, (token) => {
    const existing = tokens.get(token);
    if (existing) return existing;
    const stable = `chart-runtime-token-${tokens.size + 1}`;
    tokens.set(token, stable);
    return stable;
  });
  return normalizedClasses.replace(/\bzr\d+\b/g, 'chart-runtime');
}

function normalizeSvgIds(svg: string): string {
  const replacements = new Map<string, string>();
  const idPattern = /\bid=(['"])([^'"]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(svg)) !== null) {
    if (!replacements.has(match[2]!)) replacements.set(match[2]!, `chart-id-${replacements.size + 1}`);
  }
  let normalized = svg;
  for (const [source, target] of replacements) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized
      .replace(new RegExp(`(\\bid=['"])${escaped}(['"])`, 'g'), `$1${target}$2`)
      .replace(new RegExp(`(url\\(\\s*['"]?#)${escaped}(['"]?\\s*\\))`, 'g'), `$1${target}$2`)
      .replace(new RegExp(`((?:href|xlink:href)=['"]#)${escaped}(['"])`, 'g'), `$1${target}$2`);
  }
  return normalized;
}

function sanitizeSvg(svg: string): string {
  const standalone = normalizeSvgIds(normalizeRuntimeTokens(svg.trim()));
  if (!/^<svg\b/i.test(standalone) || !/<\/svg>$/.test(standalone)) {
    throw new Error('ECharts did not render a standalone SVG document');
  }
  if (
    /<\/?(?:script|foreignObject|iframe|object|embed)\b/i.test(standalone)
    || /<!DOCTYPE\b|<!ENTITY\b/i.test(standalone)
    || /\son[a-z]+\s*=/i.test(standalone)
    || /(?:href|xlink:href|src)\s*=\s*["']\s*(?:https?:|javascript:|data:)/i.test(standalone)
    || /url\(\s*["']?\s*(?:https?:|javascript:|data:)/i.test(standalone)
  ) {
    throw new Error('ECharts SVG contains executable or remote content');
  }
  return standalone;
}

function assertDimensions({ width, height }: ChartDimensions): void {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('chart width and height must be positive integers');
  }
  if (width * height > 20_000_000) throw new Error('chart dimensions exceed 20 megapixels');
}

export function renderChartSvg(spec: ChartSpec, dimensions: ChartDimensions): RenderedChartSvg {
  assertDimensions(dimensions);
  let renderedSvg: string;
  try {
    const chart = echarts.init(null, undefined, {
      renderer: 'svg',
      ssr: true,
      width: dimensions.width,
      height: dimensions.height,
    });
    try {
      chart.setOption(chartOption(spec), { notMerge: true, lazyUpdate: false, silent: true });
      renderedSvg = chart.renderToSVGString({ useViewBox: true });
    } finally {
      chart.dispose();
    }
  } catch (error) {
    throw new ChartRendererUnavailableError(error);
  }
  return {
    svg: sanitizeSvg(renderedSvg),
    table: chartTableAlternative(spec),
  };
}

export interface RenderAndSealChartSvgInput extends ChartDimensions {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  spec: ChartSpec;
  evidenceResolver: ChartEvidenceResolver;
  artifacts: Pick<ControlArtifactStore, 'writeJson'>;
  activeLease: ControlExecutionLease;
  chartDataArtifact: ControlArtifact;
  publication: ArtifactPublicationGroup;
  assets: Pick<VisualAssetService, 'sealChartRender'>;
  exportPolicy: VisualAssetExportPolicy;
  ensureActive: () => Promise<void>;
}

export interface SealedChartSvg extends RenderedChartSvg {
  visualAsset: VisualAssetResult;
  chartSpecArtifactId: string;
}

export async function renderAndSealChartSvg(input: RenderAndSealChartSvgInput): Promise<SealedChartSvg> {
  const chartDataArtifact = input.chartDataArtifact;
  const publication = input.publication;
  if (!publication.artifactIds.includes(chartDataArtifact.id)) {
    throw new Error('Caller publication must already own the Chart Data Artifact');
  }
  publication.track(chartDataArtifact.id);
  try {
    if (
      input.activeLease.taskId !== input.taskId
      || input.activeLease.planVersionId !== input.planVersionId
      || input.activeLease.attemptId !== input.attemptId
    ) {
      throw new ArtifactIntegrityError(
        chartDataArtifact.id,
        'Chart active lease binding does not match Task, Plan, and Attempt',
      );
    }
    if (
      chartDataArtifact.state !== 'SEALED'
      || chartDataArtifact.kind !== 'chart_data'
      || !chartDataArtifact.contentSha256
      || chartDataArtifact.taskId !== input.taskId
      || chartDataArtifact.planVersionId !== input.planVersionId
      || chartDataArtifact.attemptId !== input.attemptId
    ) {
      throw new ArtifactIntegrityError(
        chartDataArtifact.id,
        'Chart Data Artifact must be sealed and bound to the active Task, Plan, and Attempt',
      );
    }
    const validatedSpec = validateChartSpec(input.spec, input.evidenceResolver);
    const specHash = chartSpecHash(validatedSpec);
    let rendered: RenderedChartSvg;
    try {
      rendered = renderChartSvg(validatedSpec, input);
    } catch (error) {
      if (error instanceof ChartRendererUnavailableError) throw error;
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new ArtifactIntegrityError(
        chartDataArtifact.id,
        `Chart SVG failed integrity validation${detail}`,
      );
    }
    const visualAsset = await input.assets.sealChartRender({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      activeLease: input.activeLease,
      dataArtifactId: chartDataArtifact.id,
      dataArtifactContentSha256: chartDataArtifact.contentSha256,
      chartId: validatedSpec.chartId,
      specHash,
      bytes: Buffer.from(rendered.svg, 'utf8'),
      width: input.width,
      height: input.height,
      exportPolicy: input.exportPolicy,
      publication,
      ensureActive: input.ensureActive,
    });
    publication.track(visualAsset.assetArtifact.id).track(visualAsset.manifestArtifact.id);
    if (
      visualAsset.manifest.version !== 'visual-asset-manifest-v2'
      || visualAsset.manifest.source.kind !== 'chart_render'
      || visualAsset.manifest.source.dataArtifactId !== chartDataArtifact.id
      || visualAsset.manifest.source.dataArtifactContentSha256 !== chartDataArtifact.contentSha256
      || visualAsset.manifest.derivedFrom !== null
      || visualAsset.manifest.derivation?.kind !== 'chart_svg'
      || visualAsset.manifest.derivation.chartId !== validatedSpec.chartId
      || visualAsset.manifest.derivation.specHash !== specHash
    ) {
      throw new ArtifactIntegrityError(
        visualAsset.manifestArtifact.id,
        'sealed chart render does not match its Chart Data and Chart Spec provenance',
      );
    }
    const chartSpecArtifact = await input.artifacts.writeJson({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: 'chart_spec',
      relativePath: `charts/${encodeURIComponent(validatedSpec.chartId)}.json`,
      value: {
        version: 'verified-chart-v1',
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        spec: validatedSpec,
        specHash,
        table: rendered.table,
        dataArtifactRef: {
          artifactId: chartDataArtifact.id,
          contentSha256: chartDataArtifact.contentSha256,
        },
        assetRef: {
          assetId: visualAsset.assetArtifact.id,
          manifestArtifactId: visualAsset.manifestArtifact.id,
        },
      },
      schemaVersion: 'verified-chart-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
    });
    publication.track(chartSpecArtifact.id);
    await input.ensureActive();
    if (
      chartSpecArtifact.state !== 'SEALED'
      || !chartSpecArtifact.contentSha256
      || chartSpecArtifact.kind !== 'chart_spec'
      || chartSpecArtifact.schemaVersion !== 'verified-chart-v1'
      || chartSpecArtifact.taskId !== input.taskId
      || chartSpecArtifact.planVersionId !== input.planVersionId
      || chartSpecArtifact.attemptId !== input.attemptId
    ) {
      throw new ArtifactIntegrityError(
        chartSpecArtifact.id,
        'Chart Spec Artifact did not seal with the required binding and schema',
      );
    }
    return {
      ...rendered,
      visualAsset,
      chartSpecArtifactId: chartSpecArtifact.id,
    };
  } catch (error) {
    try {
      await publication.compensate('Chart publication did not complete');
    } catch (invalidationError) {
      if (invalidationError === error) throw error;
      if (
        error instanceof ArtifactInvalidationError
        && invalidationError instanceof ArtifactInvalidationError
      ) {
        throw mergeArtifactInvalidationErrors(error, invalidationError);
      }
      throw invalidationError;
    }
    throw error;
  }
}
