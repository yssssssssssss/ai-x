import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ZeroVisualPlacement, ZeroVisualRole } from './zero-report-renderer.ts';

export const MAX_IMAGE_BASE64_CHARS = 44_000;
const DEFAULT_RASTER_WIDTH = 400;
const DEFAULT_JPEG_QUALITY = 45;
const MIN_RASTER_WIDTH = 240;
const MIN_JPEG_QUALITY = 28;
const MAX_SLICE_COUNT = 64;

export interface ZeroVisualInput {
  key: string;
  blockId: string;
  role: ZeroVisualRole;
  pairKey?: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml';
  bytes: Uint8Array;
  width: number;
  height: number;
  exportPolicy: 'allow' | 'mask' | 'block';
  preserveTransparency?: boolean;
  label?: string;
}

export interface ZeroImageSlice {
  key: string;
  sourceKey: string;
  blockId: string;
  role: ZeroVisualRole;
  sliceIndex: number;
  sliceCount: number;
  sourceTop: number;
  sourceHeight: number;
  mediaType: 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
  width: number;
  height: number;
  base64Length: number;
  contentSha256: string;
  label: string;
}

export interface ZeroImageTranscodeResult {
  slices: ZeroImageSlice[];
  placements: ZeroVisualPlacement[];
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validate(input: ZeroVisualInput): void {
  if (!input.key || !input.blockId || input.bytes.byteLength === 0) {
    throw new Error('Zero visual input identity and bytes are required');
  }
  if (input.exportPolicy === 'block') throw new Error(`Zero visual ${input.key} is blocked from export`);
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error(`Zero visual ${input.key} geometry is invalid`);
  }
}

function boundaries(height: number, count: number): Array<{ top: number; height: number }> {
  const result: Array<{ top: number; height: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const top = Math.floor((height * index) / count);
    const end = Math.floor((height * (index + 1)) / count);
    result.push({ top, height: end - top });
  }
  return result;
}

async function rasterSlice(input: {
  visual: ZeroVisualInput;
  boundary: { top: number; height: number };
  width: number;
  quality: number;
}): Promise<{ bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png'; width: number; height: number }> {
  const source = sharp(input.visual.bytes, { limitInputPixels: 20_000_000 })
    .extract({ left: 0, top: input.boundary.top, width: input.visual.width, height: input.boundary.height });
  if (input.visual.preserveTransparency && input.visual.mediaType === 'image/png') {
    const value = await source
      .resize({ width: input.width, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer({ resolveWithObject: true });
    return { bytes: value.data, mediaType: 'image/png', width: value.info.width, height: value.info.height };
  }
  const value = await source
    .flatten({ background: '#ffffff' })
    .resize({ width: input.width, withoutEnlargement: true })
    .jpeg({ quality: input.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer({ resolveWithObject: true });
  return { bytes: value.data, mediaType: 'image/jpeg', width: value.info.width, height: value.info.height };
}

async function chartSlice(input: ZeroVisualInput, width: number): Promise<{
  bytes: Uint8Array;
  mediaType: 'image/png';
  width: number;
  height: number;
}> {
  const value = await sharp(input.bytes, {
    density: input.mediaType === 'image/svg+xml' ? 144 : 72,
    limitInputPixels: 20_000_000,
  })
    .flatten({ background: '#ffffff' })
    .resize({ width, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: value.data, mediaType: 'image/png', width: value.info.width, height: value.info.height };
}

function groupVisuals(inputs: readonly ZeroVisualInput[]): ZeroVisualInput[][] {
  const groups = new Map<string, ZeroVisualInput[]>();
  for (const input of inputs) {
    validate(input);
    const groupKey = input.pairKey ? `pair:${input.pairKey}` : `single:${input.key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(input);
    groups.set(groupKey, group);
  }
  for (const [key, group] of groups) {
    if (!key.startsWith('pair:')) continue;
    if (group.length !== 2) throw new Error(`Zero visual ${key} pair must contain exactly two assets`);
    if (group[0]!.width !== group[1]!.width || group[0]!.height !== group[1]!.height) {
      throw new Error(`Zero visual ${key} pair geometry does not match`);
    }
  }
  return [...groups.values()];
}

async function transcodeGroup(group: readonly ZeroVisualInput[]): Promise<ZeroImageSlice[]> {
  const chart = group.length === 1 && group[0]!.role === 'chart';
  let sliceCount = chart
    ? 1
    : Math.max(1, Math.ceil(group[0]!.height / (group[0]!.width * 3)));
  let width = chart ? 1200 : DEFAULT_RASTER_WIDTH;
  let quality = DEFAULT_JPEG_QUALITY;

  for (;;) {
    const cuts = boundaries(group[0]!.height, sliceCount);
    const encoded: ZeroImageSlice[] = [];
    for (const visual of group) {
      for (let index = 0; index < cuts.length; index += 1) {
        const boundary = cuts[index]!;
        const output = chart
          ? await chartSlice(visual, width)
          : await rasterSlice({ visual, boundary, width, quality });
        const bytes = new Uint8Array(output.bytes);
        encoded.push({
          key: `${visual.key}:${index + 1}`,
          sourceKey: visual.key,
          blockId: visual.blockId,
          role: visual.role,
          sliceIndex: index,
          sliceCount,
          sourceTop: boundary.top,
          sourceHeight: boundary.height,
          mediaType: output.mediaType,
          bytes,
          width: output.width,
          height: output.height,
          base64Length: Buffer.from(bytes).toString('base64').length,
          contentSha256: digest(bytes),
          label: visual.label ?? `${visual.role} ${index + 1}/${sliceCount}`,
        });
      }
    }
    if (encoded.every((slice) => slice.base64Length <= MAX_IMAGE_BASE64_CHARS)) return encoded;
    if (!chart && sliceCount < MAX_SLICE_COUNT && group[0]!.height / (sliceCount + 1) >= 64) {
      sliceCount += 1;
      continue;
    }
    if (quality > MIN_JPEG_QUALITY) {
      quality = Math.max(MIN_JPEG_QUALITY, quality - 4);
      continue;
    }
    if (width > MIN_RASTER_WIDTH) {
      width = Math.max(MIN_RASTER_WIDTH, width - 40);
      continue;
    }
    if (!chart && sliceCount < MAX_SLICE_COUNT) {
      sliceCount += 1;
      continue;
    }
    throw new Error(`Zero visual ${group.map(({ key }) => key).join(',')} cannot fit the script limit`);
  }
}

export async function transcodeZeroImages(
  inputs: readonly ZeroVisualInput[],
): Promise<ZeroImageTranscodeResult> {
  const keys = new Set<string>();
  for (const input of inputs) {
    if (keys.has(input.key)) throw new Error(`duplicate Zero visual key ${input.key}`);
    keys.add(input.key);
  }
  const groups = groupVisuals(inputs);
  const slices = (await Promise.all(groups.map(transcodeGroup))).flat();
  slices.sort((left, right) => {
    const block = left.blockId.localeCompare(right.blockId);
    if (block !== 0) return block;
    const slice = left.sliceIndex - right.sliceIndex;
    if (slice !== 0) return slice;
    return left.role.localeCompare(right.role);
  });
  return {
    slices,
    placements: slices.map((slice) => ({
      key: slice.key,
      blockId: slice.blockId,
      role: slice.role,
      sliceIndex: slice.sliceIndex,
      sliceCount: slice.sliceCount,
      label: slice.label,
    })),
  };
}
