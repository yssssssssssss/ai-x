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
  readonly invalidations: string[] = [];
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly values = new Map<string, unknown>();
  readonly bytes = new Map<string, Buffer>();
  failManifest = false;
  failBinaryAt: number | undefined;

  async writeBinary(input: BinaryArtifactWriteInput): Promise<ControlArtifact> {
    this.binaryWrites.push(input);
    if (this.binaryWrites.length === this.failBinaryAt) throw new Error('binary write failed');
    const id = `binary-${this.binaryWrites.length}`;
    const bytes = Buffer.from(input.bytes);
    const mediaType = bytes.equals(JPEG) ? 'image/jpeg' : 'image/png';
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
    if (this.failManifest) throw new Error('manifest write failed');
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

  async readVerifiedBoundJson<T>(artifactId: string) {
    return { artifact: this.artifacts.get(artifactId)!, value: structuredClone(this.values.get(artifactId)) as T };
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

  async invalidateArtifactPublication(artifactId: string): Promise<void> {
    this.invalidations.push(artifactId);
    const stored = this.artifacts.get(artifactId);
    if (stored) this.artifacts.set(artifactId, { ...stored, state: 'FAILED' });
  }
}

function inputGate(evidenceRef: string): ControlGateRecord {
  return {
    gateType: 'input', gateKey: 'designImage', requiredAuthority: 'owner',
    decision: 'provided', value: null, evidenceRef, actorUserId: 'owner-1', actorRole: 'owner',
    idempotencyKey: 'input-1',
  };
}

const pending = [{
  kind: 'visual' as const,
  role: 'designImage',
  label: '设计稿',
  multiple: false,
  targets: [{ step_no: 1, tool_id: 'design-experience-review', field: 'designImage', multiple: false }],
}];

test('plural pending input preserves all values for plural targets and projects the first to singular targets', () => {
  const value = [{ id: 'first' }, { id: 'second' }];
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

test('uploads image bytes and resolves transient model data URLs from sealed Artifacts', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new VisualInputGateStore(artifacts);
  const uploaded = await store.upload({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gateKey: 'designImage',
    multiple: false,
    taskSensitivity: 'internal',
    files: [{ fileName: 'design.png', mediaType: 'image/png', bytes: PNG }],
  });

  assert.equal(uploaded.visualInputId, 'json-1');
  assert.doesNotMatch(JSON.stringify(artifacts.jsonWrites[0]!.value), /data:image|base64/u);
  const prepared = await store.prepareBinding({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage',
    multiple: false, visualInputId: uploaded.visualInputId,
  });
  assert.deepEqual(prepared.artifactIds, ['binary-1', 'json-1']);

  const resolved = await store.resolve({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    gates: [inputGate(uploaded.visualInputId)],
    pendingInputs: pending,
  });
  const value = resolved.gates[0]?.value as { dataUrl: string };
  assert.match(value.dataUrl, /^data:image\/png;base64,/u);
  assert.deepEqual(Buffer.from(value.dataUrl.split(',')[1]!, 'base64'), PNG);
});

test('rejects unsupported MIME and singular/multiple mismatches at upload', async () => {
  const store = new VisualInputGateStore(new MemoryArtifacts());
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage',
    multiple: false, taskSensitivity: 'internal',
    files: [{ fileName: 'design.png', mediaType: 'image/jpeg', bytes: PNG }],
  }), /metadata does not match/u);
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage',
    multiple: false, taskSensitivity: 'internal', files: [],
  }), /exactly one image/u);
});

test('invalidates all written images when publication fails', async () => {
  const artifacts = new MemoryArtifacts();
  artifacts.failManifest = true;
  const store = new VisualInputGateStore(artifacts);
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'screenshots',
    multiple: true, taskSensitivity: 'internal',
    files: [
      { fileName: 'one.png', mediaType: 'image/png', bytes: PNG },
      { fileName: 'two.jpg', mediaType: 'image/jpeg', bytes: JPEG },
    ],
  }), /manifest write failed/u);
  assert.deepEqual(artifacts.invalidations, ['binary-1', 'binary-2']);
});

test('rejects foreign manifests and duplicate image Artifact references', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new VisualInputGateStore(artifacts);
  const uploaded = await store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', gateKey: 'designImage',
    multiple: false, taskSensitivity: 'internal',
    files: [{ fileName: 'design.png', mediaType: 'image/png', bytes: PNG }],
  });
  const manifest = artifacts.values.get(uploaded.visualInputId) as Record<string, unknown>;
  artifacts.values.set(uploaded.visualInputId, { ...manifest, taskId: 'task-foreign' });
  await assert.rejects(() => store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1',
    gates: [inputGate(uploaded.visualInputId)], pendingInputs: pending,
  }), /active plan/u);

  artifacts.values.set(uploaded.visualInputId, {
    ...manifest,
    multiple: true,
    images: [
      ...manifest.images as unknown[],
      ...(manifest.images as unknown[]),
    ],
  });
  await assert.rejects(() => store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1',
    gates: [inputGate(uploaded.visualInputId)], pendingInputs: [{ ...pending[0]!, multiple: true }],
  }), /duplicated/u);
});
