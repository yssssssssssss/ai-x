import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  MAX_IMAGE_BASE64_CHARS,
  transcodeZeroImages,
  type ZeroVisualInput,
} from '../apps/agent-api/src/integrations/zero/zero-image-transcoder.ts';

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function jpeg(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><text x="20" y="60" font-size="40">visual evidence</text></svg>`) }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function png(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } })
    .png()
    .toBuffer();
}

test('Zero image transcoder keeps paired long-image slice boundaries aligned and script-safe', async () => {
  const original = await jpeg(600, 3600, { r: 245, g: 245, b: 245 });
  const annotation = await jpeg(600, 3600, { r: 255, g: 235, b: 235 });
  const before = [hash(original), hash(annotation)];
  const inputs: ZeroVisualInput[] = [{
    key: 'comparison:original', blockId: 'comparison', role: 'image_original', pairKey: 'comparison',
    mediaType: 'image/jpeg', bytes: original, width: 600, height: 3600, exportPolicy: 'allow',
  }, {
    key: 'comparison:annotation', blockId: 'comparison', role: 'image_annotation', pairKey: 'comparison',
    mediaType: 'image/jpeg', bytes: annotation, width: 600, height: 3600, exportPolicy: 'allow',
  }];

  const result = await transcodeZeroImages(inputs);
  const originals = result.slices.filter((slice) => slice.role === 'image_original');
  const annotations = result.slices.filter((slice) => slice.role === 'image_annotation');
  assert.ok(originals.length >= 2);
  assert.equal(originals.length, annotations.length);
  assert.deepEqual(
    originals.map(({ sourceTop, sourceHeight }) => [sourceTop, sourceHeight]),
    annotations.map(({ sourceTop, sourceHeight }) => [sourceTop, sourceHeight]),
  );
  for (const slice of result.slices) {
    assert.ok(slice.base64Length <= MAX_IMAGE_BASE64_CHARS);
    assert.equal(slice.mediaType, 'image/jpeg');
    assert.match(slice.contentSha256, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.deepEqual([hash(original), hash(annotation)], before, 'source bytes remain immutable');
});

test('Zero image transcoder converts transparent PNG and SVG charts to bounded publish formats', async () => {
  const raster = await png(320, 240);
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640"><rect width="1200" height="640" fill="#fff"/><rect x="80" y="80" width="500" height="80" fill="#e1251b"/></svg>',
  );
  const result = await transcodeZeroImages([{
    key: 'image', blockId: 'image', role: 'image', mediaType: 'image/png', bytes: raster,
    width: 320, height: 240, exportPolicy: 'allow', preserveTransparency: false,
  }, {
    key: 'chart', blockId: 'chart', role: 'chart', mediaType: 'image/svg+xml', bytes: svg,
    width: 1200, height: 640, exportPolicy: 'allow',
  }]);
  const image = result.slices.find((slice) => slice.sourceKey === 'image');
  const chart = result.slices.find((slice) => slice.sourceKey === 'chart');
  assert.equal(image?.mediaType, 'image/jpeg');
  assert.equal(chart?.mediaType, 'image/png');
  assert.equal(chart?.sliceCount, 1);
  assert.ok((chart?.base64Length ?? Infinity) <= MAX_IMAGE_BASE64_CHARS);
});

test('Zero image transcoder preserves explicitly transparent PNG output', async () => {
  const bytes = await png(64, 64);
  const result = await transcodeZeroImages([{
    key: 'transparent', blockId: 'transparent', role: 'image', mediaType: 'image/png', bytes,
    width: 64, height: 64, exportPolicy: 'allow', preserveTransparency: true,
  }]);
  assert.equal(result.slices[0]?.mediaType, 'image/png');
});

test('Zero image transcoder exports blocked-policy inputs and rejects mismatched pair geometry', async () => {
  const bytes = await jpeg(100, 100, { r: 255, g: 255, b: 255 });
  const direct = await transcodeZeroImages([{
    key: 'blocked', blockId: 'blocked', role: 'image', mediaType: 'image/jpeg', bytes,
    width: 100, height: 100, exportPolicy: 'block',
  }]);
  assert.equal(direct.slices.length, 1);
  await assert.rejects(() => transcodeZeroImages([{
    key: 'pair-a', blockId: 'pair', role: 'image_original', pairKey: 'pair', mediaType: 'image/jpeg', bytes,
    width: 100, height: 100, exportPolicy: 'allow',
  }, {
    key: 'pair-b', blockId: 'pair', role: 'image_annotation', pairKey: 'pair', mediaType: 'image/jpeg', bytes,
    width: 100, height: 90, exportPolicy: 'allow',
  }]), /geometry/);
});
