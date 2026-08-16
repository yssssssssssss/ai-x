import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { ReportDocument } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import type {
  ChartSpec,
  EvidenceManifest,
  VisualAssetManifest,
} from '../packages/api-contract/research-deliverable.ts';
import type { ChartTableAlternative } from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';

const taskId = 'task-report-bundle-1';
const planVersionId = 'plan-report-bundle-1';
const attemptId = 'attempt-report-bundle-1';
const originalAssetId = 'asset-original';
const annotationAssetId = 'asset-annotation';
const chartAssetId = 'asset-chart';
const blockedAssetId = 'asset-blocked';
const originalManifestArtifactId = 'manifest-original';
const annotationManifestArtifactId = 'manifest-annotation';
const chartManifestArtifactId = 'manifest-chart';
const blockedManifestArtifactId = 'manifest-blocked';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const ANNOTATED_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7, 8]);
const BLOCKED_PNG = new TextEncoder().encode('blocked-private-image');
const CHART_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><text>87</text></svg>',
);

interface MultimodalReportFixture {
  presentationMode: 'multimodal';
  deliverable: Record<string, unknown>;
  evidenceManifest: EvidenceManifest & Record<string, unknown>;
  reportReview: Record<string, unknown>;
  reportDocument: ReportDocument;
  visualAssetManifests: VisualAssetManifest[];
}

interface ReportBundleModule {
  createReportBundle(input: {
    report: MultimodalReportFixture;
    readAsset(input: { taskId: string; assetId: string }): Promise<{
      bytes: Uint8Array;
      mediaType: VisualAssetManifest['mediaType'];
    }>;
  }): Promise<Uint8Array>;
}

type BundleAssetReader = (input: { taskId: string; assetId: string }) => Promise<{
  bytes: Uint8Array;
  mediaType: VisualAssetManifest['mediaType'];
}>;

interface ViewBlock {
  id: string;
  kind: string;
  altText?: string;
  evidenceIds?: string[];
  spec?: ChartSpec;
  table?: unknown;
  originalAssetId?: string;
  annotationAssetId?: string;
}

interface ReportDocumentViewModule {
  ReportDocumentView: unknown;
  createReportTableShape(table: ChartTableAlternative): {
    headers: Array<{ id: string; label: string; scope: 'col' }>;
    rows: Array<{
      key: string;
      header: { id: string; label: string; scope: 'row'; headers: string[] };
      cells: Array<{ value: number | null; headers: string[] }>;
    }>;
  };
  createReportDocumentViewModel(input: {
    document: ReportDocument;
    visualAssetManifests: VisualAssetManifest[];
    assetUrl(input: { assetId: string }): string;
  }): {
    navigation: Array<{ id: string; title: string }>;
    sections: Array<{ id: string; blocks: ViewBlock[] }>;
  };
  createReportDocumentInteractionState(): {
    expandedEvidence: ReadonlySet<string>;
    imageVariants: Readonly<Record<string, 'original' | 'annotation'>>;
    imageZoom: Readonly<Record<string, number>>;
  };
  reduceReportDocumentInteraction(
    state: ReturnType<ReportDocumentViewModule['createReportDocumentInteractionState']>,
    action:
      | { type: 'toggle-evidence'; blockId: string }
      | { type: 'select-image-variant'; blockId: string; variant: 'original' | 'annotation' }
      | { type: 'set-image-zoom'; blockId: string; zoom: number },
  ): ReturnType<ReportDocumentViewModule['createReportDocumentInteractionState']>;
}

interface Stage4Module {
  selectCurrentStage4Renderer(report: unknown): {
    component: 'CurrentTextReport' | 'ReportDocumentView';
    reportDocument?: ReportDocument;
  };
}

const reportBundleModulePath: string = '../apps/web/src/reporting/report-bundle.ts';
const reportDocumentViewModulePath: string = '../apps/web/src/reporting/ReportDocumentView.tsx';
const stage4ModulePath: string = '../apps/web/src/components/stages/CurrentStage4Report.tsx';
const printStylesheet = new URL('../apps/web/src/reporting/report-print.css', import.meta.url);

async function loadReportBundleModule(): Promise<ReportBundleModule> {
  const exports = await import(reportBundleModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof exports.createReportBundle, 'function', 'report-bundle must export createReportBundle');
  return exports as unknown as ReportBundleModule;
}

async function loadReportDocumentViewModule(): Promise<ReportDocumentViewModule> {
  const exports = await import(reportDocumentViewModulePath) as unknown as Record<string, unknown>;
  assert.equal(
    typeof exports.createReportDocumentViewModel,
    'function',
    'ReportDocumentView must expose its pure block mapping for focused Node tests',
  );
  assert.equal(typeof exports.createReportDocumentInteractionState, 'function');
  assert.equal(typeof exports.createReportTableShape, 'function');
  assert.equal(typeof exports.reduceReportDocumentInteraction, 'function');
  assert.equal(typeof exports.ReportDocumentView, 'function');
  return exports as unknown as ReportDocumentViewModule;
}

async function loadStage4Module(): Promise<Stage4Module> {
  const exports = await import(stage4ModulePath) as unknown as Record<string, unknown>;
  assert.equal(
    typeof exports.selectCurrentStage4Renderer,
    'function',
    'Stage4 must expose its presentation-mode dispatch decision',
  );
  return exports as unknown as Stage4Module;
}

function chartSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'competitor-score',
    type: 'comparison',
    title: 'Verified competitor score',
    categories: ['Score'],
    series: [{
      key: 'competitor:a',
      label: 'Competitor A',
      values: [87],
      evidenceIds: [['evidence-1']],
    }],
    yAxis: { min: 0 },
  };
}

function reportDocument(): ReportDocument {
  const spec = chartSpec();
  return {
    version: 'report-document-v1',
    title: 'Verified market report',
    subtitle: 'Evidence-bound multimodal report',
    executiveSummary: 'Verified evidence supports a focused market opportunity.',
    sections: [{
      id: 'cover',
      title: 'Cover',
      questionIds: [],
      blocks: [{ id: 'cover-title', type: 'paragraph', text: 'Verified market report' }],
    }, {
      id: 'key-metrics',
      title: 'Key metrics',
      questionIds: [],
      blocks: [{
        id: 'metric-1',
        type: 'metric',
        label: 'Competitor A score',
        value: 87,
        evidenceIds: ['evidence-1'],
      }],
    }, {
      id: 'findings',
      title: 'Findings',
      questionIds: [],
      blocks: [{
        id: 'finding-1',
        type: 'fact',
        text: 'Competitor A has the highest verified score.',
        evidenceIds: ['evidence-1'],
      }],
    }, {
      id: 'visual-evidence',
      title: 'Visual evidence',
      questionIds: [],
      blocks: [{
        id: 'image-1',
        type: 'image',
        assetRef: { assetId: originalAssetId, manifestArtifactId: originalManifestArtifactId },
        caption: 'Verified source image',
        altText: 'Product comparison source captured from verified evidence.',
      }, {
        id: 'image-blocked',
        type: 'image',
        assetRef: { assetId: blockedAssetId, manifestArtifactId: blockedManifestArtifactId },
        caption: 'Blocked internal source image',
        altText: 'Internal source image that is not exportable.',
      }],
    }, {
      id: 'comparison',
      title: 'Comparison',
      questionIds: ['question-1'],
      blocks: [{
        id: 'comparison-1',
        type: 'image-comparison',
        beforeAssetRef: { assetId: originalAssetId, manifestArtifactId: originalManifestArtifactId },
        afterAssetRef: { assetId: annotationAssetId, manifestArtifactId: annotationManifestArtifactId },
        caption: 'Original and annotated evidence',
        altText: 'Original evidence compared with its verified annotation.',
      }, {
        id: 'chart-1',
        type: 'chart',
        chartRef: {
          chartId: spec.chartId,
          assetId: chartAssetId,
          manifestArtifactId: chartManifestArtifactId,
        },
        specHash: `sha256:${'c'.repeat(64)}`,
        spec,
        table: {
          caption: spec.title,
          columns: ['Series', 'Score'],
          rows: [{
            key: 'competitor:a',
            label: 'Competitor A',
            cells: [87],
            evidenceIds: [['evidence-1']],
          }],
        },
        caption: spec.title,
        altText: 'Competitor A has a verified score of 87.',
      }],
    }, {
      id: 'recommendations',
      title: 'Recommendations',
      questionIds: [],
      blocks: [{ id: 'recommendation-1', type: 'paragraph', text: 'Prioritize the verified opportunity.' }],
    }, {
      id: 'risks',
      title: 'Risks',
      questionIds: [],
      blocks: [{ id: 'risk-1', type: 'paragraph', text: 'Public pricing can change.' }],
    }, {
      id: 'appendix',
      title: 'Evidence',
      questionIds: [],
      blocks: [{ id: 'evidence-index', type: 'list', items: ['evidence-1: verified dataset evidence'] }],
    }],
  };
}

function visualManifest(input: {
  assetId: string;
  mediaType: VisualAssetManifest['mediaType'];
  exportPolicy: VisualAssetManifest['exportPolicy'];
  source?: VisualAssetManifest['source'];
  derivedFrom?: VisualAssetManifest['derivedFrom'];
  derivation?: VisualAssetManifest['derivation'];
}): VisualAssetManifest {
  return {
    version: 'visual-asset-manifest-v1',
    taskId,
    planVersionId,
    attemptId,
    assetId: input.assetId,
    contentSha256: `sha256:${'a'.repeat(64)}`,
    mediaType: input.mediaType,
    byteSize: input.mediaType === 'image/svg+xml' ? CHART_SVG.byteLength : PNG.byteLength,
    width: input.mediaType === 'image/svg+xml' ? 800 : 1,
    height: input.mediaType === 'image/svg+xml' ? 450 : 1,
    exportPolicy: input.exportPolicy,
    source: input.source ?? { kind: 'user_upload', fileName: `${input.assetId}.png` },
    derivedFrom: input.derivedFrom ?? null,
    derivation: input.derivation ?? null,
    manifestHash: `sha256:${'f'.repeat(64)}`,
  };
}

function visualAssetManifests(): VisualAssetManifest[] {
  const original = visualManifest({
    assetId: originalAssetId,
    mediaType: 'image/png',
    exportPolicy: 'allow',
    source: {
      kind: 'tool_artifact',
      artifactId: 'private-tool-artifact',
      artifactContentSha256: `sha256:${'1'.repeat(64)}`,
      jsonPointer: '/output/private/path',
      url: 'https://evidence.example.test/source?token=secret-token',
    },
  });
  const annotation = visualManifest({
    assetId: annotationAssetId,
    mediaType: 'image/png',
    exportPolicy: 'mask',
    source: { kind: 'derived' },
    derivedFrom: {
      assetId: original.assetId,
      manifestArtifactId: originalManifestArtifactId,
      contentSha256: original.contentSha256,
      manifestHash: original.manifestHash,
    },
    derivation: { kind: 'annotation', overlayArtifactId: 'private-overlay-artifact' },
  });
  const chart = visualManifest({
    assetId: chartAssetId,
    mediaType: 'image/svg+xml',
    exportPolicy: 'allow',
    source: { kind: 'derived' },
    derivedFrom: {
      assetId: original.assetId,
      manifestArtifactId: originalManifestArtifactId,
      contentSha256: original.contentSha256,
      manifestHash: original.manifestHash,
    },
    derivation: {
      kind: 'chart_svg',
      chartId: chartSpec().chartId,
      specHash: `sha256:${'c'.repeat(64)}`,
    },
  });
  const blocked = visualManifest({
    assetId: blockedAssetId,
    mediaType: 'image/png',
    exportPolicy: 'block',
    source: { kind: 'user_upload', fileName: 'private-secret-token.png' },
  });
  return [blocked, chart, original, annotation];
}

function multimodalReport(): MultimodalReportFixture {
  const evidenceManifest: EvidenceManifest & Record<string, unknown> = {
    version: 'evidence-v1',
    taskId,
    planVersionId,
    attemptId,
    collectedAt: '2026-08-16T00:00:00.000Z',
    manifestHash: `sha256:${'e'.repeat(64)}`,
    storageUri: '/private/artifacts/evidence-manifest.json',
    entries: [{
      id: 'evidence-1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: 'private-evidence-artifact',
      artifactContentSha256: `sha256:${'d'.repeat(64)}`,
      jsonPointer: '/private/value',
      sourceUrl: 'https://evidence.example.test/source?token=secret-token',
      sensitivity: 'internal',
      redaction: 'none',
      toolProof: {
        implementationId: 'verified-tool',
        executionMode: 'real',
        redactedOutputHash: `sha256:${'b'.repeat(64)}`,
      },
    }],
  };
  return {
    presentationMode: 'multimodal',
    deliverable: {
      version: 'research-deliverable-v1',
      taskId,
      planVersionId,
      attemptId,
      secretToken: 'secret-token',
    },
    evidenceManifest,
    reportReview: {
      version: 'report-review-v1',
      taskId,
      planVersionId,
      attemptId,
      deliverableArtifactId: 'deliverable-private-artifact',
      verdict: 'pass',
      dimensions: [
        'requirement_coverage',
        'question_coverage',
        'evidence_coverage',
        'reasoning_quality',
        'recommendation_quality',
        'visual_quality',
        'risk_disclosure',
      ].map((id) => ({ id, passed: true, issues: [] })),
      revisionRound: 0,
      storageUri: '/private/artifacts/report-review.json',
    },
    reportDocument: reportDocument(),
    visualAssetManifests: visualAssetManifests(),
  };
}

function assetReader(reads: string[]): BundleAssetReader {
  const bytes = new Map<string, { bytes: Uint8Array; mediaType: VisualAssetManifest['mediaType'] }>([
    [originalAssetId, { bytes: PNG, mediaType: 'image/png' }],
    [annotationAssetId, { bytes: ANNOTATED_PNG, mediaType: 'image/png' }],
    [chartAssetId, { bytes: CHART_SVG, mediaType: 'image/svg+xml' }],
    [blockedAssetId, { bytes: BLOCKED_PNG, mediaType: 'image/png' }],
  ]);
  return async (input: { taskId: string; assetId: string }) => {
    assert.equal(input.taskId, taskId, 'bundle reads must stay on the owner task route');
    reads.push(input.assetId);
    const value = bytes.get(input.assetId);
    assert.ok(value, `missing bytes for ${input.assetId}`);
    return value;
  };
}

interface FflateModule {
  unzipSync(bytes: Uint8Array): Record<string, Uint8Array>;
  strFromU8(bytes: Uint8Array): string;
}

async function unzip(bytes: Uint8Array): Promise<{
  entries: Record<string, Uint8Array>;
  text(path: string): string;
}> {
  const fflateModuleName: string = 'fflate';
  const fflate = await import(fflateModuleName) as unknown as FflateModule;
  const entries = fflate.unzipSync(bytes);
  return {
    entries,
    text(path: string): string {
      const value = entries[path];
      assert.ok(value, `ZIP entry ${path} must exist`);
      return fflate.strFromU8(value);
    },
  };
}

function allText(entries: Record<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  return Object.entries(entries)
    .filter(([path]) => !path.endsWith('.png'))
    .map(([path, bytes]) => `${path}\n${decoder.decode(bytes)}`)
    .join('\n');
}

test('Markdown bundle contains the complete safe report package and only exportable owner-read assets', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const reads: string[] = [];
  const bytes = await createReportBundle({ report: multimodalReport(), readAsset: assetReader(reads) });
  const bundle = await unzip(bytes);

  assert.deepEqual(Object.keys(bundle.entries).sort(), [
    'assets/',
    'assets/asset-annotation.png',
    'assets/asset-chart.svg',
    'assets/asset-original.png',
    'evidence-manifest.json',
    'report-document.json',
    'report-review.json',
    'report.md',
    'visual-assets.json',
  ]);
  assert.deepEqual(reads.sort(), [annotationAssetId, chartAssetId, originalAssetId]);
  assert.equal(blockedAssetId in bundle.entries, false);
  assert.equal(reads.includes(blockedAssetId), false, 'blocked assets must be rejected before owner route reads');
  assert.deepEqual(bundle.entries['assets/asset-chart.svg'], CHART_SVG, 'bundle must carry the sealed SVG bytes');
});

test('Markdown uses deterministic relative image paths, sealed SVG references, and Chart table alternatives', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const bytes = await createReportBundle({ report: multimodalReport(), readAsset: assetReader([]) });
  const bundle = await unzip(bytes);
  const markdown = bundle.text('report.md');

  assert.match(markdown, /!\[Product comparison source captured from verified evidence\.\]\(assets\/asset-original\.png\)/u);
  assert.match(markdown, /assets\/asset-annotation\.png/u);
  assert.match(markdown, /!\[Competitor A has a verified score of 87\.\]\(assets\/asset-chart\.svg\)/u);
  assert.match(markdown, /\|\s*Competitor A\s*\|\s*87\s*\|/u, 'Chart table alternative must remain editable');
  const chartBlock = reportDocument().sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart');
  assert.ok(chartBlock?.type === 'chart');
  const markdownTableLines = markdown.split('\n').filter((line) => line.startsWith('|'));
  const markdownCells = (line: string): string[] => line.split('|').slice(1, -1).map((cell) => cell.trim());
  assert.deepEqual(markdownCells(markdownTableLines[0] ?? ''), chartBlock.table.columns);
  assert.equal(markdownCells(markdownTableLines[1] ?? '').length, chartBlock.table.columns.length);
  assert.deepEqual(
    markdownCells(markdownTableLines[2] ?? ''),
    [chartBlock.table.rows[0]!.label, ...chartBlock.table.rows[0]!.cells.map(String)],
  );
  assert.match(markdown, /evidence-1/u);
  assert.doesNotMatch(markdown, /(?:src|href)=|blob:|file:|https?:\/\/|\/private\//iu);
  assert.doesNotMatch(markdown, /asset-blocked|Blocked internal source image/u);
});

test('bundle JSON files are distribution-safe and do not leak storage URIs, hashes, secrets, or blocked metadata', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const bytes = await createReportBundle({ report: multimodalReport(), readAsset: assetReader([]) });
  const bundle = await unzip(bytes);
  const text = allText(bundle.entries);

  assert.doesNotMatch(text, /storageUri|contentSha256|manifestHash|artifactContentSha256|redactedOutputHash|specHash/u);
  assert.doesNotMatch(text, /sha256:|\/private\/|secret-token|token=/u);
  assert.doesNotMatch(text, /asset-blocked|private-secret-token/u);

  const visualAssets = JSON.parse(bundle.text('visual-assets.json')) as Array<Record<string, unknown>>;
  assert.deepEqual(visualAssets.map(({ assetId }) => assetId), [
    annotationAssetId,
    chartAssetId,
    originalAssetId,
  ]);
  for (const asset of visualAssets) {
    assert.deepEqual(Object.keys(asset).sort(), [
      'assetId',
      'byteSize',
      'exportPolicy',
      'height',
      'mediaType',
      'width',
    ]);
  }
});

test('bundle JSON and Markdown remove internal Artifact provenance from Evidence lists but retain safe Evidence content', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const report = multimodalReport();
  const appendix = report.reportDocument.sections.find(({ id }) => id === 'appendix');
  assert.ok(appendix);
  appendix.blocks = [{
    id: 'evidence-index',
    type: 'list',
    items: [
      'evidence-1: dataset Evidence from Artifact private-evidence-artifact. Provenance modelCallId model-call-private.',
    ],
  }];

  const bytes = await createReportBundle({ report, readAsset: assetReader([]) });
  const bundle = await unzip(bytes);
  const exported = [bundle.text('report-document.json'), bundle.text('report.md')];

  for (const text of exported) {
    assert.match(text, /evidence-1/u);
    assert.match(text, /dataset Evidence/u);
    assert.doesNotMatch(
      text,
      /private-evidence-artifact|model-call-private|modelCallId|Provenance|from Artifact/iu,
    );
  }
});

test('bundle bytes and filenames are deterministic across input manifest order and asset read timing', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const first = multimodalReport();
  const second = multimodalReport();
  second.visualAssetManifests.reverse();

  const firstBytes = await createReportBundle({ report: first, readAsset: assetReader([]) });
  const secondBytes = await createReportBundle({ report: second, readAsset: assetReader([]) });

  assert.deepEqual(secondBytes, firstBytes);
  const entries = Object.keys((await unzip(firstBytes)).entries);
  assert.deepEqual(entries, [...entries].sort(), 'ZIP entries must be emitted in stable lexical order');
});

test('bundle rejects non-multimodal and incomplete visual packages before reading assets', async () => {
  const { createReportBundle } = await loadReportBundleModule();
  const complete = multimodalReport();

  for (const presentationMode of ['legacy_text', 'current_text'] as const) {
    const reads: string[] = [];
    await assert.rejects(
      createReportBundle({
        report: { ...complete, presentationMode } as unknown as MultimodalReportFixture,
        readAsset: assetReader(reads),
      }),
      /multimodal|presentation mode/i,
    );
    assert.deepEqual(reads, []);
  }

  const missingChart = multimodalReport();
  missingChart.visualAssetManifests = missingChart.visualAssetManifests
    .filter(({ assetId }) => assetId !== chartAssetId);
  const reads: string[] = [];
  await assert.rejects(
    createReportBundle({ report: missingChart, readAsset: assetReader(reads) }),
    /chart|visual asset|manifest|reference/i,
  );
  assert.deepEqual(reads, []);
});

test('ReportDocument view model maps navigation and every professional block without recomputing Chart data', async () => {
  const { createReportDocumentViewModel } = await loadReportDocumentViewModule();
  const document = reportDocument();
  const model = createReportDocumentViewModel({
    document,
    visualAssetManifests: visualAssetManifests(),
    assetUrl: ({ assetId }) => `/api/control-tasks/${taskId}/assets/${assetId}`,
  });

  assert.deepEqual(model.navigation, document.sections.map(({ id, title }) => ({ id, title })));
  const blocks = model.sections.flatMap(({ blocks }) => blocks);
  for (const kind of [
    'metric',
    'table',
    'chart',
    'image',
    'comparison',
    'evidence',
    'recommendation',
    'risk',
  ]) {
    assert.ok(blocks.some((block) => block.kind === kind), `${kind} block must be renderable`);
  }

  const chart = blocks.find(({ kind }) => kind === 'chart');
  assert.deepEqual(chart?.spec, chartSpec());
  assert.deepEqual(chart?.table, document.sections[4]!.blocks[1]!.type === 'chart'
    ? document.sections[4]!.blocks[1]!.table
    : assert.fail('expected Chart block'));
  const evidence = blocks.find(({ id }) => id === 'finding-1');
  assert.deepEqual(evidence?.evidenceIds, ['evidence-1']);
  const image = blocks.find(({ id }) => id === 'image-1');
  assert.equal(image?.altText, 'Product comparison source captured from verified evidence.');
  const comparison = blocks.find(({ id }) => id === 'comparison-1');
  assert.equal(comparison?.altText, 'Original evidence compared with its verified annotation.');
  assert.equal(comparison?.originalAssetId, originalAssetId);
  assert.equal(comparison?.annotationAssetId, annotationAssetId);
});

test('ReportDocumentView table shape uses sealed columns once with explicit row and cell associations', async () => {
  const { createReportTableShape } = await loadReportDocumentViewModule();
  const document = reportDocument();
  const chart = document.sections.flatMap(({ blocks }) => blocks).find(({ type }) => type === 'chart');
  assert.ok(chart?.type === 'chart');
  const shape = createReportTableShape(chart.table);

  assert.deepEqual(shape.headers.map(({ label }) => label), chart.table.columns);
  assert.equal(shape.headers.filter(({ label }) => label === 'Series').length, 1);
  assert.equal(new Set(shape.headers.map(({ id }) => id)).size, shape.headers.length);
  assert.equal(shape.rows.length, chart.table.rows.length);
  for (let rowIndex = 0; rowIndex < shape.rows.length; rowIndex += 1) {
    const rendered = shape.rows[rowIndex]!;
    const sourceRow: ChartTableAlternative['rows'][number] = chart.table.rows[rowIndex]!;
    assert.equal(rendered.header.label, sourceRow.label);
    assert.equal(rendered.header.scope, 'row');
    assert.deepEqual(rendered.header.headers, [shape.headers[0]!.id]);
    assert.deepEqual(rendered.cells.map(({ value }) => value), sourceRow.cells);
    assert.equal(rendered.cells.length + 1, shape.headers.length);
    for (let cellIndex = 0; cellIndex < rendered.cells.length; cellIndex += 1) {
      assert.deepEqual(
        rendered.cells[cellIndex]!.headers,
        [rendered.header.id, shape.headers[cellIndex + 1]!.id],
      );
    }
  }
});

test('ReportDocument interactions expand Finding evidence and control original/annotation image zoom', async () => {
  const {
    createReportDocumentInteractionState,
    reduceReportDocumentInteraction,
  } = await loadReportDocumentViewModule();
  const initial = createReportDocumentInteractionState();

  const expanded = reduceReportDocumentInteraction(initial, {
    type: 'toggle-evidence',
    blockId: 'finding-1',
  });
  assert.equal(initial.expandedEvidence.has('finding-1'), false, 'interaction state must be immutable');
  assert.equal(expanded.expandedEvidence.has('finding-1'), true);

  const original = reduceReportDocumentInteraction(expanded, {
    type: 'select-image-variant',
    blockId: 'comparison-1',
    variant: 'original',
  });
  assert.equal(original.imageVariants['comparison-1'], 'original');

  const zoomed = reduceReportDocumentInteraction(original, {
    type: 'set-image-zoom',
    blockId: 'comparison-1',
    zoom: 2,
  });
  assert.equal(zoomed.imageZoom['comparison-1'], 2);
});

test('print stylesheet covers A4, cover and TOC, fixed chrome, page breaks, SVG, repeated headings, and monochrome', async () => {
  const css = await readFile(printStylesheet, 'utf8');

  assert.match(css, /@page\s*\{[^}]*size\s*:\s*A4/isu);
  assert.match(css, /@media\s+print/iu);
  assert.match(css, /(?:report-cover|data-print-role\s*=\s*["']cover)/iu);
  assert.match(css, /(?:report-toc|table-of-contents|data-print-role\s*=\s*["']toc)/iu);
  assert.match(css, /report-header[^\{]*\{[^}]*position\s*:\s*fixed/isu);
  assert.match(css, /report-footer[^\{]*\{[^}]*position\s*:\s*fixed/isu);
  assert.match(css, /(?:break-before|break-after|page-break-before|page-break-after)\s*:/iu);
  assert.match(css, /svg[^\{]*\{[^}]*(?:break-inside|page-break-inside)\s*:\s*avoid/isu);
  assert.match(css, /thead[^\{]*\{[^}]*display\s*:\s*table-header-group/isu);
  assert.match(css, /(?:monochrome|grayscale|print-color-adjust|border-style|text-decoration)/iu);
});

test('Stage4 dispatches multimodal packages to ReportDocumentView without changing text modes', async () => {
  const { selectCurrentStage4Renderer } = await loadStage4Module();
  const multimodal = multimodalReport();

  const selected = selectCurrentStage4Renderer(multimodal);
  assert.equal(selected.component, 'ReportDocumentView');
  assert.equal(selected.reportDocument, multimodal.reportDocument);

  for (const presentationMode of ['legacy_text', 'current_text'] as const) {
    const textReport = {
      presentationMode,
      deliverable: multimodal.deliverable,
      evidenceManifest: multimodal.evidenceManifest,
      reportReview: multimodal.reportReview,
    };
    assert.equal(selectCurrentStage4Renderer(textReport).component, 'CurrentTextReport');
  }
});
