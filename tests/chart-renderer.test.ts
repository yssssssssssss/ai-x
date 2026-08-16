import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChartSpec } from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';
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
  state: 'SEALED';
  storageUri: string;
  contentSha256: string;
  byteSize: number;
  schemaVersion: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  failureReason: null;
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
};
type JsonWrite = Omit<BinaryWrite, 'bytes'> & { value: unknown };

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

class SvgAwareArtifactStore {
  readonly binaryWrites: BinaryWrite[] = [];
  readonly jsonWrites: JsonWrite[] = [];
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

test('seals server SVG through VisualAssetService with chart_svg lineage', async () => {
  const artifacts = new SvgAwareArtifactStore();
  const assets = new VisualAssetService({ artifacts: artifacts as never });
  const original = await assets.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'chart-source.png', bytes: PNG },
    exportPolicy: 'allow',
  });

  const result = await renderAndSealChartSvg({
    ...binding,
    spec: comparisonSpec(),
    original: {
      assetId: original.assetArtifact.id,
      manifestArtifactId: original.manifestArtifact.id,
    },
    assets,
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
  });
  assert.equal(
    Buffer.from(artifacts.binaryWrites.at(-1)!.bytes).toString('utf8'),
    result.svg,
  );
});
