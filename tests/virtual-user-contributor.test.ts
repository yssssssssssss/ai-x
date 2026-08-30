import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvidenceManifest } from '../packages/api-contract/research-deliverable.ts';
import { virtualUserSimulationEvidence } from '../apps/orchestrator-runtime/src/evidence/virtual-user-evidence.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  ContributionAdapterError,
  ContributionAdapterRegistry,
  VIRTUAL_USER_TOOL_ADAPTER_ID,
} from '../apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const output = {
  status: 'available',
  isSimulated: true,
  summary: '已生成一个虚拟用户模拟反馈。',
  digitalPersonas: [{
    id: 'trust-cautious',
    name: '许安',
    type: '信任谨慎型用户',
    description: '关注平台背书和风险提示。',
    goals: ['降低决策风险'],
    concerns: ['项目可信度不足'],
  }],
  reviews: [{
    profileId: 'trust-cautious',
    personaName: '许安',
    personaType: '信任谨慎型用户',
    firstImpression: '项目很新，但可信度信息不足。',
    detailedExperience: '我会先寻找平台背书、进度与退款保障。',
    scores: { usability: 0.6, trust: 0.4, conversionIntent: 0.35 },
    overallScore: 0.45,
    topChangeRequest: '补充平台审核与退款保障说明。',
    stance: 'mixed',
    isSimulated: true,
  }],
  aggregate: {
    scoreSummary: { usability: 0.6, trust: 0.4, conversionIntent: 0.35 },
    sharedPainPoints: ['项目可信度不足'],
    sharedHighlights: [],
    divergences: ['用户对创新和风险的权衡不同。'],
    churnRisks: ['缺少退款保障。'],
  },
  recommendations: ['优先补充可信度与风险说明。'],
  warnings: [],
  boundaryNotes: ['本结果是虚拟用户模拟，不是真实用户访谈。'],
};

function manifest(): EvidenceManifest {
  return {
    version: 'evidence-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    collectedAt: '2026-08-25T00:00:00.000Z',
    manifestHash: hash,
    entries: [{
      id: 'SIM1-1',
      kind: 'tool_output',
      evidenceClass: 'simulation',
      toolId: 'virtual-user-lab',
      toolTier: 'optional',
      artifactId: 'artifact-virtual',
      artifactContentSha256: hash,
      jsonPointer: '/output/reviews/0',
      stepNo: 1,
      sensitivity: 'internal',
      redaction: 'none',
    }],
  };
}

test('virtual-user Tool schema requires an explicitly synthetic, complete available result', () => {
  const schemaPath = join(process.cwd(), 'tools/virtual-user-lab/output.schema.json');
  const validator = new SchemaValidator();
  assert.deepEqual(validator.validateFile(schemaPath, output), []);
  assert.ok(validator.validateFile(schemaPath, { status: 'available' }).length > 0);
  assert.ok(validator.validateFile(schemaPath, { ...output, isSimulated: false }).length > 0);
  assert.ok(validator.validateFile(schemaPath, { ...output, reviews: [] }).length > 0);
  assert.doesNotThrow(() => JSON.parse(readFileSync(schemaPath, 'utf8')));
});

test('virtual-user Evidence uses exact review pointers and remains simulation-classified', () => {
  assert.deepEqual(virtualUserSimulationEvidence({
    stepNo: 4,
    artifactId: 'artifact-virtual',
    artifactContentSha256: hash,
    output,
    implementationId: 'virtual-user-real',
    redactedOutputHash: hash,
  }).map(({ id, evidenceClass, jsonPointer }) => ({ id, evidenceClass, jsonPointer })), [{
    id: 'SIM4-1',
    evidenceClass: 'simulation',
    jsonPointer: '/output/reviews/0',
  }]);
});

test('virtual-user adapter emits only provisional hypotheses with simulation Evidence and disclaimer', () => {
  const artifact = new ContributionAdapterRegistry().adapt({
    adapterId: VIRTUAL_USER_TOOL_ADAPTER_ID,
    source: output,
    sourceArtifact: {
      id: 'artifact-virtual',
      contentSha256: hash,
      schemaVersion: 'tool-output-v1',
    },
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation:virtual-user',
    skillId: 'virtual-user-research',
    contributionTypes: ['virtual_user_hypothesis'],
    questionIds: ['question-motivation'],
    requestedArtifactTypes: ['strategy_map'],
    evidenceManifest: manifest(),
  });

  assert.ok(artifact.contribution.units.length >= 2);
  assert.ok(artifact.contribution.units.every(({ support }) => (
    support.status === 'provisional' && support.validationNeeded.length > 0
  )));
  assert.deepEqual(artifact.contribution.units[0]!.support.evidenceIds, ['SIM1-1']);
  assert.ok(artifact.contribution.limitations.includes('虚拟用户假设，不代表真实用户研究。'));
  assert.equal(artifact.source.unitMappings[0]!.sourceJsonPointer, '/output/reviews/0');
});

test('virtual-user adapter rejects available output without simulation Evidence', () => {
  const withoutEvidence = manifest();
  withoutEvidence.entries = [];
  assert.throws(
    () => new ContributionAdapterRegistry().adapt({
      adapterId: VIRTUAL_USER_TOOL_ADAPTER_ID,
      source: output,
      sourceArtifact: { id: 'artifact-virtual', contentSha256: hash, schemaVersion: 'tool-output-v1' },
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      invocationId: 'invocation:virtual-user',
      skillId: 'virtual-user-research',
      contributionTypes: ['virtual_user_hypothesis'],
      questionIds: ['question-motivation'],
      requestedArtifactTypes: [],
      evidenceManifest: withoutEvidence,
    }),
    (error: unknown) => error instanceof ContributionAdapterError
      && error.code === 'source_envelope_invalid',
  );
});
