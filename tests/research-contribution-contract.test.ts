import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  EvidenceManifest,
  ResearchContributionV1,
} from '../packages/api-contract/research-deliverable.ts';
import {
  ResearchContributionValidationError,
  validateResearchContribution,
} from '../apps/orchestrator-runtime/src/skills/research-contribution.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const factualHash = `sha256:${'a'.repeat(64)}`;

const evidenceManifest: EvidenceManifest = {
  version: 'evidence-v1',
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-24T00:00:00.000Z',
  manifestHash: factualHash,
  entries: [
    {
      id: 'evidence-public',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'tavily-web-search',
      artifactId: 'artifact-public',
      artifactContentSha256: factualHash,
      jsonPointer: '/results/0',
      sourceUrl: 'https://example.com/source',
      sensitivity: 'public',
      redaction: 'none',
    },
    {
      id: 'evidence-knowledge',
      kind: 'knowledge_excerpt',
      evidenceClass: 'knowledge',
      artifactId: 'artifact-knowledge',
      artifactContentSha256: factualHash,
      jsonPointer: '/items/0',
      sensitivity: 'internal',
      redaction: 'none',
    },
    {
      id: 'evidence-simulation',
      kind: 'tool_output',
      evidenceClass: 'simulation',
      toolId: 'virtual-user-lab',
      artifactId: 'artifact-simulation',
      artifactContentSha256: factualHash,
      jsonPointer: '/responses/0',
      sensitivity: 'internal',
      redaction: 'none',
    },
  ],
};

function validContribution(): ResearchContributionV1 {
  return {
    version: 'research-contribution-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    invocationId: 'invocation-market',
    skillId: 'competitive-web-research',
    contributionTypes: ['market_landscape'],
    units: [{
      key: 'market.finding.1',
      kind: 'finding',
      title: '众筹供给更强调新品验证',
      statement: '公开案例显示众筹频道主要承接新品首发和需求验证。',
      businessImplication: '首页应强化新品发现与可信度线索。',
      recommendedAction: '优先验证新品标签和项目背书。',
      requestedArtifactTypes: ['strategy_map'],
      support: {
        questionIds: ['question-market'],
        evidenceIds: ['evidence-public'],
        status: 'supported',
        confidence: 0.8,
        validationNeeded: '',
      },
    }],
    limitations: ['公开资料无法代表全部项目。'],
    openQuestions: ['真实用户是否理解众筹规则？'],
  };
}

function validate(contribution: ResearchContributionV1): void {
  validateResearchContribution({
    contribution,
    allowedQuestionIds: ['question-market'],
    evidenceManifest,
  });
}

function expectContributionError(
  contribution: ResearchContributionV1,
  kind: ResearchContributionValidationError['kind'],
  issueIds: string[],
): void {
  assert.throws(
    () => validate(contribution),
    (error: unknown) => {
      assert.ok(error instanceof ResearchContributionValidationError);
      assert.equal(error.kind, kind);
      for (const issueId of issueIds) assert.ok(error.issueIds.includes(issueId));
      return true;
    },
  );
}

test('research contribution schema is registered and accepts a strict contribution', () => {
  const spec = resolveSchema('research-contribution-v1');
  assert.equal(spec.file, 'research-contribution-v1.schema.json');
  assert.ok(loadSchemaText(spec)?.includes('research-contribution-v1'));
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow(
    'research-contribution-v1',
    validContribution(),
  ));
  assert.doesNotThrow(() => validate(validContribution()));
});

test('research contribution schema requires Question support and provisional validation work', () => {
  const validator = new SchemaValidator();
  const noQuestion = validContribution();
  noQuestion.units[0]!.support.questionIds = [];
  assert.throws(
    () => validator.validateOrThrow('research-contribution-v1', noQuestion),
    SchemaValidationError,
  );

  const noValidation = validContribution();
  noValidation.units[0]!.support = {
    ...noValidation.units[0]!.support,
    status: 'provisional',
    evidenceIds: [],
    validationNeeded: '',
  };
  assert.throws(
    () => validator.validateOrThrow('research-contribution-v1', noValidation),
    SchemaValidationError,
  );
});

test('supported contribution units require a factual Evidence root', () => {
  const contribution = validContribution();
  contribution.units[0]!.support.evidenceIds = ['evidence-knowledge'];
  expectContributionError(contribution, 'supported_without_factual_evidence', [
    'market.finding.1',
    'evidence-knowledge',
  ]);
});

test('contribution units reject unknown Question and Evidence references', () => {
  const unknownQuestion = validContribution();
  unknownQuestion.units[0]!.support.questionIds = ['question-missing'];
  expectContributionError(unknownQuestion, 'unknown_question', [
    'market.finding.1',
    'question-missing',
  ]);

  const unknownEvidence = validContribution();
  unknownEvidence.units[0]!.support.evidenceIds = ['evidence-missing'];
  expectContributionError(unknownEvidence, 'unknown_evidence', [
    'market.finding.1',
    'evidence-missing',
  ]);
});

test('virtual-user and simulation-backed contribution units cannot be supported facts', () => {
  const virtualContribution = validContribution();
  virtualContribution.contributionTypes = ['virtual_user_hypothesis'];
  virtualContribution.units[0]!.support.evidenceIds = ['evidence-public'];
  expectContributionError(virtualContribution, 'synthetic_supported', ['market.finding.1']);

  const simulationContribution = validContribution();
  simulationContribution.units[0]!.support.evidenceIds = ['evidence-simulation'];
  expectContributionError(simulationContribution, 'synthetic_supported', [
    'market.finding.1',
    'evidence-simulation',
  ]);
});

test('research contribution rejects duplicate unit keys and mismatched lineage', () => {
  const duplicate = validContribution();
  duplicate.units.push(structuredClone(duplicate.units[0]!));
  expectContributionError(duplicate, 'duplicate_unit_key', ['market.finding.1']);

  const mismatch = validContribution();
  mismatch.attemptId = 'attempt-other';
  expectContributionError(mismatch, 'evidence_lineage_mismatch', [
    'task-1',
    'plan-1',
    'attempt-other',
  ]);
});
