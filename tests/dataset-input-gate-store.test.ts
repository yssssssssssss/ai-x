import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ControlArtifact, ControlGateRecord } from '../database/control-plane.ts';
import {
  datasetEvidenceEntries,
  ExecutionAuthenticityError,
} from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import type {
  ArtifactWriteInput,
  CsvArtifactWriteInput,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  DatasetInputGateStore,
  DatasetInputGateError,
} from '../apps/orchestrator-runtime/src/control/dataset-input-gate-store.ts';

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(input: {
  id: string;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
  contentSha256: string;
  byteSize: number;
  mediaType?: string;
  metadata?: Record<string, unknown>;
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
    metadata: input.metadata ?? null,
  };
}

class MemoryArtifacts {
  readonly csvWrites: CsvArtifactWriteInput[] = [];
  readonly jsonWrites: ArtifactWriteInput[] = [];
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly csv = new Map<string, string>();
  readonly json = new Map<string, unknown>();
  readonly invalidated: string[] = [];

  async writeCsv(input: CsvArtifactWriteInput): Promise<ControlArtifact> {
    this.csvWrites.push(input);
    const id = `csv-${this.csvWrites.length}`;
    const bytes = Buffer.from(input.content, 'utf8');
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      contentSha256: sha256(bytes),
      byteSize: bytes.byteLength,
      mediaType: 'text/csv; charset=utf-8',
      metadata: input.metadata,
    });
    this.artifacts.set(id, stored);
    this.csv.set(id, input.content);
    return stored;
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    const id = `json-${this.jsonWrites.length + 1}`;
    this.jsonWrites.push(input);
    const bytes = Buffer.from(JSON.stringify(input.value));
    const stored = artifact({
      id,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 'v1',
      contentSha256: sha256(bytes),
      byteSize: bytes.byteLength,
    });
    this.artifacts.set(id, stored);
    this.json.set(id, structuredClone(input.value));
    return stored;
  }

  async readVerifiedBoundCsv(id: string) {
    return { artifact: this.artifacts.get(id)!, content: this.csv.get(id)! };
  }

  async readVerifiedBoundJson<T>(id: string) {
    return { artifact: this.artifacts.get(id)!, value: structuredClone(this.json.get(id)) as T };
  }

  async invalidateArtifactPublication(id: string): Promise<void> {
    this.invalidated.push(id);
    const stored = this.artifacts.get(id);
    if (stored) this.artifacts.set(id, { ...stored, state: 'FAILED' });
  }
}

function gate(evidenceRef: string): ControlGateRecord {
  return {
    gateType: 'input', gateKey: 'user_research_dataset', requiredAuthority: 'owner',
    decision: 'provided', value: null, evidenceRef, actorUserId: 'owner-1', actorRole: 'owner',
    idempotencyKey: 'dataset-input-1',
  };
}

const pending = [{
  kind: 'dataset' as const,
  role: 'user_research_dataset',
  label: '匿名用户研究 CSV',
  multiple: false,
  targets: [{ step_no: 4, tool_id: 'industry-market-analysis', field: 'user_research_dataset', multiple: false }],
}];

test('uploads one UTF-8 CSV as bound raw and normalized Dataset Artifacts', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new DatasetInputGateStore(artifacts);
  const uploaded = await store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset',
    ownerUserId: 'owner-1', taskSensitivity: 'internal', fileName: 'users.csv',
    mediaType: 'text/csv', bytes: Buffer.from('sample_id,quote,score\nu1,"价格,太复杂",3\nu2,"想快速比较",5\n'),
    metadata: {
      rowMeaning: '一行代表一位匿名受访者', timeRange: '2026-Q3',
      fieldNotes: { sample_id: '匿名样本', quote: '用户原话', score: '评分' },
      units: { score: '分' }, sampling: '访谈样本', piiConfirmedAbsent: true,
    },
  });

  assert.equal(uploaded.rowCount, 2);
  assert.deepEqual(uploaded.columns, ['sample_id', 'quote', 'score']);
  assert.equal(artifacts.csvWrites.length, 1);
  assert.equal(artifacts.jsonWrites.length, 1);
  assert.equal(uploaded.datasetInputId, 'json-1');

  const resolved = await store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1', ownerUserId: 'owner-1',
    gates: [gate(uploaded.datasetInputId)], pendingInputs: pending,
  });
  assert.equal(resolved.datasets[0]?.profile.rowCount, 2);
  assert.deepEqual(resolved.datasets[0]?.profile.columnProfiles, [{
    index: 0, name: 'sample_id', nonEmptyCount: 2, uniqueCount: 2,
    numericCount: 0, numericMin: null, numericMax: null, numericMean: null,
  }, {
    index: 1, name: 'quote', nonEmptyCount: 2, uniqueCount: 2,
    numericCount: 0, numericMin: null, numericMax: null, numericMean: null,
  }, {
    index: 2, name: 'score', nonEmptyCount: 2, uniqueCount: 2,
    numericCount: 2, numericMin: 3, numericMax: 5, numericMean: 4,
  }]);
  assert.deepEqual(resolved.gates[0]?.value, {
    version: 'dataset-model-view-v1',
    datasetInputId: 'json-1',
    profileEvidenceId: 'dataset:user_research_dataset:profile',
    role: 'user_research_dataset',
    columns: [{ index: 0, name: 'sample_id' }, { index: 1, name: 'quote' }, { index: 2, name: 'score' }],
    columnProfiles: resolved.datasets[0]?.profile.columnProfiles,
    rows: [{
      index: 0, evidenceId: 'dataset:user_research_dataset:row:1', values: ['u1', '价格,太复杂', '3'],
    }, {
      index: 1, evidenceId: 'dataset:user_research_dataset:row:2', values: ['u2', '想快速比较', '5'],
    }],
    rowCount: 2,
    metadata: {
      rowMeaning: '一行代表一位匿名受访者', timeRange: '2026-Q3',
      fieldNotes: { sample_id: '匿名样本', quote: '用户原话', score: '评分' },
      units: { score: '分' }, sampling: '访谈样本', piiConfirmedAbsent: true,
    },
  });
});

test('maps each normalized Dataset row to an exact Evidence pointer', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new DatasetInputGateStore(artifacts);
  const uploaded = await store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset', ownerUserId: 'owner-1',
    taskSensitivity: 'internal', fileName: 'users.csv', mediaType: 'text/csv',
    bytes: Buffer.from('sample_id,score\nu1,3\nu2,5\n'),
    metadata: {
      rowMeaning: '一行一个样本', timeRange: '2026-Q3', fieldNotes: {}, units: { score: '分' },
      sampling: '测试样本', piiConfirmedAbsent: true,
    },
  });
  const resolved = await store.resolve({
    taskId: 'task-1', planVersionId: 'plan-1', ownerUserId: 'owner-1',
    gates: [gate(uploaded.datasetInputId)], pendingInputs: pending,
  });

  assert.deepEqual(datasetEvidenceEntries(resolved.datasets).map((entry) => ({
    id: entry.id, kind: entry.kind, evidenceClass: entry.evidenceClass,
    artifactId: entry.artifactId, jsonPointer: entry.jsonPointer,
  })), [{
    id: 'dataset:user_research_dataset:profile', kind: 'dataset', evidenceClass: 'dataset',
    artifactId: 'json-1', jsonPointer: '/columnProfiles',
  }, {
    id: 'dataset:user_research_dataset:row:1', kind: 'dataset', evidenceClass: 'dataset',
    artifactId: 'json-1', jsonPointer: '/rows/0/values',
  }, {
    id: 'dataset:user_research_dataset:row:2', kind: 'dataset', evidenceClass: 'dataset',
    artifactId: 'json-1', jsonPointer: '/rows/1/values',
  }]);
  const missingHash = structuredClone(resolved.datasets[0]!);
  missingHash.artifact.contentSha256 = null;
  assert.throws(() => datasetEvidenceEntries([missingHash]), ExecutionAuthenticityError);
});

test('rejects a normalized Dataset above the model analysis budget with an explicit code', async () => {
  const artifacts = new MemoryArtifacts();
  const store = new DatasetInputGateStore(artifacts);
  const rows = Array.from({ length: 6_000 }, (_, index) => `${index},${'x'.repeat(100)}`).join('\n');
  await assert.rejects(() => store.upload({
    taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset', ownerUserId: 'owner-1',
    taskSensitivity: 'internal', fileName: 'users.csv', mediaType: 'text/csv',
    bytes: Buffer.from(`id,value\n${rows}\n`),
    metadata: {
      rowMeaning: '一行一个样本', timeRange: '2026-Q3', fieldNotes: {}, units: {},
      sampling: '全量导出', piiConfirmedAbsent: true,
    },
  }), (error: unknown) => {
    assert.ok(error instanceof DatasetInputGateError);
    assert.equal(error.code, 'dataset_too_large_for_analysis');
    return true;
  });
  assert.equal(artifacts.csvWrites.length, 1);
  assert.equal(artifacts.jsonWrites.length, 0);
  assert.deepEqual(artifacts.invalidated, ['csv-1']);
});

test('accepts direct-identifier columns and values without PII gating', async () => {
  for (const content of [
    '姓名,feedback\n张三,很好\n',
    'sample_id,feedback\nu1,请联系13800138000\n',
  ]) {
    const artifacts = new MemoryArtifacts();
    const store = new DatasetInputGateStore(artifacts);
    await assert.doesNotReject(() => store.upload({
      taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset', ownerUserId: 'owner-1',
      taskSensitivity: 'internal', fileName: 'users.csv', mediaType: 'text/csv', bytes: Buffer.from(content),
      metadata: {
        rowMeaning: '一行一个样本', timeRange: '2026-Q3', fieldNotes: {}, units: {},
        sampling: '测试样本', piiConfirmedAbsent: false,
      },
    }));
    assert.equal(artifacts.csvWrites.length, 1);
    assert.equal(artifacts.jsonWrites.length, 1);
  }
});

test('accepts confidential and non-attested Dataset input', async () => {
  for (const candidate of [
    { taskSensitivity: 'confidential' as const, piiConfirmedAbsent: true },
    { taskSensitivity: 'internal' as const, piiConfirmedAbsent: false },
  ]) {
    const artifacts = new MemoryArtifacts();
    const store = new DatasetInputGateStore(artifacts);
    await assert.doesNotReject(() => store.upload({
      taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset', ownerUserId: 'owner-1',
      taskSensitivity: candidate.taskSensitivity, fileName: 'users.csv', mediaType: 'text/csv',
      bytes: Buffer.from('id,value\n1,a\n'),
      metadata: {
        rowMeaning: '一行一个样本', timeRange: '2026-Q3', fieldNotes: {}, units: {},
        sampling: '测试样本', piiConfirmedAbsent: candidate.piiConfirmedAbsent,
      },
    }));
    assert.equal(artifacts.csvWrites.length, 1);
    assert.equal(artifacts.jsonWrites.length, 1);
  }
});

test('rejects non-CSV and malformed Dataset input before writes', async () => {
  const cases = [
    { taskSensitivity: 'internal' as const, fileName: 'users.txt', mediaType: 'text/plain', piiConfirmedAbsent: true, content: 'id,value\n1,a\n' },
    { taskSensitivity: 'internal' as const, fileName: 'users.csv', mediaType: 'text/csv', piiConfirmedAbsent: true, content: 'id,value\n1\n' },
  ];
  for (const candidate of cases) {
    const artifacts = new MemoryArtifacts();
    const store = new DatasetInputGateStore(artifacts);
    await assert.rejects(() => store.upload({
      taskId: 'task-1', planVersionId: 'plan-1', role: 'user_research_dataset', ownerUserId: 'owner-1',
      taskSensitivity: candidate.taskSensitivity, fileName: candidate.fileName, mediaType: candidate.mediaType,
      bytes: Buffer.from(candidate.content),
      metadata: {
        rowMeaning: '一行一个样本', timeRange: '2026-Q3', fieldNotes: {}, units: {},
        sampling: '测试样本', piiConfirmedAbsent: candidate.piiConfirmedAbsent,
      },
    }), DatasetInputGateError);
    assert.equal(artifacts.csvWrites.length, 0);
    assert.equal(artifacts.jsonWrites.length, 0);
  }
});
