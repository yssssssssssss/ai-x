import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlExecutionLease } from '../database/control-plane.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceEntry,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  chartSpecHash,
  type ChartEvidenceResolver,
  type ChartSpec,
} from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';
import {
  renderAndSealChartSvg,
  renderChartSvg,
  stableChartColor,
} from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';
import { VisualAssetService } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const binding = {
  taskId: 'task-chart-render-1',
  planVersionId: 'plan-chart-render-1',
  attemptId: 'attempt-chart-render-1',
};
const activeLease: ControlExecutionLease = {
  ...binding,
  leaseOwner: 'task17-chart-renderer-test',
  leaseToken: 'task17-chart-renderer-lease-token',
};

const RENDER_EVIDENCE_ARTIFACT_ID = 'artifact-chart-render-evidence-1';
const RENDER_EVIDENCE_ARTIFACT_HASH = `sha256:${'e'.repeat(64)}`;
const renderEvidenceValue = {
  metrics: {
    actorRevenue: 12,
    actorRetention: 87,
    competitorRevenue: 10,
    competitorRetention: 81,
  },
};
const renderArtifactResolver: EvidenceArtifactResolver = {
  resolveArtifact: (artifactId) => artifactId === RENDER_EVIDENCE_ARTIFACT_ID
    ? {
        artifact: {
          id: RENDER_EVIDENCE_ARTIFACT_ID,
          contentSha256: RENDER_EVIDENCE_ARTIFACT_HASH,
        },
        value: renderEvidenceValue,
      }
    : null,
};
const renderEvidenceService = new EvidenceService();
const RENDER_EVIDENCE_POINTERS: Record<string, string> = {
  'E-actor-revenue': '/metrics/actorRevenue',
  'E-actor-retention': '/metrics/actorRetention',
  'E-competitor-revenue': '/metrics/competitorRevenue',
  'E-competitor-retention': '/metrics/competitorRetention',
};
const renderEvidenceManifest = renderEvidenceService.createManifest({
  ...binding,
  collectedAt: '2026-08-16T00:00:00.000Z',
  entries: Object.entries(RENDER_EVIDENCE_POINTERS).map(([id, jsonPointer]) => ({
    id,
    kind: 'knowledge_excerpt',
    evidenceClass: 'dataset',
    artifactId: RENDER_EVIDENCE_ARTIFACT_ID,
    artifactContentSha256: RENDER_EVIDENCE_ARTIFACT_HASH,
    jsonPointer,
    sensitivity: 'internal',
    redaction: 'none',
  })) as EvidenceEntry[],
}, renderArtifactResolver);
const renderEvidenceById: Record<string, EvidenceEntry> = Object.fromEntries(
  renderEvidenceManifest.entries.map((entry) => [entry.id, entry]),
);
const renderEvidenceResolver: ChartEvidenceResolver = (evidenceId) => {
  const entry = renderEvidenceById[evidenceId];
  return entry ? renderEvidenceService.resolveEvidenceValue(entry, renderArtifactResolver) : undefined;
};

function comparisonSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-comparison-1',
    type: 'comparison',
    title: 'Actor and competitor comparison',
    categories: ['Revenue', 'Retention'],
    series: [
      {
        key: 'actor:primary',
        label: 'Actor',
        values: [12, 87],
        evidenceIds: [['E-actor-revenue'], ['E-actor-retention']],
      },
      {
        key: 'competitor:acme',
        label: 'Acme',
        values: [10, 81],
        evidenceIds: [['E-competitor-revenue'], ['E-competitor-retention']],
      },
    ],
    yAxis: { min: 0 },
  };
}

function trendSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-trend-1',
    type: 'trend',
    title: 'Monthly verified trend',
    categories: ['January', 'February', 'March'],
    series: [{
      key: 'actor:primary',
      label: 'Actor',
      values: [2, null, 5],
      evidenceIds: [['E-january'], [], ['E-march']],
    }],
    yAxis: { min: 0 },
  };
}

function assertSafeSvg(svg: string): void {
  assert.match(svg, /^<svg\b/i);
  assert.doesNotMatch(svg, /<script\b/i);
  assert.doesNotMatch(svg, /<foreignObject\b/i);
  assert.doesNotMatch(svg, /(?:href|xlink:href|src)\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(svg, /url\(\s*["']?https?:\/\//i);
}

test('renders deterministic standalone SVG without executable or remote content', () => {
  const first = renderChartSvg(comparisonSpec(), { width: 800, height: 480 });
  const second = renderChartSvg(comparisonSpec(), { width: 800, height: 480 });

  assert.equal(first.svg, second.svg);
  assertSafeSvg(first.svg);
});

test('derives series colors from stable actor and competitor keys rather than series order', () => {
  const spec = comparisonSpec();
  const actorColor = stableChartColor('actor:primary');
  const competitorColor = stableChartColor('competitor:acme');
  assert.notEqual(actorColor, competitorColor);

  const actorOnly = renderChartSvg({ ...spec, series: [spec.series[0]!] }, { width: 800, height: 480 });
  const competitorOnly = renderChartSvg({ ...spec, series: [spec.series[1]!] }, { width: 800, height: 480 });
  assert.match(actorOnly.svg, new RegExp(actorColor, 'i'));
  assert.doesNotMatch(actorOnly.svg, new RegExp(competitorColor, 'i'));
  assert.match(competitorOnly.svg, new RegExp(competitorColor, 'i'));
  assert.doesNotMatch(competitorOnly.svg, new RegExp(actorColor, 'i'));

  const reordered = renderChartSvg(
    { ...spec, series: [...spec.series].reverse() },
    { width: 800, height: 480 },
  );
  assert.match(reordered.svg, new RegExp(actorColor, 'i'));
  assert.match(reordered.svg, new RegExp(competitorColor, 'i'));
});

test('returns a tabular text alternative with the exact values and Evidence bindings', () => {
  const rendered = renderChartSvg(comparisonSpec(), { width: 800, height: 480 });

  assert.deepEqual(rendered.table, {
    caption: 'Actor and competitor comparison',
    columns: ['Series', 'Revenue', 'Retention'],
    rows: [
      {
        key: 'actor:primary',
        label: 'Actor',
        cells: [12, 87],
        evidenceIds: [['E-actor-revenue'], ['E-actor-retention']],
      },
      {
        key: 'competitor:acme',
        label: 'Acme',
        cells: [10, 81],
        evidenceIds: [['E-competitor-revenue'], ['E-competitor-retention']],
      },
    ],
  });
});

test('keeps null missing data in the tabular alternative instead of rendering it as zero', () => {
  const rendered = renderChartSvg(trendSpec(), { width: 800, height: 480 });
  assert.equal(rendered.table.rows[0]!.cells[1], null);
  assert.notEqual(rendered.table.rows[0]!.cells[1], 0);
  assert.deepEqual(rendered.table.rows[0]!.evidenceIds[1], []);
});

type FakeArtifact = {
  id: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  kind: string;
  state: 'STAGING' | 'SEALED' | 'FAILED';
  storageUri: string;
  contentSha256: string;
  byteSize: number;
  schemaVersion: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  failureReason: string | null;
  mediaType: string | null;
  metadata: Record<string, unknown> | null;
};
type BinaryWrite = {
  taskId: string;
  planVersionId: string;
  attemptId?: string;
  kind: string;
  relativePath: string;
  bytes: Uint8Array;
  schemaVersion?: string;
  sensitivity?: string;
  redactionPolicyVersion?: string;
  activeLease?: ControlExecutionLease;
};
type JsonWrite = Omit<BinaryWrite, 'bytes'> & { value: unknown };

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

class SvgAwareArtifactStore {
  readonly binaryWrites: BinaryWrite[] = [];
  readonly jsonWrites: JsonWrite[] = [];
  readonly invalidations: Array<{ artifactId: string; reason: string }> = [];
  private readonly artifacts = new Map<string, FakeArtifact>();
  private readonly binaryValues = new Map<string, Buffer>();
  private readonly jsonValues = new Map<string, unknown>();
  private nextId = 1;

  async writeBinary(input: BinaryWrite): Promise<FakeArtifact> {
    const bytes = Buffer.from(input.bytes);
    const metadata = this.inspect(bytes);
    const artifact = this.createArtifact(input, {
      kind: input.kind,
      contentSha256: digest(bytes),
      byteSize: bytes.byteLength,
      mediaType: metadata.contentType,
      metadata: { width: metadata.width, height: metadata.height },
    });
    this.binaryWrites.push({ ...input, bytes });
    this.artifacts.set(artifact.id, artifact);
    this.binaryValues.set(artifact.id, bytes);
    return artifact;
  }

  async writeJson(input: JsonWrite): Promise<FakeArtifact> {
    const bytes = Buffer.from(JSON.stringify(input.value));
    const artifact = this.createArtifact(input, {
      kind: input.kind,
      contentSha256: digest(bytes),
      byteSize: bytes.byteLength,
      mediaType: null,
      metadata: null,
    });
    this.jsonWrites.push(structuredClone(input));
    this.artifacts.set(artifact.id, artifact);
    this.jsonValues.set(artifact.id, structuredClone(input.value));
    return artifact;
  }

  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    this.invalidations.push({ artifactId, reason });
    const artifact = this.artifacts.get(artifactId);
    if (artifact) {
      artifact.state = 'FAILED';
      artifact.failureReason = reason;
    }
  }

  async readVerifiedBinary(artifactId: string) {
    const artifact = this.requireArtifact(artifactId);
    const bytes = this.binaryValues.get(artifactId);
    if (!bytes) throw new Error(`binary Artifact ${artifactId} does not resolve`);
    return { artifact, bytes: Buffer.from(bytes), metadata: this.inspect(bytes) };
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: FakeArtifact; value: T }> {
    const artifact = this.requireArtifact(artifactId);
    if (!this.jsonValues.has(artifactId)) throw new Error(`JSON Artifact ${artifactId} does not resolve`);
    return { artifact, value: structuredClone(this.jsonValues.get(artifactId)) as T };
  }

  private inspect(bytes: Buffer): { contentType: string; byteSize: number; width: number; height: number } {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { contentType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1 };
    }
    const svg = bytes.toString('utf8');
    if (/^<svg\b/i.test(svg)) {
      const width = Number(svg.match(/\bwidth=["'](\d+)["']/i)?.[1]);
      const height = Number(svg.match(/\bheight=["'](\d+)["']/i)?.[1]);
      if (width > 0 && height > 0) {
        return { contentType: 'image/svg+xml', byteSize: bytes.byteLength, width, height };
      }
    }
    throw new Error('unsupported binary signature');
  }

  private requireArtifact(artifactId: string): FakeArtifact {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} does not resolve`);
    return artifact;
  }

  private createArtifact(
    input: Pick<BinaryWrite, 'taskId' | 'planVersionId' | 'attemptId' | 'schemaVersion' | 'sensitivity' | 'redactionPolicyVersion'>,
    fields: Pick<FakeArtifact, 'kind' | 'contentSha256' | 'byteSize' | 'mediaType' | 'metadata'>,
  ): FakeArtifact {
    const id = `artifact-chart-${this.nextId++}`;
    return {
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId ?? binding.attemptId,
      kind: fields.kind,
      state: 'SEALED',
      storageUri: `/private/${id}`,
      contentSha256: fields.contentSha256,
      byteSize: fields.byteSize,
      schemaVersion: input.schemaVersion ?? 'v1',
      sensitivity: input.sensitivity ?? 'internal',
      redactionPolicyVersion: input.redactionPolicyVersion ?? 'v1',
      failureReason: null,
      mediaType: fields.mediaType,
      metadata: fields.metadata,
    };
  }
}

class UnsealedChartSpecArtifactStore extends SvgAwareArtifactStore {
  override async writeJson(input: JsonWrite): Promise<FakeArtifact> {
    const artifact = await super.writeJson(input);
    return input.kind === 'chart_spec' ? { ...artifact, state: 'STAGING' } : artifact;
  }
}

async function createSealHarness(artifacts = new SvgAwareArtifactStore()) {
  const assets = new VisualAssetService({ artifacts: artifacts as never });
  const original = await assets.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'chart-source.png', bytes: PNG },
    exportPolicy: 'allow',
  });
  return { artifacts, assets, original };
}

class RecordingVisualAssets {
  deriveCalls = 0;

  constructor(private readonly service: VisualAssetService) {}

  async derive(input: Parameters<VisualAssetService['derive']>[0]) {
    this.deriveCalls += 1;
    return this.service.derive(input);
  }
}

test('rejects an Evidence-value mismatch before calling VisualAssetService.derive', async () => {
  const fixture = await createSealHarness();
  const assets = new RecordingVisualAssets(fixture.assets);
  const spec = comparisonSpec();
  spec.series[0]!.values[0] = 99;

  await assert.rejects(
    () => renderAndSealChartSvg({
      ...binding,
      spec,
      evidenceResolver: renderEvidenceResolver,
      original: {
        assetId: fixture.original.assetArtifact.id,
        manifestArtifactId: fixture.original.manifestArtifact.id,
      },
      assets: assets as never,
      artifacts: fixture.artifacts,
      activeLease,
      exportPolicy: 'allow',
      width: 800,
      height: 480,
    }),
    /value|Evidence|match/i,
  );
  assert.equal(assets.deriveCalls, 0);
});

test('rejects dangling Evidence before calling VisualAssetService.derive', async () => {
  const fixture = await createSealHarness();
  const assets = new RecordingVisualAssets(fixture.assets);
  const spec = comparisonSpec();
  spec.series[0]!.evidenceIds[0] = ['E-does-not-exist'];

  await assert.rejects(
    () => renderAndSealChartSvg({
      ...binding,
      spec,
      evidenceResolver: renderEvidenceResolver,
      original: {
        assetId: fixture.original.assetArtifact.id,
        manifestArtifactId: fixture.original.manifestArtifact.id,
      },
      assets: assets as never,
      artifacts: fixture.artifacts,
      activeLease,
      exportPolicy: 'allow',
      width: 800,
      height: 480,
    }),
    /E-does-not-exist|dangling|resolve/i,
  );
  assert.equal(assets.deriveCalls, 0);
});

test('seals server SVG through VisualAssetService with chart_svg lineage', async () => {
  const artifacts = new SvgAwareArtifactStore();
  const assets = new VisualAssetService({ artifacts: artifacts as never });
  const original = await assets.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'chart-source.png', bytes: PNG },
    exportPolicy: 'allow',
  });

  const spec = comparisonSpec();

  const result = await renderAndSealChartSvg({
    ...binding,
    spec,
    evidenceResolver: renderEvidenceResolver,
    original: {
      assetId: original.assetArtifact.id,
      manifestArtifactId: original.manifestArtifact.id,
    },
    assets,
    artifacts,
    activeLease,
    exportPolicy: 'allow',
    width: 800,
    height: 480,
  });

  assertSafeSvg(result.svg);
  assert.equal(result.derived.assetArtifact.state, 'SEALED');
  assert.equal(result.derived.assetArtifact.kind, 'visual_asset');
  assert.equal(result.derived.assetArtifact.mediaType, 'image/svg+xml');
  assert.equal(result.derived.manifest.mediaType, 'image/svg+xml');
  assert.deepEqual(result.derived.manifest.derivedFrom, {
    assetId: original.assetArtifact.id,
    manifestArtifactId: original.manifestArtifact.id,
    contentSha256: original.assetArtifact.contentSha256,
    manifestHash: original.manifest.manifestHash,
  });
  assert.deepEqual(result.derived.manifest.derivation, {
    kind: 'chart_svg',
    chartId: 'chart-comparison-1',
    specHash: chartSpecHash(spec),
  });
  assert.equal(
    Buffer.from(artifacts.binaryWrites.at(-1)!.bytes).toString('utf8'),
    result.svg,
  );
  const chartSpecWrite = artifacts.jsonWrites.find((write) => write.kind === 'chart_spec');
  const derivedManifestWrite = artifacts.jsonWrites
    .filter((write) => write.kind === 'visual_asset_manifest')
    .at(-1);
  const derivedBinaryWrite = artifacts.binaryWrites.at(-1);
  assert.ok(chartSpecWrite);
  assert.ok(derivedManifestWrite);
  assert.ok(derivedBinaryWrite);
  assert.deepEqual(derivedBinaryWrite.activeLease, activeLease);
  assert.deepEqual(derivedManifestWrite.activeLease, activeLease);
  assert.deepEqual(chartSpecWrite.activeLease, activeLease);
  assert.deepEqual({
    taskId: chartSpecWrite.taskId,
    planVersionId: chartSpecWrite.planVersionId,
    attemptId: chartSpecWrite.attemptId,
    kind: chartSpecWrite.kind,
    relativePath: chartSpecWrite.relativePath,
    schemaVersion: chartSpecWrite.schemaVersion,
  }, {
    ...binding,
    kind: 'chart_spec',
    relativePath: 'charts/chart-comparison-1.json',
    schemaVersion: 'verified-chart-v1',
  });
  assert.deepEqual(chartSpecWrite.value, {
    version: 'verified-chart-v1',
    ...binding,
    spec,
    specHash: chartSpecHash(spec),
    table: result.table,
    assetRef: {
      assetId: result.derived.assetArtifact.id,
      manifestArtifactId: result.derived.manifestArtifact.id,
    },
  });
  const persistedChart = await artifacts.readVerifiedJson(result.chartSpecArtifactId);
  assert.equal(persistedChart.artifact.id, result.chartSpecArtifactId);
  assert.equal(persistedChart.artifact.state, 'SEALED');
  assert.equal(persistedChart.artifact.kind, 'chart_spec');
  assert.equal(persistedChart.artifact.schemaVersion, 'verified-chart-v1');
  assert.deepEqual(persistedChart.value, chartSpecWrite.value);
});

test('fails closed when the verified Chart JSON Artifact does not seal', async () => {
  const artifacts = new UnsealedChartSpecArtifactStore();
  const fixture = await createSealHarness(artifacts);
  const spec = comparisonSpec();

  await assert.rejects(
    () => renderAndSealChartSvg({
      ...binding,
      spec,
      evidenceResolver: renderEvidenceResolver,
      original: {
        assetId: fixture.original.assetArtifact.id,
        manifestArtifactId: fixture.original.manifestArtifact.id,
      },
      assets: fixture.assets,
      artifacts,
      activeLease,
      exportPolicy: 'allow',
      width: 800,
      height: 480,
    }),
    /chart|artifact|sealed/i,
  );

  const chartSpecWrite = artifacts.jsonWrites.find((write) => write.kind === 'chart_spec');
  assert.ok(chartSpecWrite);
  assert.deepEqual(chartSpecWrite.activeLease, activeLease);
  assert.equal(artifacts.invalidations.length, 3);
  assert.ok(artifacts.invalidations.every(({ reason }) => reason === 'Chart publication did not complete'));
});
