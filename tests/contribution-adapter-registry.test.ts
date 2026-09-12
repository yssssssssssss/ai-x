import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceManifest } from '../packages/api-contract/research-deliverable.ts';
import {
  contextOnlyContributionUnitKeys,
  ContributionAdapterError,
  ContributionAdapterRegistry,
  VISUAL_ANALYSIS_CONTRIBUTION_ADAPTER_ID,
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
  assert.deepEqual(artifact.source.diagnosticFields, ['/summary', '/status']);
  assert.match(artifact.source.adapterHash, /^sha256:[a-f0-9]{64}$/u);
});

test('generate-persona binds dataset-derived units to the Dataset profile Evidence', () => {
  const datasetManifest: EvidenceManifest = {
    ...evidenceManifest,
    entries: [{
      id: 'dataset:user_research_dataset:profile',
      kind: 'dataset',
      evidenceClass: 'dataset',
      artifactId: 'dataset-profile-1',
      artifactContentSha256: `sha256:${'d'.repeat(64)}`,
      jsonPointer: '/columnProfiles',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  };
  const artifact = adapt({ evidenceManifest: datasetManifest });
  const personaUnits = artifact.contribution.units.filter(({ kind }) => kind === 'persona');
  assert.ok(personaUnits.length > 0);
  assert.ok(personaUnits.every(({ support }) => (
    support.status === 'supported'
    && support.evidenceIds.join(',') === 'dataset:user_research_dataset:profile'
  )));
  assert.equal(
    artifact.contribution.units.find(({ kind }) => kind === 'hypothesis')?.support.status,
    'provisional',
  );
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

test('generic adapter preserves a non-empty structured payload as typed Contribution units', () => {
  const payload = {
    personas: [{ name: '谨慎型支持者', needs: ['可信项目说明', '风险透明'] }],
    segmentation_basis: '按决策行为与风险偏好划分',
    serialized_note: '{"kind":"plain text"}',
  };
  const artifact = adapt({
    source: {
      ...sourceEnvelope,
      findings: [],
      assumptions: [],
      recommendations: [],
      payload,
    },
  });

  assert.deepEqual(artifact.contribution.units.map(({ kind, title }) => ({ kind, title })), [
    { kind: 'persona', title: 'personas' },
    { kind: 'persona', title: 'segmentation_basis' },
    { kind: 'persona', title: 'serialized_note' },
  ]);
  assert.deepEqual(artifact.source.unitMappings.map(({ sourceJsonPointer }) => sourceJsonPointer), [
    '/payload/personas',
    '/payload/segmentation_basis',
    '/payload/serialized_note',
  ]);
  assert.ok(artifact.contribution.units[0]!.statement.includes('谨慎型支持者'));
  assert.equal(artifact.contribution.units[1]!.statement, payload.segmentation_basis);
  assert.equal(artifact.contribution.units[2]!.statement, payload.serialized_note);
  assert.deepEqual(contextOnlyContributionUnitKeys(artifact), ['payload-001']);
  assert.deepEqual(artifact.source.diagnosticFields, ['/summary', '/status']);
});

test('visual analysis adapter preserves screenshot Evidence and provisional boundaries', () => {
  const visualEvidenceManifest: EvidenceManifest = {
    ...evidenceManifest,
    entries: [
      {
        id: 'S1-1', kind: 'screenshot', evidenceClass: 'screenshot',
        artifactId: 'visual-manifest-1', artifactContentSha256: `sha256:${'b'.repeat(64)}`,
        jsonPointer: '/assetId', sensitivity: 'internal', redaction: 'none',
      },
      {
        id: 'S1-2', kind: 'screenshot', evidenceClass: 'screenshot',
        artifactId: 'visual-manifest-2', artifactContentSha256: `sha256:${'c'.repeat(64)}`,
        jsonPointer: '/assetId', sensitivity: 'internal', redaction: 'none',
      },
    ],
  };
  const artifact = new ContributionAdapterRegistry().adapt({
    adapterId: VISUAL_ANALYSIS_CONTRIBUTION_ADAPTER_ID,
    source: {
      version: 'visual-analysis-suite-v1',
      status: 'partial',
      samples: [{
        sampleId: 'JD-001', role: 'primary', sourceImageId: 'source-1',
        aesthetic: {
          status: 'available', summary: '美学分析完成。',
          findings: ['信息密度偏高。'], recommendations: [], warnings: [],
        },
        attention: {
          status: 'available', summary: '首屏存在两个注意力中心。', hotspots: [], warnings: [],
        },
      }],
      visualReviewBatches: [{
        batchId: 'primary-batch-001', role: 'primary', sampleIds: ['JD-001'],
        status: 'available', summary: '评审完成。', findings: ['价格入口层级不稳定。'],
        recommendations: [], reviewers: [], warnings: [],
      }],
      comparisonFindings: [{
        id: 'comparison:aesthetic-overall', dimension: 'aesthetic-overall',
        statement: '主方案均值为 0.6，对照方案为 0.7。',
        primaryValue: 0.6, comparisonValue: 0.7, interpretation: 'descriptive_only',
      }],
      warnings: ['attention-analysis-lab: timeout'],
      boundaryNotes: ['注意力结果不是眼动实验。'],
      toolProvenance: [],
    },
    sourceArtifact: {
      id: 'artifact-visual-suite',
      contentSha256: `sha256:${'d'.repeat(64)}`,
      schemaVersion: 'tool-output-v1',
    },
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation:design-experience-review',
    skillId: 'design-experience-review',
    contributionTypes: ['design_audit'],
    questionIds: ['question-design'],
    requestedArtifactTypes: [],
    evidenceManifest: visualEvidenceManifest,
  });

  assert.deepEqual(artifact.contribution.contributionTypes, ['design_audit']);
  assert.equal(artifact.contribution.units.length, 4);
  assert.ok(artifact.contribution.units.every(({ support }) => (
    support.status === 'provisional'
    && support.confidence === 0.5
    && support.evidenceIds.join(',') === 'S1-1,S1-2'
  )));
  assert.deepEqual(artifact.source.unitMappings.map(({ sourceJsonPointer }) => sourceJsonPointer), [
    '/output/samples/0/aesthetic/findings/0',
    '/output/samples/0/attention/summary',
    '/output/visualReviewBatches/0/findings/0',
    '/output/comparisonFindings/0',
  ]);
  assert.ok(artifact.contribution.limitations.includes('注意力结果不是眼动实验。'));
  assert.equal(JSON.stringify(artifact).includes('sofa'), false);
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
