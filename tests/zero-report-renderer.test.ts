import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ReportBlockV3,
  ReportDocumentV1V2,
  ReportDocumentV3,
  ReportDocumentV4,
} from '../packages/api-contract/report-document.ts';
import { collectReportDocumentV4Semantics } from '../packages/report-rendering/report-document-visitor.ts';
import {
  ZERO_REPORT_TEMPLATE_VERSION,
  renderZeroReport,
} from '../apps/agent-api/src/integrations/zero/zero-report-renderer.ts';
import {
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';

const ZERO_V3_DOCUMENT_HASH = `sha256:${'d'.repeat(64)}`;
const ZERO_V4_DOCUMENT_HASH = `sha256:${'e'.repeat(64)}`;

const document: ReportDocumentV1V2 = {
  version: 'report-document-v1',
  title: 'AI 导购竞品分析',
  subtitle: '证据驱动的竞品分析',
  executiveSummary: '京东 AI 导购在商品组织和转化入口上领先。',
  sections: [{
    id: 'summary',
    title: '执行摘要',
    questionIds: [],
    blocks: [
      { id: 'paragraph-1', type: 'paragraph', text: '管理摘要正文。' },
      { id: 'list-1', type: 'list', items: ['结论一', '结论二'] },
      { id: 'metric-1', type: 'metric', label: '综合得分', value: 3.88, evidenceIds: ['E1'] },
      { id: 'fact-1', type: 'fact', text: '价格与 CTA 同屏。', evidenceIds: ['E1'] },
    ],
  }, {
    id: 'visual-evidence',
    title: '视觉证据',
    questionIds: [],
    blocks: [{
      id: 'image-1',
      type: 'image',
      assetRef: { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
      caption: '原始截图',
      altText: '原始截图证据',
    }, {
      id: 'comparison-1',
      type: 'image-comparison',
      beforeAssetRef: { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
      afterAssetRef: { assetId: 'asset-2', manifestArtifactId: 'manifest-2' },
      caption: '原图与标注图',
      altText: '对照证据',
    }, {
      id: 'chart-1',
      type: 'chart',
      chartRef: { chartId: 'weights', assetId: 'chart-asset', manifestArtifactId: 'chart-manifest' },
      specHash: `sha256:${'a'.repeat(64)}`,
      spec: {
        version: 'chart-spec-v1', chartId: 'weights', type: 'comparison', title: '评分权重',
        categories: ['需求理解'],
        series: [{ key: 'weight', label: '权重', values: [20], evidenceIds: [['E1']] }],
        yAxis: { min: 0 },
      },
      table: { caption: '评分权重', columns: ['Series', '需求理解'], rows: [{ key: 'weight', label: '权重', cells: [20], evidenceIds: [['E1']] }] },
      caption: '评分权重',
      altText: '评分权重图',
    }],
  }],
};

const visuals = [
  { key: 'image-1:single:1', blockId: 'image-1', role: 'image' as const, sliceIndex: 0, sliceCount: 1, label: '原始截图' },
  { key: 'comparison-1:original:1', blockId: 'comparison-1', role: 'image_original' as const, sliceIndex: 0, sliceCount: 2, label: '原图第 1 段' },
  { key: 'comparison-1:original:2', blockId: 'comparison-1', role: 'image_original' as const, sliceIndex: 1, sliceCount: 2, label: '原图第 2 段' },
  { key: 'comparison-1:annotation:1', blockId: 'comparison-1', role: 'image_annotation' as const, sliceIndex: 0, sliceCount: 2, label: '标注图第 1 段' },
  { key: 'comparison-1:annotation:2', blockId: 'comparison-1', role: 'image_annotation' as const, sliceIndex: 1, sliceCount: 2, label: '标注图第 2 段' },
  { key: 'chart-1:chart:1', blockId: 'chart-1', role: 'chart' as const, sliceIndex: 0, sliceCount: 1, label: '评分权重图' },
];

function allBlockV3Document(): ReportDocumentV3 {
  const document = reportDocumentV3Fixture();
  const blocks: ReportBlockV3[] = [{
    id: 'block-paragraph', type: 'paragraph', title: '背景', visibility: 'always',
    unitRefs: ['unit-paragraph'], leafRefs: ['leaf-paragraph'], leafRef: 'leaf-paragraph', text: '段落分析。',
  }, {
    id: 'block-fact', type: 'fact', visibility: 'always',
    unitRefs: ['unit-fact'], leafRefs: ['leaf-fact'], leafRef: 'leaf-fact', text: '受审事实。',
  }, {
    id: 'block-metric', type: 'metric', visibility: 'always',
    unitRefs: ['unit-metric'], leafRefs: ['leaf-metric'], leafRef: 'leaf-metric', label: '转化率', value: 12, unit: '%',
  }, {
    id: 'block-list', type: 'list', title: '要点', visibility: 'collapsible', ordered: true,
    unitRefs: ['unit-list'], leafRefs: ['leaf-list-1', 'leaf-list-2'],
    items: [
      { id: 'list-1', leafRef: 'leaf-list-1', label: '第一', text: '要点一' },
      { id: 'list-2', leafRef: 'leaf-list-2', text: '要点二' },
    ],
  }, {
    id: 'block-answer', type: 'answer', title: '直接答案', visibility: 'always', kind: 'direct_answer',
    unitRefs: ['unit-answer'], leafRefs: ['leaf-answer', 'leaf-answer-item'],
    textLeafRef: 'leaf-answer', text: '答案正文。', answerStatus: 'supported',
    items: [{ id: 'answer-1', leafRef: 'leaf-answer-item', text: '答案要点。' }],
  }, {
    id: 'block-image', type: 'image', visibility: 'always',
    unitRefs: ['unit-image'], leafRefs: ['leaf-image'], leafRef: 'leaf-image',
    assetRef: { assetId: 'asset-image', manifestArtifactId: 'manifest-image' },
    caption: '项目截图', altText: '项目页面',
  }, {
    id: 'block-comparison', type: 'image-comparison', visibility: 'always',
    unitRefs: ['unit-comparison'], leafRefs: ['leaf-before', 'leaf-after'],
    beforeLeafRef: 'leaf-before', afterLeafRef: 'leaf-after',
    beforeAssetRef: { assetId: 'asset-before', manifestArtifactId: 'manifest-before' },
    afterAssetRef: { assetId: 'asset-after', manifestArtifactId: 'manifest-after' },
    caption: '改版对比', altText: '改版前后',
  }, {
    id: 'block-chart', type: 'chart', visibility: 'always',
    unitRefs: ['unit-chart'], leafRefs: ['leaf-chart'], leafRef: 'leaf-chart',
    chartRef: { chartId: 'motivation', assetId: 'asset-chart', manifestArtifactId: 'manifest-chart' },
    specHash: `sha256:${'b'.repeat(64)}`,
    spec: {
      version: 'chart-spec-v1', chartId: 'motivation', type: 'comparison', title: '动机分布',
      categories: ['新奇'], series: [{ key: 'share', label: '占比', values: [60], evidenceIds: [['E1']] }],
      yAxis: { min: 0 },
    },
    table: {
      caption: '动机分布', columns: ['系列', '新奇'],
      rows: [{ key: 'share', label: '占比', cells: [60], evidenceIds: [['E1']] }],
    },
    caption: '动机分布', altText: '动机图表',
  }];
  document.sections[0]!.blocks.unshift(...blocks);
  const leafIds = blocks.flatMap((block) => block.leafRefs);
  for (const leafId of leafIds) document.traceIndex[leafId] = reportDocumentV3Trace(`/test/${leafId}`);
  document.semanticManifest.presentationUnitIds.unshift(...blocks.flatMap((block) => block.unitRefs));
  document.semanticManifest.leafUnitIds.unshift(...leafIds);
  document.semanticManifest.assetIds = ['asset-image', 'asset-before', 'asset-after', 'asset-chart'];
  return document;
}

const v3Visuals = [
  { key: 'block-image:image:1', blockId: 'block-image', role: 'image' as const, sliceIndex: 0, sliceCount: 1, label: '项目截图' },
  { key: 'block-comparison:original:1', blockId: 'block-comparison', role: 'image_original' as const, sliceIndex: 0, sliceCount: 1, label: '原图' },
  { key: 'block-comparison:annotation:1', blockId: 'block-comparison', role: 'image_annotation' as const, sliceIndex: 0, sliceCount: 1, label: '标注图' },
  { key: 'block-chart:chart:1', blockId: 'block-chart', role: 'chart' as const, sliceIndex: 0, sliceCount: 1, label: '动机分布' },
];

function reportDocumentV4Fixture(): ReportDocumentV4 {
  const leafIds = ['card-leaf', 'stage-leaf'];
  const document: ReportDocumentV4 = {
    version: 'report-document-v4',
    title: { id: 'copy-title', provenance: 'model', text: 'V4 编辑报告', sourceLeafIds: leafIds },
    subtitle: '兼容性验证',
    executiveSummary: {
      id: 'copy-summary', provenance: 'model', text: 'V4 执行摘要', sourceLeafIds: leafIds,
    },
    style: 'editorial',
    density: 'comfortable',
    copyMode: 'model',
    sourceDeliverableArtifactId: 'deliverable-v4',
    sourceDeliverableContentSha256: ZERO_V4_DOCUMENT_HASH,
    projectionMode: 'full',
    layoutMode: 'model',
    sections: [{
      id: 'section-cards',
      title: { id: 'copy-section-card', provenance: 'model', text: '卡片洞察', sourceLeafIds: ['card-leaf'] },
      lead: { id: 'copy-lead', provenance: 'model', text: '先看核心卡片。', sourceLeafIds: ['card-leaf'] },
      transition: {
        id: 'copy-transition', provenance: 'model', text: '随后进入行动阶段。', sourceLeafIds: leafIds,
      },
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        id: 'card-grid',
        type: 'card-grid',
        title: '关键洞察',
        visibility: 'always',
        unitRefs: ['card-unit'],
        leafRefs: ['card-leaf'],
        digest: {
          id: 'copy-card-digest', provenance: 'model', text: '卡片摘要。', sourceLeafIds: ['card-leaf'],
        },
        cards: [{
          id: 'card-1', title: '信任线索', body: '展示来源与验证状态。', status: '已验证', leafRefs: ['card-leaf'],
        }],
      }],
    }, {
      id: 'section-flow',
      title: { id: 'copy-section-flow', provenance: 'model', text: '行动路径', sourceLeafIds: ['stage-leaf'] },
      view: 'actions',
      prominence: 'supporting',
      blocks: [{
        id: 'stage-flow',
        type: 'stage-flow',
        title: '落地阶段',
        visibility: 'always',
        unitRefs: ['stage-unit'],
        leafRefs: ['stage-leaf'],
        stages: [{
          id: 'stage-1', label: '验证', description: '运行可用性测试。', timeLabel: '第 1 周', leafRefs: ['stage-leaf'],
        }],
      }],
    }],
    traceIndex: Object.fromEntries(leafIds.map((leafId) => [
      leafId,
      reportDocumentV3Trace(`/test/${leafId}`),
    ])),
    notices: [],
    semanticManifest: {
      version: 'report-semantic-manifest-v2',
      presentationUnitIds: [],
      leafUnitIds: [],
      assetIds: [],
      auditRecordIds: [],
      noticeIds: [],
      copyFragmentIds: [],
    },
  };
  document.semanticManifest = collectReportDocumentV4Semantics(document);
  return document;
}

test('Zero report renderer maps report blocks and stable visual placeholders', () => {
  const rendered = renderZeroReport({
    document,
    publicationId: '11111111-1111-4111-8111-111111111111',
    visuals,
  });
  assert.equal(rendered.templateVersion, ZERO_REPORT_TEMPLATE_VERSION);
  assert.equal(rendered.expectedWidth, 1440);
  assert.match(rendered.html, /AI 导购竞品分析/);
  assert.match(rendered.html, /管理摘要正文/);
  assert.match(rendered.html, /结论一/);
  assert.match(rendered.html, /综合得分/);
  assert.match(rendered.html, /价格与 CTA 同屏/);
  assert.match(rendered.html, /评分权重/);
  assert.deepEqual(rendered.placeholders.map(({ key }) => key), visuals.map(({ key }) => key));
  assert.equal(new Set(rendered.placeholders.map(({ nodeName }) => nodeName)).size, visuals.length);
  assert.ok(
    rendered.html.indexOf('原图第 1 段') < rendered.html.indexOf('标注图第 1 段'),
    'comparison slices render original before annotation',
  );
  for (const placeholder of rendered.placeholders) {
    assert.match(rendered.html, new RegExp(placeholder.nodeName));
  }
});

test('Zero report renderer emits static bounded HTML without embedded image data', () => {
  const rendered = renderZeroReport({ document, publicationId: 'publication-1', visuals });
  assert.ok(rendered.html.length < 500_000);
  assert.doesNotMatch(rendered.html, /<script/iu);
  assert.doesNotMatch(rendered.html, /\son[a-z]+\s*=/iu);
  assert.doesNotMatch(rendered.html, /data:image/iu);
  assert.doesNotMatch(rendered.html, /fetch\(|localStorage|https?:\/\//iu);
  assert.match(rendered.html, /data-ai-alt=/u);
});

test('Zero report renderer preserves v2 projection-list and answer rendering', () => {
  const v2: ReportDocumentV1V2 = {
    ...document,
    version: 'report-document-v2',
    sections: [{
      id: 'v2',
      title: 'v2',
      questionIds: ['q1'],
      blocks: [{
        id: 'projection', type: 'projection-list', items: ['投影要点'], sourcePointers: ['/payload'], summary: false,
      }, {
        id: 'answer', type: 'answer', kind: 'direct_answer', title: '答案', text: '答案正文',
        items: ['详细要点'], questionIds: ['q1'], evidenceIds: ['E1'], findingIds: ['F1'],
        summaryIds: ['S1'], confidence: 0.8, answerStatus: 'supported', sourcePointers: ['/payload'], summary: false,
      }],
    }],
  };
  const rendered = renderZeroReport({ document: v2, publicationId: 'publication-v2', visuals: [] });
  assert.match(rendered.html, /投影要点/u);
  assert.match(rendered.html, /DIRECT ANSWER · SUPPORTED/u);
  assert.match(rendered.html, /Confidence 80% · Evidence E1/u);
});

test('Zero report renderer rejects duplicate visual keys and unknown block bindings', () => {
  assert.throws(() => renderZeroReport({
    document,
    publicationId: 'publication-1',
    visuals: [visuals[0]!, visuals[0]!],
  }), /duplicate visual key/);
  assert.throws(() => renderZeroReport({
    document,
    publicationId: 'publication-1',
    visuals: [{ ...visuals[0]!, blockId: 'missing-block' }],
  }), /unknown report block/);
});

test('Zero report renderer traverses every v3 block and returns a manifest only for an explicit document hash', () => {
  const document = allBlockV3Document();
  const rendered = renderZeroReport({
    document,
    publicationId: 'publication-v3',
    visuals: v3Visuals,
    sourceReportDocumentContentSha256: ZERO_V3_DOCUMENT_HASH,
  });

  for (const block of document.sections.flatMap(({ blocks }) => blocks)) {
    assert.match(rendered.html, new RegExp(`data-ai-alt="${block.id}"`, 'u'));
  }
  assert.match(rendered.html, /记录表|record-table/u);
  assert.match(rendered.html, /触发 → 支持/u);
  assert.match(rendered.html, /建立可信项目档案/u);
  assert.match(rendered.html, /分析审计附录/u);
  assert.match(rendered.html, /data-audit-record-id="audit-1"/u);
  assert.match(rendered.html, /data-notice-id="notice-layout"/u);
  assert.deepEqual(rendered.placeholders.map(({ key }) => key), v3Visuals.map(({ key }) => key));
  assert.equal(rendered.renderManifest?.renderer, 'zero');
  assert.equal(rendered.renderManifest?.sourceReportDocumentContentSha256, ZERO_V3_DOCUMENT_HASH);
  assert.deepEqual(rendered.renderManifest?.semantics, document.semanticManifest);

  const withoutHash = renderZeroReport({ document, publicationId: 'publication-v3-no-hash', visuals: v3Visuals });
  assert.equal(withoutHash.renderManifest, undefined);
  assert.throws(() => renderZeroReport({
    document,
    publicationId: 'publication-v3-invalid-hash',
    visuals: v3Visuals,
    sourceReportDocumentContentSha256: document.sourceDeliverableContentSha256.slice(0, -1),
  }), /valid ReportDocument content hash/u);
});

test('Zero report renderer preserves v4 copy and structured blocks with a v2 render manifest', () => {
  const document = reportDocumentV4Fixture();
  const rendered = renderZeroReport({
    document,
    publicationId: 'publication-v4',
    visuals: [],
    sourceReportDocumentContentSha256: ZERO_V4_DOCUMENT_HASH,
  });

  for (const text of [
    'V4 编辑报告',
    'V4 执行摘要',
    '卡片洞察',
    '先看核心卡片。',
    '卡片摘要。',
    '随后进入行动阶段。',
    '信任线索',
    '展示来源与验证状态。',
    '已验证',
    '行动路径',
    '验证',
    '运行可用性测试。',
    '第 1 周',
  ]) {
    assert.match(rendered.html, new RegExp(text, 'u'));
  }
  assert.doesNotMatch(rendered.html, /\[object Object\]/u);
  assert.match(rendered.html, /data-copy-provenance="model"/u);
  assert.match(rendered.html, /data-leaf-refs="card-leaf"/u);
  assert.match(rendered.html, /data-leaf-refs="stage-leaf"/u);
  assert.equal(rendered.name, document.title.text);
  assert.equal(rendered.renderManifest?.version, 'report-render-manifest-v2');
  assert.deepEqual(rendered.renderManifest?.semantics, document.semanticManifest);
});
