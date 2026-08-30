import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import type { ReportDocumentV4 } from '../packages/api-contract/report-document.ts';
import {
  renderStandaloneReport,
  STANDALONE_HTML_V4_RENDERER_VERSION,
} from '../apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts';
import {
  assertReportDocumentV4Integrity,
  collectReportDocumentV4Semantics,
  visitReportDocumentV4,
} from '../packages/report-rendering/report-document-visitor.ts';
import {
  assertEquivalentRenderSemanticsV2,
  createReportRenderManifestV2,
} from '../packages/report-rendering/report-render-manifest.ts';
import {
  REPORT_DOCUMENT_V4_FIXTURE_SHA,
  reportDocumentV4Fixture,
} from './fixtures/report-document-v4.ts';

const reportDocumentViewModulePath: string = '../apps/web/src/reporting/ReportDocumentView.tsx';

async function renderWebDocument(): Promise<string> {
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
      document: reportDocumentV4Fixture(),
      visualAssetManifests: [],
      taskId: 'task-v4',
      sourceReportDocumentContentSha256: REPORT_DOCUMENT_V4_FIXTURE_SHA,
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }
}

test('report-document-v4 validates embedded copy provenance and rich blocks', () => {
  const document = reportDocumentV4Fixture();
  new SchemaValidator().validateOrThrow('report-document', document);
  assert.doesNotThrow(() => assertReportDocumentV4Integrity(document));
  assert.deepEqual(collectReportDocumentV4Semantics(document), document.semanticManifest);

  const traversal = visitReportDocumentV4(document, {
    visitBlock(block) { return block.type; },
    visitSection(section, blocks) { return { id: section.id, blocks }; },
    visitNotice(notice) { return notice.id; },
    visitAuditRecord(record) { return record.id; },
  });
  assert.deepEqual(traversal.sections.map(({ blocks }) => blocks), [
    ['record-table'],
    ['stage-flow'],
    ['card-grid'],
  ]);
  assertEquivalentRenderSemanticsV2(document.semanticManifest, traversal.semantics);
  assert.equal(createReportRenderManifestV2({
    renderer: 'react',
    rendererVersion: 'react-report-document-v4',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V4_FIXTURE_SHA,
    document,
    semantics: traversal.semantics,
  }).version, 'report-render-manifest-v2');

  const unknown = structuredClone(document) as ReportDocumentV4 & { unexpected?: string };
  unknown.unexpected = 'not allowed';
  assert.throws(
    () => new SchemaValidator().validateOrThrow('report-document', unknown),
    /additional properties/u,
  );
});

test('report-document-v4 rejects fabricated or out-of-scope copy provenance', () => {
  const missingModelSource = reportDocumentV4Fixture();
  missingModelSource.title.sourceLeafIds = [];
  assert.throws(
    () => assertReportDocumentV4Integrity(missingModelSource),
    /model copy must cite at least one source leaf/u,
  );

  const fabricatedSystemSource = reportDocumentV4Fixture();
  fabricatedSystemSource.sections[1]!.title.sourceLeafIds = ['graph-n1'];
  assert.throws(
    () => assertReportDocumentV4Integrity(fabricatedSystemSource),
    /system copy cannot claim source leaf support/u,
  );

  const escapedBlockScope = reportDocumentV4Fixture();
  escapedBlockScope.sections[0]!.blocks[0]!.digest!.sourceLeafIds = ['action-1'];
  assert.throws(
    () => assertReportDocumentV4Integrity(escapedBlockScope),
    /outside its allowed scope/u,
  );
});

test('Standalone and Web render v4 copy, card grid, stage flow, disclosure, and print content', async () => {
  const document = reportDocumentV4Fixture();
  const standalone = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V4_FIXTURE_SHA,
  });
  assert.equal(standalone.renderManifest.version, 'report-render-manifest-v2');
  assert.equal(standalone.renderManifest.rendererVersion, STANDALONE_HTML_V4_RENDERER_VERSION);
  assert.match(standalone.html, /data-report-version="report-document-v4"/u);
  assert.match(standalone.html, /data-copy-fragment-id="copy-report-title"/u);
  assert.match(standalone.html, /data-copy-provenance="model"/u);
  assert.match(standalone.html, /class="card-grid"/u);
  assert.match(standalone.html, /class="stage-flow"/u);
  assert.match(standalone.html, /class="screen-disclosure section-disclosure section-supporting"/u);
  assert.match(standalone.html, /class="print-disclosure report-section section-supporting"/u);
  assert.match(standalone.html, /@media print/u);

  const web = await renderWebDocument();
  assert.match(web, /data-report-version="report-document-v4"/u);
  assert.match(web, /data-copy-fragment-id="copy-executive-summary"/u);
  assert.match(web, /class="report-card-grid"/u);
  assert.match(web, /class="report-stage-flow"/u);
  assert.match(web, /<details class="report-section report-section-disclosure"/u);
  assert.match(web, /从兴趣到信任/u);
});

test('v4 Renderer escapes model copy as text', () => {
  const document = reportDocumentV4Fixture();
  document.title.text = '<script>alert("copy")</script>';
  const html = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V4_FIXTURE_SHA,
  }).html;
  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;script&gt;alert\(&quot;copy&quot;\)&lt;\/script&gt;/u);
});
