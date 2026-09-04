import {
  BinaryArtifactValidationError,
  inspectTrustedRaster,
} from '../control/artifact-store.ts';

const VISUAL_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export interface VisualInputImage {
  bytes: Buffer;
  contentType: keyof typeof EXTENSIONS;
  extension: 'jpg' | 'png' | 'webp';
  pixelCount: number;
}

export class VisualInputDataUrlError extends Error {
  constructor() {
    super('visual input dataUrl must contain non-empty canonical base64 JPEG, PNG, or WebP data');
    this.name = 'VisualInputDataUrlError';
  }
}

async function decodeVisualDataUrl(value: unknown): Promise<VisualInputImage> {
  if (typeof value !== 'string') throw new VisualInputDataUrlError();
  const match = VISUAL_DATA_URL.exec(value);
  if (!match || match[0] !== value) throw new VisualInputDataUrlError();
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) throw new VisualInputDataUrlError();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0 || bytes.toString('base64') !== encoded) {
    throw new VisualInputDataUrlError();
  }
  const contentType = match[1] as keyof typeof EXTENSIONS;
  let pixelCount = 0;
  try {
    const metadata = await inspectTrustedRaster(bytes);
    if (metadata.contentType !== contentType) throw new VisualInputDataUrlError();
    pixelCount = metadata.width * metadata.height;
  } catch (error) {
    if (error instanceof VisualInputDataUrlError) throw error;
    if (error instanceof BinaryArtifactValidationError) throw new VisualInputDataUrlError();
    throw error;
  }
  return {
    bytes,
    contentType,
    extension: EXTENSIONS[contentType],
    pixelCount,
  };
}

async function collectVisualInputs(value: unknown, images: VisualInputImage[]): Promise<void> {
  if (Array.isArray(value)) {
    for (const child of value) await collectVisualInputs(child, images);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'dataUrl') images.push(await decodeVisualDataUrl(child));
    else await collectVisualInputs(child, images);
  }
}

export async function parseVisualInputDataUrls(value: unknown): Promise<VisualInputImage[]> {
  const images: VisualInputImage[] = [];
  await collectVisualInputs(value, images);
  return images;
}
