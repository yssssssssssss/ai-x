import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ControlArtifact, ControlGateRecord } from '../database/control-plane.ts';
import type {
  ArtifactWriteInput,
  TextArtifactWriteInput,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  DocumentInputGateError,
  DocumentInputGateStore,
} from '../apps/orchestrator-runtime/src/control/document-input-gate-store.ts';

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function artifact(input: {
  id: string;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
  content: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}): ControlArtifact {
  const bytes = Buffer.from(input.content, 'utf8');
  return {
    id: input.id,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: null,
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/trusted/${input.id}`,
    contentSha256: sha256(bytes),
    byteSize: bytes.byteLength,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: input.mediaType ?? null,
    metadata: input.metadata ?? null,
  };
}

class MemoryArtifacts {
  readonly textWrites: TextArtifactWriteInput[] = [];
  readonly jsonWrites: ArtifactWriteInput[] = [];
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly text = new Map<string, string>();
  readonly json = new Map<string, unknown>();
  readonly invalidated: string[] = [];
  failManifest = false;

  async writeText(input: TextArtifactWriteInput): Promise<ControlArtifact> {
    this.textWrites.push(input);
    const id = `text-${this.textWrites.length}`;
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      content: input.content,
      mediaType: input.mediaType,
      metadata: input.metadata,
    });
    this.artifacts.set(id, stored);
    this.text.set(id, input.content);
    return stored;
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    if (this.failManifest) throw new Error('manifest write failed');
    this.jsonWrites.push(input);
    const id = `json-${this.jsonWrites.length}`;
    const content = JSON.stringify(input.value, null, 2);
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      content,
      metadata: input.metadata,
    });
    this.artifacts.set(id, stored);
    this.json.set(id, structuredClone(input.value));
    return stored;
  }

  async readVerifiedBoundJson<T>(id: string) {
    return { artifact: this.artifacts.get(id)!, value: structuredClone(this.json.get(id)) as T };
  }

  async readVerifiedBoundDocument(id: string) {
    return { artifact: this.artifacts.get(id)!, content: this.text.get(id)! };
  }

  async invalidateArtifactPublication(id: string): Promise<void> {
    this.invalidated.push(id);
    const stored = this.artifacts.get(id);
    if (stored) this.artifacts.set(id, { ...stored, state: 'FAILED' });
  }
}

function gate(evidenceRef: string): ControlGateRecord {
  return {
    gateType: 'input',
    gateKey: 'internal_documents',
    requiredAuthority: 'owner',
    decision: 'provided',
    value: null,
    evidenceRef,
    actorUserId: 'owner-1',
    actorRole: 'owner',
    idempotencyKey: 'document-input-1',
  };
}

const pending = [{
  kind: 'document' as const,
  role: 'internal_documents',
  label: '内部业务材料',
  multiple: true,
  targets: [{
    step_no: 1,
    tool_id: 'industry-market-analysis',
    field: 'internal_documents',
    multiple: true,
  }],
}];

test('seals Markdown and TXT documents and resolves one bounded model value', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new DocumentInputGateStore(artifacts);
  const uploaded = await store.upload({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    role: 'internal_documents',
    ownerUserId: 'owner-1',
    taskSensitivity: 'internal',
    multiple: true,
    files: [{
      fileName: '运营背景.md',
      mediaType: 'text/markdown',
      bytes: Buffer.from('# 背景\n真实运营材料'),
    }, {
      fileName: '访谈记录.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('用户希望快速找到目标图书。'),
    }],
  });

  assert.equal(uploaded.files.length, 2);
  assert.equal(artifacts.textWrites.length, 2);
  assert.equal(artifacts.jsonWrites.length, 1);
  assert.doesNotMatch(JSON.stringify(artifacts.jsonWrites[0]!.value), /base64|data:/u);

  const resolved = await store.resolve({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    ownerUserId: 'owner-1',
    gates: [gate(uploaded.documentInputId)],
    pendingInputs: pending,
  });
  assert.equal(resolved.documents.length, 1);
  assert.deepEqual(resolved.gates[0]?.value, [{
    version: 'document-model-view-v1',
    artifactId: 'text-1',
    role: 'internal_documents',
    fileName: '运营背景.md',
    mediaType: 'text/markdown; charset=utf-8',
    content: '# 背景\n真实运营材料',
    truncated: false,
  }, {
    version: 'document-model-view-v1',
    artifactId: 'text-2',
    role: 'internal_documents',
    fileName: '访谈记录.txt',
    mediaType: 'text/plain; charset=utf-8',
    content: '用户希望快速找到目标图书。',
    truncated: false,
  }]);
});

test('rejects unsupported document formats at the upload boundary', async () => {
  const store = new DocumentInputGateStore(new MemoryArtifacts());
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', role: 'internal_documents',
    ownerUserId: 'owner-1', taskSensitivity: 'internal', multiple: false,
    files: [{ fileName: 'report.pdf', mediaType: 'application/pdf', bytes: Buffer.from('%PDF') }],
  }), (error: unknown) => error instanceof DocumentInputGateError);
});

test('invalidates written documents when manifest publication fails', async () => {
  const artifacts = new MemoryArtifacts();
  artifacts.failManifest = true;
  const store = new DocumentInputGateStore(artifacts);
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', role: 'internal_documents',
    ownerUserId: 'owner-1', taskSensitivity: 'internal', multiple: true,
    files: [
      { fileName: 'a.md', mediaType: 'text/markdown', bytes: Buffer.from('# A') },
      { fileName: 'b.txt', mediaType: 'text/plain', bytes: Buffer.from('B') },
    ],
  }), /manifest write failed/u);
  assert.deepEqual(artifacts.invalidated, ['text-1', 'text-2']);
});
