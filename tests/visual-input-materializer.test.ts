import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const modulePath = '../apps/orchestrator-runtime/src/report/visual-input-materializer.ts';
const moduleFile = new URL(modulePath, import.meta.url);

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('real-jpeg-bytes').toString('base64')}`;
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('real-png-bytes').toString('base64')}`;

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
        value: [{ dataUrl: JPEG_DATA_URL }, { dataUrl: PNG_DATA_URL }],
      },
      { gateType: 'confirmation', gateKey: 'scope', value: 'public' },
    ],
  });

  assert.equal(ingests.length, 2);
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
        bytes: Buffer.from('real-jpeg-bytes'),
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
        bytes: Buffer.from('real-png-bytes'),
      },
    },
  ]);
  assert.equal(annotations.length, 2);
  assert.deepEqual(annotations.map((input) => input.original), [
    { assetId: 'asset-1', manifestArtifactId: 'manifest-1' },
    { assetId: 'asset-2', manifestArtifactId: 'manifest-2' },
  ]);
  assert.ok(annotations.every((input) => Array.isArray(input.annotations)));
});
