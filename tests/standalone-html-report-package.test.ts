import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import type { ControlArtifact } from '../database/control-plane.ts';
import { REPORT_REVIEW_V2_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';
import type { ReportDocumentV3, ReportDocumentV4 } from '../packages/api-contract/report-document.ts';
import type { ReportPackageV2 } from '../packages/api-contract/report-package.ts';
import { EvidenceService } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  HtmlBundleIntegrityError,
  HtmlBundleUnavailableError,
  StandaloneHtmlReportPackageService,
} from '../apps/orchestrator-runtime/src/report/standalone-html-report-package.ts';
import {
  renderStandaloneReport,
  STANDALONE_HTML_RENDERER_VERSION,
} from '../apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts';
import {
  REPORT_DOCUMENT_V3_FIXTURE_SHA,
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';
import { reportDocumentV4Fixture } from './fixtures/report-document-v4.ts';
import {
  researchStrategyCoverageV2,
  researchStrategyFindingGraphV2,
  researchStrategyPayloadV2,
} from './fixtures/research-strategy-v2.ts';

const TASK_ID = 'task-1';
const PLAN_ID = 'plan-1';
const ATTEMPT_ID = 'attempt-1';
const DOCUMENT_HASH = `sha256:${'b'.repeat(64)}`;
const EVIDENCE_ARTIFACT_ID = 'evidence-source-1';
const EVIDENCE_ARTIFACT_VALUE = { excerpt: 'Verified source information is a decision signal.' };
const EVIDENCE_ARTIFACT_HASH = `sha256:${createHash('sha256')
  .update(JSON.stringify(EVIDENCE_ARTIFACT_VALUE))
  .digest('hex')}`;

interface Entry {
  artifact: ControlArtifact;
  value?: unknown;
  content?: string;
  bytes?: Buffer;
  metadata?: {
    contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
    byteSize: number;
    width: number;
    height: number;
  };
}

function artifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  contentSha256?: string;
  byteSize?: number;
  mediaType?: string;
  storageUri?: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    kind: input.kind,
    state: 'SEALED',
    storageUri: input.storageUri ?? `/sealed/${input.id}`,
    contentSha256: input.contentSha256 ?? `sha256:${'f'.repeat(64)}`,
    byteSize: input.byteSize ?? 10,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: input.mediaType ?? null,
    metadata: null,
  };
}

function reportPackage(overrides: Partial<ReportPackageV2> = {}): ReportPackageV2 {
  return {
    version: 'report-package-v2',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    reportPublicationId: 'publication-1',
    presentationMode: 'multimodal',
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-1',
    reportReviewArtifactId: 'review-1',
    sourceReportDocumentArtifactId: 'document-1',
    sourceReportDocumentContentSha256: DOCUMENT_HASH,
    layout: {
      mode: 'fallback',
      blueprintArtifactId: 'blueprint-1',
      reasonCode: 'planner_disabled',
    },
    assetSnapshot: { assets: [], charts: [] },
    standaloneHtml: {
      status: 'ready',
      artifactId: 'html-1',
      rendererVersion: STANDALONE_HTML_RENDERER_VERSION,
    },
    notices: reportDocumentV3Fixture().notices,
    ...overrides,
  };
}

class MemoryArtifacts {
  readonly entries = new Map<string, Entry>();
  readonly jsonReads: string[] = [];
  readonly textReads: string[] = [];
  readonly binaryReads: string[] = [];

  async readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.jsonReads.push(artifactId);
    const entry = this.entries.get(artifactId);
    if (!entry || entry.value === undefined) throw new Error(`missing JSON ${artifactId}`);
    return { artifact: entry.artifact, value: entry.value as T };
  }

  async readVerifiedBoundText(artifactId: string): Promise<{ artifact: ControlArtifact; content: string }> {
    this.textReads.push(artifactId);
    const entry = this.entries.get(artifactId);
    if (!entry || entry.content === undefined) throw new Error(`missing text ${artifactId}`);
    return { artifact: entry.artifact, content: entry.content };
  }

  async readVerifiedBinary(artifactId: string) {
    this.binaryReads.push(artifactId);
    const entry = this.entries.get(artifactId);
    if (!entry?.bytes || !entry.metadata) throw new Error(`missing binary ${artifactId}`);
    return { artifact: entry.artifact, bytes: entry.bytes, metadata: entry.metadata };
  }
}

function setup(input: { document?: ReportDocumentV3 | ReportDocumentV4; reportPackage?: ReportPackageV2 } = {}) {
  const document = input.document ?? reportDocumentV3Fixture();
  const value = input.reportPackage ?? reportPackage();
  const artifacts = new MemoryArtifacts();
  const evidenceArtifact = artifact({
    id: EVIDENCE_ARTIFACT_ID,
    kind: 'knowledge_output',
    schemaVersion: 'knowledge-output-v1',
    contentSha256: EVIDENCE_ARTIFACT_HASH,
  });
  const evidenceManifest = new EvidenceService().createManifest({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'knowledge_excerpt',
      evidenceClass: 'dataset',
      artifactId: EVIDENCE_ARTIFACT_ID,
      artifactContentSha256: EVIDENCE_ARTIFACT_HASH,
      jsonPointer: '/excerpt',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, {
    resolveArtifact: (artifactId) => artifactId === EVIDENCE_ARTIFACT_ID
      ? {
          artifact: { id: evidenceArtifact.id, contentSha256: evidenceArtifact.contentSha256! },
          value: EVIDENCE_ARTIFACT_VALUE,
        }
      : null,
  });
  const packageArtifact = artifact({
    id: 'package-1',
    kind: 'report_package',
    schemaVersion: 'report-package-v2',
  });
  artifacts.entries.set('package-1', { artifact: packageArtifact, value });
  artifacts.entries.set('document-1', {
    artifact: artifact({
      id: 'document-1',
      kind: 'report_document',
      schemaVersion: document.version,
      contentSha256: DOCUMENT_HASH,
    }),
    value: document,
  });
  artifacts.entries.set('deliverable-1', {
    artifact: artifact({
      id: 'deliverable-1',
      kind: 'deliverable',
      schemaVersion: 'research-deliverable-v1-review-gated',
    }),
    value: {
      version: 'research-deliverable-v1',
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      deliverableType: 'research_strategy_report',
      evidenceManifestArtifactId: 'evidence-1',
      methodSummary: 'reviewed synthesis',
      findingGraph: researchStrategyFindingGraphV2(),
      payload: researchStrategyPayloadV2(),
      recommendations: [{
        id: 'recommendation-Q1',
        statement: 'Ship a source-backed trust card.',
        summaryIds: ['summary-Q1'],
      }],
      coverage: researchStrategyCoverageV2(),
      risksAndOpenIssues: [],
      capabilityProvenance: [],
    },
  });
  artifacts.entries.set(EVIDENCE_ARTIFACT_ID, {
    artifact: evidenceArtifact,
    value: EVIDENCE_ARTIFACT_VALUE,
  });
  artifacts.entries.set('evidence-1', {
    artifact: artifact({ id: 'evidence-1', kind: 'evidence_manifest', schemaVersion: 'evidence-v1' }),
    value: evidenceManifest,
  });
  artifacts.entries.set('review-1', {
    artifact: artifact({
      id: 'review-1',
      kind: 'report_review',
      schemaVersion: 'report-review-v2',
      storageUri: '/sealed/reports/review-r0.json',
    }),
    value: {
      version: 'report-review-v2',
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      deliverableArtifactId: 'deliverable-1',
      verdict: 'pass',
      dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
      revisionRound: 0,
    },
  });
  const html = renderStandaloneReport({
    document,
    sourceReportDocumentContentSha256: DOCUMENT_HASH,
    assetPathById: new Map(value.assetSnapshot.assets.map((asset) => [asset.assetId, asset.relativePath])),
  }).html;
  artifacts.entries.set('html-1', {
    artifact: artifact({
      id: 'html-1',
      kind: 'standalone_html_report',
      schemaVersion: 'standalone-html-report-v1',
      mediaType: 'text/html; charset=utf-8',
      byteSize: Buffer.byteLength(html),
      contentSha256: `sha256:${createHash('sha256').update(html).digest('hex')}`,
    }),
    content: html,
  });
  let verifyCalls = 0;
  const reportPackages = {
    async verify() {
      verifyCalls += 1;
      return { artifact: packageArtifact, value };
    },
  };
  return {
    artifacts,
    get verifyCalls() { return verifyCalls; },
    service: new StandaloneHtmlReportPackageService({ artifacts, reportPackages }),
  };
}

function bundleInput() {
  return {
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    reportPackageArtifactId: 'package-1',
  };
}

test('builds a deterministic offline HTML Bundle from verified v2 package components', async () => {
  const first = setup();
  const second = setup();
  const firstBytes = await first.service.create(bundleInput());
  const secondBytes = await second.service.create(bundleInput());
  assert.deepEqual(firstBytes, secondBytes);

  const entries = unzipSync(firstBytes);
  assert.deepEqual(Object.keys(entries).sort(), [
    'deliverable.json',
    'evidence-manifest.json',
    'full-report.md',
    'render-manifest.json',
    'report-document.json',
    'report-review.json',
    'report.html',
  ]);
  assert.match(strFromU8(entries['report.html']!), /^<!doctype html>/u);
  assert.match(strFromU8(entries['full-report.md']!), /# 京东众筹频道策略报告/u);
  const exportedDocument = JSON.parse(strFromU8(entries['report-document.json']!)) as Record<string, unknown>;
  assert.equal(exportedDocument.version, 'report-document-v3');
  const manifest = JSON.parse(strFromU8(entries['render-manifest.json']!)) as Record<string, unknown>;
  assert.equal(manifest.renderer, 'standalone_html');
  assert.equal(manifest.sourceReportDocumentContentSha256, DOCUMENT_HASH);
  assert.doesNotMatch(strFromU8(entries['deliverable.json']!), /diagnosticReference|must-not-export/u);
  assert.doesNotMatch(strFromU8(entries['evidence-manifest.json']!), /internalPath|private\/evidence/u);
  assert.doesNotMatch(strFromU8(entries['report-review.json']!), /hiddenPrompt|receipt|must-not-export/u);
  assert.equal(first.verifyCalls, 1);
});

test('builds a v4 Bundle with safe JSON, editorial Markdown, and Render Manifest v2', async () => {
  const document = reportDocumentV4Fixture();
  const fixture = setup({
    document,
    reportPackage: reportPackage({ notices: document.notices }),
  });

  const entries = unzipSync(await fixture.service.create(bundleInput()));
  const exportedDocument = JSON.parse(strFromU8(entries['report-document.json']!)) as Record<string, unknown>;
  const renderManifest = JSON.parse(strFromU8(entries['render-manifest.json']!)) as Record<string, unknown>;
  const markdown = strFromU8(entries['full-report.md']!);

  assert.equal(exportedDocument.version, 'report-document-v4');
  assert.equal(renderManifest.version, 'report-render-manifest-v2');
  assert.match(markdown, /^# 从兴趣到信任：京东众筹增长策略/mu);
  assert.match(markdown, /建立可信项目档案/u);
  assert.match(strFromU8(entries['report.html']!), /data-report-version="report-document-v4"/u);
});

test('includes only immutable snapshot Asset paths and bytes referenced by the report', async () => {
  const document = structuredClone(reportDocumentV3Fixture());
  document.sections[0]!.blocks.push({
    id: 'block-image-1',
    type: 'image',
    title: '证据截图',
    visibility: 'always',
    unitRefs: ['image-unit-1'],
    leafRefs: ['image-leaf-1'],
    leafRef: 'image-leaf-1',
    assetRef: { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
    caption: '已验证截图',
    altText: '测试截图',
  });
  document.traceIndex['image-leaf-1'] = reportDocumentV3Trace('/payload/assets/0');
  document.semanticManifest.presentationUnitIds.push('image-unit-1');
  document.semanticManifest.leafUnitIds.push('image-leaf-1');
  document.semanticManifest.assetIds.push('asset-1');
  const bytes = Buffer.from([1, 2, 3, 4]);
  const assetHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const value = reportPackage({
    assetSnapshot: {
      assets: [{
        assetId: 'asset-1',
        manifestArtifactId: 'manifest-1',
        contentSha256: assetHash,
        manifestHash: `sha256:${'c'.repeat(64)}`,
        relativePath: 'assets/evidence.png',
        mediaType: 'image/png',
        sourceKind: 'visual_asset',
        exportPolicy: 'allow',
        leafIds: ['image-leaf-1'],
      }],
      charts: [],
    },
  });
  const fixture = setup({ document, reportPackage: value });
  fixture.artifacts.entries.set('asset-1', {
    artifact: artifact({
      id: 'asset-1',
      kind: 'visual_asset',
      schemaVersion: 'visual-asset-v1',
      contentSha256: assetHash,
      byteSize: bytes.byteLength,
      mediaType: 'image/png',
    }),
    bytes,
    metadata: { contentType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1 },
  });

  const entries = unzipSync(await fixture.service.create(bundleInput()));
  assert.deepEqual(Buffer.from(entries['assets/evidence.png']!), bytes);
  assert.deepEqual(fixture.artifacts.binaryReads, ['asset-1']);
  assert.match(strFromU8(entries['report.html']!), /src="assets\/evidence\.png"/u);
  assert.match(strFromU8(entries['full-report.md']!), /\]\(assets\/evidence\.png\)/u);
});

test('returns unavailable before verifying or reading HTML and Assets', async () => {
  const value = reportPackage({
    standaloneHtml: { status: 'unavailable', reasonCode: 'artifact_write_failed' },
  });
  const fixture = setup({ reportPackage: value });

  await assert.rejects(() => fixture.service.create(bundleInput()), HtmlBundleUnavailableError);
  assert.equal(fixture.verifyCalls, 0);
  assert.deepEqual(fixture.artifacts.jsonReads, ['package-1']);
  assert.deepEqual(fixture.artifacts.textReads, []);
  assert.deepEqual(fixture.artifacts.binaryReads, []);
});

test('preserves sealed HTML bytes without requiring the current Renderer to reproduce them', async () => {
  const fixture = setup();
  const historicalHtml = '<!doctype html><title>historical renderer output</title>';
  fixture.artifacts.entries.get('html-1')!.content = historicalHtml;

  const entries = unzipSync(await fixture.service.create(bundleInput()));
  assert.equal(strFromU8(entries['report.html']!), historicalHtml);
});

test('escapes Markdown control syntax and never accepts a content-provided image target', async () => {
  const document = structuredClone(reportDocumentV3Fixture());
  document.title = '# injected <script>alert(1)</script>';
  document.subtitle = '![remote](https://example.test/tracker.png)';
  const fixture = setup({ document });
  const entries = unzipSync(await fixture.service.create(bundleInput()));
  const markdown = strFromU8(entries['full-report.md']!);

  assert.doesNotMatch(markdown, /<script>/u);
  assert.doesNotMatch(markdown, /!\[remote\]\(https:\/\//u);
  assert.match(markdown, /\\# injected &lt;script&gt;/u);
  assert.ok(markdown.includes('\\!\\[remote\\]\\(https://example\\.test/tracker\\.png\\)'));
});

test('omits a failed optional audit sidecar and records a stable export Notice', async () => {
  const fixture = setup();
  fixture.artifacts.entries.delete('review-1');
  const entries = unzipSync(await fixture.service.create(bundleInput()));

  assert.equal(entries['report-review.json'], undefined);
  const manifest = JSON.parse(strFromU8(entries['render-manifest.json']!)) as {
    outputNotices: Array<{ code: string }>;
  };
  assert.deepEqual(manifest.outputNotices.map(({ code }) => code), ['export_attachment_omitted']);
});

test('strictly omits malformed optional sidecars without leaking internal fields or losing the core bundle', async () => {
  const cases: Array<{
    label: string;
    mutate(fixture: ReturnType<typeof setup>): void;
    omitted: string[];
    retained: string[];
  }> = [{
    label: 'Deliverable diagnostic field',
    mutate(fixture) {
      const entry = fixture.artifacts.entries.get('deliverable-1')!;
      (entry.value as Record<string, unknown>).diagnosticReference = 'private-diagnostic-path';
    },
    omitted: ['deliverable.json'],
    retained: ['evidence-manifest.json', 'report-review.json'],
  }, {
    label: 'Evidence internal path',
    mutate(fixture) {
      const entry = fixture.artifacts.entries.get('evidence-1')!;
      const manifest = entry.value as { entries: Array<Record<string, unknown>> };
      manifest.entries[0]!.internalPath = '/private/evidence.json';
    },
    omitted: ['deliverable.json', 'evidence-manifest.json'],
    retained: ['report-review.json'],
  }, {
    label: 'Evidence legacy redaction object',
    mutate(fixture) {
      const entry = fixture.artifacts.entries.get('evidence-1')!;
      const manifest = entry.value as { entries: Array<Record<string, unknown>> };
      manifest.entries[0]!.redaction = { status: 'not_required', policyVersion: 'v1' };
    },
    omitted: ['deliverable.json', 'evidence-manifest.json'],
    retained: ['report-review.json'],
  }, {
    label: 'Evidence Artifact hash drift',
    mutate(fixture) {
      const entry = fixture.artifacts.entries.get('evidence-1')!;
      const manifest = entry.value as { entries: Array<Record<string, unknown>> };
      manifest.entries[0]!.artifactContentSha256 = `sha256:${'0'.repeat(64)}`;
    },
    omitted: ['deliverable.json', 'evidence-manifest.json'],
    retained: ['report-review.json'],
  }, {
    label: 'Review prompt and receipt fields',
    mutate(fixture) {
      const entry = fixture.artifacts.entries.get('review-1')!;
      const review = entry.value as Record<string, unknown>;
      review.hiddenPrompt = 'private-system-prompt';
      review.receipt = 'private-model-receipt';
    },
    omitted: ['report-review.json'],
    retained: ['deliverable.json', 'evidence-manifest.json'],
  }];

  for (const candidate of cases) {
    const fixture = setup();
    candidate.mutate(fixture);
    const entries = unzipSync(await fixture.service.create(bundleInput()));

    for (const path of ['report.html', 'report-document.json', 'full-report.md']) {
      assert.ok(entries[path], `${candidate.label}: missing core ${path}`);
    }
    for (const path of candidate.omitted) {
      assert.equal(entries[path], undefined, `${candidate.label}: ${path} must be omitted`);
    }
    for (const path of candidate.retained) {
      assert.ok(entries[path], `${candidate.label}: ${path} should remain exportable`);
    }
    const manifest = JSON.parse(strFromU8(entries['render-manifest.json']!)) as {
      outputNotices: Array<{ code: string }>;
    };
    assert.deepEqual(
      manifest.outputNotices.map(({ code }) => code),
      ['export_attachment_omitted'],
      candidate.label,
    );
    const archiveText = Object.values(entries).map((bytes) => strFromU8(bytes)).join('\n');
    assert.doesNotMatch(
      archiveText,
      /private-diagnostic-path|private\/evidence\.json|private-system-prompt|private-model-receipt/u,
      candidate.label,
    );
  }
});
