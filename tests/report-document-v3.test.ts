import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReportDocumentV3 } from '../packages/api-contract/report-document.ts';
import {
  assertReportDocumentV3Integrity,
  collectReportDocumentV3Semantics,
  visitReportDocumentV3,
} from '../packages/report-rendering/report-document-visitor.ts';
import {
  assertEquivalentRenderSemantics,
  createReportRenderManifestV1,
} from '../packages/report-rendering/report-render-manifest.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  REPORT_DOCUMENT_V3_FIXTURE_SHA,
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';

test('report-document-v3 schema and semantic integrity accept typed editorial blocks', () => {
  const document = reportDocumentV3Fixture();
  new SchemaValidator().validateOrThrow('report-document', document);
  assert.doesNotThrow(() => assertReportDocumentV3Integrity(document));
  assert.deepEqual(collectReportDocumentV3Semantics(document), document.semanticManifest);
});

test('report-document-v3 schema rejects unknown fields without changing legacy schema routing', () => {
  const document = reportDocumentV3Fixture() as ReportDocumentV3 & { unexpected?: string };
  document.unexpected = 'not allowed';
  assert.throws(
    () => new SchemaValidator().validateOrThrow('report-document', document),
    /additional properties/u,
  );
});

test('shared visitor traverses every v3 block and produces renderer semantics', () => {
  const document = reportDocumentV3Fixture();
  const visited: string[] = [];
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      visited.push(block.id);
      return block.type;
    },
    visitSection(section, blocks) {
      return { id: section.id, blocks };
    },
    visitNotice(notice) {
      return notice;
    },
    visitAuditRecord(record) {
      return record;
    },
  });
  assert.deepEqual(visited, ['block-table-001', 'block-graph-001', 'block-priority-001']);
  assert.equal(traversal.sections.length, 3);
  assertEquivalentRenderSemantics(document.semanticManifest, traversal.semantics);

  const manifest = createReportRenderManifestV1({
    renderer: 'standalone_html',
    rendererVersion: 'standalone-html-v1',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    document,
    semantics: traversal.semantics,
  });
  assert.deepEqual(manifest.semantics, document.semanticManifest);
  assert.throws(() => createReportRenderManifestV1({
    renderer: 'standalone_html',
    rendererVersion: 'standalone-html-v1',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    document,
    semantics: {
      ...traversal.semantics,
      leafUnitIds: traversal.semantics.leafUnitIds.slice(1),
    },
  }), /not semantically equivalent/u);
});

test('render manifest rejects a block skipped by the renderer visitor', () => {
  const document = reportDocumentV3Fixture();
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      return block.id === 'block-table-001' ? null : block.type;
    },
    visitSection(section, blocks) {
      return { id: section.id, blocks };
    },
    visitNotice(notice) {
      return notice;
    },
    visitAuditRecord(record) {
      return record;
    },
  });

  assert.throws(() => createReportRenderManifestV1({
    renderer: 'standalone_html',
    rendererVersion: 'standalone-html-v1',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    document,
    semantics: traversal.semantics,
  }), /presentationUnitIds.*not semantically equivalent/u);
});

test('render manifest rejects an audit record skipped by the renderer visitor', () => {
  const document = reportDocumentV3Fixture();
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      return block.type;
    },
    visitSection(section, blocks) {
      return { id: section.id, blocks };
    },
    visitNotice(notice) {
      return notice;
    },
    visitAuditRecord() {
      return null;
    },
  });

  assert.throws(() => createReportRenderManifestV1({
    renderer: 'standalone_html',
    rendererVersion: 'standalone-html-v1',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    document,
    semantics: traversal.semantics,
  }), /auditRecordIds.*not semantically equivalent/u);
});

test('render manifest rejects a notice skipped by the renderer visitor', () => {
  const document = reportDocumentV3Fixture();
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      return block.type;
    },
    visitSection(section, blocks) {
      return { id: section.id, blocks };
    },
    visitNotice() {
      return null;
    },
    visitAuditRecord(record) {
      return record;
    },
  });

  assert.throws(() => createReportRenderManifestV1({
    renderer: 'standalone_html',
    rendererVersion: 'standalone-html-v1',
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    document,
    semantics: traversal.semantics,
  }), /noticeIds.*not semantically equivalent/u);
});

test('v3 integrity rejects orphan, duplicate, and non-rendered leaf ownership', () => {
  const orphan = structuredClone(reportDocumentV3Fixture());
  orphan.semanticManifest.leafUnitIds.push('orphan-leaf');
  assert.throws(() => assertReportDocumentV3Integrity(orphan), /leafUnitIds/u);

  const duplicate = structuredClone(reportDocumentV3Fixture());
  duplicate.sections[1]!.blocks[0]!.unitRefs = ['matrix-1'];
  duplicate.semanticManifest.presentationUnitIds = ['matrix-1', 'actions-1'];
  assert.throws(() => assertReportDocumentV3Integrity(duplicate), /presentation unit owner/u);

  const hidden = structuredClone(reportDocumentV3Fixture());
  hidden.sections[0]!.blocks[0]!.leafRefs.push('ghost-leaf');
  hidden.traceIndex['ghost-leaf'] = reportDocumentV3Trace('/ghost');
  hidden.semanticManifest.leafUnitIds.push('ghost-leaf');
  assert.throws(() => assertReportDocumentV3Integrity(hidden), /displayed leaf references/u);
});

test('v3 integrity rejects graph edges that point outside their block', () => {
  const document = structuredClone(reportDocumentV3Fixture());
  const graph = document.sections[1]!.blocks[0]!;
  assert.equal(graph.type, 'graph');
  if (graph.type !== 'graph') throw new Error('fixture graph block missing');
  graph.edges[0]!.to = 'node-missing';
  assert.throws(() => assertReportDocumentV3Integrity(document), /outside the block/u);
});
