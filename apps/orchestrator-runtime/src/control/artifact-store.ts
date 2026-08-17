import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  configureFsSafeNative,
  FsSafeError,
  root as openFsSafeRoot,
  type OpenResult,
  type Root,
} from '@openclaw/fs-safe';
import { imageSize } from 'image-size';
import sharp from 'sharp';
import { inflateSync } from 'node:zlib';
import type {
  ControlArtifact,
  ControlExecutionLease,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';

configureFsSafeNative({ mode: 'require' });

const MAX_BINARY_BYTE_SIZE = 10 * 1024 * 1024;
const MAX_BINARY_PIXEL_COUNT = 20_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ArtifactIntegrityError extends Error {
  readonly code?: string;

  constructor(artifactId: string, reason = 'checksum does not match its sealed record', code?: string) {
    super(`artifact ${artifactId} ${reason}`);
    this.name = 'ArtifactIntegrityError';
    this.code = code;
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
  trustedMediaType?: 'image/svg+xml';
}

export type TrustedBinaryContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

export interface TrustedBinaryMetadata {
  contentType: TrustedBinaryContentType;
  byteSize: number;
  width: number;
  height: number;
}

async function readHandleExact(handle: FileHandle, byteSize: number): Promise<{ bytes: Buffer; contentSha256: string }> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size !== BigInt(byteSize)) {
    throw new Error('opened file size changed from its sealed byte size');
  }
  const bytes = Buffer.allocUnsafe(byteSize);
  let position = 0;
  while (position < byteSize) {
    const result = await handle.read(bytes, position, byteSize - position, position);
    if (result.bytesRead === 0) throw new Error('opened file ended before its sealed byte size');
    position += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error('opened file changed while reading');
  }
  return {
    bytes,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function indexedPngSamplesFitPalette(
  compressed: Buffer[],
  width: number,
  height: number,
  bitDepth: number,
  interlace: number,
  paletteEntries: number,
): boolean {
  if (![1, 2, 4, 8].includes(bitDepth) || (interlace !== 0 && interlace !== 1) || paletteEntries === 0) return false;
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const layouts = passes.map(([startX, startY, stepX, stepY]) => {
    const passWidth = width <= startX! ? 0 : Math.ceil((width - startX!) / stepX!);
    const passHeight = height <= startY! ? 0 : Math.ceil((height - startY!) / stepY!);
    return { passWidth, passHeight, rowSize: Math.ceil((passWidth * bitDepth) / 8) };
  }).filter(({ passWidth, passHeight }) => passWidth > 0 && passHeight > 0);
  const expectedLength = layouts.reduce((total, layout) => total + (layout.rowSize + 1) * layout.passHeight, 0);
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
          const left = index > 0 ? reconstructed[index - 1]! : 0;
          const above = previous[index] ?? 0;
          const upperLeft = index > 0 ? previous[index - 1]! : 0;
          let predictor = 0;
          if (filter === 1) predictor = left;
          else if (filter === 2) predictor = above;
          else if (filter === 3) predictor = Math.floor((left + above) / 2);
          else if (filter === 4) {
            const estimate = left + above - upperLeft;
            const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
            predictor = distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
              ? left : distances[1]! <= distances[2]! ? above : upperLeft;
          }
          reconstructed[index] = (raw + predictor) & 0xff;
        }
        offset += layout.rowSize;
        for (let pixel = 0; pixel < layout.passWidth; pixel += 1) {
          const bitOffset = pixel * bitDepth;
          const shift = 8 - bitDepth - (bitOffset % 8);
          const sample = (reconstructed[Math.floor(bitOffset / 8)]! >> shift) & ((1 << bitDepth) - 1);
          if (sample >= paletteEntries) return false;
        }
        previous = reconstructed;
      }
    }
    return offset === inflated.byteLength;
  } catch {
    return false;
  }
}

function hasAcceptablePngEnvelope(bytes: Buffer): boolean {
  if (bytes.byteLength < 45 || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let paletteEntries = 0;
  const imageData: Buffer[] = [];
  let idatCount = 0;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const dataEnd = offset + 8 + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false;
    if (type === 'IHDR' && offset === PNG_SIGNATURE.byteLength && length === 13) {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      interlace = bytes[offset + 20]!;
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 768) return false;
      paletteEntries = length / 3;
    } else if (type === 'IDAT') {
      if (++idatCount > 1_024) return false;
      if (colorType === 3) imageData.push(bytes.subarray(offset + 8, dataEnd));
    } else if (type === 'IEND') {
      return length === 0
        && idatCount > 0
        && chunkEnd === bytes.byteLength
        && (colorType !== 3 || indexedPngSamplesFitPalette(
          imageData, width, height, bitDepth, interlace, paletteEntries,
        ));
    }
    offset = chunkEnd;
  }
  return false;
}

function inspectTrustedSvg(bytes: Buffer): TrustedBinaryMetadata {
  const svg = bytes.toString('utf8').trim();
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>') || Buffer.byteLength(svg) !== bytes.byteLength) {
    throw new BinaryArtifactValidationError('trusted SVG must be a standalone UTF-8 svg document');
  }
  if (
    /<\/?(?:script|foreignObject|iframe|object|embed)\b/i.test(svg)
    || /<!DOCTYPE\b|<!ENTITY\b/i.test(svg)
    || /\son[a-z]+\s*=/i.test(svg)
    || /(?:href|xlink:href|src)\s*=\s*["'](?!#)[^"']*["']/i.test(svg)
    || /url\(\s*["']?(?!#)[^)]+\)/i.test(svg)
  ) {
    throw new BinaryArtifactValidationError('trusted SVG contains executable or external content');
  }
  const root = svg.match(/^<svg\b[^>]*>/i)?.[0];
  const width = Number(root?.match(/\bwidth=["']([1-9]\d*)["']/i)?.[1]);
  const height = Number(root?.match(/\bheight=["']([1-9]\d*)["']/i)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new BinaryArtifactValidationError('trusted SVG width and height must be positive integers');
  }
  if (width * height > MAX_BINARY_PIXEL_COUNT) {
    throw new BinaryArtifactValidationError('pixel count exceeds 20 megapixels');
  }
  return { contentType: 'image/svg+xml', byteSize: bytes.byteLength, width, height };
}

async function inspectBinary(
  bytes: Buffer,
  trustedMediaType?: BinaryArtifactWriteInput['trustedMediaType'],
): Promise<TrustedBinaryMetadata> {
  if (bytes.byteLength > MAX_BINARY_BYTE_SIZE) {
    throw new BinaryArtifactValidationError('byte size exceeds 10 MiB');
  }
  if (trustedMediaType === 'image/svg+xml') return inspectTrustedSvg(bytes);
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
  if (dimensions.type === 'png') {
    contentType = 'image/png';
    sharpFormat = 'png';
    if (!hasAcceptablePngEnvelope(bytes)) {
      throw new BinaryArtifactValidationError('PNG IDAT structure is malformed or exceeds the chunk limit');
    }
  } else if (dimensions.type === 'jpg') {
    contentType = 'image/jpeg';
    sharpFormat = 'jpeg';
  } else if (dimensions.type === 'webp') {
    contentType = 'image/webp';
    sharpFormat = 'webp';
  } else {
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

  private async openRoot(): Promise<Root> {
    await mkdir(this.options.root, { recursive: true });
    return openFsSafeRoot(this.options.root, {
      hardlinks: 'allow',
      maxBytes: MAX_BINARY_BYTE_SIZE,
      mkdir: true,
      mode: 0o600,
      nonBlockingRead: true,
      symlinks: 'reject',
    });
  }

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
    if (input.attemptId) return join(this.options.root, 'tasks', input.taskId, 'attempts', input.attemptId);
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

  private logicalPath(storageUri: string): string {
    const logical = relative(resolve(this.options.root), resolve(storageUri));
    if (!logical || logical.startsWith('..') || isAbsolute(logical)) {
      throw new ArtifactIntegrityError('path', 'storage path escapes its trusted root');
    }
    return logical;
  }

  private assertVerifiedPath(artifact: ControlArtifact): string {
    if (!artifact.planVersionId) {
      throw new ArtifactIntegrityError(artifact.id, 'has no versioned workspace identity');
    }
    const logical = this.logicalPath(artifact.storageUri);
    const expectedDirectory = relative(resolve(this.options.root), resolve(this.directoryFor({
      taskId: artifact.taskId,
      planVersionId: artifact.planVersionId,
      attemptId: artifact.attemptId ?? undefined,
    })));
    if (logical !== expectedDirectory && !logical.startsWith(`${expectedDirectory}${sep}`)) {
      throw new ArtifactIntegrityError(artifact.id, 'storage path does not match its versioned workspace');
    }
    return logical;
  }

  private async openExact(root: Root, logicalPath: string, byteSize: number): Promise<{
    opened: OpenResult;
    bytes: Buffer;
    contentSha256: string;
  }> {
    const opened = await root.open(logicalPath, {
      hardlinks: 'allow',
      nonBlockingRead: true,
      symlinks: 'reject',
    });
    try {
      const exact = await readHandleExact(opened.handle, byteSize);
      return { opened, ...exact };
    } catch (error) {
      await opened[Symbol.asyncDispose]();
      throw error;
    }
  }


  private async assertLogicalPathStillOpened(root: Root, logicalPath: string, expected: OpenResult): Promise<void> {
    const current = await root.open(logicalPath, {
      hardlinks: 'allow',
      nonBlockingRead: true,
      symlinks: 'reject',
    });
    try {
      if (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino) {
        throw new ArtifactIntegrityError('publication', 'logical path no longer references the sealed file');
      }
    } finally {
      await current[Symbol.asyncDispose]();
    }
  }

  private async writeBytes(
    input: ArtifactWriteBase,
    bytes: Buffer,
    metadata?: TrustedBinaryMetadata,
  ): Promise<ControlArtifact> {
    const directory = this.directoryFor(input);
    const storageUri = this.resolveArtifactPath(directory, input.relativePath);
    const logicalPath = this.logicalPath(storageUri);
    const callerContentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let artifact: ControlArtifact | null = null;
    let opened: OpenResult | null = null;
    let root: Root | null = null;
    try {
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
      const owners = await this.options.registry.listArtifactsByStorageUri(storageUri);
      const current = owners.find((candidate) => candidate.id === artifact!.id);
      const previous = owners.filter((candidate) => candidate.id !== artifact!.id);
      if (!current || current.state !== 'STAGING' || previous.some((candidate) => candidate.state !== 'FAILED')) {
        throw new ArtifactIntegrityError(artifact.id, 'storage path has a live owner', 'EEXIST');
      }

      root = await this.openRoot();
      if (previous.length > 0) {
        try {
          const existing = await this.openExact(root, logicalPath, bytes.byteLength);
          opened = existing.opened;
          if (existing.contentSha256 !== callerContentSha256) {
            throw new ArtifactIntegrityError(artifact.id, 'FAILED publication bytes differ from validated retry');
          }
        } catch (error) {
          if (!(error instanceof FsSafeError) || error.code !== 'not-found') throw error;
        }
      }
      if (!opened) {
        await root.create(logicalPath, bytes, { mkdir: true, mode: 0o600 });
        root = await this.openRoot();
        const created = await this.openExact(root, logicalPath, bytes.byteLength);
        opened = created.opened;
        if (created.contentSha256 !== callerContentSha256) {
          throw new ArtifactIntegrityError(artifact.id, 'created publication bytes differ from validated input');
        }
      }

      const sealed = await this.options.registry.sealArtifact({
        artifactId: artifact.id,
        contentSha256: callerContentSha256,
        byteSize: bytes.byteLength,
        ...(input.activeLease ?? {}),
      });
      try {
        await this.assertLogicalPathStillOpened(root, logicalPath, opened);
        const afterSeal = await readHandleExact(opened.handle, bytes.byteLength);
        if (afterSeal.contentSha256 !== callerContentSha256) {
          throw new ArtifactIntegrityError(artifact.id, 'publication changed while seal was pending');
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
      const persisted = artifact ? await this.options.registry.getArtifact(artifact.id) : null;
      if (artifact && persisted?.state === 'SEALED' && opened && root) {
        try {
          await this.assertLogicalPathStillOpened(root, logicalPath, opened);
          const afterCommit = await readHandleExact(opened.handle, bytes.byteLength);
          if (persisted.contentSha256 === callerContentSha256 && afterCommit.contentSha256 === callerContentSha256) {
            return persisted;
          }
        } catch {
          // The committed row is invalidated below; never recover through a changed logical path.
        }
        await this.options.registry.invalidateArtifactPublication(
          artifact.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (artifact) await this.options.registry.failArtifact(artifact.id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (opened) await opened[Symbol.asyncDispose]();
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
    return this.writeBytes(input, bytes, await inspectBinary(bytes, input.trustedMediaType));
  }

  async reconcileStaging(): Promise<void> {
    for (const artifact of await this.options.registry.listStagingArtifacts()) {
      await this.options.registry.failArtifact(
        artifact.id,
        `staging artifact path retained or absent for trusted GC: ${artifact.storageUri}`,
      );
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
    if (artifact.byteSize === null) throw new ArtifactIntegrityError(artifactId, 'sealed byte size is missing');
    if (maxByteSize !== undefined && artifact.byteSize > maxByteSize) {
      throw new BinaryArtifactValidationError('stored byte size exceeds 10 MiB');
    }
    const logicalPath = verifyPath ? this.assertVerifiedPath(artifact) : this.logicalPath(artifact.storageUri);
    const root = await this.openRoot();
    let exact: { opened: OpenResult; bytes: Buffer; contentSha256: string };
    try {
      exact = await this.openExact(root, logicalPath, artifact.byteSize);
    } catch (error) {
      throw new ArtifactIntegrityError(
        artifactId,
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      if (exact.contentSha256 !== artifact.contentSha256) throw new ArtifactIntegrityError(artifactId);
      return { artifact, bytes: exact.bytes };
    } finally {
      await exact.opened[Symbol.asyncDispose]();
    }
  }

  async verifySealed(artifactId: string): Promise<ControlArtifact> {
    return (await this.readVerifiedBytes(artifactId)).artifact;
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    const { artifact, bytes } = await this.readVerifiedBytes(artifactId);
    return { artifact, value: JSON.parse(bytes.toString('utf8')) as T };
  }

  async readVerifiedBinary(artifactId: string): Promise<{
    artifact: ControlArtifact;
    bytes: Buffer;
    metadata: TrustedBinaryMetadata;
  }> {
    const { artifact, bytes } = await this.readVerifiedBytes(artifactId, true, MAX_BINARY_BYTE_SIZE);
    const metadata = await inspectBinary(
      bytes,
      artifact.mediaType === 'image/svg+xml' ? 'image/svg+xml' : undefined,
    );
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
