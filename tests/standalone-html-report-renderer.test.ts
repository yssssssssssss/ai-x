import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderStandaloneReport,
  STANDALONE_HTML_RENDERER_VERSION,
} from '../apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts';
import {
  REPORT_DOCUMENT_V3_FIXTURE_SHA,
  reportDocumentV3Fixture,
} from './fixtures/report-document-v3.ts';

test('standalone HTML renders typed v3 structure, audit, CSP, and print-safe disclosure', () => {
  const document = reportDocumentV3Fixture();
  const result = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  });

  assert.match(result.html, /^<!doctype html>/u);
  assert.match(result.html, /Content-Security-Policy/u);
  assert.match(result.html, /default-src 'none'/u);
  assert.match(result.html, /script-src 'none'/u);
  assert.match(result.html, new RegExp(`report-document-sha256" content="${REPORT_DOCUMENT_V3_FIXTURE_SHA}`));
  assert.match(result.html, new RegExp(`report-renderer-version" content="${STANDALONE_HTML_RENDERER_VERSION}`));
  assert.doesNotMatch(result.html, /<script(?:\s|>)/u);
  assert.match(result.html, /<table class="record-table">/u);
  assert.match(result.html, /graph-linear/u);
  assert.match(result.html, /priority-board/u);
  assert.match(result.html, /建立可信项目档案/u);
  assert.match(result.html, /分析审计附录/u);
  assert.match(result.html, /data-audit-record-id="audit-1"/u);
  assert.match(result.html, /data-print-audit-record-id="audit-1"/u);
  assert.match(result.html, /data-notice-id="notice-layout"/u);
  assert.match(result.html, /class="screen-disclosure"/u);
  assert.match(result.html, /class="print-disclosure"/u);
  assert.match(result.html, /focus-visible/u);
  assert.match(result.html, /@media print/u);
  assert.equal(result.renderManifest.rendererVersion, STANDALONE_HTML_RENDERER_VERSION);
  assert.deepEqual(result.renderManifest.semantics, document.semanticManifest);
});

test('standalone HTML context-escapes report text without adding script or network dependencies', () => {
  const document = reportDocumentV3Fixture();
  document.title = '<script>alert("x")</script>';
  document.sections[0]!.title = '<img src=x onerror=alert(1)>';
  const result = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  });
  assert.doesNotMatch(result.html, /<script>alert/u);
  assert.doesNotMatch(result.html, /<img src=x/u);
  assert.match(result.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u);
  assert.doesNotMatch(result.html, /https?:\/\//u);
});

test('standalone HTML applies style, density, prominence, and graph variants from v3', () => {
  const document = reportDocumentV3Fixture();
  document.style = 'analytical';
  document.density = 'compact';
  const graph = document.sections.flatMap(({ blocks }) => blocks).find((block) => block.type === 'graph');
  assert.equal(graph?.type, 'graph');
  if (graph?.type !== 'graph') return;
  graph.variant = 'hub_spoke';

  const hub = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  }).html;
  assert.match(hub, /<body class="report-style-analytical report-density-compact" data-report-style="analytical" data-report-density="compact">/u);
  assert.match(hub, /class="report-section section-primary"[^>]*data-prominence="primary"/u);
  assert.match(hub, /class="graph graph-hub_spoke" data-graph-variant="hub_spoke"/u);
  assert.match(hub, /\.graph-hub_spoke \.graph-node:first-child/u);
  assert.match(hub, /\.report-density-compact \.report-section/u);

  graph.variant = 'two_sided';
  const twoSided = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  }).html;
  assert.match(twoSided, /class="graph graph-two_sided" data-graph-variant="two_sided"/u);
  assert.match(twoSided, /\.graph-two_sided \.graph-node:nth-child\(odd\)/u);
});

test('standalone HTML rejects unsafe or colliding bundle asset paths before rendering', () => {
  const document = reportDocumentV3Fixture();
  assert.throws(() => renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    assetPathById: new Map([['unused', '../report.html']]),
  }), /unsafe/u);
  assert.throws(() => renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    assetPathById: new Map([
      ['asset-1', 'assets/shared.png'],
      ['asset-2', 'assets/shared.png'],
    ]),
  }), /unique/u);
});
