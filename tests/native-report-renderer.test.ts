import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';

import {
  NATIVE_REPORT_DOCUMENT_VERSION,
  nativeReportDocumentHash,
  parseNativeReportDocument,
  type NativeReportDocumentV1,
} from '../packages/api-contract/native-skill-orchestration.ts';
import {
  NativeReportRenderError,
  renderNativeReportBundle,
  renderNativeReportDocumentHtml,
} from '../apps/orchestrator-runtime/src/report/native-report-renderer.ts';

function document(): NativeReportDocumentV1 {
  return {
    version: NATIVE_REPORT_DOCUMENT_VERSION,
    title: '京东图书行业分析',
    subtitle: '基于当前输入和公开资料',
    summary: {
      conclusion: '优先改善选书效率。',
      findings: ['分类入口需要更明确'],
      actions: ['先优化频道首屏'],
    },
    assetIds: ['asset-screen'],
    tabs: [{
      id: 'industry', title: '行业洞察', sections: [{
        id: 'industry-overview', title: '市场概览', blocks: [{
          type: 'markdown', content: '公开资料显示需求稳定 [S-1]。', sourceIds: ['S-1'],
        }, {
          type: 'metric-group', sourceIds: ['S-1'], metrics: [{ label: '样本量', value: '120', note: '本次数据' }],
        }],
      }],
    }, {
      id: 'category', title: '品类差异资产', sections: [{
        id: 'category-table', title: '差异比较', blocks: [{
          type: 'table', columns: ['品类', '需求'], rows: [['文学', '发现']], sourceIds: ['S-1'],
        }],
      }],
    }, {
      id: 'competition', title: '竞品分析', sections: [{
        id: 'competition-quadrant', title: '竞品定位', blocks: [{
          type: 'quadrant', xAxis: '效率', yAxis: '丰富度', points: [{ label: '平台甲', x: 70, y: 60 }], sourceIds: ['S-1'],
        }],
      }],
    }, {
      id: 'experience', title: '体验诊断', sections: [{
        id: 'experience-image', title: '页面观察', blocks: [{
          type: 'image', assetId: 'asset-screen', caption: '京东页面截图', altText: '频道首页', display: 'phone-frame', sourceIds: ['S-1'],
        }, {
          type: 'wireframe', title: '首屏结构', elements: [{ label: '分类入口', description: '突出高频品类' }], sourceIds: [],
        }],
      }],
    }, {
      id: 'strategy', title: '设计策略', sections: [{
        id: 'strategy-roadmap', title: '实施顺序', blocks: [{
          type: 'timeline', items: [{ title: '第一阶段', description: '改善导航', tag: '优先' }], sourceIds: ['S-1'],
        }],
      }],
    }],
  };
}

const sources = [{
  id: 'S-1', title: '公开资料', type: 'tool_result' as const, url: 'https://example.com/source',
}];

test('parses and deterministically renders the seven report block types as five CSS-only tabs', () => {
  const parsed = parseNativeReportDocument(document());
  assert.match(nativeReportDocumentHash(parsed), /^sha256:[a-f0-9]{64}$/u);
  const render = () => renderNativeReportDocumentHtml({
    document: parsed,
    sources,
    gaps: ['缺少站内转化指标。'],
    assetUrl: (assetId) => `/api/control-tasks/task-1/assets/${assetId}`,
  });
  const first = render();
  assert.equal(first, render());
  for (const title of ['行业洞察', '品类差异资产', '竞品分析', '体验诊断', '设计策略']) {
    assert.match(first, new RegExp(title, 'u'));
  }
  assert.match(first, /type="radio"/u);
  assert.match(first, /class="metrics"/u);
  assert.match(first, /class="quadrant"/u);
  assert.match(first, /class="wireframe"/u);
  assert.match(first, /\/api\/control-tasks\/task-1\/assets\/asset-screen/u);
  assert.doesNotMatch(first, /<script|data:image|javascript:/iu);
});

test('builds a deterministic offline ZIP with relative image assets', () => {
  const input = {
    document: document(),
    sources,
    gaps: [] as string[],
    assets: [{ assetId: 'asset-screen', fileName: 'screen.png', bytes: new Uint8Array([1, 2, 3]) }],
  };
  const first = renderNativeReportBundle(input);
  const second = renderNativeReportBundle(input);
  assert.deepEqual(first, second);
  const files = unzipSync(first);
  assert.deepEqual(Object.keys(files).sort(), ['assets/screen.png', 'index.html']);
  const html = strFromU8(files['index.html']!);
  assert.match(html, /src="assets\/screen\.png"/u);
  assert.doesNotMatch(html, /data:image|<script/iu);
});

test('rejects unknown report source and Asset references at the renderer boundary', () => {
  const unknownSource = document();
  unknownSource.tabs[0]!.sections[0]!.blocks[0]!.sourceIds = ['S-missing'];
  assert.throws(() => renderNativeReportDocumentHtml({
    document: unknownSource,
    sources,
    gaps: [],
    assetUrl: () => '/asset',
  }), NativeReportRenderError);

  const missingAsset = document();
  missingAsset.assetIds = [];
  assert.throws(() => parseNativeReportDocument(missingAsset), /assetIds/u);
});
