import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ResolvedVisualInputImage } from '../apps/orchestrator-runtime/src/control/visual-input-gate-store.ts';
import { VisualAnalysisSuiteAdapter } from '../apps/orchestrator-runtime/src/runtime/visual-analysis-suite-adapter.ts';
import {
  ToolInvocationError,
  type ToolAdapter,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

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
function resolvedImage(
  id: string,
  bytes: Buffer,
  contentType: 'image/jpeg' | 'image/png' | 'image/webp',
): ResolvedVisualInputImage {
  return {
    artifact: {
      id,
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: null,
      kind: 'visual_input_image',
      state: 'SEALED',
      storageUri: `/trusted/${id}`,
      contentSha256: `sha256:${id}`,
      byteSize: bytes.byteLength,
      schemaVersion: 'visual-input-image-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
      mediaType: contentType,
      metadata: { width: 1, height: 1 },
    },
    bytes,
    metadata: { contentType, byteSize: bytes.byteLength, width: 1, height: 1 },
    dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
  };
}

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
    visuals: [
      {
        gateKey: 'competitor_screenshots',
        multiple: true,
        images: [
          resolvedImage('input-jpeg', JPEG_BYTES, 'image/jpeg'),
          resolvedImage('input-png', PNG_BYTES, 'image/png'),
          resolvedImage('input-webp', WEBP_BYTES, 'image/webp'),
        ],
      },
    ],
    annotationPurpose: 'input_provenance',
  });

  assert.equal(ingests.length, 3);
  assert.deepEqual(ingests.map((input) => ({
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    exportPolicy: input.exportPolicy,
    activeLease: input.activeLease,
    source: input.source,
  })), [
    {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      exportPolicy: 'allow',
      activeLease: {
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        leaseOwner: 'worker',
        leaseToken: 'token',
      },
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
      activeLease: {
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        leaseOwner: 'worker',
        leaseToken: 'token',
      },
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
      activeLease: {
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        leaseOwner: 'worker',
        leaseToken: 'token',
      },
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
  assert.ok(annotations.every((input) => (
    (input.activeLease as Record<string, unknown>)?.leaseToken === 'token'
  )));
  assert.deepEqual(
    annotations.map((input) => input.findingIds),
    [['input-provenance-1'], ['input-provenance-2'], ['input-provenance-3']],
  );
  assert.ok(annotations.every((input) => {
    const annotation = (input.annotations as Array<Record<string, unknown>>)[0];
    return annotation?.severity === 'low'
      && annotation.x === 0.01
      && annotation.y === 0.01
      && annotation.width === 0.98
      && annotation.height === 0.98
      && String(annotation.label).includes('仅用于来源溯源，不代表研究发现');
  }));
});

test('ingests non-competitive visual inputs without inventing issue annotations', async () => {
  let ingestCount = 0;
  let annotationCount = 0;
  const { VisualInputMaterializer } = await import(modulePath);
  const materializer = new VisualInputMaterializer({
    visualAssets: {
      async ingest() {
        ingestCount += 1;
        return {
          assetArtifact: { id: 'asset-original' },
          manifestArtifact: { id: 'manifest-original' },
        };
      },
    },
    imageAnnotations: {
      async annotate() {
        annotationCount += 1;
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
    visuals: [{
      gateKey: 'designImage',
      multiple: false,
      images: [resolvedImage('input-png', PNG_BYTES, 'image/png')],
    }],
  });

  assert.equal(ingestCount, 1);
  assert.equal(annotationCount, 0);
});

test('ingests design-audit originals without creating pre-analysis annotations', async () => {
  const { VisualInputMaterializer } = await import(modulePath);
  let ingestCount = 0;
  const annotations: Array<Record<string, unknown>> = [];
  const materializer = new VisualInputMaterializer({
    visualAssets: {
      async ingest() {
        ingestCount += 1;
        return {
          assetArtifact: { id: 'asset-original' },
          manifestArtifact: { id: 'manifest-original' },
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

  const originals = await materializer.materialize({
    lease: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      leaseOwner: 'worker',
      leaseToken: 'token',
    },
    visuals: [{
      gateKey: 'designImage',
      multiple: false,
      images: [resolvedImage('input-png', PNG_BYTES, 'image/png')],
    }],
  });

  assert.equal(ingestCount, 1);
  assert.equal(annotations.length, 0);
  assert.deepEqual(originals, [{
    gateKey: 'designImage',
    imageIndex: 1,
    original: { assetId: 'asset-original', manifestArtifactId: 'manifest-original' },
  }]);
});

test('creates design annotations only from explicit finding-bound analysis', async () => {
  const { VisualInputMaterializer } = await import(modulePath);
  const annotations: Array<Record<string, unknown>> = [];
  const materializer = new VisualInputMaterializer({
    visualAssets: {
      async ingest() {
        throw new Error('ingest is not part of the annotation phase');
      },
    },
    imageAnnotations: {
      async annotate(input: Record<string, unknown>) {
        annotations.push(input);
        return {};
      },
    },
  });
  const lease = {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    leaseOwner: 'worker',
    leaseToken: 'token',
  };

  await materializer.annotateDesignFindings({
    lease,
    original: {
      gateKey: 'designImage',
      imageIndex: 1,
      original: { assetId: 'asset-original', manifestArtifactId: 'manifest-original' },
    },
    findings: [{
      findingId: 'design-attention-2-1',
      label: '主行动入口与促销信息竞争注意力',
      severity: 'high',
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.2,
    }],
  });

  assert.equal(annotations.length, 1);
  assert.deepEqual(annotations[0], {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    activeLease: lease,
    original: { assetId: 'asset-original', manifestArtifactId: 'manifest-original' },
    findingIds: ['design-attention-2-1'],
    annotations: [{
      shape: 'rectangle',
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.2,
      findingId: 'design-attention-2-1',
      label: '主行动入口与促销信息竞争注意力',
      severity: 'high',
    }],
    exportPolicy: 'allow',
  });
  await assert.rejects(
    () => materializer.annotateDesignFindings({
      lease,
      original: {
        gateKey: 'designImage',
        imageIndex: 1,
        original: { assetId: 'asset-original', manifestArtifactId: 'manifest-original' },
      },
      findings: [],
    }),
    /at least one verified analysis finding/u,
  );
});

test('does not create visual assets when there are no resolved visual inputs', async () => {
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

  await materializer.materialize({
    lease: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      leaseOwner: 'worker',
      leaseToken: 'token',
    },
    visuals: [],
  });
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

test('visual analysis suite keeps sample order and degrades only the failed lab result', async () => {
  let aestheticCalls = 0;
  const labAdapter: ToolAdapter = {
    adapterType: 'rest_json',
    implementationId: 'fixture-labs',
    executionMode: 'real',
    endpointHost: () => 'labs.test',
    async invoke(options) {
      if (options.toolId === 'aesthetic-quant-lab') {
        aestheticCalls += 1;
        const body = options.input as { designImage?: { dataUrl?: string } };
        if (body.designImage?.dataUrl?.endsWith('Y21wLTI=')) {
          throw new ToolInvocationError(options.toolId, {
            kind: 'timeout', retryable: true, sanitizedMessage: 'fixture timeout',
          });
        }
        return {
          output: {
            status: 'available', summary: '美学分析完成。', overallScore: 0.6 + aestheticCalls / 100,
            findings: [`美学观察 ${aestheticCalls}`], recommendations: [], warnings: [],
          },
          latencyMs: 1,
          receipt: {
            declaredAdapterType: 'rest_json', resolvedAdapterType: 'rest_json',
            implementationId: 'fixture-labs', executionMode: 'real', endpointHost: 'labs.test',
            status: 'ok', latencyMs: 1,
          },
        };
      }
      if (options.toolId === 'attention-analysis-lab') {
        return {
          output: {
            status: 'available', mode: 'hybrid', engine: 'vlm', summary: '注意力分析完成。',
            hotspots: [], peakAttentionScore: 0.8, focusBalanceScore: 0.7,
            distractionRiskScore: 0.4, warnings: [],
          },
          latencyMs: 1,
          receipt: {
            declaredAdapterType: 'rest_json', resolvedAdapterType: 'rest_json',
            implementationId: 'fixture-labs', executionMode: 'real', endpointHost: 'labs.test',
            status: 'ok', latencyMs: 1,
          },
        };
      }
      return {
        output: {
          status: 'partial_failed', engine: 'vlm', summary: '三角色评审完成。',
          visualReview: {
            reviewers: [{ role: 'structural', roleLabel: '视觉设计师', score: 0.7, findings: ['层级可继续收敛。'], suggestions: ['强化主行动。'] }],
            consensus: [], conflicts: [], priorityActions: ['强化主行动。'],
          },
          findings: ['层级可继续收敛。'], recommendations: ['强化主行动。'],
          warnings: ['没有品牌参考图。'], boundaryNotes: [],
        },
        latencyMs: 1,
        receipt: {
          declaredAdapterType: 'rest_json', resolvedAdapterType: 'rest_json',
          implementationId: 'fixture-labs', executionMode: 'real', endpointHost: 'labs.test',
          status: 'ok', latencyMs: 1,
        },
      };
    },
  };
  const adapter = new VisualAnalysisSuiteAdapter(labAdapter);
  const manifest = loadToolManifest('tools/visual-analysis-suite/manifest.yaml');
  const controller = new AbortController();
  const result = await adapter.invoke({
    toolId: 'visual-analysis-suite',
    manifest,
    context: { signal: controller.signal, deadlineAt: Date.now() + 10_000 },
    input: {
      research_goal: '比较商品详情页视觉体验',
      jd_screenshots: [
        { dataUrl: 'data:image/png;base64,amQtMQ==' },
        { dataUrl: 'data:image/png;base64,amQtMg==' },
      ],
      competitor_screenshots: [
        { dataUrl: 'data:image/png;base64,Y21wLTE=' },
        { dataUrl: 'data:image/png;base64,Y21wLTI=' },
      ],
      designImages: [],
    },
  });
  const output = result.output as {
    status: string;
    samples: Array<{ sampleId: string; role: string; aesthetic: { status: string } }>;
    comparisonFindings: unknown[];
    toolProvenance: unknown[];
  };
  assert.equal(output.status, 'partial');
  assert.deepEqual(output.samples.map(({ sampleId, role }) => ({ sampleId, role })), [
    { sampleId: 'JD-001', role: 'primary' },
    { sampleId: 'JD-002', role: 'primary' },
    { sampleId: 'COMP-001', role: 'comparison' },
    { sampleId: 'COMP-002', role: 'comparison' },
  ]);
  assert.equal(output.samples[3]!.aesthetic.status, 'failed');
  assert.equal(output.comparisonFindings.length, 3);
  assert.equal(output.toolProvenance.length, 10);
  assert.equal(JSON.stringify(output).includes('base64'), false);
  new SchemaValidator().validateFileOrThrow(
    join(process.cwd(), 'tools/visual-analysis-suite/output.schema.json'),
    output,
  );
});
