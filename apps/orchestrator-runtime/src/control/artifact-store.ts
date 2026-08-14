import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { imageSize } from 'image-size';
import sharp from 'sharp';
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

function sha256Descriptor(descriptor: number, byteSize: number): string {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(byteSize)) {
    throw new Error('published file size changed from its sealed byte size');
  }
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, byteSize)));
  let position = 0;
  while (position < byteSize) {
    const read = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, byteSize - position), position);
    if (read === 0) throw new Error('published file ended before its sealed byte size');
    hash.update(chunk.subarray(0, read));
    position += read;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error('published file changed while hashing');
  }
  return `sha256:${hash.digest('hex')}`;
}

function pngPayloadMatchesDimensions(
  compressed: Buffer[],
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
  paletteEntries: number,
): boolean {
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (!channels || !allowedDepths[colorType]?.includes(bitDepth) || (interlace !== 0 && interlace !== 1)) return false;
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const layouts = passes.map(([startX, startY, stepX, stepY]) => {
    const passWidth = width <= startX! ? 0 : Math.ceil((width - startX!) / stepX!);
    const passHeight = height <= startY! ? 0 : Math.ceil((height - startY!) / stepY!);
    return { passWidth, passHeight, rowSize: Math.ceil((passWidth * channels * bitDepth) / 8) };
  }).filter(({ passHeight }) => passHeight > 0);
  const expectedLength = layouts.reduce((total, layout) => total + (layout.rowSize + 1) * layout.passHeight, 0);
  const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  try {
    const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength });
    if (inflated.byteLength !== expectedLength) return false;
    let offset = 0;
    for (const layout of layouts) {
      let previous = Buffer.alloc(layout.rowSize);
      for (let row = 0; row < layout.passHeight; row += 1) {
        const filter = inflated[offset++];
        if (filter === undefined || filter > 4) return false;
        const reconstructed = Buffer.allocUnsafe(layout.rowSize);
        for (let index = 0; index < layout.rowSize; index += 1) {
          const raw = inflated[offset + index]!;
          const left = index >= bytesPerPixel ? reconstructed[index - bytesPerPixel]! : 0;
          const above = previous[index] ?? 0;
          const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel]! : 0;
          let predictor = 0;
          if (filter === 1) predictor = left;
          else if (filter === 2) predictor = above;
          else if (filter === 3) predictor = Math.floor((left + above) / 2);
          else if (filter === 4) {
            const estimate = left + above - upperLeft;
            const leftDistance = Math.abs(estimate - left);
            const aboveDistance = Math.abs(estimate - above);
            const upperLeftDistance = Math.abs(estimate - upperLeft);
            predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
              ? left
              : aboveDistance <= upperLeftDistance ? above : upperLeft;
          }
          reconstructed[index] = (raw + predictor) & 0xff;
        }
        offset += layout.rowSize;
        if (colorType === 3) {
          for (let pixel = 0; pixel < layout.passWidth; pixel += 1) {
            const bitOffset = pixel * bitDepth;
            const shift = 8 - bitDepth - (bitOffset % 8);
            const sample = (reconstructed[Math.floor(bitOffset / 8)]! >> shift) & ((1 << bitDepth) - 1);
            if (sample >= paletteEntries) return false;
          }
        }
        previous = reconstructed;
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
  let paletteEntries = 0;
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
      paletteEntries = length / 3;
    }
    if (type === 'IDAT') {
      if (imageDataEnded || (colorType === 3 && !sawPalette) || imageData.length >= 1_024) return false;
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
        && pngPayloadMatchesDimensions(imageData, width, height, bitDepth, colorType, interlace, paletteEntries);
    }
    offset = chunkEnd;
  }
  return false;
}

function parseJpegQuantizationSegment(bytes: Buffer, offset: number, length: number): number[] | null {
  let cursor = offset + 2;
  const end = offset + length;
  const tableIds: number[] = [];
  while (cursor < end) {
    const precisionAndId = bytes[cursor++];
    if (precisionAndId === undefined || (precisionAndId >> 4) > 1 || (precisionAndId & 0x0f) > 3) return null;
    tableIds.push(precisionAndId & 0x0f);
    cursor += (precisionAndId >> 4) === 0 ? 64 : 128;
    if (cursor > end) return null;
  }
  return cursor === end && tableIds.length > 0 ? tableIds : null;
}

function parseJpegHuffmanSegment(bytes: Buffer, offset: number, length: number): string[] | null {
  let cursor = offset + 2;
  const end = offset + length;
  const tableKeys: string[] = [];
  while (cursor < end) {
    const classAndId = bytes[cursor++];
    if (classAndId === undefined || (classAndId >> 4) > 1 || (classAndId & 0x0f) > 3 || cursor + 16 > end) return null;
    let symbolCount = 0;
    let availableCodes = 1;
    for (let index = 0; index < 16; index += 1) {
      availableCodes = (availableCodes << 1) - bytes[cursor + index]!;
      if (availableCodes < 0) return null;
      symbolCount += bytes[cursor + index]!;
    }
    if (symbolCount === 0 || cursor + 16 + symbolCount > end) return null;
    tableKeys.push(`${classAndId >> 4}:${classAndId & 0x0f}`);
    cursor += 16 + symbolCount;
  }
  return cursor === end && tableKeys.length > 0 ? tableKeys : null;
}

function isJpegContainerValid(bytes: Buffer): boolean {
  if (bytes.byteLength < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frameMarker = 0;
  const quantizationTables = new Set<number>();
  const huffmanTables = new Set<string>();
  const frameComponents = new Map<number, number>();
  let sawScan = false;
  let sawScanByte = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      return offset === bytes.byteLength && frameComponents.size > 0 && sawScan && sawScanByte;
    }
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return false;
    if (marker === 0xdb) {
      const ids = parseJpegQuantizationSegment(bytes, offset, segmentLength);
      if (!ids) return false;
      for (const id of ids) quantizationTables.add(id);
    }
    if (marker === 0xc4) {
      const keys = parseJpegHuffmanSegment(bytes, offset, segmentLength);
      if (!keys) return false;
      for (const key of keys) huffmanTables.add(key);
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frameComponents.size > 0 || bytes[offset + 2] !== 8) return false;
      const componentCount = bytes[offset + 7];
      if (!componentCount || componentCount > 4 || segmentLength !== 8 + 3 * componentCount) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return false;
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = offset + 8 + index * 3;
        const id = bytes[componentOffset]!;
        const sampling = bytes[componentOffset + 1]!;
        const tableId = bytes[componentOffset + 2]!;
        if (frameComponents.has(id) || (sampling >> 4) === 0 || (sampling >> 4) > 4 || (sampling & 0x0f) === 0 || (sampling & 0x0f) > 4 || tableId > 3) return false;
        frameComponents.set(id, tableId);
      }
      frameMarker = marker;
    }
    if (marker === 0xda) {
      const scanComponentCount = bytes[offset + 2];
      if (!scanComponentCount || scanComponentCount > frameComponents.size || segmentLength !== 6 + 2 * scanComponentCount) return false;
      const scanIds = new Set<number>();
      for (let index = 0; index < scanComponentCount; index += 1) {
        const selectorOffset = offset + 3 + index * 2;
        const id = bytes[selectorOffset]!;
        const selectors = bytes[selectorOffset + 1]!;
        if (!frameComponents.has(id) || scanIds.has(id) || !quantizationTables.has(frameComponents.get(id)!)) return false;
        scanIds.add(id);
        const dc = selectors >> 4;
        const ac = selectors & 0x0f;
        if (dc > 3 || ac > 3) return false;
        const spectralStart = bytes[offset + 3 + scanComponentCount * 2]!;
        const spectralEnd = bytes[offset + 4 + scanComponentCount * 2]!;
        if (spectralStart === 0 && !huffmanTables.has(`0:${dc}`)) return false;
        if (spectralEnd > 0 && !huffmanTables.has(`1:${ac}`)) return false;
      }
      const spectralStart = bytes[offset + 3 + scanComponentCount * 2]!;
      const spectralEnd = bytes[offset + 4 + scanComponentCount * 2]!;
      const approximation = bytes[offset + 5 + scanComponentCount * 2]!;
      if (spectralStart > spectralEnd || spectralEnd > 63 || (frameMarker !== 0xc2 && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))) return false;
      sawScan = true;
    }
    offset += segmentLength;
    if (marker !== 0xda) continue;
    let currentScanHasByte = false;
    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        sawScanByte = true;
        currentScanHasByte = true;
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (bytes[offset] === 0xff) offset += 1;
      const escaped = bytes[offset];
      if (escaped === 0x00 || (escaped !== undefined && escaped >= 0xd0 && escaped <= 0xd7)) {
        currentScanHasByte = true;
        offset += 1;
        continue;
      }
      if (!currentScanHasByte) return false;
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function isWebpImagePayloadValid(bytes: Buffer, type: string, dataOffset: number, length: number): boolean {
  if (type === 'VP8 ') {
    if (length <= 10) return false;
    const frameTag = bytes.readUIntLE(dataOffset, 3);
    const firstPartitionLength = frameTag >>> 5;
    return (frameTag & 1) === 0
      && ((frameTag >> 1) & 7) <= 3
      && ((frameTag >> 4) & 1) === 1
      && length > 10 + firstPartitionLength
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a
      && (bytes.readUInt16LE(dataOffset + 6) & 0x3fff) > 0
      && (bytes.readUInt16LE(dataOffset + 8) & 0x3fff) > 0;
  }
  if (type === 'VP8L') {
    return length > 5 && bytes[dataOffset] === 0x2f && (bytes[dataOffset + 4]! >> 5) === 0;
  }
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
  let sawExtendedHeader = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + length;
    if (chunkEnd > bytes.byteLength) return false;
    if (type === 'VP8X') {
      if (sawExtendedHeader || offset !== 12 || length !== 10) return false;
      const dataOffset = offset + 8;
      if ((bytes[dataOffset]! & 0xc1) !== 0 || bytes.readUIntBE(dataOffset + 1, 3) !== 0) return false;
      if (bytes.readUIntLE(dataOffset + 4, 3) === 0xffffff || bytes.readUIntLE(dataOffset + 7, 3) === 0xffffff) return false;
      sawExtendedHeader = true;
    }
    if ((type === 'VP8 ' || type === 'VP8L') && sawImageChunk) return false;
    if (type === 'ANMF' && !sawExtendedHeader) return false;
    if (isWebpImagePayloadValid(bytes, type, offset + 8, length)) sawImageChunk = true;
    offset = chunkEnd + (length % 2);
  }
  return sawImageChunk && offset === bytes.byteLength;
}

async function inspectBinary(bytes: Buffer): Promise<TrustedBinaryMetadata> {
  if (bytes.byteLength > MAX_BINARY_BYTE_SIZE) {
    throw new BinaryArtifactValidationError('byte size exceeds 10 MiB');
  }
  let dimensions: { width: number; height: number; type?: string };
  try {
    dimensions = imageSize(bytes);
  } catch (error) {
    throw new BinaryArtifactValidationError(error instanceof Error ? error.message : String(error));
  }
  const { width, height } = dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new BinaryArtifactValidationError('image dimensions or signature are invalid');
  }
  if (width * height > MAX_BINARY_PIXEL_COUNT) {
    throw new BinaryArtifactValidationError('pixel count exceeds 20 megapixels');
  }
  let contentType: TrustedBinaryContentType;
  let sharpFormat: 'png' | 'jpeg' | 'webp';
  let containerValid = false;
  if (dimensions.type === 'png') {
    contentType = 'image/png';
    sharpFormat = 'png';
    containerValid = isPngContainerValid(bytes);
  } else if (dimensions.type === 'jpg') {
    contentType = 'image/jpeg';
    sharpFormat = 'jpeg';
    containerValid = isJpegContainerValid(bytes);
  } else if (dimensions.type === 'webp') {
    contentType = 'image/webp';
    sharpFormat = 'webp';
    containerValid = isWebpContainerValid(bytes);
  } else {
    throw new BinaryArtifactValidationError('only complete PNG, JPEG, and WebP bytes are supported');
  }
  if (!containerValid) {
    throw new BinaryArtifactValidationError('only complete PNG, JPEG, and WebP bytes are supported');
  }
  try {
    const decoder = sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_BINARY_PIXEL_COUNT,
    });
    const decodedMetadata = await decoder.metadata();
    if (
      decodedMetadata.format !== sharpFormat
      || decodedMetadata.width !== width
      || decodedMetadata.height !== height
      || (decodedMetadata.pages ?? 1) !== 1
    ) {
      throw new Error('decoded image metadata does not match its sniffed header');
    }
    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== width
      || decoded.info.height !== height
      || decoded.data.byteLength !== width * height * decoded.info.channels
    ) {
      throw new Error('decoded image pixels are incomplete');
    }
  } catch (error) {
    throw new BinaryArtifactValidationError(`decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { contentType, byteSize: bytes.byteLength, width, height };
}

export class ControlArtifactStore {
  constructor(
    private readonly options: {
      root: string;
      registry: Pick<
        ControlPlaneRepository,
        | 'createStagingArtifact' | 'sealArtifact' | 'failArtifact' | 'getArtifact'
        | 'listArtifactsByStorageUri' | 'listStagingArtifacts'
        | 'requireSealedArtifact' | 'requireSealedArtifactBinding' | 'invalidateArtifactPublication'
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

  private descriptorMatchesPath(path: string, descriptor: number): boolean {
    try {
      const descriptorStat = fstatSync(descriptor, { bigint: true });
      const pathStat = lstatSync(path, { bigint: true });
      return !pathStat.isSymbolicLink()
        && descriptorStat.dev === pathStat.dev
        && descriptorStat.ino === pathStat.ino;
    } catch {
      return false;
    }
  }

  private descriptorPathInsideRoot(rootPhysicalPath: string, path: string, descriptor: number): boolean {
    if (!this.descriptorMatchesPath(path, descriptor)) return false;
    try {
      const physicalPath = realpathSync(path);
      const physicalRelative = relative(rootPhysicalPath, physicalPath);
      return physicalRelative !== '' && !physicalRelative.startsWith('..') && !isAbsolute(physicalRelative);
    } catch {
      return false;
    }
  }

  private assertDescriptorInsideRoot(rootPhysicalPath: string, path: string, descriptor: number): void {
    if (!this.descriptorPathInsideRoot(rootPhysicalPath, path, descriptor)) {
      throw new ArtifactIntegrityError('publication', 'publication directory escaped its pinned root');
    }
  }

  private assertDescriptorPath(path: string, descriptor: number): void {
    if (!this.descriptorMatchesPath(path, descriptor)) {
      throw new ArtifactIntegrityError('publication', 'filesystem identity changed during publication');
    }
  }

  private async writeBytes(
    input: ArtifactWriteBase,
    bytes: Buffer,
    metadata?: TrustedBinaryMetadata,
  ): Promise<ControlArtifact> {
    const directory = this.directoryFor(input);
    const storageUri = this.resolveArtifactPath(directory, input.relativePath);
    const parentUri = dirname(storageUri);
    const rootUri = resolve(this.options.root);
    const callerContentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let artifact: ControlArtifact | null = null;
    let temporaryUri = '';
    let rootPhysicalPath = '';
    let rootDescriptor = -1;
    let parentDescriptor = -1;
    let temporaryDescriptor = -1;
    let publishedDescriptor = -1;
    let published = false;

    const publicationStable = () => rootDescriptor >= 0
      && parentDescriptor >= 0
      && this.descriptorMatchesPath(rootUri, rootDescriptor)
      && this.descriptorPathInsideRoot(rootPhysicalPath, parentUri, parentDescriptor)
      && (temporaryDescriptor < 0 || this.descriptorMatchesPath(temporaryUri, temporaryDescriptor))
      && (!published || (publishedDescriptor >= 0 && this.descriptorMatchesPath(storageUri, publishedDescriptor)));

    try {
      mkdirSync(this.options.root, { recursive: true });
      rootDescriptor = openSync(this.options.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      rootPhysicalPath = realpathSync(rootUri);
      this.assertDescriptorPath(rootUri, rootDescriptor);
      this.assertUnaliasedRootPath(storageUri);

      artifact = await this.options.registry.createStagingArtifact({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: input.kind,
        storageUri,
        schemaVersion: input.schemaVersion ?? 'v1',
        sensitivity: input.sensitivity ?? 'internal',
        redactionPolicyVersion: input.redactionPolicyVersion ?? 'v1',
        ...(metadata
          ? { mediaType: metadata.contentType, metadata: { width: metadata.width, height: metadata.height } }
          : {}),
      });
      temporaryUri = `${storageUri}.${artifact.id}.tmp`;
      mkdirSync(parentUri, { recursive: true });
      this.assertDescriptorPath(this.options.root, rootDescriptor);
      parentDescriptor = openSync(parentUri, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.assertDescriptorPath(parentUri, parentDescriptor);
      this.assertDescriptorInsideRoot(rootPhysicalPath, parentUri, parentDescriptor);
      this.assertDescriptorPath(this.options.root, rootDescriptor);

      temporaryDescriptor = openSync(
        temporaryUri,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      this.assertDescriptorPath(rootUri, rootDescriptor);
      this.assertDescriptorInsideRoot(rootPhysicalPath, parentUri, parentDescriptor);
      this.assertDescriptorPath(temporaryUri, temporaryDescriptor);
      writeFileSync(temporaryDescriptor, bytes);
      fsyncSync(temporaryDescriptor);
      const temporaryStat = fstatSync(temporaryDescriptor, { bigint: true });
      if (!temporaryStat.isFile() || temporaryStat.size !== BigInt(bytes.byteLength)) {
        throw new ArtifactIntegrityError(artifact.id, 'validated temporary file size changed');
      }
      this.assertDescriptorPath(rootUri, rootDescriptor);
      this.assertDescriptorInsideRoot(rootPhysicalPath, parentUri, parentDescriptor);
      this.assertDescriptorPath(temporaryUri, temporaryDescriptor);

      let reusedPublication = false;
      try {
        linkSync(temporaryUri, storageUri);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owners = await this.options.registry.listArtifactsByStorageUri(storageUri);
        const current = owners.find((candidate) => candidate.id === artifact!.id);
        const previous = owners.filter((candidate) => candidate.id !== artifact!.id);
        if (!current || current.state !== 'STAGING' || previous.length === 0 || previous.some((candidate) => candidate.state !== 'FAILED')) {
          throw error;
        }
        reusedPublication = true;
      }
      published = true;
      publishedDescriptor = openSync(storageUri, constants.O_RDONLY | constants.O_NOFOLLOW);
      const publishedStat = fstatSync(publishedDescriptor, { bigint: true });
      if (
        !publishedStat.isFile()
        || publishedStat.size !== temporaryStat.size
        || (!reusedPublication && (
          publishedStat.dev !== temporaryStat.dev
          || publishedStat.ino !== temporaryStat.ino
          || publishedStat.nlink < 2n
        ))
      ) {
        throw new ArtifactIntegrityError(artifact.id, 'published file does not match validated input');
      }
      this.assertDescriptorPath(rootUri, rootDescriptor);
      this.assertDescriptorInsideRoot(rootPhysicalPath, parentUri, parentDescriptor);
      this.assertDescriptorPath(temporaryUri, temporaryDescriptor);
      this.assertDescriptorPath(storageUri, publishedDescriptor);
      const publishedContentSha256 = sha256Descriptor(publishedDescriptor, bytes.byteLength);
      if (publishedContentSha256 !== callerContentSha256) {
        throw new ArtifactIntegrityError(artifact.id, 'published content does not match validated caller bytes');
      }

      const sealed = await this.options.registry.sealArtifact({
        artifactId: artifact.id,
        contentSha256: publishedContentSha256,
        byteSize: bytes.byteLength,
        ...(input.activeLease ?? {}),
      });
      try {
        this.assertDescriptorPath(rootUri, rootDescriptor);
        this.assertDescriptorInsideRoot(rootPhysicalPath, parentUri, parentDescriptor);
        this.assertDescriptorPath(temporaryUri, temporaryDescriptor);
        this.assertDescriptorPath(storageUri, publishedDescriptor);
        if (sha256Descriptor(publishedDescriptor, bytes.byteLength) !== publishedContentSha256) {
          throw new ArtifactIntegrityError(artifact.id, 'published content changed while seal was pending');
        }
      } catch (error) {
        await this.options.registry.invalidateArtifactPublication(
          artifact.id,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return sealed;
    } catch (error) {
      const persisted = artifact && published ? await this.options.registry.getArtifact(artifact.id) : null;
      if (
        artifact
        && persisted?.state === 'SEALED'
        && publicationStable()
        && persisted.contentSha256 === callerContentSha256
        && sha256Descriptor(publishedDescriptor, bytes.byteLength) === callerContentSha256
      ) {
        return persisted;
      }
      if (artifact && persisted?.state === 'SEALED') {
        await this.options.registry.invalidateArtifactPublication(
          artifact.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      // Path cleanup is intentionally deferred to a future trusted GC. Node does not expose
      // dirfd-relative unlink/rename, so cleanup after an ancestor swap cannot be made safe.
      if (artifact) await this.options.registry.failArtifact(artifact.id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (publishedDescriptor >= 0) closeSync(publishedDescriptor);
      if (temporaryDescriptor >= 0) closeSync(temporaryDescriptor);
      if (parentDescriptor >= 0) closeSync(parentDescriptor);
      if (rootDescriptor >= 0) closeSync(rootDescriptor);
    }
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    const content = JSON.stringify(input.value, null, 2);
    if (content === undefined) throw new TypeError('JSON artifact value is not serializable');
    return this.writeBytes(input, Buffer.from(content));
  }

  async writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact> {
    if (input.bytes.byteLength > MAX_BINARY_BYTE_SIZE) {
      throw new BinaryArtifactValidationError('byte size exceeds 10 MiB');
    }
    const bytes = Buffer.from(input.bytes);
    return this.writeBytes(input, bytes, await inspectBinary(bytes));
  }

  async reconcileStaging(): Promise<void> {
    for (const artifact of await this.options.registry.listStagingArtifacts()) {
      const reason = existsSync(artifact.storageUri)
        ? `staging artifact path retained for trusted GC: ${artifact.storageUri}`
        : 'staging artifact file is missing';
      await this.options.registry.failArtifact(artifact.id, reason);
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

  private async readVerifiedBytes(
    artifactId: string,
    verifyPath = false,
    maxByteSize?: number,
  ): Promise<{ artifact: ControlArtifact; bytes: Buffer }> {
    const artifact = verifyPath
      ? await this.options.registry.requireSealedArtifactBinding(artifactId)
      : await this.options.registry.requireSealedArtifact(artifactId);
    if (verifyPath) this.assertVerifiedPath(artifact);
    let descriptor = -1;
    try {
      descriptor = openSync(artifact.storageUri, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) throw new ArtifactIntegrityError(artifactId, 'sealed storage is not a regular file');
      if (maxByteSize !== undefined && before.size > BigInt(maxByteSize)) {
        throw new BinaryArtifactValidationError('stored byte size exceeds 10 MiB');
      }
      if (artifact.byteSize === null || before.size !== BigInt(artifact.byteSize)) {
        throw new ArtifactIntegrityError(artifactId, 'sealed byte size does not match storage');
      }
      if (verifyPath) this.assertDescriptorPath(artifact.storageUri, descriptor);
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.byteLength !== artifact.byteSize) {
        throw new ArtifactIntegrityError(artifactId, 'sealed file changed during read');
      }
      if (verifyPath) {
        this.assertDescriptorPath(artifact.storageUri, descriptor);
        this.assertVerifiedPath(artifact);
      }
      const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actual !== artifact.contentSha256) throw new ArtifactIntegrityError(artifactId);
      return { artifact, bytes };
    } finally {
      if (descriptor >= 0) closeSync(descriptor);
    }
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
    const { artifact, bytes } = await this.readVerifiedBytes(artifactId, true, MAX_BINARY_BYTE_SIZE);
    const metadata = await inspectBinary(bytes);
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
