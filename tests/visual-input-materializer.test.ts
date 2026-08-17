import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const modulePath = '../apps/orchestrator-runtime/src/report/visual-input-materializer.ts';
const moduleFile = new URL(modulePath, import.meta.url);

const JPEG_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
  'base64',
);
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const WEBP_BYTES = Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==', 'base64');
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const WEBP_DATA_URL = `data:image/webp;base64,${WEBP_BYTES.toString('base64')}`;

test('materializes image input gates as sealed originals with derived annotations', async () => {
  assert.equal(existsSync(moduleFile), true, 'VisualInputMaterializer module must exist');
  const { VisualInputMaterializer } = await import(modulePath);
  const ingests: Array<Record<string, unknown>> = [];
  const annotations: Array<Record<string, unknown>> = [];
  const materializer = new VisualInputMaterializer({
    visualAssets: {
      async ingest(input: Record<string, unknown>) {
        ingests.push(input);
        const index = ingests.length;
        return {
          assetArtifact: { id: `asset-${index}` },
          manifestArtifact: { id: `manifest-${index}` },
          manifest: { assetId: `asset-${index}` },
        };
      },
    },
    imageAnnotations: {
      async annotate(input: Record<string, unknown>) {
        annotations.push(input);
        return {};
      },
    },
  });

  await materializer.materialize({
    lease: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      leaseOwner: 'worker',
      leaseToken: 'token',
    },
    gates: [
      {
        gateType: 'input',
        gateKey: 'competitor_screenshots',
        value: [
          { dataUrl: JPEG_DATA_URL },
          { nested: [{ dataUrl: PNG_DATA_URL }, { dataUrl: WEBP_DATA_URL }] },
        ],
      },
      { gateType: 'confirmation', gateKey: 'scope', value: 'public' },
    ],
  });

  assert.equal(ingests.length, 3);
  assert.deepEqual(ingests.map((input) => ({
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    exportPolicy: input.exportPolicy,
    source: input.source,
  })), [
    {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      exportPolicy: 'allow',
      source: {
        kind: 'user_upload',
        fileName: 'competitor_screenshots-1.jpg',
        bytes: JPEG_BYTES,
      },
    },
    {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      exportPolicy: 'allow',
      source: {
        kind: 'user_upload',
        fileName: 'competitor_screenshots-2.png',
        bytes: PNG_BYTES,
      },
    },
    {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      exportPolicy: 'allow',
      source: {
        kind: 'user_upload',
        fileName: 'competitor_screenshots-3.webp',
        bytes: WEBP_BYTES,
      },
    },
  ]);
  assert.equal(annotations.length, 3);
  assert.deepEqual(annotations.map((input) => input.original), [
    { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
    { assetId: 'asset-2', manifestArtifactId: 'manifest-2' },
    { assetId: 'asset-3', manifestArtifactId: 'manifest-3' },
  ]);
  assert.ok(annotations.every((input) => Array.isArray(input.annotations)));
});

test('rejects invalid visual input instead of silently skipping it', async () => {
  let ingestCount = 0;
  const { VisualInputMaterializer } = await import(modulePath);
  const materializer = new VisualInputMaterializer({
    visualAssets: {
      async ingest() {
        ingestCount += 1;
        return {
          assetArtifact: { id: 'asset' },
          manifestArtifact: { id: 'manifest' },
          manifest: { assetId: 'asset' },
        };
      },
    },
    imageAnnotations: {
      async annotate() {
        return {};
      },
    },
  });

  await assert.rejects(
    () => materializer.materialize({
      lease: {
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        leaseOwner: 'worker',
        leaseToken: 'token',
      },
      gates: [
        {
          gateType: 'input',
          gateKey: 'valid_first',
          value: { dataUrl: JPEG_DATA_URL },
        },
        {
          gateType: 'input',
          gateKey: 'competitor_screenshots',
          value: { nested: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
        },
      ],
    }),
    /visual input dataUrl/u,
  );
  assert.equal(ingestCount, 0);
});

test('rejects a complete image whose declared MIME disagrees with its decoded format', async () => {
  const { parseVisualInputDataUrls } = await import(
    '../apps/orchestrator-runtime/src/report/visual-input-data-url.ts'
  );
  await assert.rejects(
    () => parseVisualInputDataUrls({
      dataUrl: `data:image/png;base64,${JPEG_BYTES.toString('base64')}`,
    }),
    /visual input dataUrl/u,
  );
});
