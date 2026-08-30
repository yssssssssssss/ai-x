import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlArtifact, ControlExecutionLease } from '../database/control-plane.ts';
import {
  createReportPublicationId,
  renderAndSealStandaloneHtml,
} from '../apps/orchestrator-runtime/src/report/report-v3-publication.ts';
import { REPORT_DOCUMENT_V3_FIXTURE_SHA, reportDocumentV3Fixture } from './fixtures/report-document-v3.ts';
import { REPORT_DOCUMENT_V4_FIXTURE_SHA, reportDocumentV4Fixture } from './fixtures/report-document-v4.ts';

const lease: ControlExecutionLease = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  leaseOwner: 'worker-1',
  leaseToken: 'token-1',
};

function documentArtifact(): ControlArtifact {
  return {
    id: 'document-1',
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    kind: 'report_document',
    state: 'SEALED',
    storageUri: '/safe/report-document.json',
    contentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
    byteSize: 10,
    schemaVersion: 'report-document-v3',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
  };
}

test('Report Publication identity is deterministic and changes with reviewed inputs', () => {
  const input = {
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    deliverableContentSha256: `sha256:${'a'.repeat(64)}`,
    reportReviewContentSha256: `sha256:${'b'.repeat(64)}`,
    reportDocumentVersion: 'report-document-v3' as const,
  };
  const first = createReportPublicationId(input);
  assert.equal(createReportPublicationId(input), first);
  assert.notEqual(createReportPublicationId({
    ...input,
    reportReviewContentSha256: `sha256:${'c'.repeat(64)}`,
  }), first);
  assert.match(first, /^report-publication-v1:[a-f0-9]{64}$/u);
});

test('Standalone HTML publication seals a bound text Artifact and reports ready', async () => {
  let writeInput: Record<string, unknown> | undefined;
  let tracked: ControlArtifact | undefined;
  const sealed: ControlArtifact = {
    ...documentArtifact(),
    id: 'html-1',
    kind: 'standalone_html_report',
    storageUri: '/safe/report.html',
    contentSha256: `sha256:${'d'.repeat(64)}`,
    schemaVersion: 'standalone-html-report-v1',
    mediaType: 'text/html; charset=utf-8',
  };
  const result = await renderAndSealStandaloneHtml({
    artifacts: {
      async writeText(input) {
        writeInput = input as unknown as Record<string, unknown>;
        return sealed;
      },
    },
    activeLease: lease,
    reportDocumentArtifact: documentArtifact(),
    document: reportDocumentV3Fixture(),
    onArtifactSealed: (artifact) => { tracked = artifact; },
  });

  assert.equal(result.standaloneHtml.status, 'ready');
  assert.equal(writeInput?.relativePath, 'reports/report.html');
  assert.match(String(writeInput?.content), new RegExp(REPORT_DOCUMENT_V3_FIXTURE_SHA));
  assert.equal(tracked?.id, 'html-1');
});

test('Standalone HTML publication accepts a sealed ReportDocument v4 Artifact', async () => {
  let html = '';
  const v4Artifact: ControlArtifact = {
    ...documentArtifact(),
    schemaVersion: 'report-document-v4',
    contentSha256: REPORT_DOCUMENT_V4_FIXTURE_SHA,
  };
  const result = await renderAndSealStandaloneHtml({
    artifacts: {
      async writeText(input) {
        html = input.content;
        return {
          ...v4Artifact,
          id: 'html-v4',
          kind: 'standalone_html_report',
          schemaVersion: 'standalone-html-report-v1',
          mediaType: 'text/html; charset=utf-8',
        };
      },
    },
    activeLease: lease,
    reportDocumentArtifact: v4Artifact,
    document: reportDocumentV4Fixture(),
  });

  assert.equal(result.standaloneHtml.status, 'ready');
  assert.match(html, /data-report-version="report-document-v4"/u);
  assert.match(html, new RegExp(REPORT_DOCUMENT_V4_FIXTURE_SHA));
});

test('Standalone HTML render/write failures degrade without publishing a partial Artifact', async () => {
  let writes = 0;
  const unsafe = await renderAndSealStandaloneHtml({
    artifacts: { async writeText() { writes += 1; return documentArtifact(); } },
    activeLease: lease,
    reportDocumentArtifact: documentArtifact(),
    document: reportDocumentV3Fixture(),
    assetPathById: new Map([['asset-1', '../unsafe.png']]),
  });
  assert.deepEqual(unsafe, {
    standaloneHtml: { status: 'unavailable', reasonCode: 'unsafe_output' },
  });
  assert.equal(writes, 0);

  const failed = await renderAndSealStandaloneHtml({
    artifacts: { async writeText() { throw new Error('disk unavailable'); } },
    activeLease: lease,
    reportDocumentArtifact: documentArtifact(),
    document: reportDocumentV3Fixture(),
  });
  assert.deepEqual(failed, {
    standaloneHtml: { status: 'unavailable', reasonCode: 'artifact_write_failed' },
  });
});
