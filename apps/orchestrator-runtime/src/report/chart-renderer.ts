import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import type {
  ChartSeries,
  ChartSpec,
  VisualAssetExportPolicy,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
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
  const chart = echarts.init(null, undefined, {
    renderer: 'svg',
    ssr: true,
    width: dimensions.width,
    height: dimensions.height,
  });
  try {
    chart.setOption(chartOption(spec), { notMerge: true, lazyUpdate: false, silent: true });
    return {
      svg: sanitizeSvg(chart.renderToSVGString({ useViewBox: true })),
      table: chartTableAlternative(spec),
    };
  } finally {
    chart.dispose();
  }
}

export interface RenderAndSealChartSvgInput extends ChartDimensions {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  spec: ChartSpec;
  evidenceResolver: ChartEvidenceResolver;
  original: VisualAssetReference;
  assets: VisualAssetService;
  exportPolicy: VisualAssetExportPolicy;
}

export interface SealedChartSvg extends RenderedChartSvg {
  derived: VisualAssetResult;
}

export async function renderAndSealChartSvg(input: RenderAndSealChartSvgInput): Promise<SealedChartSvg> {
  const validatedSpec = validateChartSpec(input.spec, input.evidenceResolver);
  const rendered = renderChartSvg(validatedSpec, input);
  const derived = await input.assets.derive({
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    original: input.original,
    derivation: {
      kind: 'chart_svg',
      chartId: validatedSpec.chartId,
      specHash: chartSpecHash(validatedSpec),
    },
    bytes: Buffer.from(rendered.svg, 'utf8'),
    exportPolicy: input.exportPolicy,
  });
  return { ...rendered, derived };
}
