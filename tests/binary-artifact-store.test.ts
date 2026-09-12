import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { getFsSafeNativeConfig, root as openFsSafeRoot } from '@openclaw/fs-safe';
import {
  ArtifactIntegrityError,
  ControlArtifactStore,
  TextArtifactValidationError,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { ArtifactInvalidationError } from '../apps/orchestrator-runtime/src/control/artifact-publication-group.ts';
import {
  ARTIFACT_QUARANTINE_PENDING_MARKER,
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
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
  'base64',
);
const WEBP = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==',
  'base64',
);
const ADAM7_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAFoEvQfAAAACXBIWXMAAAsSAAALEgHS3X78AAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
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
  createResponseLost = false;
  sealResponseLost = false;
  invalidationFailsBeforeCommit = false;
  invalidationResponseLost = false;
  invalidationConfirmationReadFails = false;
  quarantineCommitFailsOnce = false;
  beforeSealCommit?: (artifact: ControlArtifact) => void;
  afterListArtifactsByStorageUri?: (storageUri: string) => Promise<void>;

  async createStagingArtifact(input: {
    artifactId?: string;
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
      id: input.artifactId ?? randomUUID(),
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
    if (this.createResponseLost) throw new Error('create response lost after commit');
    return artifact;
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  } & Partial<ControlExecutionLease>): Promise<ControlArtifact> {
    this.sealInputs.push(input);
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact || artifact.state !== 'STAGING') {
      throw new ControlPlaneConflictError('missing staging artifact');
    }
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
    this.beforeSealCommit?.(artifact);
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

  async invalidateArtifactPublication(artifactId: string, failureReason: string): Promise<void> {
    if (this.invalidationFailsBeforeCommit) throw new Error('invalidation unavailable');
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return;
    this.artifacts.set(artifactId, { ...artifact, state: 'FAILED', failureReason });
    if (this.invalidationResponseLost) throw new Error('invalidation response was lost after commit');
  }

  async quarantineStagingArtifact(
    input: {
      artifactId: string;
      expectedStorageUri: string;
      quarantineUri: string;
      reason: string;
    },
    prepare: () => Promise<'moved' | 'already_moved' | 'absent'>,
  ): Promise<ControlArtifact | null> {
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) return null;
    const pendingPhysicalMove = artifact.state === 'FAILED'
      && artifact.storageUri === input.quarantineUri
      && artifact.failureReason?.includes(ARTIFACT_QUARANTINE_PENDING_MARKER);
    if (!pendingPhysicalMove && (
      artifact.state !== 'STAGING'
      || artifact.storageUri !== input.expectedStorageUri
    )) return null;
    if (pendingPhysicalMove) {
      const liveOwner = [...this.artifacts.values()].find((candidate) => (
        candidate.id !== artifact.id
        && candidate.storageUri === input.expectedStorageUri
        && (candidate.state === 'STAGING' || candidate.state === 'SEALED')
      ));
      if (liveOwner) {
        const reused = {
          ...artifact,
          failureReason: `${input.reason}; source path reused by live artifact ${liveOwner.id}`,
        };
        this.artifacts.set(artifact.id, reused);
        return reused;
      }
    }
    const disposition = await prepare();
    if (this.quarantineCommitFailsOnce) {
      this.quarantineCommitFailsOnce = false;
      throw new Error('simulated quarantine transaction rollback');
    }
    const storageUri = input.quarantineUri;
    const failureReason = disposition === 'absent'
      ? `${input.reason}${ARTIFACT_QUARANTINE_PENDING_MARKER}${input.expectedStorageUri}`
      : `${input.reason}; file quarantined at ${input.quarantineUri}`;
    if (pendingPhysicalMove && disposition === 'absent') return artifact;
    const failed: ControlArtifact = {
      ...artifact,
      state: 'FAILED',
      storageUri,
      failureReason,
    };
    this.artifacts.set(artifact.id, failed);
    return failed;
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    if (this.invalidationConfirmationReadFails) {
      this.invalidationConfirmationReadFails = false;
      throw new Error('invalidation confirmation read failed');
    }
    return this.artifacts.get(artifactId) ?? null;
  }

  async listArtifactsByStorageUri(storageUri: string): Promise<ControlArtifact[]> {
    const artifacts = [...this.artifacts.values()].filter((artifact) => artifact.storageUri === storageUri);
    await this.afterListArtifactsByStorageUri?.(storageUri);
    return artifacts;
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.state === 'STAGING');
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return artifact;
  }

  async requireSealedArtifactBinding(artifactId: string): Promise<ControlArtifact> {
    const artifact = await this.requireSealedArtifact(artifactId);
    if (!artifact.planVersionId) throw new ControlPlaneConflictError('artifact identity binding is invalid');
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

function textInput(content: string, relativePath = 'reports/report.html') {
  return {
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'standalone_html_report',
    relativePath,
    content,
    mediaType: 'text/html; charset=utf-8' as const,
    maxByteSize: 2 * 1024 * 1024,
    schemaVersion: 'standalone-html-report-v1',
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

function indexedPngWithMissingPaletteEntry(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    PNG.subarray(0, 8),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([0, 0, 0])),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 1]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function animatedPng(): Buffer {
  const firstIdatOffset = PNG.indexOf(Buffer.from('IDAT')) - 4;
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(1, 0);
  const frameControl = Buffer.alloc(26);
  frameControl.writeUInt32BE(1, 4);
  frameControl.writeUInt32BE(1, 8);
  frameControl.writeUInt16BE(1, 20);
  frameControl.writeUInt16BE(10, 22);
  return Buffer.concat([
    PNG.subarray(0, firstIdatOffset),
    pngChunk('acTL', animationControl),
    pngChunk('fcTL', frameControl),
    PNG.subarray(firstIdatOffset),
  ]);
}

function pngWithIdatCount(count: number): Buffer {
  const iendOffset = PNG.lastIndexOf(Buffer.from('IEND')) - 4;
  const firstIdatOffset = PNG.indexOf(Buffer.from('IDAT')) - 4;
  const firstIdatLength = PNG.readUInt32BE(firstIdatOffset);
  const afterIdat = firstIdatOffset + firstIdatLength + 12;
  return Buffer.concat([
    PNG.subarray(0, firstIdatOffset),
    ...Array.from({ length: count }, () => pngChunk('IDAT', Buffer.alloc(0))),
    PNG.subarray(firstIdatOffset, afterIdat),
    PNG.subarray(afterIdat, iendOffset),
    PNG.subarray(iendOffset),
  ]);
}

function malformedJpegWithIncompleteFrame(): Buffer {
  const segment = (marker: number, data: Buffer) => {
    const output = Buffer.alloc(data.byteLength + 4);
    output[0] = 0xff;
    output[1] = marker;
    output.writeUInt16BE(data.byteLength + 2, 2);
    data.copy(output, 4);
    return output;
  };
  const quantization = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]);
  const huffman = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0])]);
  const incompleteFrame = Buffer.from([8, 0, 1, 0, 1]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, quantization),
    segment(0xc4, huffman),
    segment(0xc0, incompleteFrame),
    segment(0xda, Buffer.alloc(0)),
    Buffer.from([0, 0xff, 0xd9]),
  ]);
}

function truncatedWebpPayload(): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8 ', 8, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(1, 28);
  return bytes;
}

function jpegDeclaringLargeFrameWithTinyEntropy(): Buffer {
  const output = Buffer.from(JPEG);
  const frameOffset = output.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frameOffset > 0);
  output.writeUInt16BE(4_000, frameOffset + 5);
  output.writeUInt16BE(5_000, frameOffset + 7);
  return output;
}

function webpWithOnePayloadByte(type: 'VP8 ' | 'VP8L'): Buffer {
  const payload = type === 'VP8 '
    ? Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0])
    : Buffer.from([0x2f, 0, 0, 0, 0, 0]);
  const chunkLength = payload.byteLength;
  const paddedLength = chunkLength + (chunkLength % 2);
  const extraLength = type === 'VP8L' ? 8 : 0;
  const output = Buffer.alloc(20 + paddedLength + extraLength);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(output.byteLength - 8, 4);
  output.write('WEBP', 8, 'ascii');
  output.write(type, 12, 'ascii');
  output.writeUInt32LE(chunkLength, 16);
  payload.copy(output, 20);
  if (extraLength) output.write('JUNK', 20 + paddedLength, 'ascii');
  return output;
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

test('accepts a lost invalidation response only after confirming FAILED state', async () => {
  const { registry, store } = setup();
  const artifact = await store.writeBinary(binaryInput(PNG, 'visuals/invalidation-ack.png'));
  registry.invalidationResponseLost = true;

  await store.invalidateArtifactPublication(artifact.id, 'cleanup after ambiguous publication');

  assert.equal(registry.artifacts.get(artifact.id)?.state, 'FAILED');
});

test('trusts an acknowledged invalidation when its confirmation read fails', async () => {
  const { registry, store } = setup();
  const artifact = await store.writeBinary(binaryInput(PNG, 'visuals/invalidation-confirmation.png'));
  registry.invalidationConfirmationReadFails = true;

  await store.invalidateArtifactPublication(artifact.id, 'cleanup with unavailable confirmation read');

  assert.equal(registry.artifacts.get(artifact.id)?.state, 'FAILED');
});

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

test('rejects animated PNG before sealing its default frame', async () => {
  const { registry, store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(animatedPng(), 'visuals/animated.png')),
    /animated|APNG|invalid|unsupported/i,
  );
  assert.equal(registry.artifacts.size, 0);
});

test('rejects JPEGs with incomplete SOF components, SOS selectors, and entropy structure', async () => {
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(malformedJpegWithIncompleteFrame(), 'visuals/incomplete.jpg')),
    /invalid|unsupported|JPEG/i,
  );
});

test('rejects WebP payloads that end after a VP8 dimensions header', async () => {
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(truncatedWebpPayload(), 'visuals/truncated.webp')),
    /invalid|unsupported|WebP/i,
  );
});

test('rejects indexed PNG samples that exceed the declared palette', async () => {
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(indexedPngWithMissingPaletteEntry(), 'visuals/bad-index.png')),
    /invalid|unsupported|PNG/i,
  );
});

test('rejects a 5000x4000 JPEG with only tiny-image entropy data', async () => {
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(jpegDeclaringLargeFrameWithTinyEntropy(), 'visuals/truncated-20mp.jpg')),
    /decode|invalid|unsupported|JPEG/i,
  );
});

test('rejects VP8 and VP8L files with only one post-header payload byte', async () => {
  const { store } = setup();
  for (const type of ['VP8 ', 'VP8L'] as const) {
    await assert.rejects(
      () => store.writeBinary(binaryInput(webpWithOnePayloadByte(type), `visuals/one-byte-${type.trim()}.webp`)),
      /decode|invalid|unsupported|WebP/i,
    );
  }
});

test('rejects over-20MP PNG dimensions before attempting to inflate IDAT', async () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20_000_001, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 16;
  ihdr[9] = 6;
  const hostile = Buffer.concat([
    PNG.subarray(0, 8),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from('not-zlib')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(hostile, 'visuals/over-limit.png')),
    /20 megapixels|pixel count/i,
  );
});

test('rejects oversized binary input before attempting a Buffer copy', async () => {
  const oversized = {
    byteLength: TEN_MIB + 1,
    length: TEN_MIB + 1,
    [Symbol.iterator]() { throw new Error('oversized input was copied'); },
  } as unknown as Uint8Array;
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(oversized, 'visuals/oversized.png')),
    /10 MiB|byte size|too large/i,
  );
});

test('rejects oversized stored binary from fstat before allocating or hashing it', async () => {
  const { store } = setup();
  const sealed = await store.writeBinary(binaryInput(PNG, 'visuals/stored-size.png'));
  writeFileSync(sealed.storageUri, Buffer.alloc(TEN_MIB + 1));
  await assert.rejects(
    () => store.readVerifiedBinary(sealed.id),
    /10 MiB|byte size|too large/i,
  );
});

test('does not seal a path replacement introduced during publication', async () => {
  const { registry, store } = setup();
  registry.beforeSealCommit = (artifact) => {
    renameSync(artifact.storageUri, `${artifact.storageUri}.validated`);
    writeFileSync(artifact.storageUri, WEBP);
  };
  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, 'visuals/replaced-before-seal.png')),
    /integrity|publication|identity/i,
  );
});

test('does not seal when the publication parent is swapped to an external symlink', async () => {
  const { root, registry, store } = setup();
  const outside = mkdtempSync(join(tmpdir(), 'binary-publication-swap-'));
  temporaryRoots.push(outside);
  registry.beforeSealCommit = (artifact) => {
    const parent = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, 'visuals');
    renameSync(parent, `${parent}.validated`);
    symlinkSync(outside, parent, 'dir');
    assert.equal(artifact.storageUri, join(parent, 'parent-swap.png'));
  };
  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, 'visuals/parent-swap.png')),
    /workspace|publication|identity/i,
  );
});

test('rejects PNGs with excessive IDAT chunk counts before aggregation', async () => {
  const { store } = setup();
  await assert.rejects(
    () => store.writeBinary(binaryInput(pngWithIdatCount(1_025), 'visuals/idat-flood.png')),
    /IDAT|invalid|unsupported/i,
  );
});

test('invalidates a seal when the pinned inode is overwritten while seal is pending', async () => {
  const { registry, store } = setup();
  registry.beforeSealCommit = (artifact) => {
    const original = readFileSync(artifact.storageUri, 'utf8');
    writeFileSync(artifact.storageUri, original.replace('AAAA', 'BBBB'));
  };
  await assert.rejects(
    () => store.writeJson({
      taskId: ACTIVE_LEASE.taskId,
      planVersionId: ACTIVE_LEASE.planVersionId,
      attemptId: ACTIVE_LEASE.attemptId,
      kind: 'context_manifest',
      relativePath: 'visuals/in-place-overwrite.json',
      value: { marker: 'AAAA' },
    }),
    /checksum|content|integrity|changed/i,
  );
});

test('reports the residual sealed Artifact when post-seal invalidation fails', async () => {
  const { registry, store } = setup();
  registry.beforeSealCommit = (artifact) => {
    const original = readFileSync(artifact.storageUri, 'utf8');
    writeFileSync(artifact.storageUri, original.replace('AAAA', 'BBBB'));
  };
  registry.invalidationFailsBeforeCommit = true;

  await assert.rejects(
    () => store.writeJson({
      taskId: ACTIVE_LEASE.taskId,
      planVersionId: ACTIVE_LEASE.planVersionId,
      attemptId: ACTIVE_LEASE.attemptId,
      kind: 'context_manifest',
      relativePath: 'visuals/invalidation-failed.json',
      value: { marker: 'AAAA' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      assert.equal(error.failedArtifactIds.length, 1);
      assert.equal(registry.artifacts.get(error.failedArtifactIds[0]!)?.state, 'SEALED');
      return true;
    },
  );
});


test('invalidates a seal when bytes are appended to the pinned inode during seal', async () => {
  const { registry, store } = setup();
  registry.beforeSealCommit = (artifact) => {
    writeFileSync(artifact.storageUri, Buffer.from([0]), { flag: 'a' });
  };
  await assert.rejects(
    () => store.writeJson({
      taskId: ACTIVE_LEASE.taskId,
      planVersionId: ACTIVE_LEASE.planVersionId,
      attemptId: ACTIVE_LEASE.attemptId,
      kind: 'context_manifest',
      relativePath: 'visuals/append-during-seal.json',
      value: { marker: 'stable' },
    }),
    /size|content|integrity|changed/i,
  );
});

test('publishes only the final entry without materializing a temp inode', async () => {
  const { store } = setup();
  const sealed = await store.writeBinary(binaryInput(PNG, 'visuals/native-final.png'));
  const siblings = readdirSync(dirname(sealed.storageUri));
  assert.deepEqual(siblings.filter((name) => name.startsWith('native-final.png')), ['native-final.png']);
  assert.equal(existsSync(sealed.storageUri), true);
});

test('retains failed publication and safely reuses only identical bytes', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/retained-failed.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  registry.leaseExpired = true;
  await assert.rejects(
    () => store.writeBinary({ ...binaryInput(PNG, relativePath), activeLease: ACTIVE_LEASE }),
    ControlPlaneConflictError,
  );
  assert.equal(existsSync(storageUri), true);
  assert.deepEqual(readFileSync(storageUri), PNG);

  registry.leaseExpired = false;
  await assert.rejects(
    () => store.writeBinary({ ...binaryInput(JPEG, relativePath), activeLease: ACTIVE_LEASE }),
  );
  assert.deepEqual(readFileSync(storageUri), PNG);
  const retried = await store.writeBinary({ ...binaryInput(PNG, relativePath), activeLease: ACTIVE_LEASE });
  assert.equal(retried.state, 'SEALED');
});

test('refuses an existing STAGING publication path without modifying its bytes', async () => {
  const { root, registry, store } = setup();
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, 'visuals/staged.png');
  mkdirSync(dirname(storageUri), { recursive: true });
  writeFileSync(storageUri, PNG);
  await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    storageUri,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await assert.rejects(() => store.writeBinary(binaryInput(PNG, 'visuals/staged.png')));
  assert.deepEqual(readFileSync(storageUri), PNG);
});

test('reconcileStaging fails DB state but retains the original path for trusted GC', async () => {
  const { root, registry, store } = setup();
  const storageUri = join(root, 'staging-retained.png');
  writeFileSync(storageUri, PNG);
  const staged = await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    storageUri,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await store.reconcileStaging();
  assert.equal((await registry.getArtifact(staged.id))?.state, 'FAILED');
  assert.equal(existsSync(storageUri), true);
  assert.equal(existsSync(`${storageUri}.${staged.id}.orphan`), false);
});

test('quarantines STAGING bytes and permits a different same-path retry', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/recovered.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  mkdirSync(dirname(storageUri), { recursive: true });
  writeFileSync(storageUri, PNG);
  const staged = await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    storageUri,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  const quarantineUri = `${storageUri}.${staged.id}.orphan`;

  const failed = await store.quarantineStagingArtifact(staged.id);

  assert.equal(failed?.state, 'FAILED');
  assert.equal(failed?.storageUri, quarantineUri);
  assert.equal(existsSync(storageUri), false);
  assert.equal(existsSync(quarantineUri), true);
  assert.deepEqual(readFileSync(quarantineUri), PNG);

  const retried = await store.writeBinary(binaryInput(JPEG, relativePath));
  assert.equal(retried.state, 'SEALED');
  assert.deepEqual(readFileSync(storageUri), JPEG);
  assert.deepEqual(readFileSync(quarantineUri), PNG);
});

test('finishes quarantine after a move succeeds but the registry transaction rolls back', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/interrupted-quarantine.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  mkdirSync(dirname(storageUri), { recursive: true });
  writeFileSync(storageUri, PNG);
  const staged = await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    storageUri,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  const quarantineUri = `${storageUri}.${staged.id}.orphan`;
  registry.quarantineCommitFailsOnce = true;

  await assert.rejects(
    () => store.quarantineStagingArtifact(staged.id),
    /transaction rollback/,
  );
  assert.equal((await registry.getArtifact(staged.id))?.state, 'STAGING');
  assert.equal((await registry.getArtifact(staged.id))?.storageUri, storageUri);
  assert.equal(existsSync(storageUri), false);
  assert.deepEqual(readFileSync(quarantineUri), PNG);

  const failed = await store.quarantineStagingArtifact(staged.id);
  assert.equal(failed?.state, 'FAILED');
  assert.equal(failed?.storageUri, quarantineUri);
  assert.deepEqual(readFileSync(quarantineUri), PNG);
});

test('quarantines a stale writer that creates its file after recovery marks the row FAILED', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/late-stale-writer.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  registry.afterListArtifactsByStorageUri = async () => {
    registry.afterListArtifactsByStorageUri = undefined;
    const staging = [...registry.artifacts.values()].find((artifact) => (
      artifact.state === 'STAGING' && artifact.storageUri === storageUri
    ));
    assert.ok(staging);
    const pending = await store.quarantineStagingArtifact(staging.id);
    assert.equal(pending?.state, 'FAILED');
    assert.match(pending?.failureReason ?? '', /source file was absent/);
  };

  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, relativePath)),
    ControlPlaneConflictError,
  );

  const failed = [...registry.artifacts.values()].find((artifact) => (
    artifact.state === 'FAILED' && artifact.storageUri.startsWith(`${storageUri}.`)
  ));
  assert.ok(failed);
  assert.match(failed.failureReason ?? '', /file quarantined/);
  assert.equal(existsSync(storageUri), false);
  assert.deepEqual(readFileSync(failed.storageUri), PNG);

  const retried = await store.writeBinary(binaryInput(JPEG, relativePath));
  assert.equal(retried.state, 'SEALED');
  assert.deepEqual(readFileSync(storageUri), JPEG);
  assert.deepEqual(readFileSync(failed.storageUri), PNG);
});

test('reports a stale writer when its completed quarantine cannot be persisted', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/quarantine-commit-lost.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  registry.afterListArtifactsByStorageUri = async () => {
    registry.afterListArtifactsByStorageUri = undefined;
    const staging = [...registry.artifacts.values()].find((artifact) => (
      artifact.state === 'STAGING' && artifact.storageUri === storageUri
    ));
    assert.ok(staging);
    const pending = await store.quarantineStagingArtifact(staging.id);
    assert.equal(pending?.state, 'FAILED');
    registry.quarantineCommitFailsOnce = true;
  };

  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, relativePath)),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      assert.equal(error.failedArtifactIds.length, 1);
      return true;
    },
  );

  const failed = [...registry.artifacts.values()][0];
  assert.equal(failed?.state, 'FAILED');
  assert.match(failed?.failureReason ?? '', /source file was absent/);
  assert.equal(existsSync(storageUri), false);
  assert.equal(existsSync(failed?.storageUri ?? ''), true);
});

test('never moves a same-path retry owned by a new sealed Artifact', async () => {
  const { root, registry, store } = setup();
  const relativePath = 'visuals/reused-after-absent.png';
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, relativePath);
  const staged = await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset',
    storageUri,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  const pending = await store.quarantineStagingArtifact(staged.id);
  assert.equal(pending?.state, 'FAILED');
  assert.match(pending?.failureReason ?? '', /source file was absent/);

  const retried = await store.writeBinary(binaryInput(JPEG, relativePath));
  assert.equal(retried.state, 'SEALED');
  assert.deepEqual((await store.readVerifiedBinary(retried.id)).bytes, JPEG);

  const reconciled = await store.quarantineStagingArtifact(staged.id);
  assert.match(reconciled?.failureReason ?? '', new RegExp(`reused by live artifact ${retried.id}`));
  assert.equal(existsSync(storageUri), true);
  assert.deepEqual((await store.readVerifiedBinary(retried.id)).bytes, JPEG);
  assert.equal(existsSync(`${storageUri}.${staged.id}.orphan`), false);
});

test('requires native fs-safe on Node22 and creates and opens beneath a root capability', async () => {
  assert.ok(Number.parseInt(process.versions.node, 10) >= 22);
  assert.equal(getFsSafeNativeConfig().mode, 'require');
  const rootDir = mkdtempSync(join(tmpdir(), 'fs-safe-native-smoke-'));
  temporaryRoots.push(rootDir);
  const capability = await openFsSafeRoot(rootDir, {
    hardlinks: 'allow', symlinks: 'reject', maxBytes: TEN_MIB, mkdir: true, nonBlockingRead: true,
  });
  await capability.create('nested/smoke.bin', Buffer.from('native-smoke'));
  const opened = await capability.open('nested/smoke.bin', {
    hardlinks: 'allow', symlinks: 'reject', nonBlockingRead: true,
  });
  try {
    const bytes = Buffer.alloc(12);
    const result = await opened.handle.read(bytes, 0, bytes.byteLength, 0);
    assert.equal(result.bytesRead, 12);
    assert.equal(bytes.toString(), 'native-smoke');
  } finally {
    await opened[Symbol.asyncDispose]();
  }
});

test('accepts a valid narrow Adam7 PNG with zero-width passes', async () => {
  const { store } = setup();
  const sealed = await store.writeBinary(binaryInput(ADAM7_PNG, 'visuals/adam7.png'));
  assert.deepEqual((await store.readVerifiedBinary(sealed.id)).metadata, {
    contentType: 'image/png', byteSize: ADAM7_PNG.byteLength, width: 1, height: 1,
  });
});

test('rejects a FAILED-path FIFO reuse without blocking', { skip: process.platform === 'win32' }, async () => {
  const { root, registry, store } = setup();
  const storageUri = join(root, 'tasks', ACTIVE_LEASE.taskId, 'attempts', ACTIVE_LEASE.attemptId, 'visuals/fifo.png');
  mkdirSync(dirname(storageUri), { recursive: true });
  execFileSync('mkfifo', [storageUri]);
  const failed = await registry.createStagingArtifact({
    taskId: ACTIVE_LEASE.taskId,
    planVersionId: ACTIVE_LEASE.planVersionId,
    attemptId: ACTIVE_LEASE.attemptId,
    kind: 'visual_asset', storageUri, schemaVersion: 'visual-asset-v1', sensitivity: 'internal', redactionPolicyVersion: 'v1',
  });
  await registry.failArtifact(failed.id, 'fixture FAILED owner');
  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, 'visuals/fifo.png')),
    /file|regular|read|path|operation|failed/i,
  );
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

test('fails a recovered STAGING row when its create response is lost', async () => {
  const { registry, store } = setup();
  registry.createResponseLost = true;

  await assert.rejects(
    () => store.writeBinary(binaryInput(PNG, 'visuals/create-response-lost.png')),
    /create response lost after commit/,
  );

  assert.equal(registry.artifacts.size, 1);
  assert.deepEqual(
    [...registry.artifacts.values()].map(({ state }) => state),
    ['FAILED'],
  );
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
    /workspace|path|root|publication/i,
  );
  assert.equal(existsSync(join(outside, 'attempts')), false);
  assert.deepEqual([...registry.artifacts.values()].map((artifact) => artifact.state), ['FAILED']);
  assert.equal(registry.sealInputs.length, 0);
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

test('stores and verifies a task-bound visual input without a Plan Version', async () => {
  const { store } = setup();

  const sealed = await store.writeBinary({
    taskId: 'task-material',
    kind: 'visual_input_image',
    relativePath: 'source.png',
    bytes: PNG,
    schemaVersion: 'visual-input-image-v1',
    metadata: {
      requestId: 'target-design',
      role: 'designImage',
      fileName: 'source.png',
      ownerUserId: 'owner-1',
    },
  });

  assert.equal(sealed.state, 'SEALED');
  assert.equal(sealed.planVersionId, null);
  assert.equal(sealed.attemptId, null);
  assert.match(sealed.storageUri, /tasks\/task-material\/materials\/source\.png$/);
  assert.deepEqual(sealed.metadata, {
    requestId: 'target-design',
    role: 'designImage',
    fileName: 'source.png',
    ownerUserId: 'owner-1',
    width: 1,
    height: 1,
  });
  assert.equal((await store.verifyTaskBoundVisual(sealed.id)).id, sealed.id);
  assert.deepEqual((await store.readVerifiedBinary(sealed.id)).bytes, PNG);
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
  assert.deepEqual((await store.readVerifiedBoundJson<typeof value>(sealed.id)).value, value);
  registry.artifacts.set(sealed.id, { ...sealed, planVersionId: null });
  assert.deepEqual((await store.readVerifiedJson<typeof value>(sealed.id)).value, value);
  await assert.rejects(() => store.readVerifiedBoundJson<typeof value>(sealed.id));
  assert.equal(registry.sealInputs.length, 1);
});

test('seals and reads bound standalone HTML as exact UTF-8 text', async () => {
  const { registry, store } = setup();
  const content = '<!doctype html><html lang="zh-CN"><body>报告 🙂</body></html>';
  const sealed = await store.writeText({
    ...textInput(content),
    maxByteSize: Buffer.byteLength(content, 'utf8'),
  });

  assert.equal(sealed.state, 'SEALED');
  assert.equal(sealed.mediaType, 'text/html; charset=utf-8');
  assert.equal(sealed.metadata, null);
  assert.equal(sealed.byteSize, Buffer.byteLength(content, 'utf8'));
  assert.equal(
    sealed.contentSha256,
    `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
  );
  assert.match(sealed.storageUri, /tasks\/task-1\/attempts\/attempt-1\/reports\/report\.html$/u);
  assert.equal(readFileSync(sealed.storageUri, 'utf8'), content);
  assert.deepEqual(await store.readVerifiedBoundText(sealed.id), { artifact: sealed, content });
  assert.equal(registry.sealInputs.length, 1);
});

test('rejects invalid standalone HTML text before creating STAGING state', async () => {
  const { registry, store } = setup();
  const invalidInputs = [
    { ...textInput('<html>nul\0byte</html>') },
    {
      ...textInput('<html></html>'),
      mediaType: 'text/html' as 'text/html; charset=utf-8',
    },
    { ...textInput('<html>\ud800</html>') },
    { ...textInput('中'), maxByteSize: 2 },
    { ...textInput('<html></html>'), maxByteSize: 0 },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(() => store.writeText(input), TextArtifactValidationError);
  }
  assert.equal(registry.artifacts.size, 0);

  await assert.rejects(
    () => store.writeText(textInput('<html></html>', '../report.html')),
    /must stay under its versioned directory/u,
  );
  assert.equal(registry.artifacts.size, 0);
});

test('bound text reads reject media type, binding, byte-size, and hash mismatches', async () => {
  {
    const { registry, store } = setup();
    const sealed = await store.writeText(textInput('<html>media</html>'));
    registry.artifacts.set(sealed.id, { ...sealed, mediaType: 'text/plain; charset=utf-8' });
    await assert.rejects(() => store.readVerifiedBoundText(sealed.id), ArtifactIntegrityError);
  }
  {
    const { registry, store } = setup();
    const sealed = await store.writeText(textInput('<html>binding</html>'));
    registry.artifacts.set(sealed.id, { ...sealed, planVersionId: null });
    await assert.rejects(() => store.readVerifiedBoundText(sealed.id));
  }
  {
    const { registry, store } = setup();
    const sealed = await store.writeText(textInput('<html>size</html>'));
    registry.artifacts.set(sealed.id, { ...sealed, byteSize: sealed.byteSize! + 1 });
    await assert.rejects(() => store.readVerifiedBoundText(sealed.id), ArtifactIntegrityError);
  }
  {
    const { store } = setup();
    const sealed = await store.writeText(textInput('<html>hash</html>'));
    writeFileSync(sealed.storageUri, '<html>HASH</html>');
    await assert.rejects(() => store.readVerifiedBoundText(sealed.id), ArtifactIntegrityError);
  }
});

test('bound text reads reject checksummed invalid UTF-8 and NUL bytes', async () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('<html>nul\0byte</html>')]) {
    const { registry, store } = setup();
    const sealed = await store.writeText(textInput('<html>valid</html>'));
    writeFileSync(sealed.storageUri, bytes);
    registry.artifacts.set(sealed.id, {
      ...sealed,
      byteSize: bytes.byteLength,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });

    await assert.rejects(() => store.readVerifiedBoundText(sealed.id), ArtifactIntegrityError);
  }
});
