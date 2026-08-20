import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReportDocument } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import {
  ZERO_REPORT_TEMPLATE_VERSION,
  renderZeroReport,
} from '../apps/agent-api/src/integrations/zero/zero-report-renderer.ts';

const document: ReportDocument = {
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
