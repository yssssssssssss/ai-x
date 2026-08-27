import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  ArtifactInvalidationError,
  ArtifactPublicationGroup,
} from '../apps/orchestrator-runtime/src/control/artifact-publication-group.ts';
import {
  ArtifactIntegrityError,
  type TrustedBinaryMetadata,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  VerifiedVisualAssetReader,
  VisualAssetService,
} from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import type { ToolMediaAttachment } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { ControlExecutionLease } from '../database/control-plane.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450"/></svg>');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const binding = {
  taskId: 'task-visual-1',
  planVersionId: 'plan-visual-1',
  attemptId: 'attempt-visual-1',
};

type FakeArtifact = {
  id: string;
  taskId: string;
  planVersionId: string | null;
  attemptId: string | null;
  kind: string;
  state: 'STAGING' | 'SEALED' | 'FAILED';
  storageUri: string;
  contentSha256: string | null;
  byteSize: number | null;
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
  trustedMediaType?: 'image/svg+xml';
};

type JsonWrite = Omit<BinaryWrite, 'bytes'> & { value: unknown };

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function expectedManifestHash(manifest: object): string {
  const { manifestHash: _manifestHash, ...draft } = manifest as Record<string, unknown>;
  return digest(JSON.stringify(stable(draft)));
}

function rehashedManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { manifestHash: _manifestHash, ...draft } = manifest;
  return { ...draft, manifestHash: digest(JSON.stringify(stable(draft))) };
}

function sniff(bytes: Buffer): Pick<TrustedBinaryMetadata, 'contentType' | 'width' | 'height'> {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', width: 1, height: 1 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { contentType: 'image/jpeg', width: 1, height: 1 };
  }
  if (bytes.toString('utf8').startsWith('<svg')) {
    return { contentType: 'image/svg+xml', width: 800, height: 450 };
  }
  throw new Error('unsupported image signature');
}

class FakeArtifactStore {
  readonly binaryWrites: BinaryWrite[] = [];
  readonly jsonWrites: JsonWrite[] = [];
  readonly artifacts = new Map<string, FakeArtifact>();
  readonly binaryValues = new Map<string, Buffer>();
  readonly jsonValues = new Map<string, unknown>();
  readonly invalidations: Array<{ artifactId: string; reason: string }> = [];
  failJsonKind: string | undefined;
  failInvalidation = false;
  private nextId = 1;

  seedJson(artifact: FakeArtifact, value: unknown): void {
    this.artifacts.set(artifact.id, artifact);
    this.jsonValues.set(artifact.id, structuredClone(value));
  }

  async writeBinary(input: BinaryWrite): Promise<FakeArtifact> {
    this.binaryWrites.push({ ...input, bytes: Buffer.from(input.bytes) });
    const bytes = Buffer.from(input.bytes);
    const inspected = sniff(bytes);
    const artifact = this.artifact(input, {
      kind: input.kind,
      contentSha256: digest(bytes),
      byteSize: bytes.byteLength,
      mediaType: inspected.contentType,
      metadata: { width: inspected.width, height: inspected.height },
    });
    this.artifacts.set(artifact.id, artifact);
    this.binaryValues.set(artifact.id, bytes);
    return artifact;
  }

  async writeJson(input: JsonWrite): Promise<FakeArtifact> {
    this.jsonWrites.push(structuredClone(input));
    if (input.kind === this.failJsonKind) throw new Error(`${input.kind} write failed`);
    const bytes = Buffer.from(JSON.stringify(input.value, null, 2));
    const artifact = this.artifact(input, {
      kind: input.kind,
      contentSha256: digest(bytes),
      byteSize: bytes.byteLength,
      mediaType: null,
      metadata: null,
    });
    this.artifacts.set(artifact.id, artifact);
    this.jsonValues.set(artifact.id, structuredClone(input.value));
    return artifact;
  }

  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    this.invalidations.push({ artifactId, reason });
    if (this.failInvalidation) throw new Error(`invalidation failed for ${artifactId}`);
    const artifact = this.artifacts.get(artifactId);
    if (artifact) {
      artifact.state = 'FAILED';
      artifact.failureReason = reason;
    }
  }

  async readVerifiedBinary(artifactId: string): Promise<{
    artifact: FakeArtifact;
    bytes: Buffer;
    metadata: TrustedBinaryMetadata;
  }> {
    const artifact = this.requireSealed(artifactId);
    const bytes = this.binaryValues.get(artifactId);
    if (!bytes) throw new Error(`binary Artifact ${artifactId} does not resolve`);
    const inspected = sniff(bytes);
    return {
      artifact,
      bytes: Buffer.from(bytes),
      metadata: {
        contentType: inspected.contentType,
        byteSize: bytes.byteLength,
        width: inspected.width,
        height: inspected.height,
      },
    };
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: FakeArtifact; value: T }> {
    const artifact = this.requireSealed(artifactId);
    if (!this.jsonValues.has(artifactId)) throw new Error(`JSON Artifact ${artifactId} does not resolve`);
    return { artifact, value: structuredClone(this.jsonValues.get(artifactId)) as T };
  }

  private requireSealed(artifactId: string): FakeArtifact {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.state !== 'SEALED' || !artifact.contentSha256) {
      throw new Error(`Artifact ${artifactId} is not sealed`);
    }
    return artifact;
  }

  private artifact(
    input: Pick<BinaryWrite, 'taskId' | 'planVersionId' | 'attemptId' | 'schemaVersion' | 'sensitivity' | 'redactionPolicyVersion'>,
    fields: Pick<FakeArtifact, 'kind' | 'contentSha256' | 'byteSize' | 'mediaType' | 'metadata'>,
  ): FakeArtifact {
    const id = `artifact-${this.nextId++}`;
    return {
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId ?? null,
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

class WrongIdentityChartDataStore extends FakeArtifactStore {
  override async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: FakeArtifact; value: T }> {
    const result = await super.readVerifiedJson<T>(artifactId);
    if (result.artifact.kind !== 'chart_data') return result;
    return { ...result, artifact: { ...result.artifact, id: 'different-chart-data-artifact' } };
  }
}

class CorruptChartBinaryReadStore extends FakeArtifactStore {
  constructor(private readonly corruption: 'hash' | 'mediaType' | 'dimensions') {
    super();
  }

  override async readVerifiedBinary(artifactId: string) {
    const result = await super.readVerifiedBinary(artifactId);
    if (this.corruption === 'hash') {
      return { ...result, bytes: Buffer.concat([result.bytes, Buffer.from('tampered')]) };
    }
    if (this.corruption === 'mediaType') {
      return { ...result, metadata: { ...result.metadata, contentType: 'image/png' as const } };
    }
    return { ...result, metadata: { ...result.metadata, width: result.metadata.width + 1 } };
  }
}

class CorruptChartManifestReadStore extends FakeArtifactStore {
  override async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: FakeArtifact; value: T }> {
    const result = await super.readVerifiedJson<T>(artifactId);
    if (result.artifact.kind !== 'visual_asset_manifest') return result;
    return {
      ...result,
      value: {
        ...(result.value as Record<string, unknown>),
        manifestHash: `sha256:${'f'.repeat(64)}`,
      } as T,
    };
  }
}

class UntrackedChartInvalidationFailureStore extends FakeArtifactStore {
  override async writeBinary(input: BinaryWrite): Promise<FakeArtifact> {
    const artifact = await super.writeBinary(input);
    throw new ArtifactInvalidationError(
      [artifact.id],
      'fixture inner chart invalidation failed',
      [new Error('fixture inner invalidation failure')],
    );
  }
}

function toolArtifact(overrides: Partial<FakeArtifact> = {}): FakeArtifact {
  return {
    id: 'artifact-tool-output-1',
    ...binding,
    kind: 'tool_output',
    state: 'SEALED',
    storageUri: '/private/tool-output.json',
    contentSha256: digest('verified tool output'),
    byteSize: 100,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: null,
    metadata: null,
    ...overrides,
  };
}

function toolSource(artifact: FakeArtifact, jsonPointer = '/output/results/0/oss_url') {
  return {
    kind: 'tool_artifact' as const,
    artifactId: artifact.id,
    artifactContentSha256: artifact.contentSha256!,
    jsonPointer,
  };
}

function harness(options: {
  url?: string;
  response?: Response;
  addresses?: Record<string, string[]>;
  toolArtifactOverrides?: Partial<FakeArtifact>;
  toolValue?: unknown;
} = {}) {
  const artifacts = new FakeArtifactStore();
  const artifact = toolArtifact(options.toolArtifactOverrides);
  const url = options.url ?? 'https://cdn.example.test/screenshot.png';
  artifacts.seedJson(
    artifact,
    options.toolValue ?? { output: { results: [{ oss_url: url }] } },
  );
  const resolvedHosts: string[] = [];
  const fetchedUrls: string[] = [];
  const service = new VisualAssetService({
    artifacts: artifacts as never,
    resolveHost: async (hostname: string) => {
      resolvedHosts.push(hostname);
      return options.addresses?.[hostname] ?? ['93.184.216.34'];
    },
    fetch: async (input: string | URL) => {
      const requested = String(input);
      fetchedUrls.push(requested);
      return options.response ?? new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
      });
    },
  });
  return { artifact, artifacts, fetchedUrls, resolvedHosts, service, url };
}

function ingestTool(service: VisualAssetService, artifact: FakeArtifact, jsonPointer?: string) {
  return service.ingest({
    ...binding,
    source: toolSource(artifact, jsonPointer),
    exportPolicy: 'allow',
  });
}

const browserLease: ControlExecutionLease = {
  ...binding,
  leaseOwner: 'browser-worker',
  leaseToken: 'browser-token',
};

function browserHarness(options: {
  attachment?: Partial<ToolMediaAttachment>;
  metadata?: Record<string, unknown>;
  toolArtifactOverrides?: Partial<FakeArtifact>;
} = {}) {
  const artifacts = new FakeArtifactStore();
  const artifact = toolArtifact(options.toolArtifactOverrides);
  const attachment: ToolMediaAttachment = {
    attachmentId: 'capture-1',
    bytes: PNG,
    mediaType: 'image/png',
    contentSha256: digest(PNG),
    sourcePageUrl: 'https://source.example.test/product',
    capturedAt: '2026-08-19T08:00:00.000Z',
    captureMode: 'full_page_screenshot',
    viewport: { width: 1440, height: 900 },
    width: 1,
    height: 1,
    ...options.attachment,
  };
  const metadata = {
    attachment_id: 'capture-1',
    source_result_index: 0,
    requested_url: 'https://source.example.test/product',
    final_url: 'https://source.example.test/product?view=final',
    page_title: 'Product page',
    captured_at: '2026-08-19T08:00:00.000Z',
    capture_mode: 'full_page_screenshot',
    viewport: { width: 1440, height: 900 },
    media_type: 'image/png',
    width: 1,
    height: 1,
    byte_size: PNG.byteLength,
    content_sha256: digest(PNG),
    truncated: false,
    ...options.metadata,
  };
  artifacts.seedJson(artifact, { output: { captures: [metadata], failures: [] } });
  return {
    artifact,
    artifacts,
    attachment,
    metadata,
    service: new VisualAssetService({ artifacts: artifacts as never }),
  };
}

function ingestBrowser(
  fixture: ReturnType<typeof browserHarness>,
  ensureActive: () => void = () => undefined,
) {
  return fixture.service.ingestBrowserCapture({
    ...binding,
    activeLease: browserLease,
    toolArtifactId: fixture.artifact.id,
    toolArtifactContentSha256: fixture.artifact.contentSha256!,
    captureIndex: 0,
    attachment: fixture.attachment,
    exportPolicy: 'allow',
    ensureActive,
  });
}

const chartLease: ControlExecutionLease = {
  ...binding,
  leaseOwner: 'chart-worker',
  leaseToken: 'chart-token',
};

function sealChart(
  service: VisualAssetService,
  dataArtifact: FakeArtifact,
  artifacts: FakeArtifactStore,
  overrides: Partial<Parameters<VisualAssetService['sealChartRender']>[0]> = {},
) {
  const publication = overrides.publication ?? new ArtifactPublicationGroup(artifacts as never);
  if (!publication.artifactIds.includes(dataArtifact.id)) publication.track(dataArtifact.id);
  return service.sealChartRender({
    ...binding,
    activeLease: chartLease,
    dataArtifactId: dataArtifact.id,
    dataArtifactContentSha256: dataArtifact.contentSha256!,
    chartId: 'comparison-weights',
    specHash: `sha256:${'c'.repeat(64)}`,
    bytes: SVG,
    width: 800,
    height: 450,
    exportPolicy: 'allow',
    ...overrides,
    publication,
    ensureActive: overrides.ensureActive ?? (async () => undefined),
  });
}

test('rejects non-HTTP remote schemes and direct user-provided remote URLs before network access', async () => {
  const ftp = harness({ url: 'ftp://cdn.example.test/screenshot.png' });
  await assert.rejects(() => ingestTool(ftp.service, ftp.artifact), /HTTP|scheme|protocol/i);
  assert.deepEqual(ftp.resolvedHosts, []);
  assert.deepEqual(ftp.fetchedUrls, []);
  assert.equal(ftp.artifacts.binaryWrites.length, 0);

  const direct = harness();
  await assert.rejects(
    () => direct.service.ingest({
      ...binding,
      source: { kind: 'remote_url', url: direct.url },
      exportPolicy: 'allow',
    } as never),
    /Tool Artifact|pointer|remote URL/i,
  );
  assert.deepEqual(direct.resolvedHosts, []);
  assert.deepEqual(direct.fetchedUrls, []);
  assert.equal(direct.artifacts.binaryWrites.length, 0);
});

test('rejects loopback, private, link-local, and metadata destinations before fetch', async () => {
  const blocked = [
    ['127.0.0.1', 'loopback'],
    ['::1', 'IPv6 loopback'],
    ['10.0.0.7', 'RFC1918 10/8'],
    ['172.16.0.7', 'RFC1918 172.16/12'],
    ['192.168.0.7', 'RFC1918 192.168/16'],
    ['169.254.10.20', 'IPv4 link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['fc00::7', 'IPv6 private'],
    ['fe80::7', 'IPv6 link-local'],
  ] as const;

  for (const [address, label] of blocked) {
    const current = harness({ addresses: { 'cdn.example.test': [address] } });
    await assert.rejects(
      () => ingestTool(current.service, current.artifact),
      /public|private|loopback|link-local|metadata|address/i,
      label,
    );
    assert.deepEqual(current.fetchedUrls, [], label);
    assert.equal(current.artifacts.binaryWrites.length, 0, label);
  }
});

test('re-resolves and rejects a redirect target that resolves to a private or metadata address', async () => {
  const redirected = harness({
    response: new Response(null, {
      status: 302,
      headers: { location: 'http://metadata.example.test/latest/meta-data/' },
    }),
    addresses: {
      'cdn.example.test': ['93.184.216.34'],
      'metadata.example.test': ['169.254.169.254'],
    },
  });

  await assert.rejects(
    () => ingestTool(redirected.service, redirected.artifact),
    /redirect|private|link-local|metadata|address/i,
  );
  assert.deepEqual(redirected.resolvedHosts, ['cdn.example.test', 'metadata.example.test']);
  assert.deepEqual(redirected.fetchedUrls, ['https://cdn.example.test/screenshot.png']);
  assert.equal(redirected.artifacts.binaryWrites.length, 0);
});

test('pins each redirect hop transport to validated addresses while preserving HTTP Host and TLS SNI', async () => {
  const artifacts = new FakeArtifactStore();
  const artifact = toolArtifact();
  artifacts.seedJson(artifact, {
    output: { results: [{ oss_url: 'https://cdn.example.test/screenshot.png' }] },
  });
  const resolved: Record<string, string[]> = {
    'cdn.example.test': ['93.184.216.34'],
    'images.example.test': ['1.1.1.1'],
  };
  const transportCalls: Array<{
    url: URL;
    validatedAddresses: string[];
    hostHeader: string;
    serverName: string | null;
  }> = [];
  const unsafeTransportLookups: string[] = [];
  const transport = {
    async request(input: {
      url: URL;
      validatedAddresses: string[];
      hostHeader: string;
      serverName: string | null;
      signal: AbortSignal;
    }): Promise<Response> {
      transportCalls.push({
        url: new URL(input.url),
        validatedAddresses: [...input.validatedAddresses],
        hostHeader: input.hostHeader,
        serverName: input.serverName,
      });
      if (input.url.hostname === 'cdn.example.test') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://images.example.test/final.png' },
        });
      }
      return new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
      });
    },
  };
  const service = new VisualAssetService({
    artifacts: artifacts as never,
    resolveHost: async (hostname: string) => resolved[hostname] ?? [],
    transport,
    fetch: async () => {
      unsafeTransportLookups.push('169.254.169.254');
      throw new Error('unpinned fetch performed a private metadata DNS lookup');
    },
  } as never);

  const result = await ingestTool(service, artifact);

  assert.equal(result.manifest.assetId, result.assetArtifact.id);
  assert.deepEqual(unsafeTransportLookups, []);
  assert.deepEqual(transportCalls.map((call) => ({
    url: call.url.toString(),
    validatedAddresses: call.validatedAddresses,
    hostHeader: call.hostHeader,
    serverName: call.serverName,
  })), [
    {
      url: 'https://cdn.example.test/screenshot.png',
      validatedAddresses: ['93.184.216.34'],
      hostHeader: 'cdn.example.test',
      serverName: 'cdn.example.test',
    },
    {
      url: 'https://images.example.test/final.png',
      validatedAddresses: ['1.1.1.1'],
      hostHeader: 'images.example.test',
      serverName: 'images.example.test',
    },
  ]);
});

test('rejects MIME-signature disagreement before publishing a Binary Artifact', async () => {
  const spoofed = harness({
    response: new Response(JPEG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(JPEG.byteLength) },
    }),
  });

  await assert.rejects(() => ingestTool(spoofed.service, spoofed.artifact), /MIME|signature|content-type/i);
  assert.equal(spoofed.artifacts.binaryWrites.length, 0);
  assert.equal(spoofed.artifacts.jsonWrites.length, 0);
});

test('rejects an actual response body over 10 MiB even when Content-Length claims one byte', async () => {
  const oversized = harness({
    response: new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '1' },
    }),
  });

  await assert.rejects(() => ingestTool(oversized.service, oversized.artifact), /10 MiB|size|too large/i);
  assert.equal(oversized.artifacts.binaryWrites.length, 0);
  assert.equal(oversized.artifacts.jsonWrites.length, 0);
});

test('requires a SEALED, binding-matched Tool Artifact hash and resolving JSON Pointer', async () => {
  const cases = [
    {
      label: 'content hash mismatch',
      options: {},
      source: (artifact: FakeArtifact) => ({ ...toolSource(artifact), artifactContentSha256: digest('forged') }),
    },
    {
      label: 'wrong Artifact kind',
      options: { toolArtifactOverrides: { kind: 'user_upload' } },
      source: toolSource,
    },
    {
      label: 'foreign task binding',
      options: { toolArtifactOverrides: { taskId: 'task-foreign' } },
      source: toolSource,
    },
    {
      label: 'missing JSON Pointer',
      options: {},
      source: (artifact: FakeArtifact) => toolSource(artifact, '/output/results/1/oss_url'),
    },
  ] as const;

  for (const current of cases) {
    const fixture = harness(current.options);
    await assert.rejects(
      () => fixture.service.ingest({
        ...binding,
        source: current.source(fixture.artifact),
        exportPolicy: 'allow',
      }),
      /Tool Artifact|hash|binding|pointer|resolve/i,
      current.label,
    );
    assert.deepEqual(fixture.resolvedHosts, [], current.label);
    assert.deepEqual(fixture.fetchedUrls, [], current.label);
    assert.equal(fixture.artifacts.binaryWrites.length, 0, current.label);
  }
});

test('ingests an ai-spider oss_url only through its verified Tool Artifact JSON Pointer', async () => {
  const fixture = harness();

  const result = await ingestTool(fixture.service, fixture.artifact);

  assert.deepEqual(fixture.resolvedHosts, ['cdn.example.test']);
  assert.deepEqual(fixture.fetchedUrls, [fixture.url]);
  assert.equal(fixture.artifacts.binaryWrites.length, 1);
  assert.equal(result.assetArtifact.kind, 'visual_asset');
  assert.equal(result.assetArtifact.mediaType, 'image/png');
  assert.deepEqual(result.manifest.source, {
    kind: 'tool_artifact',
    artifactId: fixture.artifact.id,
    artifactContentSha256: fixture.artifact.contentSha256,
    jsonPointer: '/output/results/0/oss_url',
    url: fixture.url,
  });
  assert.equal(result.manifest.assetId, result.assetArtifact.id);
  assert.equal(result.manifest.exportPolicy, 'allow');
  assert.equal(result.manifest.manifestHash, expectedManifestHash(result.manifest));
  assert.equal(result.manifestArtifact.kind, 'visual_asset_manifest');
});

test('ingests a user PNG without resolving or fetching a remote URL', async () => {
  const fixture = harness();

  const result = await fixture.service.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'research-screen.png', bytes: PNG },
    exportPolicy: 'block',
  });

  assert.deepEqual(fixture.resolvedHosts, []);
  assert.deepEqual(fixture.fetchedUrls, []);
  assert.equal(fixture.artifacts.binaryWrites.length, 1);
  assert.deepEqual(result.manifest.source, {
    kind: 'user_upload',
    fileName: 'research-screen.png',
  });
  assert.equal(result.manifest.mediaType, 'image/png');
  assert.equal(result.manifest.exportPolicy, 'block');
  assert.equal(result.manifest.manifestHash, expectedManifestHash(result.manifest));
});

test('publishes and re-reads a browser capture as a strictly bound V2 visual Asset', async () => {
  const fixture = browserHarness();
  let activeChecks = 0;

  const result = await ingestBrowser(fixture, () => { activeChecks += 1; });

  assert.equal(activeChecks, 6);
  assert.equal(result.manifest.version, 'visual-asset-manifest-v2');
  assert.equal(result.manifestArtifact.schemaVersion, 'visual-asset-manifest-v2');
  assert.deepEqual(result.manifest.source, {
    kind: 'browser_capture',
    artifactId: fixture.artifact.id,
    artifactContentSha256: fixture.artifact.contentSha256,
    jsonPointer: '/output/captures/0',
    attachmentId: 'capture-1',
    sourcePageUrl: 'https://source.example.test/product',
    finalUrl: 'https://source.example.test/product?view=final',
    pageTitle: 'Product page',
    capturedAt: '2026-08-19T08:00:00.000Z',
    captureMode: 'full_page_screenshot',
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(result.manifest.contentSha256, digest(PNG));
  assert.equal(result.manifest.manifestHash, expectedManifestHash(result.manifest));
  const verified = await fixture.service.readVerified({
    assetId: result.assetArtifact.id,
    manifestArtifactId: result.manifestArtifact.id,
  });
  assert.deepEqual(verified.bytes, PNG);
});

test('reads a V2 chart_render Manifest against its sealed chart data without adding a Chart writer', async () => {
  const artifacts = new FakeArtifactStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  const assetArtifact = await artifacts.writeBinary({
    ...binding,
    kind: 'visual_asset',
    relativePath: 'charts/render.svg',
    bytes: SVG,
    schemaVersion: 'visual-asset-v1',
  });
  const draft = {
    version: 'visual-asset-manifest-v2' as const,
    ...binding,
    assetId: assetArtifact.id,
    contentSha256: assetArtifact.contentSha256!,
    mediaType: 'image/svg+xml' as const,
    byteSize: SVG.byteLength,
    width: 800,
    height: 450,
    exportPolicy: 'allow' as const,
    source: {
      kind: 'chart_render' as const,
      dataArtifactId: dataArtifact.id,
      dataArtifactContentSha256: dataArtifact.contentSha256!,
    },
    derivedFrom: null,
    derivation: {
      kind: 'chart_svg' as const,
      chartId: 'comparison-weights',
      specHash: `sha256:${'c'.repeat(64)}`,
    },
  };
  const manifest = { ...draft, manifestHash: expectedManifestHash(draft) };
  const manifestArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'visual_asset_manifest',
    relativePath: 'charts/render.manifest.json',
    value: manifest,
    schemaVersion: 'visual-asset-manifest-v2',
  });
  const service = new VisualAssetService({ artifacts: artifacts as never });

  const verified = await service.readVerified({
    assetId: assetArtifact.id,
    manifestArtifactId: manifestArtifact.id,
  });
  assert.equal(verified.manifest.version, 'visual-asset-manifest-v2');
  assert.equal(verified.manifest.source.kind, 'chart_render');
  assert.deepEqual(verified.bytes, SVG);

  const invalidManifests: Record<string, unknown>[] = [{
    ...manifest,
    derivedFrom: {
      assetId: 'unrelated-asset',
      manifestArtifactId: 'unrelated-manifest',
      contentSha256: `sha256:${'d'.repeat(64)}`,
      manifestHash: `sha256:${'e'.repeat(64)}`,
    },
  }, {
    ...manifest,
    derivation: null,
  }];
  for (const invalidManifest of invalidManifests) {
    artifacts.jsonValues.set(manifestArtifact.id, rehashedManifest(invalidManifest));
    await assert.rejects(
      () => service.readVerified({
        assetId: assetArtifact.id,
        manifestArtifactId: manifestArtifact.id,
      }),
      /visual Asset manifest|schema|derivedFrom|derivation/i,
    );
  }
  artifacts.jsonValues.set(manifestArtifact.id, manifest);

  artifacts.artifacts.get(dataArtifact.id)!.contentSha256 = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(
    () => service.readVerified({
      assetId: assetArtifact.id,
      manifestArtifactId: manifestArtifact.id,
    }),
    /chart render|data Artifact|provenance/i,
  );
});

test('seals a verified chart data render as an exact V2 SVG publication', async () => {
  const artifacts = new FakeArtifactStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  const service = new VisualAssetService({ artifacts: artifacts as never });

  const result = await sealChart(service, dataArtifact, artifacts);

  assert.equal(result.manifest.version, 'visual-asset-manifest-v2');
  assert.equal(result.manifestArtifact.schemaVersion, 'visual-asset-manifest-v2');
  assert.deepEqual(result.manifest.source, {
    kind: 'chart_render',
    dataArtifactId: dataArtifact.id,
    dataArtifactContentSha256: dataArtifact.contentSha256,
  });
  assert.equal(result.manifest.derivedFrom, null);
  assert.deepEqual(result.manifest.derivation, {
    kind: 'chart_svg',
    chartId: 'comparison-weights',
    specHash: `sha256:${'c'.repeat(64)}`,
  });
  assert.equal(result.manifest.contentSha256, digest(SVG));
  assert.equal(result.manifest.mediaType, 'image/svg+xml');
  assert.equal(result.manifest.width, 800);
  assert.equal(result.manifest.height, 450);
  assert.equal(result.manifest.manifestHash, expectedManifestHash(result.manifest));
  assert.deepEqual(artifacts.binaryWrites.at(-1)?.activeLease, chartLease);
  assert.equal(artifacts.binaryWrites.at(-1)?.trustedMediaType, 'image/svg+xml');
  assert.deepEqual(artifacts.jsonWrites.at(-1)?.activeLease, chartLease);
  const verified = await service.readVerified({
    assetId: result.assetArtifact.id,
    manifestArtifactId: result.manifestArtifact.id,
  });
  assert.deepEqual(verified.bytes, SVG);
});

test('does not write chart Artifacts after its publication Group is committed', async () => {
  const artifacts = new FakeArtifactStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  const publication = new ArtifactPublicationGroup(artifacts as never);
  publication.track(dataArtifact.id);
  publication.commit();
  const service = new VisualAssetService({ artifacts: artifacts as never });
  const jsonWriteCount = artifacts.jsonWrites.length;

  await assert.rejects(
    () => sealChart(service, dataArtifact, artifacts, { publication }),
    /publication group.*committed/i,
  );

  assert.equal(artifacts.binaryWrites.length, 0);
  assert.equal(artifacts.jsonWrites.length, jsonWriteCount);
  assert.deepEqual(artifacts.invalidations, []);
});

for (const failurePoint of [
  {
    name: 'SVG',
    hasBeenWritten: (artifacts: FakeArtifactStore) => artifacts.binaryWrites.length === 1,
    expectedKinds: ['chart_data', 'visual_asset'],
    expectedManifestWrites: 0,
  },
  {
    name: 'Manifest',
    hasBeenWritten: (artifacts: FakeArtifactStore) => (
      artifacts.jsonWrites.some(({ kind }) => kind === 'visual_asset_manifest')
    ),
    expectedKinds: ['chart_data', 'visual_asset', 'visual_asset_manifest'],
    expectedManifestWrites: 1,
  },
] as const) {
  test(`compensates the chart publication when the lease is lost after the ${failurePoint.name} write`, async () => {
    const artifacts = new FakeArtifactStore();
    const dataArtifact = await artifacts.writeJson({
      ...binding,
      kind: 'chart_data',
      relativePath: 'charts/data.json',
      value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
      schemaVersion: 'competitive-weight-chart-data-v1',
    });
    const service = new VisualAssetService({ artifacts: artifacts as never });
    let leaseRejected = false;

    await assert.rejects(
      () => sealChart(service, dataArtifact, artifacts, {
        ensureActive: async () => {
          if (leaseRejected || !failurePoint.hasBeenWritten(artifacts)) return;
          leaseRejected = true;
          throw new Error(`lease lost after ${failurePoint.name} write`);
        },
      }),
      new RegExp(`lease lost after ${failurePoint.name} write`, 'i'),
    );

    assert.equal(leaseRejected, true);
    assert.equal(artifacts.binaryWrites.length, 1);
    assert.equal(
      artifacts.jsonWrites.filter(({ kind }) => kind === 'visual_asset_manifest').length,
      failurePoint.expectedManifestWrites,
    );
    assert.deepEqual(
      artifacts.invalidations.map(({ artifactId }) => artifacts.artifacts.get(artifactId)?.kind),
      failurePoint.expectedKinds,
    );
    assert.ok(artifacts.invalidations.every(({ artifactId }) => (
      artifacts.artifacts.get(artifactId)?.state === 'FAILED'
    )));
  });
}

test('rejects chart data identity drift before publishing an SVG', async () => {
  const artifacts = new WrongIdentityChartDataStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  const service = new VisualAssetService({ artifacts: artifacts as never });

  await assert.rejects(
    () => sealChart(service, dataArtifact, artifacts),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactIntegrityError);
      assert.match(error.message, /chart render|data Artifact|identity|provenance/i);
      return true;
    },
  );
  assert.equal(artifacts.binaryWrites.length, 0);
});

test('requires sealed chart_data with an exact hash and Task, Plan, Attempt binding', async () => {
  const cases: Array<{
    label: string;
    artifactOverrides?: Partial<FakeArtifact>;
    inputOverrides?: Partial<Parameters<VisualAssetService['sealChartRender']>[0]>;
  }> = [
    { label: 'kind', artifactOverrides: { kind: 'tool_output' } },
    { label: 'state', artifactOverrides: { state: 'STAGING' } },
    { label: 'task', artifactOverrides: { taskId: 'other-task' } },
    { label: 'plan', artifactOverrides: { planVersionId: 'other-plan' } },
    { label: 'attempt', artifactOverrides: { attemptId: 'other-attempt' } },
    {
      label: 'hash',
      inputOverrides: { dataArtifactContentSha256: digest('different chart data') },
    },
  ];

  for (const current of cases) {
    const artifacts = new FakeArtifactStore();
    const dataArtifact = await artifacts.writeJson({
      ...binding,
      kind: 'chart_data',
      relativePath: 'charts/data.json',
      value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
      schemaVersion: 'competitive-weight-chart-data-v1',
    });
    Object.assign(dataArtifact, current.artifactOverrides);
    const service = new VisualAssetService({ artifacts: artifacts as never });

    await assert.rejects(
      () => sealChart(service, dataArtifact, artifacts, current.inputOverrides),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactIntegrityError);
        assert.match(error.message, /Artifact|sealed|binding|Task|Plan|Attempt|hash/i);
        return true;
      },
      current.label,
    );
    assert.equal(artifacts.binaryWrites.length, 0, current.label);
  }
});

test('rejects sealed SVG hash, media type, or dimensions that differ from the render input', async () => {
  for (const corruption of ['hash', 'mediaType', 'dimensions'] as const) {
    const artifacts = new CorruptChartBinaryReadStore(corruption);
    const dataArtifact = await artifacts.writeJson({
      ...binding,
      kind: 'chart_data',
      relativePath: 'charts/data.json',
      value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
      schemaVersion: 'competitive-weight-chart-data-v1',
    });
    const service = new VisualAssetService({ artifacts: artifacts as never });

    await assert.rejects(
      () => sealChart(service, dataArtifact, artifacts),
      /Binary Artifact|SVG input/i,
      corruption,
    );
    assert.equal(artifacts.binaryWrites.length, 1, corruption);
    assert.equal(
      artifacts.jsonWrites.filter(({ kind }) => kind === 'visual_asset_manifest').length,
      0,
      corruption,
    );
    assert.equal(artifacts.invalidations.length, 2, corruption);
    assert.deepEqual(
      artifacts.invalidations.map(({ artifactId }) => artifacts.artifacts.get(artifactId)?.kind),
      ['chart_data', 'visual_asset'],
      corruption,
    );
  }
});

test('compensates the chart SVG and V2 Manifest together when readback fails', async () => {
  const artifacts = new CorruptChartManifestReadStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  const service = new VisualAssetService({ artifacts: artifacts as never });

  await assert.rejects(() => sealChart(service, dataArtifact, artifacts), /manifest hash|integrity/i);
  assert.deepEqual(
    artifacts.invalidations.map(({ artifactId }) => artifacts.artifacts.get(artifactId)?.kind),
    ['chart_data', 'visual_asset', 'visual_asset_manifest'],
  );
});

test('surfaces chart render compensation failures as ArtifactInvalidationError', async () => {
  const artifacts = new CorruptChartManifestReadStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  artifacts.failInvalidation = true;
  const service = new VisualAssetService({ artifacts: artifacts as never });

  await assert.rejects(
    () => sealChart(service, dataArtifact, artifacts),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      assert.equal(error.failedArtifactIds.length, 3);
      return true;
    },
  );
});

test('preserves untracked inner and outer chart invalidation failures', async () => {
  const artifacts = new UntrackedChartInvalidationFailureStore();
  const dataArtifact = await artifacts.writeJson({
    ...binding,
    kind: 'chart_data',
    relativePath: 'charts/data.json',
    value: { weights: [{ dimension: '需求理解', percentage: 20 }] },
    schemaVersion: 'competitive-weight-chart-data-v1',
  });
  artifacts.failInvalidation = true;
  const service = new VisualAssetService({ artifacts: artifacts as never });

  await assert.rejects(
    () => sealChart(service, dataArtifact, artifacts),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      const assetArtifact = [...artifacts.artifacts.values()].find(({ kind }) => kind === 'visual_asset');
      assert.ok(assetArtifact);
      assert.deepEqual(
        new Set(error.failedArtifactIds),
        new Set([assetArtifact.id, dataArtifact.id]),
      );
      assert.equal(error.failures.length, 2);
      return true;
    },
  );
});

test('rejects browser sidecars that disagree with Tool metadata before publishing media', async () => {
  const cases = [
    browserHarness({ attachment: { sourcePageUrl: 'https://other.example.test/product' } }),
    browserHarness({ attachment: { contentSha256: digest('forged') } }),
    browserHarness({ attachment: { attachmentId: 'capture-2' } }),
    browserHarness({ metadata: { media_type: 'image/jpeg' } }),
    browserHarness({ metadata: { width: 2 } }),
    browserHarness({ metadata: { height: 2 } }),
    browserHarness({ metadata: { byte_size: PNG.byteLength + 1 } }),
    browserHarness({ metadata: { captured_at: '2026-08-19T08:00:01.000Z' } }),
    browserHarness({ metadata: { capture_mode: 'element_screenshot' } }),
    browserHarness({ metadata: { selector: 'main' } }),
    browserHarness({ metadata: { requested_url: 'http://source.example.test/product' } }),
    browserHarness({ metadata: { final_url: 'http://source.example.test/product' } }),
    browserHarness({ metadata: { viewport: { width: 800, height: 600 } } }),
  ];

  for (const fixture of cases) {
    await assert.rejects(() => ingestBrowser(fixture), /browser capture|HTTPS|attachment|metadata/i);
    assert.equal(fixture.artifacts.binaryWrites.length, 0);
    assert.equal(fixture.artifacts.jsonWrites.length, 0);
  }
});

test('checks Tool scope after each browser Artifact write and compensates before returning', async () => {
  const fixture = browserHarness();
  let activeChecks = 0;

  await assert.rejects(
    () => ingestBrowser(fixture, () => {
      activeChecks += 1;
      if (activeChecks === 5) throw new Error('deadline exceeded after Manifest write');
    }),
    /deadline exceeded/i,
  );

  assert.equal(fixture.artifacts.binaryWrites.length, 1);
  assert.equal(fixture.artifacts.jsonWrites.length, 1);
  assert.deepEqual(
    fixture.artifacts.invalidations.map(({ artifactId }) => artifactId),
    [...fixture.artifacts.artifacts.values()]
      .filter(({ kind }) => kind === 'visual_asset' || kind === 'visual_asset_manifest')
      .map(({ id }) => id),
  );
});

test('surfaces browser capture compensation failures as ArtifactInvalidationError', async () => {
  const fixture = browserHarness();
  fixture.artifacts.failInvalidation = true;
  let activeChecks = 0;

  await assert.rejects(
    () => ingestBrowser(fixture, () => {
      activeChecks += 1;
      if (activeChecks === 3) throw new Error('lease lost after Binary write');
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      assert.equal(error.failedArtifactIds.length, 1);
      return true;
    },
  );
});

test('rejects V2 marker mismatch and browser provenance drift during readback', async () => {
  const markerFixture = browserHarness();
  const markerResult = await ingestBrowser(markerFixture);
  markerFixture.artifacts.artifacts.get(markerResult.manifestArtifact.id)!.schemaVersion = 'visual-asset-manifest-v1';
  await assert.rejects(
    () => markerFixture.service.readVerified({
      assetId: markerResult.assetArtifact.id,
      manifestArtifactId: markerResult.manifestArtifact.id,
    }),
    /schemaVersion|body version/i,
  );

  const provenanceFixture = browserHarness();
  const provenanceResult = await ingestBrowser(provenanceFixture);
  provenanceFixture.artifacts.jsonValues.set(provenanceFixture.artifact.id, {
    output: {
      captures: [{
        ...provenanceFixture.metadata,
        final_url: 'https://source.example.test/changed',
      }],
      failures: [],
    },
  });
  await assert.rejects(
    () => provenanceFixture.service.readVerified({
      assetId: provenanceResult.assetArtifact.id,
      manifestArtifactId: provenanceResult.manifestArtifact.id,
    }),
    /provenance|Tool metadata/i,
  );
});

test('fences an ingested visual Asset and its Manifest with the active execution lease', async () => {
  const fixture = harness();
  const activeLease: ControlExecutionLease = {
    ...binding,
    leaseOwner: 'visual-worker',
    leaseToken: 'visual-token',
  };

  await fixture.service.ingest({
    ...binding,
    activeLease,
    source: { kind: 'user_upload', fileName: 'leased.png', bytes: PNG },
    exportPolicy: 'allow',
  });

  assert.deepEqual(fixture.artifacts.binaryWrites[0]?.activeLease, activeLease);
  assert.deepEqual(fixture.artifacts.jsonWrites[0]?.activeLease, activeLease);
});

test('invalidates the sealed visual Asset when its Manifest publication fails', async () => {
  const fixture = harness();
  fixture.artifacts.failJsonKind = 'visual_asset_manifest';

  await assert.rejects(() => fixture.service.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'partial.png', bytes: PNG },
    exportPolicy: 'allow',
  }), /manifest.*write failed/i);

  const asset = [...fixture.artifacts.artifacts.values()].find(({ kind }) => kind === 'visual_asset');
  assert.equal(asset?.state, 'FAILED');
  assert.deepEqual(fixture.artifacts.invalidations.map(({ artifactId }) => artifactId), [asset?.id]);
});

test('surfaces V1 visual Asset compensation failure instead of hiding it behind the write error', async () => {
  const fixture = harness();
  fixture.artifacts.failJsonKind = 'visual_asset_manifest';
  fixture.artifacts.failInvalidation = true;

  await assert.rejects(
    () => fixture.service.ingest({
      ...binding,
      source: { kind: 'user_upload', fileName: 'partial.png', bytes: PNG },
      exportPolicy: 'allow',
    }),
    ArtifactInvalidationError,
  );
});

for (const kind of ['annotation', 'heatmap'] as const) {
  test(`creates an immutable original-to-${kind} derived lineage`, async () => {
    const fixture = harness();
    const original = await fixture.service.ingest({
      ...binding,
      source: { kind: 'user_upload', fileName: 'original.png', bytes: PNG },
      exportPolicy: 'allow',
    });
    const originalBefore = await fixture.artifacts.readVerifiedBinary(original.assetArtifact.id);

    const derived = await fixture.service.derive({
      ...binding,
      original: {
        assetId: original.assetArtifact.id,
        manifestArtifactId: original.manifestArtifact.id,
      },
      derivation: kind === 'annotation'
        ? { kind, overlayArtifactId: 'artifact-overlay-1' }
        : { kind },
      bytes: PNG,
      exportPolicy: 'allow',
    });

    assert.notEqual(derived.assetArtifact.id, original.assetArtifact.id);
    assert.deepEqual(derived.manifest.derivedFrom, {
      assetId: original.assetArtifact.id,
      contentSha256: original.assetArtifact.contentSha256,
      manifestArtifactId: original.manifestArtifact.id,
      manifestHash: original.manifest.manifestHash,
    });
    assert.deepEqual(derived.manifest.derivation, kind === 'annotation'
      ? { kind, overlayArtifactId: 'artifact-overlay-1' }
      : { kind });
    assert.equal(derived.manifest.manifestHash, expectedManifestHash(derived.manifest));
    const originalAfter = await fixture.artifacts.readVerifiedBinary(original.assetArtifact.id);
    assert.deepEqual(originalAfter.bytes, originalBefore.bytes);
    assert.equal(originalAfter.artifact.contentSha256, originalBefore.artifact.contentSha256);
  });
}

test('validates exportPolicy against the Manifest schema before publishing any Artifact', async () => {
  const fixture = harness();

  await assert.rejects(
    () => fixture.service.ingest({
      ...binding,
      source: { kind: 'user_upload', fileName: 'invalid-policy.png', bytes: PNG },
      exportPolicy: 'download',
    } as never),
    /exportPolicy|schema|manifest/i,
  );
  assert.equal(fixture.artifacts.binaryWrites.length, 0);
  assert.equal(fixture.artifacts.jsonWrites.length, 0);
});

test('validates derivation against the Manifest schema before publishing a Derived Artifact', async () => {
  const fixture = harness();
  const original = await fixture.service.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'original.png', bytes: PNG },
    exportPolicy: 'allow',
  });
  const binaryWrites = fixture.artifacts.binaryWrites.length;
  const jsonWrites = fixture.artifacts.jsonWrites.length;

  await assert.rejects(
    () => fixture.service.derive({
      ...binding,
      original: {
        assetId: original.assetArtifact.id,
        manifestArtifactId: original.manifestArtifact.id,
      },
      derivation: { kind: 'annotation' },
      bytes: PNG,
      exportPolicy: 'allow',
    } as never),
    /derivation|overlayArtifactId|schema|manifest/i,
  );
  assert.equal(fixture.artifacts.binaryWrites.length, binaryWrites);
  assert.equal(fixture.artifacts.jsonWrites.length, jsonWrites);
});

test('readVerified binds verified bytes to an untampered manifest hash and asset identity', async () => {
  const fixture = harness();
  const ingested = await fixture.service.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'verified.png', bytes: PNG },
    exportPolicy: 'allow',
  });

  const verified = await fixture.service.readVerified({
    assetId: ingested.assetArtifact.id,
    manifestArtifactId: ingested.manifestArtifact.id,
  });
  assert.deepEqual(verified.bytes, PNG);
  assert.equal(verified.artifact.id, ingested.assetArtifact.id);
  assert.equal(verified.manifest.manifestHash, expectedManifestHash(verified.manifest));

  fixture.artifacts.jsonValues.set(ingested.manifestArtifact.id, {
    ...ingested.manifest,
    exportPolicy: 'block',
  });
  await assert.rejects(
    () => fixture.service.readVerified({
      assetId: ingested.assetArtifact.id,
      manifestArtifactId: ingested.manifestArtifact.id,
    }),
    /manifest hash|integrity/i,
  );
});

test('VerifiedVisualAssetReader exposes the same verification through a read-only Artifact port', async () => {
  const fixture = harness();
  const ingested = await fixture.service.ingest({
    ...binding,
    source: { kind: 'user_upload', fileName: 'read-only.png', bytes: PNG },
    exportPolicy: 'allow',
  });
  const binaryWrites = fixture.artifacts.binaryWrites.length;
  const jsonWrites = fixture.artifacts.jsonWrites.length;
  const reader = new VerifiedVisualAssetReader({
    readVerifiedBinary: (artifactId) => fixture.artifacts.readVerifiedBinary(artifactId),
    readVerifiedJson: <T>(artifactId: string) => fixture.artifacts.readVerifiedJson<T>(artifactId),
  });

  const verified = await reader.readVerified({
    assetId: ingested.assetArtifact.id,
    manifestArtifactId: ingested.manifestArtifact.id,
  });

  assert.deepEqual(verified.bytes, PNG);
  assert.equal(verified.manifest.manifestHash, expectedManifestHash(verified.manifest));
  assert.equal(fixture.artifacts.binaryWrites.length, binaryWrites);
  assert.equal(fixture.artifacts.jsonWrites.length, jsonWrites);
});

test('rejects recomputed-hash SEALED Manifests that violate schema or Artifact schemaVersion', async () => {
  const cases: Array<{
    label: string;
    mutateManifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
    schemaVersion?: string;
  }> = [
    {
      label: 'missing exportPolicy',
      mutateManifest(manifest) {
        const { exportPolicy: _exportPolicy, ...withoutPolicy } = manifest;
        return withoutPolicy;
      },
    },
    {
      label: 'invalid exportPolicy',
      mutateManifest: (manifest) => ({ ...manifest, exportPolicy: 'download' }),
    },
    {
      label: 'malformed source',
      mutateManifest: (manifest) => ({
        ...manifest,
        source: { kind: 'tool_artifact', url: 'https://cdn.example.test/screenshot.png' },
      }),
    },
    {
      label: 'malformed root derivation',
      mutateManifest: (manifest) => ({
        ...manifest,
        derivedFrom: null,
        derivation: { kind: 'heatmap' },
      }),
    },
    {
      label: 'wrong Manifest Artifact schemaVersion',
      schemaVersion: 'visual-asset-manifest-v0',
    },
  ];

  for (const current of cases) {
    const fixture = harness();
    const ingested = await fixture.service.ingest({
      ...binding,
      source: { kind: 'user_upload', fileName: 'schema-checked.png', bytes: PNG },
      exportPolicy: 'allow',
    });
    const manifestArtifact = fixture.artifacts.artifacts.get(ingested.manifestArtifact.id)!;
    const mutated = rehashedManifest(current.mutateManifest
      ? current.mutateManifest(structuredClone(ingested.manifest) as unknown as Record<string, unknown>)
      : structuredClone(ingested.manifest) as unknown as Record<string, unknown>);
    fixture.artifacts.jsonValues.set(ingested.manifestArtifact.id, mutated);
    manifestArtifact.contentSha256 = digest(JSON.stringify(mutated, null, 2));
    manifestArtifact.byteSize = Buffer.byteLength(JSON.stringify(mutated, null, 2));
    if (current.schemaVersion) manifestArtifact.schemaVersion = current.schemaVersion;

    await assert.rejects(
      () => fixture.service.readVerified({
        assetId: ingested.assetArtifact.id,
        manifestArtifactId: ingested.manifestArtifact.id,
      }),
      /manifest|schema|exportPolicy|source|derivation|schemaVersion/i,
      current.label,
    );
  }
});
