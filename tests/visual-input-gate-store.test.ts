import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ControlArtifact, ControlGateRecord } from '../database/control-plane.ts';
import type {
  ArtifactWriteInput,
  BinaryArtifactWriteInput,
  TrustedBinaryMetadata,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  VisualInputGateStore,
  valueForPendingInputTarget,
} from '../apps/orchestrator-runtime/src/control/visual-input-gate-store.ts';

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z',
  'base64',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('plural pending input preserves every image for plural targets and projects the first to singular targets', () => {
  const value = [{ artifactId: 'first' }, { artifactId: 'second' }];
  assert.deepEqual(valueForPendingInputTarget({
    value,
    pendingMultiple: true,
    targetMultiple: true,
  }), value);
  assert.deepEqual(valueForPendingInputTarget({
    value,
    pendingMultiple: true,
    targetMultiple: false,
  }), value[0]);
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(input: {
  id: string;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
  byteSize: number;
  contentSha256: string;
  mediaType?: string;
}): ControlArtifact {
  return {
    ...input,
    attemptId: null,
    state: 'SEALED',
    storageUri: `/trusted/${input.id}`,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: input.mediaType ?? null,
    metadata: input.mediaType ? { width: 1, height: 1 } : null,
  };
}

class MemoryArtifacts {
  readonly binaryWrites: BinaryArtifactWriteInput[] = [];
  readonly jsonWrites: ArtifactWriteInput[] = [];
  readonly invalidations: Array<{ artifactId: string; reason: string }> = [];
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly values = new Map<string, unknown>();
  readonly bytes = new Map<string, Buffer>();

  constructor(private readonly failures: {
    binaryWrite?: number;
    invalidation?: boolean;
  } = {}) {}

  async writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact> {
    this.binaryWrites.push(input);
    if (this.binaryWrites.length === this.failures.binaryWrite) {
      throw new Error(`binary publication ${this.binaryWrites.length} failed`);
    }
    const id = `binary-${this.binaryWrites.length}`;
    const bytes = Buffer.from(input.bytes);
    const mediaType = bytes.equals(JPEG) ? 'image/jpeg' : bytes.equals(PNG) ? 'image/png' : 'image/webp';
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      byteSize: bytes.byteLength,
      contentSha256: sha256(bytes),
      mediaType,
    });
    this.artifacts.set(id, stored);
    this.bytes.set(id, bytes);
    return stored;
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    this.jsonWrites.push(input);
    const id = `json-${this.jsonWrites.length}`;
    const bytes = Buffer.from(JSON.stringify(input.value));
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      byteSize: bytes.byteLength,
      contentSha256: sha256(bytes),
    });
    this.artifacts.set(id, stored);
    this.values.set(id, structuredClone(input.value));
    return stored;
  }

  async readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    return {
      artifact: this.artifacts.get(artifactId)!,
      value: structuredClone(this.values.get(artifactId)) as T,
    };
  }

  async readVerifiedBinary(artifactId: string): Promise<{
    artifact: ControlArtifact;
    bytes: Buffer;
    metadata: TrustedBinaryMetadata;
  }> {
    const stored = this.artifacts.get(artifactId)!;
    const bytes = this.bytes.get(artifactId)!;
    return {
      artifact: stored,
      bytes: Buffer.from(bytes),
      metadata: {
        contentType: stored.mediaType as TrustedBinaryMetadata['contentType'],
        byteSize: bytes.byteLength,
        width: 1,
        height: 1,
      },
    };
  }

  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    this.invalidations.push({ artifactId, reason });
    if (this.failures.invalidation) throw new Error('compensation failed');
    const stored = this.artifacts.get(artifactId);
    if (!stored) return;
    this.artifacts.set(artifactId, { ...stored, state: 'FAILED', failureReason: reason });
  }
}

function inputGate(evidenceRef: string | null, value: unknown = null): ControlGateRecord {
  return {
    gateType: 'input',
    gateKey: 'designImage',
    requiredAuthority: 'owner',
    decision: 'provided',
    value,
    evidenceRef,
    actorUserId: 'owner-1',
    actorRole: 'owner',
    idempotencyKey: 'input-1',
  };
}

const pending = [{
  kind: 'visual' as const,
  role: 'designImage',
  label: 'designImage',
  multiple: false,
  targets: [{ step_no: 1, tool_id: 'design-experience-review', field: 'designImage', multiple: false }],
}];

test('seals visual bytes outside gate JSON and hydrates only after bound verification', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new VisualInputGateStore(artifacts);
  const dataUrl = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

  const published = await store.publish({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gateKey: 'designImage',
    multiple: false,
    requiredVisual: true,
    value: { dataUrl },
  });

  assert.equal(published.value, undefined);
  assert.equal(typeof published.evidenceRef, 'string');
  assert.equal(artifacts.binaryWrites.length, 1);
  assert.equal(artifacts.jsonWrites.length, 1);
  assert.doesNotMatch(JSON.stringify(artifacts.jsonWrites[0]!.value), /data:image|base64/u);

  const resolved = await store.resolve({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gates: [inputGate(published.evidenceRef!)],
    pendingInputs: pending,
  });

  assert.deepEqual(resolved.gates[0]?.value, { dataUrl });
  assert.deepEqual(resolved.visuals[0]?.images[0]?.bytes, JPEG);
});

test('invalidates a sealed manifest when its post-write binding check fails', async () => {
  class InvalidManifestArtifacts extends MemoryArtifacts {
    override async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
      const stored = await super.writeJson(input);
      const invalid = { ...stored, kind: 'wrong-manifest-kind' };
      this.artifacts.set(stored.id, invalid);
      return invalid;
    }
  }

  const artifacts = new InvalidManifestArtifacts();
  const store = new VisualInputGateStore(artifacts);
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;

  await assert.rejects(() => store.publish({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gateKey: 'designImage',
    multiple: false,
    requiredVisual: true,
    value: { dataUrl },
  }), /Artifact binding is invalid/u);

  assert.deepEqual(
    [...artifacts.artifacts.values()].map(({ state }) => state),
    ['FAILED', 'FAILED'],
  );
});

test('invalidates earlier binaries when a later image publication fails', async () => {
  const artifacts = new MemoryArtifacts({ binaryWrite: 2 });
  const store = new VisualInputGateStore(artifacts);

  await assert.rejects(() => store.publish({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gateKey: 'designImage',
    multiple: true,
    requiredVisual: true,
    value: [
      { dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}` },
      { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ],
  }), /binary publication 2 failed/u);

  assert.equal(artifacts.artifacts.get('binary-1')?.state, 'FAILED');
  assert.deepEqual(artifacts.invalidations.map(({ artifactId }) => artifactId), ['binary-1']);
  assert.equal(artifacts.jsonWrites.length, 0);
});

test('compensation failure never masks the original publication error', async () => {
  const artifacts = new MemoryArtifacts({ binaryWrite: 2, invalidation: true });
  const store = new VisualInputGateStore(artifacts);

  await assert.rejects(() => store.publish({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gateKey: 'designImage',
    multiple: true,
    requiredVisual: true,
    value: [
      { dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}` },
      { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ],
  }), /binary publication 2 failed/u);
});

test('rejects nested, empty, and singular/multiple visual input shape mismatches', async () => {
  const store = new VisualInputGateStore(new MemoryArtifacts());
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;

  await assert.rejects(() => store.publish({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage', multiple: false,
    requiredVisual: true,
    value: { nested: { dataUrl } },
  }), /single image input must be exactly/u);
  await assert.rejects(() => store.publish({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage', multiple: true,
    requiredVisual: true,
    value: [],
  }), /multiple input/u);
  await assert.rejects(() => store.publish({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage', multiple: false,
    requiredVisual: true,
    value: [{ dataUrl }],
  }), /single image input/u);
});

test('rejects visual URL/path fallbacks and inline images in non-visual values', async () => {
  const store = new VisualInputGateStore(new MemoryArtifacts());
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  for (const value of [
    {},
    { url: 'https://images.example.test/design.png' },
    { path: '/tmp/design.png' },
    { image: dataUrl },
  ]) {
    await assert.rejects(() => store.publish({
      taskId: 'task-1',
      planVersionId: 'plan-1',
      gateKey: 'designImage',
      multiple: false,
      requiredVisual: true,
      value,
    }), /single image input must be exactly/u);
  }
  for (const value of [
    dataUrl,
    { image: dataUrl },
    { nested: [`prefix ${dataUrl}`] },
  ]) {
    await assert.rejects(() => store.publish({
      taskId: 'task-1',
      planVersionId: 'plan-1',
      gateKey: 'brief',
      multiple: false,
      requiredVisual: false,
      value,
    }), /non-visual input contains a dataUrl/u);
  }
});

test('fails closed on legacy raw data URLs and conflicting gate storage', async () => {
  const store = new VisualInputGateStore(new MemoryArtifacts());
  const dataUrl = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  await assert.rejects(() => store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1', gates: [inputGate(null, { dataUrl })], pendingInputs: pending,
  }), /unsealed dataUrl/u);

  const artifacts = new MemoryArtifacts();
  const published = await new VisualInputGateStore(artifacts).publish({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage', multiple: false,
    requiredVisual: true, value: { dataUrl },
  });
  await assert.rejects(() => new VisualInputGateStore(artifacts).resolve({
    taskId: 'task-1', planVersionId: 'plan-1',
    gates: [inputGate(published.evidenceRef!, { dataUrl })], pendingInputs: pending,
  }), /both a value and evidence reference/u);
});

test('rejects foreign manifests and duplicate image Artifact references', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new VisualInputGateStore(artifacts);
  const jpegUrl = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  const published = await store.publish({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage', multiple: true,
    requiredVisual: true,
    value: [{ dataUrl: jpegUrl }, { dataUrl: pngUrl }],
  });
  const manifest = artifacts.values.get(published.evidenceRef!) as Record<string, unknown>;
  manifest.taskId = 'foreign-task';
  artifacts.values.set(published.evidenceRef!, manifest);
  await assert.rejects(() => store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1', gates: [inputGate(published.evidenceRef!)],
    pendingInputs: [{ ...pending[0]!, multiple: true }],
  }), /manifest does not match/u);

  manifest.taskId = 'task-1';
  const images = manifest.images as Array<Record<string, unknown>>;
  images[1] = structuredClone(images[0]);
  artifacts.values.set(published.evidenceRef!, manifest);
  await assert.rejects(() => store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1', gates: [inputGate(published.evidenceRef!)],
    pendingInputs: [{ ...pending[0]!, multiple: true }],
  }), /duplicated/u);
});
