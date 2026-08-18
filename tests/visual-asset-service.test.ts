import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { VisualAssetService } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import type { ControlExecutionLease } from '../database/control-plane.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
  'base64',
);
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

function sniff(bytes: Buffer): { contentType: string; width: number; height: number } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', width: 1, height: 1 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { contentType: 'image/jpeg', width: 1, height: 1 };
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
    const artifact = this.artifacts.get(artifactId);
    if (artifact) {
      artifact.state = 'FAILED';
      artifact.failureReason = reason;
    }
  }

  async readVerifiedBinary(artifactId: string): Promise<{
    artifact: FakeArtifact;
    bytes: Buffer;
    metadata: { contentType: string; byteSize: number; width: number; height: number };
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
