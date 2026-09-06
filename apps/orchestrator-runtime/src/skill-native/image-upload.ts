import { imageSize } from 'image-size';
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

export interface UploadedImage {
  bytes: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  pixelCount: number;
}

export async function decodeUploadedImage(value: unknown): Promise<UploadedImage> {
  if (typeof value !== 'string') throw new Error('image upload must be a data URL');
  const match = DATA_URL.exec(value);
  if (!match || match[0] !== value || match[2]!.length % 4 !== 0) {
    throw new Error('image upload must be canonical base64 JPEG, PNG, or WebP data');
  }
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) {
    throw new Error('image upload is empty, malformed, or exceeds 10 MiB');
  }

  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new Error('image upload has an invalid image header');
  }
  const mediaType = match[1] as UploadedImage['mediaType'];
  const expectedFormat = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
  if (
    dimensions.type !== expectedFormat
    || !Number.isInteger(dimensions.width)
    || !Number.isInteger(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('image upload type or dimensions are invalid');
  }

  try {
    const decoder = sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    const metadata = await decoder.metadata();
    const sharpFormat = mediaType === 'image/jpeg' ? 'jpeg' : mediaType.slice('image/'.length);
    if (
      metadata.format !== sharpFormat
      || metadata.width !== dimensions.width
      || metadata.height !== dimensions.height
      || (metadata.pages ?? 1) !== 1
    ) throw new Error('decoded metadata does not match the image header');
    await decoder.raw().toBuffer();
  } catch {
    throw new Error('image upload cannot be decoded safely');
  }

  return {
    bytes,
    mediaType,
    pixelCount: dimensions.width * dimensions.height,
  };
}
