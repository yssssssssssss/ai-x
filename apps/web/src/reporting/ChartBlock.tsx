import { useEffect, useId, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import type { ChartSpec } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';

export interface ChartBlockProps {
  spec: ChartSpec;
  table?: ChartTableAlternative;
  height?: number;
  showTable?: boolean;
  onEvidenceSelect?: (evidenceId: string) => void;
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
    title: {
      text: spec.title,
      left: 'center',
      textStyle: { color: '#172033', fontSize: 16, fontWeight: 600 },
    },
    grid: { left: 56, right: 32, top: 64, bottom: 48, containLabel: true },
    tooltip: { trigger: 'axis' },
  };
}

function chartOption(spec: ChartSpec): EChartsOption {
  if (spec.type === 'heatmap') {
    const values = spec.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
    const minimum = values.length > 0 ? Math.min(...values) : 0;
    const maximum = values.length > 0 ? Math.max(...values) : 0;
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
      })),
    };
  }

  const series = spec.type === 'comparison'
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
    xAxis: { type: 'category', data: spec.categories, axisLabel: { color: '#4b5563' } },
    yAxis: {
      type: 'value',
      ...(spec.yAxis ? { min: spec.yAxis.min } : {}),
      axisLabel: { color: '#4b5563' },
    },
    series,
  };
}

function EvidenceIds({
  ids,
  onSelect,
}: {
  ids: string[];
  onSelect?: (evidenceId: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: '#64748b' }}>
      Evidence:{' '}
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? ', ' : null}
          {onSelect
            ? (
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  style={{ border: 0, padding: 0, background: 'none', color: '#2563eb', cursor: 'pointer' }}
                >
                  {id}
                </button>
              )
            : <code>{id}</code>}
        </span>
      ))}
    </span>
  );
}

export function ChartBlock({ spec, table, height = 420, showTable = true, onEvidenceSelect }: ChartBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const captionId = useId();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    let disposeChart: (() => void) | undefined;
    void import('echarts').then(({ init }) => {
      if (cancelled) return;
      const chart = init(container, undefined, { renderer: 'svg' });
      chart.setOption(chartOption(spec), { notMerge: true, lazyUpdate: false, silent: true });
      observer = new ResizeObserver(() => chart.resize());
      observer.observe(container);
      disposeChart = () => chart.dispose();
    }).catch(() => {});
    return () => {
      cancelled = true;
      observer?.disconnect();
      disposeChart?.();
    };
  }, [spec]);

  const columns = table?.columns ?? ['Series', ...spec.categories];
  const rows = table?.rows ?? spec.series;
  for (const row of rows) {
    const values = 'cells' in row ? row.cells : row.values;
    if (values.length + 1 !== columns.length) {
      throw new Error(`Chart table row ${row.key} does not match its sealed column count`);
    }
  }

  return (
    <figure aria-labelledby={captionId} style={{ margin: 0 }}>
      <figcaption id={captionId} style={{ fontWeight: 600, marginBottom: 8 }}>{spec.title}</figcaption>
      <div
        ref={containerRef}
        role="img"
        aria-label={`${spec.title} chart. A complete tabular text alternative follows.`}
        style={{ width: '100%', height, minHeight: 240 }}
      />
      {showTable ? (
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <caption style={{ textAlign: 'left', paddingBottom: 8 }}>
              {table?.caption ?? `Tabular data and Evidence for ${spec.title}`}
            </caption>
            <thead>
              <tr>
                {columns.map((column, index) => (
                  <th
                    key={`${index}-${column}`}
                    scope="col"
                    style={{ textAlign: index === 0 ? 'left' : 'right', padding: 8, borderBottom: '1px solid #cbd5e1' }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((series) => {
                const values = 'cells' in series ? series.cells : series.values;
                return (
                  <tr key={series.key}>
                    <th scope="row" style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #e2e8f0' }}>
                      {series.label}
                    </th>
                    {values.map((value, index) => (
                      <td key={`${index + 1}-${columns[index + 1]}`} style={{ textAlign: 'right', padding: 8, borderBottom: '1px solid #e2e8f0' }}>
                        <span>{value === null ? 'Missing' : value}</span>
                        <EvidenceIds ids={series.evidenceIds[index] ?? []} onSelect={onEvidenceSelect} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}
