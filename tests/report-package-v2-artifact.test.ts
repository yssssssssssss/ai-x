import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ControlArtifact, ControlExecutionLease } from '../database/control-plane.ts';
import { REPORT_REVIEW_V2_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';
import {
  parseReportPackageV2,
  type ReportPackageV2,
} from '../packages/api-contract/report-package.ts';
import {
  ReportPackageV2ArtifactService,
  type ReportPackageV2SealInput,
} from '../apps/orchestrator-runtime/src/report/report-package-v2-artifact.ts';
import type { ArtifactWriteInput } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  REPORT_DOCUMENT_V3_FIXTURE_SHA,
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';
import { reportDocumentV4Fixture } from './fixtures/report-document-v4.ts';

const TASK_ID = 'task-1';
const PLAN_ID = 'plan-1';
const ATTEMPT_ID = 'attempt-1';
const PUBLICATION_ID = 'report-publication-1';
const DOCUMENT_HASH = `sha256:${'b'.repeat(64)}`;
const HTML_HASH = `sha256:${'c'.repeat(64)}`;
const ASSET_HASH = `sha256:${'d'.repeat(64)}`;
const MANIFEST_HASH = `sha256:${'e'.repeat(64)}`;

const ACTIVE_LEASE: ControlExecutionLease = {
  taskId: TASK_ID,
  planVersionId: PLAN_ID,
  attemptId: ATTEMPT_ID,
  leaseOwner: 'worker-1',
  leaseToken: 'lease-1',
};

interface MemoryEntry {
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
  mediaType?: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/artifacts/${input.id}`,
    contentSha256: input.contentSha256 ?? `sha256:${'f'.repeat(64)}`,
    byteSize: 10,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    publicationId: null,
    mediaType: input.mediaType ?? null,
    metadata: null,
  };
}

class MemoryArtifacts {
  readonly entries = new Map<string, MemoryEntry>();
  readonly writes: ArtifactWriteInput[] = [];
  textReads = 0;
  binaryReads = 0;

  addJson(input: Parameters<typeof artifact>[0], value: unknown): void {
    this.entries.set(input.id, { artifact: artifact(input), value });
  }

  addText(input: Parameters<typeof artifact>[0], content: string): void {
    this.entries.set(input.id, { artifact: artifact(input), content });
  }

  addBinary(
    input: Parameters<typeof artifact>[0],
    metadata: NonNullable<MemoryEntry['metadata']>,
  ): void {
    this.entries.set(input.id, {
      artifact: { ...artifact({ ...input, mediaType: metadata.contentType }), byteSize: metadata.byteSize },
      bytes: Buffer.alloc(metadata.byteSize),
      metadata,
    });
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    const id = 'package-v2';
    const content = JSON.stringify(input.value);
    const sealed = artifact({
      id,
      kind: String(input.kind),
      schemaVersion: String(input.schemaVersion),
      contentSha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    sealed.storageUri = `/artifacts/${String(input.relativePath)}`;
    this.writes.push(input);
    this.entries.set(id, { artifact: sealed, value: input.value });
    return sealed;
  }

  async readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    const entry = this.entries.get(artifactId);
    if (!entry || entry.value === undefined) throw new Error(`missing JSON ${artifactId}`);
    return { artifact: entry.artifact, value: entry.value as T };
  }

  async readVerifiedBoundText(artifactId: string): Promise<{ artifact: ControlArtifact; content: string }> {
    this.textReads += 1;
    const entry = this.entries.get(artifactId);
    if (!entry || entry.content === undefined) throw new Error(`missing text ${artifactId}`);
    return { artifact: entry.artifact, content: entry.content };
  }

  async readVerifiedBinary(artifactId: string) {
    this.binaryReads += 1;
    const entry = this.entries.get(artifactId);
    if (!entry || !entry.bytes || !entry.metadata) throw new Error(`missing binary ${artifactId}`);
    return { artifact: entry.artifact, bytes: entry.bytes, metadata: entry.metadata };
  }
}

function seedCore(store: MemoryArtifacts): void {
  store.addJson({
    id: 'deliverable-1', kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated',
    contentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  }, {
    version: 'research-deliverable-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    evidenceManifestArtifactId: 'evidence-1',
  });
  store.addJson({ id: 'evidence-1', kind: 'evidence_manifest', schemaVersion: 'evidence-v1' }, {
    version: 'evidence-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
  });
  store.addJson({ id: 'review-1', kind: 'report_review', schemaVersion: 'report-review-v2' }, {
    version: 'report-review-v2', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    deliverableArtifactId: 'deliverable-1', verdict: 'pass', revisionRound: 0,
    dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
  });
  store.addJson({
    id: 'document-1', kind: 'report_document', schemaVersion: 'report-document-v3',
    contentSha256: DOCUMENT_HASH,
  }, reportDocumentV3Fixture());
  store.addJson({
    id: 'blueprint-1', kind: 'report_editorial_blueprint', schemaVersion: 'report-editorial-blueprint-v1',
  }, {
    version: 'report-editorial-blueprint-v1', style: 'analytical', density: 'comfortable',
    sections: [
      {
        headingMode: 'view_label', view: 'answers', prominence: 'primary',
        blocks: [{ presentation: 'record-table', unitRefs: ['matrix-1'], visibility: 'always' }],
      },
      {
        headingMode: 'view_label', view: 'topics', prominence: 'supporting',
        blocks: [{ presentation: 'graph', unitRefs: ['mind-model-1'], visibility: 'always', variant: 'linear' }],
      },
      {
        headingMode: 'view_label', view: 'actions', prominence: 'primary',
        blocks: [{ presentation: 'priority-board', unitRefs: ['actions-1'], visibility: 'always' }],
      },
    ],
  });
}

function sealInput(
  overrides: Partial<Omit<ReportPackageV2SealInput, 'activeLease'>> = {},
): ReportPackageV2SealInput {
  return {
    activeLease: ACTIVE_LEASE,
    reportPublicationId: PUBLICATION_ID,
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-1',
    reportReviewArtifactId: 'review-1',
    sourceReportDocumentArtifactId: 'document-1',
    sourceReportDocumentContentSha256: DOCUMENT_HASH,
    layout: { mode: 'fallback', blueprintArtifactId: 'blueprint-1', reasonCode: 'planner_disabled' },
    assetSnapshot: { assets: [], charts: [] },
    standaloneHtml: { status: 'unavailable', reasonCode: 'artifact_write_failed' },
    notices: reportDocumentV3Fixture().notices,
    ...overrides,
  };
}

function packageValue(): ReportPackageV2 {
  const input = sealInput();
  return {
    version: 'report-package-v2',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    reportPublicationId: input.reportPublicationId,
    presentationMode: 'multimodal',
    deliverableArtifactId: input.deliverableArtifactId,
    evidenceManifestArtifactId: input.evidenceManifestArtifactId,
    reportReviewArtifactId: input.reportReviewArtifactId,
    sourceReportDocumentArtifactId: input.sourceReportDocumentArtifactId,
    sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
    layout: input.layout,
    assetSnapshot: input.assetSnapshot,
    standaloneHtml: input.standaloneHtml,
    notices: input.notices,
  };
}

test('report-package-v2 parser rejects unknown fields, malformed unions, unsafe Assets, and block exports', () => {
  assert.deepEqual(parseReportPackageV2(packageValue()), packageValue());
  const modelLayout = { ...packageValue(), layout: { mode: 'model', blueprintArtifactId: 'blueprint-1' } };
  assert.equal(parseReportPackageV2(modelLayout).layout.mode, 'model');

  const unknown = { ...packageValue(), unexpected: true };
  assert.throws(() => parseReportPackageV2(unknown), /unexpected/u);

  const malformedLayout = structuredClone(packageValue()) as ReportPackageV2 & {
    layout: ReportPackageV2['layout'] & { reasonCode?: string };
  };
  malformedLayout.layout = { mode: 'model', blueprintArtifactId: 'blueprint-1', reasonCode: 'provider_failure' };
  assert.throws(() => parseReportPackageV2(malformedLayout), /layout.reasonCode/u);

  const blocked = structuredClone(packageValue()) as unknown as {
    assetSnapshot: { assets: Array<Record<string, unknown>> };
  };
  blocked.assetSnapshot.assets.push({
    assetId: 'asset-1', manifestArtifactId: 'manifest-1', contentSha256: ASSET_HASH,
    manifestHash: MANIFEST_HASH, relativePath: 'assets/asset.png', mediaType: 'image/png',
    sourceKind: 'visual_asset', exportPolicy: 'block', leafIds: ['leaf-1'],
  });
  assert.throws(() => parseReportPackageV2(blocked), /exportPolicy/u);

  blocked.assetSnapshot.assets[0].exportPolicy = 'allow';
  blocked.assetSnapshot.assets[0].relativePath = '../asset.png';
  assert.throws(() => parseReportPackageV2(blocked), /relativePath/u);

  const orphanChart = structuredClone(packageValue()) as unknown as {
    assetSnapshot: { charts: Array<Record<string, unknown>> };
  };
  orphanChart.assetSnapshot.charts.push({
    chartId: 'chart-1', chartSpecArtifactId: 'spec-1',
    chartSpecArtifactContentSha256: ASSET_HASH, specHash: MANIFEST_HASH,
    assetId: 'missing', leafIds: ['leaf-1'],
  });
  assert.throws(() => parseReportPackageV2(orphanChart), /assetId/u);
});

test('report-package-v2 seals and read-back verifies an A-core package with an empty Asset snapshot', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const service = new ReportPackageV2ArtifactService(store);
  const sealed = await service.seal(sealInput());

  assert.equal(sealed.id, 'package-v2');
  assert.equal(sealed.schemaVersion, 'report-package-v2');
  assert.equal(sealed.publicationId, null);
  assert.equal(Object.hasOwn(store.writes[0]!, 'publicationId'), false);
  assert.equal(store.textReads, 0, 'unavailable HTML is not read');
  assert.equal(store.binaryReads, 0, 'empty Asset snapshots are valid');
  assert.equal(store.writes[0]?.relativePath, 'reports/report-package.json');
  assert.deepEqual((store.writes[0]?.value as ReportPackageV2).assetSnapshot, { assets: [], charts: [] });
});

test('report-package-v2 seals and read-back verifies a ReportDocument v4 source', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const document = reportDocumentV4Fixture();
  document.layoutMode = 'fallback';
  store.addJson({
    id: 'document-1', kind: 'report_document', schemaVersion: 'report-document-v4',
    contentSha256: DOCUMENT_HASH,
  }, document);

  const service = new ReportPackageV2ArtifactService(store);
  const sealed = await service.seal(sealInput({ notices: document.notices }));
  const verified = await service.verify({
    artifactId: sealed.id,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    reportPublicationId: PUBLICATION_ID,
  });

  assert.equal(verified.value.sourceReportDocumentArtifactId, 'document-1');
  assert.equal(store.entries.get('document-1')?.artifact.schemaVersion, 'report-document-v4');

  const documentEntry = store.entries.get('document-1')!;
  documentEntry.artifact = { ...documentEntry.artifact, schemaVersion: 'report-document-v3' };
  await assert.rejects(
    service.verify({
      artifactId: sealed.id,
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
    }),
    /ReportDocument Artifact version/u,
  );
});

test('report-package-v2 reports its sealed root before read-back verification can fail', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const service = new ReportPackageV2ArtifactService(store);
  let sealedArtifact: ControlArtifact | undefined;

  await assert.rejects(
    service.seal(sealInput({
      sourceReportDocumentContentSha256: `sha256:${'0'.repeat(64)}`,
      onArtifactSealed: (artifactValue) => {
        sealedArtifact = artifactValue;
      },
    })),
    /ReportDocument hash/u,
  );

  assert.equal(sealedArtifact?.id, 'package-v2');
  assert.equal(sealedArtifact?.state, 'SEALED');
});

test('report-package-v2 ready HTML is read as bound text and rejects identity drift', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  store.addText({
    id: 'html-1', kind: 'standalone_html_report', schemaVersion: 'standalone-html-report-v1',
    contentSha256: HTML_HASH, mediaType: 'text/html; charset=utf-8',
  }, `<!doctype html><html><head><meta name="report-document-sha256" content="${DOCUMENT_HASH}"><meta name="report-renderer-version" content="standalone-html-v1"></head><body>report</body></html>`);
  const service = new ReportPackageV2ArtifactService(store);
  const ready = sealInput({
    standaloneHtml: { status: 'ready', artifactId: 'html-1', rendererVersion: 'standalone-html-v1' },
  });
  await service.seal(ready);
  assert.equal(store.textReads, 1);

  const html = store.entries.get('html-1')!;
  html.artifact = { ...html.artifact, mediaType: 'text/plain; charset=utf-8' };
  await assert.rejects(
    () => service.verify({
      artifactId: 'package-v2', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, reportPublicationId: PUBLICATION_ID,
    }),
    /standalone HTML identity/u,
  );
});

test('report-package-v2 verifies frozen Asset bytes and Manifest policy', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const documentEntry = store.entries.get('document-1')!;
  const document = structuredClone(documentEntry.value) as ReturnType<typeof reportDocumentV3Fixture>;
  document.sections[0]!.blocks.push({
    id: 'image-1', type: 'image', visibility: 'always', unitRefs: ['image-unit'],
    leafRefs: ['image-leaf'], leafRef: 'image-leaf',
    assetRef: { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
    caption: 'image', altText: 'image',
  });
  document.traceIndex['image-leaf'] = reportDocumentV3Trace('/image');
  document.semanticManifest.presentationUnitIds.push('image-unit');
  document.semanticManifest.leafUnitIds.push('image-leaf');
  document.semanticManifest.assetIds.push('asset-1');
  documentEntry.value = document;
  const imageBlueprint = store.entries.get('blueprint-1')!.value as {
    sections: Array<{ blocks: Array<Record<string, unknown>> }>;
  };
  imageBlueprint.sections[0]!.blocks.push({
    presentation: 'image', unitRefs: ['image-unit'], visibility: 'collapsible',
  });

  store.addBinary({
    id: 'asset-1', kind: 'visual_asset', schemaVersion: 'visual-asset-v1', contentSha256: ASSET_HASH,
  }, { contentType: 'image/png', byteSize: 10, width: 1, height: 1 });
  store.addJson({
    id: 'manifest-1', kind: 'visual_asset_manifest', schemaVersion: 'visual-asset-manifest-v1',
  }, {
    version: 'visual-asset-manifest-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    assetId: 'asset-1', contentSha256: ASSET_HASH, mediaType: 'image/png', byteSize: 10,
    width: 1, height: 1, exportPolicy: 'allow', source: { kind: 'user_upload', fileName: 'a.png' },
    derivedFrom: null, derivation: null, manifestHash: MANIFEST_HASH,
  });
  const service = new ReportPackageV2ArtifactService(store);
  const withAsset = sealInput({
    assetSnapshot: {
      assets: [{
        assetId: 'asset-1', manifestArtifactId: 'manifest-1', contentSha256: ASSET_HASH,
        manifestHash: MANIFEST_HASH, relativePath: 'assets/asset-1.png', mediaType: 'image/png',
        sourceKind: 'visual_asset', exportPolicy: 'allow', leafIds: ['image-leaf'],
      }],
      charts: [],
    },
  });
  await service.seal(withAsset);
  assert.equal(store.binaryReads, 1);

  (store.entries.get('manifest-1')!.value as { exportPolicy: string }).exportPolicy = 'block';
  await assert.rejects(
    () => service.verify({
      artifactId: 'package-v2', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, reportPublicationId: PUBLICATION_ID,
    }),
    /Manifest does not match/u,
  );
});

test('report-package-v2 verifies a chart SVG, Spec, Data, and Manifest as one frozen chain', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const specArtifactHash = `sha256:${'1'.repeat(64)}`;
  const specHash = `sha256:${'2'.repeat(64)}`;
  const dataHash = `sha256:${'3'.repeat(64)}`;
  const documentEntry = store.entries.get('document-1')!;
  const document = structuredClone(documentEntry.value) as ReturnType<typeof reportDocumentV3Fixture>;
  document.sections[0]!.blocks.push({
    id: 'chart-block', type: 'chart', visibility: 'always', unitRefs: ['chart-unit'],
    leafRefs: ['chart-leaf'], leafRef: 'chart-leaf',
    chartRef: { chartId: 'chart-1', assetId: 'chart-asset', manifestArtifactId: 'chart-manifest' },
    specHash,
    spec: {
      version: 'chart-spec-v1', chartId: 'chart-1', type: 'comparison', title: 'Chart',
      categories: ['A'], series: [{ key: 'value', label: 'Value', values: [1], evidenceIds: [[]] }],
    },
    table: {
      caption: 'Chart', columns: ['Series', 'A'],
      rows: [{ key: 'value', label: 'Value', cells: [1], evidenceIds: [[]] }],
    },
    caption: 'Chart', altText: 'Chart',
  });
  document.traceIndex['chart-leaf'] = reportDocumentV3Trace('/chart');
  document.semanticManifest.presentationUnitIds.push('chart-unit');
  document.semanticManifest.leafUnitIds.push('chart-leaf');
  document.semanticManifest.assetIds.push('chart-asset');
  documentEntry.value = document;
  const chartBlueprint = store.entries.get('blueprint-1')!.value as {
    sections: Array<{ blocks: Array<Record<string, unknown>> }>;
  };
  chartBlueprint.sections[0]!.blocks.push({
    presentation: 'chart', unitRefs: ['chart-unit'], visibility: 'collapsible',
  });

  store.addBinary({
    id: 'chart-asset', kind: 'visual_asset', schemaVersion: 'visual-asset-v1', contentSha256: ASSET_HASH,
  }, { contentType: 'image/svg+xml', byteSize: 10, width: 1, height: 1 });
  store.addJson({
    id: 'chart-manifest', kind: 'visual_asset_manifest', schemaVersion: 'visual-asset-manifest-v2',
  }, {
    version: 'visual-asset-manifest-v2', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    assetId: 'chart-asset', contentSha256: ASSET_HASH, mediaType: 'image/svg+xml', byteSize: 10,
    width: 1, height: 1, exportPolicy: 'allow',
    source: { kind: 'chart_render', dataArtifactId: 'chart-data', dataArtifactContentSha256: dataHash },
    derivedFrom: null, derivation: { kind: 'chart_svg', chartId: 'chart-1', specHash },
    manifestHash: MANIFEST_HASH,
  });
  store.addJson({
    id: 'chart-spec', kind: 'chart_spec', schemaVersion: 'verified-chart-v1',
    contentSha256: specArtifactHash,
  }, {
    version: 'verified-chart-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    chartId: 'chart-1', specHash,
    assetRef: { assetId: 'chart-asset', manifestArtifactId: 'chart-manifest' },
    dataArtifactRef: { artifactId: 'chart-data', contentSha256: dataHash },
  });
  store.addJson({
    id: 'chart-data', kind: 'chart_data', schemaVersion: 'competitive-weight-chart-data-v1',
    contentSha256: dataHash,
  }, { version: 'competitive-weight-chart-data-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID });

  const service = new ReportPackageV2ArtifactService(store);
  await service.seal(sealInput({
    assetSnapshot: {
      assets: [{
        assetId: 'chart-asset', manifestArtifactId: 'chart-manifest', contentSha256: ASSET_HASH,
        manifestHash: MANIFEST_HASH, relativePath: 'assets/chart-1.svg', mediaType: 'image/svg+xml',
        sourceKind: 'chart_svg', exportPolicy: 'allow', leafIds: ['chart-leaf'],
      }],
      charts: [{
        chartId: 'chart-1', chartSpecArtifactId: 'chart-spec',
        chartSpecArtifactContentSha256: specArtifactHash, specHash, assetId: 'chart-asset',
        dataArtifactRef: {
          artifactId: 'chart-data', contentSha256: dataHash,
          schemaVersion: 'competitive-weight-chart-data-v1',
        },
        leafIds: ['chart-leaf'],
      }],
    },
  }));

  assert.equal(store.binaryReads, 1);
});

test('report-package-v2 rejects source ReportDocument hash drift', async () => {
  const store = new MemoryArtifacts();
  seedCore(store);
  const service = new ReportPackageV2ArtifactService(store);
  await service.seal(sealInput());
  const document = store.entries.get('document-1')!;
  document.artifact = { ...document.artifact, contentSha256: `sha256:${'0'.repeat(64)}` };
  await assert.rejects(
    () => service.verify({
      artifactId: 'package-v2', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, reportPublicationId: PUBLICATION_ID,
    }),
    /ReportDocument hash/u,
  );

  const packageEntry = store.entries.get('package-v2')!;
  packageEntry.artifact = { ...packageEntry.artifact, storageUri: '/artifacts/reports/other.json' };
  await assert.rejects(
    () => service.verify({
      artifactId: 'package-v2', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, reportPublicationId: PUBLICATION_ID,
    }),
    /fixed Package path/u,
  );
});
