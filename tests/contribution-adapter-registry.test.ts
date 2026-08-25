import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceManifest } from '../packages/api-contract/research-deliverable.ts';
import {
  ContributionAdapterError,
  ContributionAdapterRegistry,
} from '../apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts';

const evidenceManifest: EvidenceManifest = {
  version: 'evidence-v1',
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-25T00:00:00.000Z',
  manifestHash: `sha256:${'e'.repeat(64)}`,
  entries: [],
};

const sourceEnvelope = {
  version: 'skill-output-v2',
  status: 'succeeded',
  summary: '形成两个待验证的用户研究结论。',
  findings: [
    { id: 'finding-1', statement: '用户可能重视项目可信度。', confidence: 0.7 },
    { id: 'finding-2', statement: '新品发现可能是访问动机。', confidence: 0.6 },
  ],
  assumptions: ['当前没有真实访谈样本。'],
  limitations: ['结论仅来自公开资料。'],
  recommendations: ['用真实用户访谈验证访问动机。'],
  payload: {},
};

function adapt(overrides: Record<string, unknown> = {}) {
  return new ContributionAdapterRegistry().adapt({
    adapterId: 'skill-envelope-provisional-v1',
    source: sourceEnvelope,
    sourceArtifact: {
      id: 'artifact-skill-1',
      contentSha256: `sha256:${'a'.repeat(64)}`,
      schemaVersion: 'skill-output-v2',
    },
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation:persona',
    skillId: 'generate-persona',
    contributionTypes: ['persona'],
    questionIds: ['question-persona'],
    requestedArtifactTypes: [],
    evidenceManifest,
    ...overrides,
  });
}

test('generic Skill envelope adapter preserves every semantic field as provisional Contribution units', () => {
  const artifact = adapt();
  assert.equal(artifact.version, 'research-contribution-artifact-v1');
  assert.equal(artifact.contribution.invocationId, 'invocation:persona');
  assert.equal(artifact.contribution.skillId, 'generate-persona');
  assert.deepEqual(artifact.contribution.contributionTypes, ['persona']);
  assert.deepEqual(artifact.contribution.units.map(({ key, kind, support }) => ({
    key, kind, status: support.status, questions: support.questionIds,
  })), [
    { key: 'finding-1', kind: 'persona', status: 'provisional', questions: ['question-persona'] },
    { key: 'finding-2', kind: 'persona', status: 'provisional', questions: ['question-persona'] },
    { key: 'assumption-001', kind: 'hypothesis', status: 'provisional', questions: ['question-persona'] },
    { key: 'recommendation-001', kind: 'action', status: 'provisional', questions: ['question-persona'] },
  ]);
  assert.deepEqual(artifact.contribution.limitations, sourceEnvelope.limitations);
  assert.equal(artifact.source.unitMappings.length, artifact.contribution.units.length);
  assert.deepEqual(artifact.source.unitMappings.map(({ sourceJsonPointer }) => sourceJsonPointer), [
    '/findings/0',
    '/findings/1',
    '/assumptions/0',
    '/recommendations/0',
  ]);
  assert.deepEqual(artifact.source.diagnosticFields, ['/summary', '/payload', '/status']);
  assert.match(artifact.source.adapterHash, /^sha256:[a-f0-9]{64}$/u);
});

test('generic adapter deterministically binds every unit to all frozen scoped Questions', () => {
  const artifact = adapt({ questionIds: ['question-a', 'question-b'] });
  assert.ok(artifact.contribution.units.every(({ support }) => (
    support.questionIds.join(',') === 'question-a,question-b'
  )));
  assert.throws(
    () => adapt({ questionIds: [] }),
    (error: unknown) => error instanceof ContributionAdapterError
      && error.code === 'ambiguous_question_scope',
  );
});

test('adapter binds every frozen identity and rejects unsupported adapters', () => {
  const artifact = adapt();
  assert.deepEqual({
    taskId: artifact.contribution.taskId,
    planVersionId: artifact.contribution.planVersionId,
    attemptId: artifact.contribution.attemptId,
    invocationId: artifact.contribution.invocationId,
    skillId: artifact.contribution.skillId,
    sourceArtifactId: artifact.source.artifactId,
  }, {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation:persona',
    skillId: 'generate-persona',
    sourceArtifactId: 'artifact-skill-1',
  });
  assert.throws(
    () => adapt({ adapterId: 'unknown-adapter' }),
    (error: unknown) => error instanceof ContributionAdapterError
      && error.code === 'adapter_not_registered',
  );
});
