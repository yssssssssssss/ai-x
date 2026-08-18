import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { ImageAnnotationService } from '../apps/orchestrator-runtime/src/report/image-annotation-service.ts';

const ORIGINAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const ANNOTATED_PNG = Buffer.from(ORIGINAL_PNG);
const binding = {
  taskId: 'task-annotation-1',
  planVersionId: 'plan-annotation-1',
  attemptId: 'attempt-annotation-1',
};
const originalRef = {
  assetId: 'artifact-original-1',
  manifestArtifactId: 'artifact-original-manifest-1',
};
const activeLease = {
  ...binding,
  leaseOwner: 'annotation-worker',
  leaseToken: 'annotation-token',
};

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
type OriginalManifest = Record<string, unknown> & { manifestHash: string };

function originalManifest(overrides: Record<string, unknown> = {}): OriginalManifest {
  return {
    version: 'visual-asset-manifest-v1',
    ...binding,
    assetId: originalRef.assetId,
    contentSha256: digest(ORIGINAL_PNG),
    mediaType: 'image/png',
    byteSize: ORIGINAL_PNG.byteLength,
    width: 1,
    height: 1,
    exportPolicy: 'allow',
    source: { kind: 'user_upload', fileName: 'original.png' },
    derivedFrom: null,
    derivation: null,
    manifestHash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  } as OriginalManifest;
}

class RecordingVisualAssets {
  readonly canonicalOriginal = Buffer.from(ORIGINAL_PNG);
  readonly reads: Array<typeof originalRef> = [];
  readonly derives: Array<Record<string, unknown>> = [];

  constructor(private readonly manifest = originalManifest()) {}

  async readVerified(input: typeof originalRef) {
    this.reads.push({ ...input });
    return {
      artifact: {
        id: originalRef.assetId,
        taskId: binding.taskId,
        planVersionId: binding.planVersionId,
        attemptId: binding.attemptId,
        kind: 'visual_asset',
        state: 'SEALED',
        contentSha256: digest(this.canonicalOriginal),
        mediaType: 'image/png',
      },
      bytes: Buffer.from(this.canonicalOriginal),
      metadata: {
        contentType: 'image/png',
        byteSize: this.canonicalOriginal.byteLength,
        width: 1,
        height: 1,
      },
      manifest: structuredClone(this.manifest),
    };
  }

  async derive(input: Record<string, unknown>) {
    this.derives.push({
      ...input,
      original: structuredClone(input.original),
      derivation: structuredClone(input.derivation),
      bytes: Buffer.from(input.bytes as Uint8Array),
    });
    const derivation = structuredClone(input.derivation);
    return {
      assetArtifact: {
        id: 'artifact-annotated-1',
        kind: 'visual_asset',
        state: 'SEALED',
        contentSha256: digest(ANNOTATED_PNG),
        mediaType: 'image/png',
      },
      manifestArtifact: {
        id: 'artifact-annotated-manifest-1',
        kind: 'visual_asset_manifest',
        state: 'SEALED',
      },
      manifest: {
        ...binding,
        assetId: 'artifact-annotated-1',
        derivedFrom: {
          assetId: originalRef.assetId,
          manifestArtifactId: originalRef.manifestArtifactId,
          contentSha256: digest(ORIGINAL_PNG),
          manifestHash: this.manifest.manifestHash,
        },
        derivation,
      },
    };
  }
}

class RecordingJsonArtifacts {
  readonly writes: Array<Record<string, unknown>> = [];
  readonly invalidations: Array<{ artifactId: string; reason: string }> = [];

  async writeJson(input: Record<string, unknown>) {
    this.writes.push(structuredClone(input));
    return {
      id: 'artifact-overlay-1',
      taskId: binding.taskId,
      planVersionId: binding.planVersionId,
      attemptId: binding.attemptId,
      kind: 'image_annotation',
      state: 'SEALED',
      contentSha256: digest(JSON.stringify(input.value)),
      schemaVersion: 'image-annotation-v1',
    };
  }

  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    this.invalidations.push({ artifactId, reason });
  }
}

const validAnnotations = [
  {
    shape: 'rectangle',
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    findingId: 'F1',
    label: '主要区域',
    severity: 'high',
  },
  {
    shape: 'dot',
    x: 0.5,
    y: 0.5,
    findingId: 'F2',
    label: '关键点',
    severity: 'medium',
  },
  {
    shape: 'arrow',
    start: { x: 0.1, y: 0.9 },
    end: { x: 0.8, y: 0.2 },
    findingId: 'F1',
    label: '操作流向',
    severity: 'low',
  },
  {
    shape: 'numbered_callout',
    x: 0.75,
    y: 0.25,
    number: 1,
    findingId: 'F2',
    label: '第一处问题',
    severity: 'critical',
  },
] as const;

function harness(options: {
  manifest?: OriginalManifest;
  render?: (input: { originalBytes: Buffer; overlay: unknown }) => Promise<Uint8Array>;
} = {}) {
  const assets = new RecordingVisualAssets(options.manifest);
  const artifacts = new RecordingJsonArtifacts();
  const renders: Array<{ originalBytes: Buffer; overlay: unknown }> = [];
  const renderSvg = options.render ?? (async (input: { originalBytes: Buffer; overlay: unknown }) => {
    renders.push({
      originalBytes: Buffer.from(input.originalBytes),
      overlay: structuredClone(input.overlay),
    });
    return ANNOTATED_PNG;
  });
  const service = new ImageAnnotationService({
    assets: assets as never,
    artifacts: artifacts as never,
    renderSvg,
  });
  return { artifacts, assets, renders, service };
}

function annotate(service: ImageAnnotationService, annotations: unknown = validAnnotations) {
  return service.annotate({
    ...binding,
    original: originalRef,
    findingIds: ['F1', 'F2'],
    annotations,
    exportPolicy: 'allow',
  });
}

test('persists a structured overlay containing only rectangle, dot, arrow, and numbered callout shapes', async () => {
  const fixture = harness();

  const result = await annotate(fixture.service);

  assert.equal(fixture.artifacts.writes.length, 1);
  const overlay = fixture.artifacts.writes[0]?.value as Record<string, unknown>;
  assert.equal(overlay.version, 'image-annotation-v1');
  assert.deepEqual(overlay.original, originalRef);
  assert.deepEqual(overlay.annotations, validAnnotations);
  assert.equal(result.overlayArtifact.id, 'artifact-overlay-1');
  assert.equal(fixture.renders.length, 1);
  assert.deepEqual(fixture.renders[0]?.overlay, overlay);
});

test('fences the annotation overlay and derived visual Asset with the active execution lease', async () => {
  const fixture = harness();

  await fixture.service.annotate({
    ...binding,
    activeLease,
    original: originalRef,
    findingIds: ['F1', 'F2'],
    annotations: validAnnotations,
    exportPolicy: 'allow',
  });

  assert.deepEqual(fixture.artifacts.writes[0]?.activeLease, activeLease);
  assert.deepEqual(fixture.assets.derives[0]?.activeLease, activeLease);
});

test('invalidates the sealed overlay when derived visual publication fails', async () => {
  const fixture = harness();
  fixture.assets.derive = async () => {
    throw new Error('derived visual write failed');
  };

  await assert.rejects(() => annotate(fixture.service), /derived visual write failed/i);

  assert.deepEqual(fixture.artifacts.invalidations, [{
    artifactId: 'artifact-overlay-1',
    reason: 'image annotation publication did not complete',
  }]);
});

test('rejects unsupported annotation shapes before persistence or rendering', async () => {
  const fixture = harness();

  await assert.rejects(
    () => annotate(fixture.service, [{
      shape: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      findingId: 'F1',
      label: '不得支持的多边形',
      severity: 'high',
    }]),
    /shape|rectangle|dot|arrow|callout/i,
  );
  assert.equal(fixture.artifacts.writes.length, 0);
  assert.equal(fixture.renders.length, 0);
  assert.equal(fixture.assets.derives.length, 0);
});

test('rejects non-normalized coordinates and rectangles that leave the image bounds', async () => {
  const invalid = [
    { ...validAnnotations[0], x: -0.01 },
    { ...validAnnotations[0], x: 0.8, width: 0.3 },
    { ...validAnnotations[0], y: 0.8, height: 0.3 },
    { ...validAnnotations[1], x: 1.01 },
    { ...validAnnotations[2], end: { x: 0.8, y: -0.01 } },
    { ...validAnnotations[3], y: 1.01 },
  ];

  for (const annotation of invalid) {
    const fixture = harness();
    await assert.rejects(
      () => annotate(fixture.service, [annotation]),
      /coordinate|normalized|bounds|0.*1/i,
    );
    assert.equal(fixture.artifacts.writes.length, 0);
    assert.equal(fixture.renders.length, 0);
    assert.equal(fixture.assets.derives.length, 0);
  }
});

test('requires every annotation to reference a known Finding and include label and severity', async () => {
  const invalid = [
    { ...validAnnotations[1], findingId: 'F404' },
    { ...validAnnotations[1], label: '' },
    { ...validAnnotations[1], severity: undefined },
  ];

  for (const annotation of invalid) {
    const fixture = harness();
    await assert.rejects(
      () => annotate(fixture.service, [annotation]),
      /Finding|findingId|label|severity/i,
    );
    assert.equal(fixture.artifacts.writes.length, 0);
    assert.equal(fixture.renders.length, 0);
    assert.equal(fixture.assets.derives.length, 0);
  }
});

test('rejects a missing, foreign-bound, mismatched, or already-derived original Asset reference', async () => {
  const cases = [
    {
      label: 'manifest Asset mismatch',
      manifest: originalManifest({ assetId: 'artifact-other' }),
    },
    {
      label: 'original content hash mismatch',
      manifest: originalManifest({ contentSha256: digest('forged original') }),
    },
    {
      label: 'foreign task binding',
      manifest: originalManifest({ taskId: 'task-foreign' }),
    },
    {
      label: 'foreign Plan binding',
      manifest: originalManifest({ planVersionId: 'plan-foreign' }),
    },
    {
      label: 'foreign Attempt binding',
      manifest: originalManifest({ attemptId: 'attempt-foreign' }),
    },
    {
      label: 'already-derived Asset',
      manifest: originalManifest({
        derivedFrom: {
          assetId: 'artifact-parent',
          manifestArtifactId: 'artifact-parent-manifest',
          contentSha256: digest('parent'),
          manifestHash: digest('parent manifest'),
        },
      }),
    },
  ];

  for (const current of cases) {
    const fixture = harness({ manifest: current.manifest });
    await assert.rejects(
      () => annotate(fixture.service),
      /original|Asset|binding|derived|manifest|hash/i,
      current.label,
    );
    assert.equal(fixture.artifacts.writes.length, 0, current.label);
    assert.equal(fixture.renders.length, 0, current.label);
    assert.equal(fixture.assets.derives.length, 0, current.label);
  }

  const missing = harness();
  missing.assets.readVerified = async () => {
    throw new Error('Asset does not resolve');
  };
  await assert.rejects(() => annotate(missing.service), /Asset|resolve|original/i);
  assert.equal(missing.artifacts.writes.length, 0);
});

test('renders a new annotation Asset with immutable original lineage and the sealed overlay reference', async () => {
  const fixture = harness({
    render: async ({ originalBytes }) => {
      originalBytes.fill(0);
      return ANNOTATED_PNG;
    },
  });
  const originalBefore = Buffer.from(fixture.assets.canonicalOriginal);

  const result = await annotate(fixture.service);

  assert.deepEqual(fixture.assets.canonicalOriginal, originalBefore);
  assert.equal(fixture.assets.derives.length, 1);
  assert.deepEqual(fixture.assets.derives[0], {
    ...binding,
    original: originalRef,
    derivation: { kind: 'annotation', overlayArtifactId: 'artifact-overlay-1' },
    bytes: ANNOTATED_PNG,
    exportPolicy: 'allow',
  });
  assert.notEqual(result.derived.assetArtifact.id, originalRef.assetId);
  assert.deepEqual(result.derived.manifest.derivedFrom, {
    assetId: originalRef.assetId,
    manifestArtifactId: originalRef.manifestArtifactId,
    contentSha256: digest(ORIGINAL_PNG),
    manifestHash: originalManifest().manifestHash,
  });
  assert.deepEqual(result.derived.manifest.derivation, {
    kind: 'annotation',
    overlayArtifactId: 'artifact-overlay-1',
  });
});

test('default production construction uses a controlled renderer that emits a real Derived PNG', async () => {
  const assets = new RecordingVisualAssets();
  const artifacts = new RecordingJsonArtifacts();
  const service = new ImageAnnotationService({
    assets: assets as never,
    artifacts: artifacts as never,
  } as never);

  const result = await annotate(service, [validAnnotations[0]]);

  assert.equal(result.derived.assetArtifact.id, 'artifact-annotated-1');
  assert.equal(assets.derives.length, 1);
  const renderedBytes = Buffer.from(assets.derives[0]!.bytes as Uint8Array);
  assert.notDeepEqual(renderedBytes, ORIGINAL_PNG);
  const metadata = await sharp(renderedBytes, { failOn: 'warning' }).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
  assert.deepEqual(assets.derives[0]!.derivation, {
    kind: 'annotation',
    overlayArtifactId: 'artifact-overlay-1',
  });
});
