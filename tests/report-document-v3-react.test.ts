import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type {
  ReadableReportDocument,
  ReportBlockV3,
  ReportDocumentV1V2,
  ReportDocumentV3,
} from '../packages/api-contract/report-document.ts';
import { createReportDocumentViewModel } from '../apps/web/src/reporting/report-document-view-model.ts';
import {
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';

const reportDocumentViewModulePath: string = '../apps/web/src/reporting/ReportDocumentView.tsx';
const stage4ModulePath: string = '../apps/web/src/components/stages/CurrentStage4Report.tsx';

function allBlockTypesDocument(): ReportDocumentV3 {
  const document = structuredClone(reportDocumentV3Fixture());
  const blocks: ReportBlockV3[] = [
    {
      id: 'block-paragraph',
      type: 'paragraph',
      title: '背景',
      visibility: 'always',
      unitRefs: ['unit-paragraph'],
      leafRefs: ['leaf-paragraph'],
      leafRef: 'leaf-paragraph',
      text: '这是完整显示的核心背景。',
    },
    {
      id: 'block-fact',
      type: 'fact',
      title: '补充证据',
      visibility: 'collapsible',
      unitRefs: ['unit-fact'],
      leafRefs: ['leaf-fact'],
      leafRef: 'leaf-fact',
      text: '这是按合同折叠的补充事实。',
    },
    {
      id: 'block-metric',
      type: 'metric',
      visibility: 'always',
      unitRefs: ['unit-metric'],
      leafRefs: ['leaf-metric'],
      leafRef: 'leaf-metric',
      label: '验证样本',
      value: 24,
      unit: '人',
    },
    {
      id: 'block-list',
      type: 'list',
      title: '关键原则',
      visibility: 'always',
      unitRefs: ['unit-list'],
      leafRefs: ['leaf-list'],
      ordered: true,
      items: [{ id: 'list-1', leafRef: 'leaf-list', label: '原则', text: '先验证信任机制' }],
    },
    {
      id: 'block-answer',
      type: 'answer',
      kind: 'channel_strategy',
      title: '渠道策略',
      visibility: 'always',
      unitRefs: ['unit-answer'],
      leafRefs: ['leaf-answer', 'leaf-answer-item'],
      textLeafRef: 'leaf-answer',
      text: '先用频道入口验证高意向流量。',
      items: [{ id: 'answer-1', leafRef: 'leaf-answer-item', label: '行动', text: '小流量灰度验证' }],
      answerStatus: 'supported',
    },
    {
      id: 'block-image',
      type: 'image',
      title: '页面证据',
      visibility: 'always',
      unitRefs: ['unit-image'],
      leafRefs: ['leaf-image'],
      leafRef: 'leaf-image',
      assetRef: { assetId: 'asset-image', manifestArtifactId: 'manifest-image' },
      caption: '页面截图',
      altText: '页面截图证据',
    },
    {
      id: 'block-comparison',
      type: 'image-comparison',
      title: '前后对比',
      visibility: 'always',
      unitRefs: ['unit-comparison'],
      leafRefs: ['leaf-before', 'leaf-after'],
      beforeLeafRef: 'leaf-before',
      afterLeafRef: 'leaf-after',
      beforeAssetRef: { assetId: 'asset-before', manifestArtifactId: 'manifest-before' },
      afterAssetRef: { assetId: 'asset-after', manifestArtifactId: 'manifest-after' },
      caption: '原图与标注图对比',
      altText: '页面问题对比',
    },
    {
      id: 'block-chart',
      type: 'chart',
      title: '意向分布',
      visibility: 'always',
      unitRefs: ['unit-chart'],
      leafRefs: ['leaf-chart'],
      leafRef: 'leaf-chart',
      chartRef: {
        chartId: 'chart-intent',
        assetId: 'asset-chart',
        manifestArtifactId: 'manifest-chart',
      },
      specHash: `sha256:${'b'.repeat(64)}`,
      spec: {
        version: 'chart-spec-v1',
        chartId: 'chart-intent',
        type: 'comparison',
        title: '意向分布',
        categories: ['高意向'],
        series: [{
          key: 'segment:core',
          label: '核心用户',
          values: [72],
          evidenceIds: [['E1']],
        }],
      },
      table: {
        caption: '意向分布数据表',
        columns: ['用户', '高意向'],
        rows: [{ key: 'segment:core', label: '核心用户', cells: [72], evidenceIds: [['E1']] }],
      },
      caption: '意向分布',
      altText: '核心用户意向分布图',
    },
  ];
  const leafIds = blocks.flatMap(({ leafRefs }) => leafRefs);
  const unitIds = blocks.flatMap(({ unitRefs }) => unitRefs);
  const assetIds = ['asset-image', 'asset-before', 'asset-after', 'asset-chart'];
  for (const leafId of leafIds) {
    document.traceIndex[leafId] = reportDocumentV3Trace(`/payload/contentBlocks/${leafId}`);
  }
  document.sections.push({
    id: 'section-analysis-001',
    title: '分析底稿',
    view: 'analysis',
    prominence: 'appendix',
    blocks,
  });
  document.semanticManifest.presentationUnitIds.push(...unitIds);
  document.semanticManifest.leafUnitIds.push(...leafIds);
  document.semanticManifest.assetIds.push(...assetIds);
  return document;
}

async function renderDocument(
  document: ReadableReportDocument,
  visibleSectionIds?: readonly string[],
): Promise<string> {
  const exports = await import(reportDocumentViewModulePath) as unknown as {
    ReportDocumentView: unknown;
  };
  const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const react = requireFromWeb('react') as {
    createElement(component: unknown, props: Record<string, unknown>): unknown;
  };
  const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
    renderToStaticMarkup(element: unknown): string;
  };
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  try {
    return renderToStaticMarkup(react.createElement(exports.ReportDocumentView, {
      document,
      visualAssetManifests: [],
      taskId: 'task-v3-react',
      visibleSectionIds,
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }
}

test('React v3 view model traverses typed blocks and preserves explicit section views and semantics', () => {
  const document = allBlockTypesDocument();
  const model = createReportDocumentViewModel({
    document,
    visualAssetManifests: [],
    assetUrl: ({ assetId }) => `/assets/${assetId}`,
    sourceReportDocumentContentSha256: `sha256:${'a'.repeat(64)}`,
  });

  assert.deepEqual(
    model.navigation.map(({ id, view }) => ({ id, view })),
    document.sections.map(({ id, view }) => ({ id, view })),
  );
  assert.deepEqual(model.semantics, document.semanticManifest);
  assert.equal(model.renderManifest?.renderer, 'react');
  assert.deepEqual(model.renderManifest?.semantics, document.semanticManifest);
  const blocks = model.sections.flatMap((section) => section.blocks);
  for (const kind of [
    'paragraph', 'evidence', 'metric', 'list', 'answer', 'image', 'comparison', 'chart',
    'record-table', 'graph', 'priority-board',
  ]) {
    assert.ok(blocks.some((block) => block.kind === kind), `${kind} must be readable in v3`);
  }
  const answer = blocks.find(({ id }) => id === 'block-answer');
  assert.equal(answer?.visibility, 'always');
  assert.equal(answer?.answerKind, 'channel_strategy');
  assert.deepEqual(answer?.evidenceIds, ['E1']);
});

test('React v3 renderer obeys block visibility, keeps always content open, and renders audit appendix', async () => {
  const markup = await renderDocument(allBlockTypesDocument());

  assert.match(markup, /data-report-version="report-document-v3"/u);
  assert.match(markup, /class="report-document report-style-editorial report-density-comfortable"/u);
  assert.match(markup, /data-report-style="editorial"/u);
  assert.match(markup, /data-report-density="comfortable"/u);
  assert.match(markup, /data-report-view="analysis"/u);
  assert.match(markup, /data-prominence="appendix"/u);
  assert.match(markup, /report-record-table/u);
  assert.match(markup, /report-graph-linear/u);
  assert.match(markup, /data-graph-variant="linear"/u);
  assert.match(markup, /report-priority-board/u);
  assert.match(markup, /先用频道入口验证高意向流量。/u);
  assert.match(markup, /小流量灰度验证/u);
  assert.doesNotMatch(markup, /report-answer-details/u);
  assert.match(markup, /<details class="report-v3-block report-v3-block-evidence report-v3-collapsible"[^>]*data-block-id="block-fact"/u);
  assert.doesNotMatch(markup, /<details[^>]*data-block-id="block-answer"/u);
  assert.match(markup, /<section class="report-section report-audit-appendix"/u);
  assert.match(markup, /data-audit-record-id="audit-1"/u);
  assert.match(markup, /生成说明/u);
});

test('React v3 renderer and stylesheet distinguish report and graph presentation variants', async () => {
  const document = reportDocumentV3Fixture();
  document.style = 'operational';
  document.density = 'compact';
  const graph = document.sections.flatMap(({ blocks }) => blocks).find((block) => block.type === 'graph');
  assert.equal(graph?.type, 'graph');
  if (graph?.type !== 'graph') return;
  graph.variant = 'two_sided';

  const markup = await renderDocument(document);
  const css = await readFile(new URL('../apps/web/src/reporting/report-print.css', import.meta.url), 'utf8');
  assert.match(markup, /class="report-document report-style-operational report-density-compact"/u);
  assert.match(markup, /data-report-style="operational"/u);
  assert.match(markup, /data-report-density="compact"/u);
  assert.match(markup, /report-graph-two_sided/u);
  assert.match(markup, /data-graph-variant="two_sided"/u);
  assert.match(css, /\.report-style-operational\s*\{/u);
  assert.match(css, /\.report-density-compact \.report-cover\s*\{/u);
  assert.match(css, /\.report-section\[data-prominence="primary"\]\s*\{/u);
  assert.match(css, /\.report-graph-hub_spoke \.report-graph-nodes li:first-child\s*\{/u);
  assert.match(css, /\.report-graph-two_sided \.report-graph-nodes li:nth-child\(odd\)\s*\{/u);
});

test('React v3 renderer keeps non-active view sections and the complete contents available for print', async () => {
  const document = reportDocumentV3Fixture();
  const markup = await renderDocument(document, ['section-answers-001']);
  const css = await readFile(new URL('../apps/web/src/reporting/report-print.css', import.meta.url), 'utf8');

  assert.match(markup, /<section class="report-section" id="section-answers-001"/u);
  assert.match(markup, /<section class="report-section report-screen-hidden" id="section-topics-001"/u);
  assert.match(markup, /<section class="report-section report-screen-hidden" id="section-actions-001"/u);
  assert.match(markup, /<nav class="report-toc report-screen-hidden"[^>]*data-print-role="toc"/u);
  assert.match(markup, /href="#section-answers-001"/u);
  assert.match(markup, /href="#section-topics-001"/u);
  assert.match(markup, /href="#section-actions-001"/u);
  assert.match(css, /@media screen\s*\{[\s\S]*?\.report-document \.report-screen-hidden\s*\{\s*display: none !important;/u);
  assert.match(css, /@media print\s*\{[\s\S]*?\.report-document \.report-screen-hidden\s*\{\s*display: revert !important;/u);
});

test('Stage 4 uses v3 section.view without inferring meaning from section ids or block kinds', async () => {
  const { strategyReportSectionIds } = await import(stage4ModulePath) as unknown as {
    strategyReportSectionIds(document: ReadableReportDocument, view: 'answers' | 'actions'): string[];
  };
  const document = reportDocumentV3Fixture();
  document.sections[0]!.id = 'opaque-section-a';
  document.sections[0]!.title = '任意标题';
  document.sections[2]!.id = 'opaque-section-b';
  document.sections[2]!.title = '另一个任意标题';

  assert.deepEqual(strategyReportSectionIds(document, 'answers'), ['opaque-section-a']);
  assert.deepEqual(strategyReportSectionIds(document, 'actions'), ['opaque-section-b']);
});

test('React reader retains the legacy v2 answer disclosure', async () => {
  const document: ReportDocumentV1V2 = {
    version: 'report-document-v2',
    title: '历史报告',
    subtitle: '兼容性验证',
    executiveSummary: '历史摘要。',
    sections: [{
      id: 'executive-answers',
      title: '答案概览',
      questionIds: ['Q1'],
      blocks: [{
        id: 'legacy-answer',
        type: 'answer',
        kind: 'direct_answer',
        title: '历史答案',
        text: '旧版正文保持原样。',
        items: ['详细要点'],
        questionIds: ['Q1'],
        evidenceIds: ['E1'],
        findingIds: ['F1'],
        summaryIds: ['S1'],
        sourcePointers: ['/directAnswers/0'],
        summary: true,
      }],
    }],
  };
  const markup = await renderDocument(document);
  assert.match(markup, /<details class="report-answer-details">[\s\S]*展开详细要点/u);
  assert.doesNotMatch(markup, /data-report-version=/u);
});
