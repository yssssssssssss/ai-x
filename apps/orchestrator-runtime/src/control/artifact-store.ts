import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { imageSize } from 'image-size';
import { inflateSync } from 'node:zlib';
import type {
  ControlArtifact,
  ControlExecutionLease,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';

const MAX_BINARY_BYTE_SIZE = 10 * 1024 * 1024;
const MAX_BINARY_PIXEL_COUNT = 20_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ArtifactIntegrityError extends Error {
  constructor(artifactId: string, reason = 'checksum does not match its sealed record') {
    super(`artifact ${artifactId} ${reason}`);
    this.name = 'ArtifactIntegrityError';
  }
}

export class BinaryArtifactValidationError extends Error {
  constructor(reason: string) {
    super(`binary artifact is invalid or unsupported: ${reason}`);
    this.name = 'BinaryArtifactValidationError';
  }
}

interface ArtifactWriteBase {
  taskId: string;
  planVersionId: string;
  attemptId?: string;
  kind: string;
  relativePath: string;
  schemaVersion?: string;
  sensitivity?: string;
  redactionPolicyVersion?: string;
  activeLease?: ControlExecutionLease;
}

export interface ArtifactWriteInput extends ArtifactWriteBase {
  value: unknown;
}

export interface BinaryArtifactWriteInput extends ArtifactWriteBase {
  bytes: Uint8Array;
}

export type TrustedBinaryContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface TrustedBinaryMetadata {
  contentType: TrustedBinaryContentType;
  byteSize: number;
  width: number;
  height: number;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngPayloadMatchesDimensions(
  compressed: Buffer[],
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
): boolean {
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (!channels || !allowedDepths[colorType]?.includes(bitDepth) || (interlace !== 0 && interlace !== 1)) return false;
  if (width * height > MAX_BINARY_PIXEL_COUNT + 1) return true;

  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const layouts = passes.map(([startX, startY, stepX, stepY]) => {
    const passWidth = width <= startX! ? 0 : Math.ceil((width - startX!) / stepX!);
    const passHeight = height <= startY! ? 0 : Math.ceil((height - startY!) / stepY!);
    return { passHeight, rowSize: Math.ceil((passWidth * channels * bitDepth) / 8) };
  }).filter(({ passHeight }) => passHeight > 0);
  const expectedLength = layouts.reduce((total, layout) => total + (layout.rowSize + 1) * layout.passHeight, 0);
  try {
    const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength });
    if (inflated.byteLength !== expectedLength) return false;
    let offset = 0;
    for (const layout of layouts) {
      for (let row = 0; row < layout.passHeight; row += 1) {
        if (inflated[offset] === undefined || inflated[offset]! > 4) return false;
        offset += layout.rowSize + 1;
      }
    }
    return offset === inflated.byteLength;
  } catch {
    return false;
  }
}

function isPngContainerValid(bytes: Buffer): boolean {
  if (bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const imageData: Buffer[] = [];
  let sawPalette = false;
  let imageDataEnded = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const dataEnd = offset + 8 + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.byteLength) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return false;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0) return false;
      interlace = bytes[offset + 20]!;
    } else if (type === 'IHDR') {
      return false;
    }
    if (crc32(bytes, offset + 4, dataEnd) !== bytes.readUInt32BE(dataEnd)) return false;
    if (type === 'PLTE') {
      if (sawPalette || imageData.length > 0 || length === 0 || length % 3 !== 0 || length > 768 || colorType === 0 || colorType === 4) return false;
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (imageDataEnded || (colorType === 3 && !sawPalette)) return false;
      imageData.push(bytes.subarray(offset + 8, dataEnd));
    } else if (imageData.length > 0 && type !== 'IEND') {
      imageDataEnded = true;
    }
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type) && type[0] === type[0]?.toUpperCase()) return false;
    if (type === 'IEND') {
      return length === 0
        && imageData.length > 0
        && (colorType !== 3 || sawPalette)
        && chunkEnd === bytes.byteLength
        && pngPayloadMatchesDimensions(imageData, width, height, bitDepth, colorType, interlace);
    }
    offset = chunkEnd;
  }
  return false;
}

function isJpegQuantizationSegmentValid(bytes: Buffer, offset: number, length: number): boolean {
  let cursor = offset + 2;
  const end = offset + length;
  while (cursor < end) {
    const precisionAndId = bytes[cursor++];
    if (precisionAndId === undefined || (precisionAndId >> 4) > 1 || (precisionAndId & 0x0f) > 3) return false;
    cursor += (precisionAndId >> 4) === 0 ? 64 : 128;
  }
  return cursor === end;
}

function isJpegHuffmanSegmentValid(bytes: Buffer, offset: number, length: number): boolean {
  let cursor = offset + 2;
  const end = offset + length;
  while (cursor < end) {
    const classAndId = bytes[cursor++];
    if (classAndId === undefined || (classAndId >> 4) > 1 || (classAndId & 0x0f) > 3 || cursor + 16 > end) return false;
    let symbolCount = 0;
    for (let index = 0; index < 16; index += 1) symbolCount += bytes[cursor + index]!;
    if (symbolCount === 0) return false;
    cursor += 16 + symbolCount;
  }
  return cursor === end;
}

function isJpegContainerValid(bytes: Buffer): boolean {
  if (bytes.byteLength < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawSize = false;
  let sawQuantizationTable = false;
  let sawHuffmanTable = false;
  let sawScanByte = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      return offset === bytes.byteLength
        && sawSize
        && sawQuantizationTable
        && sawHuffmanTable
        && sawScanByte;
    }
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return false;
    if (marker === 0xdb) {
      if (!isJpegQuantizationSegmentValid(bytes, offset, segmentLength)) return false;
      sawQuantizationTable = true;
    }
    if (marker === 0xc4) {
      if (!isJpegHuffmanSegmentValid(bytes, offset, segmentLength)) return false;
      sawHuffmanTable = true;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (segmentLength < 7) return false;
      sawSize = true;
    }
    offset += segmentLength;
    if (marker !== 0xda) continue;

    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        sawScanByte = true;
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (bytes[offset] === 0xff) offset += 1;
      const escaped = bytes[offset];
      if (escaped === 0x00 || (escaped !== undefined && escaped >= 0xd0 && escaped <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function isWebpImagePayloadValid(bytes: Buffer, type: string, dataOffset: number, length: number): boolean {
  if (type === 'VP8 ') {
    return length >= 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a;
  }
  if (type === 'VP8L') return length >= 5 && bytes[dataOffset] === 0x2f;
  if (type !== 'ANMF' || length < 24) return false;

  let nestedOffset = dataOffset + 16;
  const frameEnd = dataOffset + length;
  let sawPayload = false;
  while (nestedOffset < frameEnd) {
    if (nestedOffset + 8 > frameEnd) return false;
    const nestedType = bytes.toString('ascii', nestedOffset, nestedOffset + 4);
    const nestedLength = bytes.readUInt32LE(nestedOffset + 4);
    const nestedDataOffset = nestedOffset + 8;
    const nestedEnd = nestedDataOffset + nestedLength;
    if (nestedEnd > frameEnd) return false;
    if (nestedType === 'VP8 ' || nestedType === 'VP8L') {
      if (!isWebpImagePayloadValid(bytes, nestedType, nestedDataOffset, nestedLength)) return false;
      sawPayload = true;
    }
    nestedOffset = nestedEnd + (nestedLength % 2);
  }
  return sawPayload && nestedOffset === frameEnd;
}

function isWebpContainerValid(bytes: Buffer): boolean {
  if (
    bytes.byteLength < 30
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.byteLength
  ) {
    return false;
  }
  let offset = 12;
  let sawImageChunk = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + length;
    if (chunkEnd > bytes.byteLength) return false;
    if (isWebpImagePayloadValid(bytes, type, offset + 8, length)) sawImageChunk = true;
    offset = chunkEnd + (length % 2);
  }
  return sawImageChunk && offset === bytes.byteLength;
}

function inspectBinary(bytes: Buffer): TrustedBinaryMetadata {
  if (bytes.byteLength > MAX_BINARY_BYTE_SIZE) {
    throw new BinaryArtifactValidationError('byte size exceeds 10 MiB');
  }

  let contentType: TrustedBinaryContentType;
  let expectedType: 'png' | 'jpg' | 'webp';
  if (isPngContainerValid(bytes)) {
    contentType = 'image/png';
    expectedType = 'png';
  } else if (isJpegContainerValid(bytes)) {
    contentType = 'image/jpeg';
    expectedType = 'jpg';
  } else if (isWebpContainerValid(bytes)) {
    contentType = 'image/webp';
    expectedType = 'webp';
  } else {
    throw new BinaryArtifactValidationError('only complete PNG, JPEG, and WebP bytes are supported');
  }

  let dimensions: { width: number; height: number; type?: string };
  try {
    dimensions = imageSize(bytes);
  } catch (error) {
    throw new BinaryArtifactValidationError(error instanceof Error ? error.message : String(error));
  }
  const { width, height } = dimensions;
  if (
    dimensions.type !== expectedType
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw new BinaryArtifactValidationError('image dimensions or signature are invalid');
  }
  if (width * height > MAX_BINARY_PIXEL_COUNT) {
    throw new BinaryArtifactValidationError('pixel count exceeds 20 megapixels');
  }
  return { contentType, byteSize: bytes.byteLength, width, height };
}

export class ControlArtifactStore {
  constructor(
    private readonly options: {
      root: string;
      registry: Pick<
        ControlPlaneRepository,
        'createStagingArtifact' | 'sealArtifact' | 'failArtifact' | 'getArtifact' | 'listStagingArtifacts' | 'requireSealedArtifact'
      >;
    },
  ) {}

  private directoryFor(input: Pick<ArtifactWriteBase, 'taskId' | 'planVersionId' | 'attemptId'>): string {
    for (const [name, value] of Object.entries({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    })) {
      if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
        throw new Error(`artifact ${name} is not a valid workspace identity`);
      }
    }
    if (input.attemptId) {
      return join(this.options.root, 'tasks', input.taskId, 'attempts', input.attemptId);
    }
    return join(this.options.root, 'tasks', input.taskId, 'plans', input.planVersionId);
  }

  private resolveArtifactPath(directory: string, relativePath: string): string {
    if (isAbsolute(relativePath) || normalize(relativePath).startsWith('..')) {
      throw new Error(`artifact path must stay under its versioned directory: ${relativePath}`);
    }
    const target = resolve(directory, relativePath);
    if (relative(directory, target).startsWith('..')) {
      throw new Error(`artifact path must stay under its versioned directory: ${relativePath}`);
    }
    return target;
  }

  private assertUnaliasedRootPath(path: string): void {
    const root = resolve(this.options.root);
    const target = resolve(path);
    const targetRelative = relative(root, target);
    if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
      throw new Error('artifact path must stay inside its workspace root');
    }

    let existing = target;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw new Error('artifact workspace root does not exist');
      existing = parent;
    }
    const expectedPhysicalPath = resolve(realpathSync(root), relative(root, existing));
    if (realpathSync(existing) !== expectedPhysicalPath) {
      throw new Error('artifact path must not cross a workspace symlink');
    }
  }

  private async writeBytes(
    input: ArtifactWriteBase,
    bytes: Buffer,
    metadata?: TrustedBinaryMetadata,
  ): Promise<ControlArtifact> {
    const directory = this.directoryFor(input);
    const storageUri = this.resolveArtifactPath(directory, input.relativePath);
    mkdirSync(this.options.root, { recursive: true });
    this.assertUnaliasedRootPath(storageUri);
    const artifact = await this.options.registry.createStagingArtifact({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: input.kind,
      storageUri,
      schemaVersion: input.schemaVersion ?? 'v1',
      sensitivity: input.sensitivity ?? 'internal',
      redactionPolicyVersion: input.redactionPolicyVersion ?? 'v1',
      ...(metadata
        ? {
            mediaType: metadata.contentType,
            metadata: { width: metadata.width, height: metadata.height },
          }
        : {}),
    });
    const temporaryUri = `${storageUri}.${artifact.id}.tmp`;
    let published = false;

    try {
      mkdirSync(dirname(storageUri), { recursive: true });
      this.assertUnaliasedRootPath(storageUri);
      writeFileSync(temporaryUri, bytes);
      const descriptor = openSync(temporaryUri, 'r');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      linkSync(temporaryUri, storageUri);
      published = true;
      unlinkSync(temporaryUri);
      const sealedBytes = readFileSync(storageUri);
      const contentSha256 = `sha256:${createHash('sha256').update(sealedBytes).digest('hex')}`;
      return await this.options.registry.sealArtifact({
        artifactId: artifact.id,
        contentSha256,
        byteSize: sealedBytes.byteLength,
        ...(input.activeLease ?? {}),
      });
    } catch (error) {
      if (existsSync(temporaryUri)) rmSync(temporaryUri, { force: true });
      if (published) {
        const persisted = await this.options.registry.getArtifact(artifact.id);
        if (persisted?.state === 'SEALED') {
          const persistedBytes = readFileSync(storageUri);
          const persistedHash = `sha256:${createHash('sha256').update(persistedBytes).digest('hex')}`;
          if (persisted.contentSha256 === persistedHash && persisted.byteSize === persistedBytes.byteLength) {
            return persisted;
          }
        }
      }
      if (published && existsSync(storageUri)) {
        renameSync(storageUri, `${storageUri}.${artifact.id}.orphan`);
      }
      await this.options.registry.failArtifact(artifact.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    const content = JSON.stringify(input.value, null, 2);
    if (content === undefined) throw new TypeError('JSON artifact value is not serializable');
    return this.writeBytes(input, Buffer.from(content));
  }

  async writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact> {
    const bytes = Buffer.from(input.bytes);
    return this.writeBytes(input, bytes, inspectBinary(bytes));
  }

  async reconcileStaging(): Promise<void> {
    for (const artifact of await this.options.registry.listStagingArtifacts()) {
      if (!existsSync(artifact.storageUri)) {
        await this.options.registry.failArtifact(artifact.id, 'staging artifact file is missing');
        continue;
      }
      const quarantineUri = `${artifact.storageUri}.${artifact.id}.orphan`;
      renameSync(artifact.storageUri, quarantineUri);
      await this.options.registry.failArtifact(artifact.id, `orphaned staging artifact moved to ${quarantineUri}`);
    }
  }

  private assertVerifiedPath(artifact: ControlArtifact): void {
    if (!artifact.planVersionId) {
      throw new ArtifactIntegrityError(artifact.id, 'has no versioned workspace identity');
    }
    try {
      const directory = this.directoryFor({
        taskId: artifact.taskId,
        planVersionId: artifact.planVersionId,
        attemptId: artifact.attemptId ?? undefined,
      });
      const lexicalRelative = relative(resolve(directory), resolve(artifact.storageUri));
      if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
        throw new Error('path escapes workspace');
      }
      this.assertUnaliasedRootPath(directory);
      this.assertUnaliasedRootPath(artifact.storageUri);
    } catch {
      throw new ArtifactIntegrityError(artifact.id, 'storage path does not match its versioned workspace');
    }
  }

  private async readVerifiedBytes(artifactId: string, verifyPath = false): Promise<{
    artifact: ControlArtifact;
    bytes: Buffer;
  }> {
    const artifact = await this.options.registry.requireSealedArtifact(artifactId);
    if (verifyPath) this.assertVerifiedPath(artifact);
    const bytes = readFileSync(artifact.storageUri);
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== artifact.contentSha256 || bytes.byteLength !== artifact.byteSize) {
      throw new ArtifactIntegrityError(artifactId);
    }
    return { artifact, bytes };
  }

  async verifySealed(artifactId: string): Promise<ControlArtifact> {
    return (await this.readVerifiedBytes(artifactId)).artifact;
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    const { artifact, bytes } = await this.readVerifiedBytes(artifactId);
    const value = JSON.parse(bytes.toString('utf8')) as T;
    return { artifact, value };
  }

  async readVerifiedBinary(artifactId: string): Promise<{
    artifact: ControlArtifact;
    bytes: Buffer;
    metadata: TrustedBinaryMetadata;
  }> {
    const { artifact, bytes } = await this.readVerifiedBytes(artifactId, true);
    const metadata = inspectBinary(bytes);
    const persisted = artifact.metadata;
    if (
      artifact.mediaType !== metadata.contentType
      || artifact.byteSize !== metadata.byteSize
      || !persisted
      || Object.keys(persisted).length !== 2
      || persisted.width !== metadata.width
      || persisted.height !== metadata.height
    ) {
      throw new ArtifactIntegrityError(artifactId, 'trusted media metadata does not match its bytes');
    }
    return { artifact, bytes, metadata };
  }
}
