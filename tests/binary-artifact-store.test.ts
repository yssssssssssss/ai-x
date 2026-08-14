import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import {
  ArtifactIntegrityError,
  ControlArtifactStore,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  ArtifactNotSealedError,
  ControlPlaneConflictError,
  type ControlArtifact,
  type ControlExecutionLease,
} from '../database/control-plane.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);
const WEBP = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89',
  'base64',
);
const TEN_MIB = 10 * 1024 * 1024;
const ACTIVE_LEASE: ControlExecutionLease = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  leaseOwner: 'worker-1',
  leaseToken: 'lease-token-1',
};
const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

interface TrustedBinaryMetadata {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  width: number;
  height: number;
}

class MemoryArtifactRegistry {
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly sealInputs: Array<{
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  } & Partial<ControlExecutionLease>> = [];
  leaseExpired = false;
  sealResponseLost = false;

  async createStagingArtifact(input: {
    taskId: string;
    planVersionId?: string;
    attemptId?: string;
    kind: string;
    storageUri: string;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
    mediaType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ControlArtifact> {
    const artifact: ControlArtifact = {
      id: randomUUID(),
      taskId: input.taskId,
      planVersionId: input.planVersionId ?? null,
      attemptId: input.attemptId ?? null,
      kind: input.kind,
      state: 'STAGING',
      storageUri: input.storageUri,
      contentSha256: null,
      byteSize: null,
      schemaVersion: input.schemaVersion,
      sensitivity: input.sensitivity,
      redactionPolicyVersion: input.redactionPolicyVersion,
      failureReason: null,
      mediaType: input.mediaType ?? null,
      metadata: input.metadata ?? null,
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  } & Partial<ControlExecutionLease>): Promise<ControlArtifact> {
    this.sealInputs.push(input);
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) throw new Error('missing staging artifact');
    const leaseFields = [input.taskId, input.planVersionId, input.attemptId, input.leaseOwner, input.leaseToken];
    if (leaseFields.some((value) => value !== undefined)) {
      const matches = !this.leaseExpired
        && input.taskId === ACTIVE_LEASE.taskId
        && input.planVersionId === ACTIVE_LEASE.planVersionId
        && input.attemptId === ACTIVE_LEASE.attemptId
        && input.leaseOwner === ACTIVE_LEASE.leaseOwner
        && input.leaseToken === ACTIVE_LEASE.leaseToken;
      if (!matches) throw new ControlPlaneConflictError('active execution lease is invalid or expired');
    }
    const sealed = {
      ...artifact,
      state: 'SEALED' as const,
      contentSha256: input.contentSha256,
      byteSize: input.byteSize,
    };
    this.artifacts.set(sealed.id, sealed);
    if (this.sealResponseLost) throw new Error('seal response was lost after commit');
    return sealed;
  }

  async failArtifact(artifactId: string, failureReason: string): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.state !== 'STAGING') return;
    this.artifacts.set(artifactId, { ...artifact, state: 'FAILED', failureReason });
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.state === 'STAGING');
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return artifact;
  }
}

function setup(): { root: string; registry: MemoryArtifactRegistry; store: ControlArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'binary-artifact-store-'));
  temporaryRoots.push(root);
  const registry = new MemoryArtifactRegistry();
  return { root, registry, store: new ControlArtifactStore({ root, registry }) };
}

function binaryInput(bytes: Uint8Array, relativePath = 'visuals/asset.bin') {
  return {
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    relativePath,
    bytes,
    schemaVersion: 'visual-asset-v1',
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return chunk;
}

function paddedPng(byteSize: number): Buffer {
  const iendOffset = PNG.lastIndexOf(Buffer.from('IEND')) - 4;
  const paddingSize = byteSize - PNG.byteLength - 12;
  assert.ok(paddingSize >= 0);
  return Buffer.concat([
    PNG.subarray(0, iendOffset),
    pngChunk('tEXt', Buffer.alloc(paddingSize)),
    PNG.subarray(iendOffset),
  ]);
}

function patchedPngDimensions(width: number, height: number): Buffer {
  const output = Buffer.from(PNG);
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  output.writeUInt32BE(crc32(output.subarray(12, 29)), 29);
  return output;
}

function grayscalePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  const pixels = Buffer.alloc((Math.ceil(width / 8) + 1) * height);
  return Buffer.concat([
    PNG.subarray(0, 8),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function assertRoundTrip(
  fixture: Buffer,
  contentType: TrustedBinaryMetadata['contentType'],
  extension: string,
): Promise<void> {
  const { store } = setup();
  const sealed = await store.writeBinary(binaryInput(fixture, `visuals/tiny.${extension}`));
  const verified = await store.readVerifiedBinary(sealed.id);
  assert.equal(sealed.state, 'SEALED');
  assert.equal(sealed.mediaType, contentType);
  assert.deepEqual(verified.metadata, {
    contentType,
    byteSize: fixture.byteLength,
    width: 1,
    height: 1,
  });
  assert.deepEqual(verified.bytes, fixture);
  assert.equal(verified.artifact.id, sealed.id);
}

test('sniffs and round-trips PNG, JPEG, and WebP without trusting the path extension', async () => {
  await assertRoundTrip(PNG, 'image/png', 'jpeg');
  await assertRoundTrip(JPEG, 'image/jpeg', 'webp');
  await assertRoundTrip(WEBP, 'image/webp', 'svg');
});

test('accepts exactly 10 MiB and rejects one byte over before creating STAGING state', async () => {
  const { registry, store } = setup();
  const exact = paddedPng(TEN_MIB);
  const sealed = await store.writeBinary(binaryInput(exact, 'visuals/exact.png'));
  assert.equal(sealed.byteSize, TEN_MIB);
  const countAfterExact = registry.artifacts.size;

  await assert.rejects(
    () => store.writeBinary(binaryInput(paddedPng(TEN_MIB + 1), 'visuals/too-large.png')),
    /10 MiB|byte size|too large/i,
  );
  assert.equal(registry.artifacts.size, countAfterExact);
});

test('accepts exactly 20 megapixels and rejects dimensions over 20 megapixels', async () => {
  const { registry, store } = setup();
  const exact = await store.writeBinary(binaryInput(grayscalePng(5_000, 4_000), 'visuals/20mp.png'));
  const verified = await store.readVerifiedBinary(exact.id);
  assert.equal(verified.metadata.width * verified.metadata.height, 20_000_000);
  const countAfterExact = registry.artifacts.size;

  await assert.rejects(
    () => store.writeBinary(binaryInput(grayscalePng(20_000_001, 1), 'visuals/over-20mp.png')),
    /20 megapixels|pixel count|dimensions/i,
  );
  assert.equal(registry.artifacts.size, countAfterExact);
});

test('rejects SVG, unknown, malformed, and truncated PNG/JPEG/WebP bytes', async () => {
  const { registry, store } = setup();
  const invalid = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
    Buffer.from('not an image'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    PNG.subarray(0, -12),
    JPEG.subarray(0, -2),
    WEBP.subarray(0, -2),
    patchedPngDimensions(5_000, 4_000),
  ];
  for (const [index, bytes] of invalid.entries()) {
    await assert.rejects(
      () => store.writeBinary(binaryInput(bytes, `visuals/invalid-${index}.png`)),
      /unsupported|invalid|truncated|PNG|JPEG|WebP/i,
    );
  }
  assert.equal(registry.artifacts.size, 0);
});

test('rejects file hash tamper and persisted trusted metadata tamper on verified read', async () => {
  const first = setup();
  const tamperedFile = await first.store.writeBinary(binaryInput(PNG, 'visuals/hash.png'));
  writeFileSync(tamperedFile.storageUri, JPEG);
  await assert.rejects(() => first.store.readVerifiedBinary(tamperedFile.id), ArtifactIntegrityError);

  const second = setup();
  const tamperedMetadata = await second.store.writeBinary(binaryInput(PNG, 'visuals/metadata.png'));
  second.registry.artifacts.set(tamperedMetadata.id, {
    ...tamperedMetadata,
    metadata: { width: 2, height: 1 },
  });
  await assert.rejects(
    () => second.store.readVerifiedBinary(tamperedMetadata.id),
    /metadata|integrity/i,
  );
});

test('rejects a sealed record whose storage path is moved outside its Task/Attempt workspace', async () => {
  const { root, registry, store } = setup();
  const sealed = await store.writeBinary(binaryInput(PNG, 'visuals/path.png'));
  const outside = join(root, 'tampered-path.png');
  writeFileSync(outside, PNG);
  registry.artifacts.set(sealed.id, { ...sealed, storageUri: outside });

  await assert.rejects(() => store.readVerifiedBinary(sealed.id), ArtifactIntegrityError);
});

test('passes the complete active lease fence and rejects expired or foreign leases', async () => {
  const accepted = setup();
  await accepted.store.writeBinary({
    ...binaryInput(PNG, 'visuals/active.png'),
    activeLease: ACTIVE_LEASE,
  });
  assert.deepEqual(
    {
      taskId: accepted.registry.sealInputs[0]?.taskId,
      planVersionId: accepted.registry.sealInputs[0]?.planVersionId,
      attemptId: accepted.registry.sealInputs[0]?.attemptId,
      leaseOwner: accepted.registry.sealInputs[0]?.leaseOwner,
      leaseToken: accepted.registry.sealInputs[0]?.leaseToken,
    },
    ACTIVE_LEASE,
  );

  const expired = setup();
  expired.registry.leaseExpired = true;
  await assert.rejects(
    () => expired.store.writeBinary({
      ...binaryInput(PNG, 'visuals/expired.png'),
      activeLease: ACTIVE_LEASE,
    }),
    ControlPlaneConflictError,
  );
  expired.registry.leaseExpired = false;
  const retried = await expired.store.writeBinary({
    ...binaryInput(PNG, 'visuals/expired.png'),
    activeLease: ACTIVE_LEASE,
  });
  assert.equal(retried.state, 'SEALED');

  const foreign = setup();
  await assert.rejects(
    () => foreign.store.writeBinary({
      ...binaryInput(PNG, 'visuals/foreign.png'),
      activeLease: { ...ACTIVE_LEASE, leaseToken: 'foreign-token' },
    }),
    ControlPlaneConflictError,
  );
});

test('rejects traversal and no-clobber collisions while preserving the first bytes', async () => {
  const { registry, store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, '../outside.png')),
    /must stay under its versioned directory/,
  );

  assert.equal(registry.artifacts.size, 0);

  const first = await store.writeBinary(binaryInput(PNG, 'visuals/immutable.png'));
  await assert.rejects(
    () => store.writeBinary(binaryInput(JPEG, 'visuals/immutable.png')),
  );
  assert.deepEqual(readFileSync(first.storageUri), PNG);
});
test('keeps a committed sealed destination when the repository response is lost', async () => {
  const { registry, store } = setup();
  registry.sealResponseLost = true;

  const sealed = await store.writeBinary(binaryInput(PNG, 'visuals/response-lost.png'));

  assert.equal(sealed.state, 'SEALED');
  assert.equal(existsSync(sealed.storageUri), true);
  assert.deepEqual((await store.readVerifiedBinary(sealed.id)).bytes, PNG);
});

test('rejects a versioned workspace directory symlink that escapes the artifact root', async () => {
  const { root, registry, store } = setup();
  const outside = mkdtempSync(join(tmpdir(), 'binary-artifact-outside-'));
  temporaryRoots.push(outside);
  mkdirSync(join(root, 'tasks'), { recursive: true });
  symlinkSync(outside, join(root, 'tasks', ACTIVE_LEASE.taskId), 'dir');

  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, 'visuals/escaped.png')),
    /workspace|path/i,
  );
  assert.equal(existsSync(join(outside, 'attempts')), false);
  assert.equal(registry.artifacts.size, 0);
});

test('creates a missing artifact root on the first write without weakening containment', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'binary-artifact-parent-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'new-artifact-root');
  const registry = new MemoryArtifactRegistry();
  const store = new ControlArtifactStore({ root, registry });

  const sealed = await store.writeBinary(binaryInput(PNG, 'visuals/first.png'));

  assert.equal(sealed.state, 'SEALED');
  assert.equal(existsSync(sealed.storageUri), true);
});

test('stores attempt and plan binaries only inside their versioned identity directories', async () => {
  const { store } = setup();
  const attempt = await store.writeBinary(binaryInput(PNG, 'visuals/attempt.png'));
  assert.match(
    attempt.storageUri,
    /tasks\/task-1\/attempts\/attempt-1\/visuals\/attempt\.png$/,
  );

  const plan = await store.writeBinary({
    ...binaryInput(WEBP, 'visuals/plan.webp'),
    attemptId: undefined,
  });
  assert.match(plan.storageUri, /tasks\/task-1\/plans\/plan-1\/visuals\/plan\.webp$/);
});

test('preserves legacy JSON sealing and verified reads with null media metadata', async () => {
  const { registry, store } = setup();
  const value = { legacy: true, digest: createHash('sha256').update('legacy').digest('hex') };
  const sealed = await store.writeJson({
    taskId: 'task-legacy',
    planVersionId: 'plan-legacy',
    kind: 'context_manifest',
    relativePath: 'context.json',
    value,
  });
  assert.equal(sealed.mediaType, null);
  assert.equal(sealed.metadata, null);
  registry.artifacts.set(sealed.id, { ...sealed, planVersionId: null });
  assert.deepEqual((await store.readVerifiedJson<typeof value>(sealed.id)).value, value);
  assert.equal(registry.sealInputs.length, 1);
});
