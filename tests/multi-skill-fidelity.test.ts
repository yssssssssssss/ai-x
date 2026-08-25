import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PlanContributionRequirement,
  ResearchContributionBundleV1,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import {
  buildGenericReviewedContributionLedger,
  buildReviewedContributionLedger,
  contributionUnitId,
  MultiSkillContentFidelityError,
} from '../apps/orchestrator-runtime/src/report/multi-skill-content-fidelity.ts';

const artifactId = 'artifact-contribution-market';
const bundle: ResearchContributionBundleV1 = {
  version: 'research-contribution-bundle-v1',
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  orderedInvocationIds: ['invocation:market'],
  entries: [{
    invocationId: 'invocation:market',
    skillId: 'competitive-analysis',
    artifactId,
    artifactContentSha256: `sha256:${'a'.repeat(64)}`,
    contribution: {
      version: 'research-contribution-v1',
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      invocationId: 'invocation:market',
      skillId: 'competitive-analysis',
      contributionTypes: ['competitive_analysis'],
      units: [{
        key: 'market-1',
        kind: 'finding',
        title: '市场特征',
        statement: '众筹项目需要更强的可信度说明。',
        requestedArtifactTypes: ['strategy_map'],
        support: {
          questionIds: ['question-market'],
          evidenceIds: [],
          status: 'provisional',
          confidence: 0.6,
          validationNeeded: '验证真实用户的信任判断。',
        },
      }],
      limitations: [],
      openQuestions: [],
    },
  }],
  gaps: [],
};

const requirements: PlanContributionRequirement[] = [{
  id: 'demand-market',
  demand_type: 'competitive_analysis',
  question_ids: ['question-market'],
  requested_artifact_types: ['strategy_map'],
  owner_invocation_id: 'invocation:market',
  corroborator_invocation_ids: [],
  required: true,
}];

function canonical(sourceIds: string[] = [contributionUnitId(artifactId, 'market-1')]): ResearchStrategyReportPayloadV2 {
  return {
    schemaVersion: 'research-strategy-content-v2',
    title: '策略报告',
    decisionContext: '众筹频道',
    executiveAnswer: '先强化可信度。',
    directAnswers: [],
    evidenceFindings: [{
      id: 'evidence-finding-001',
      statement: '众筹项目需要更强的可信度说明。',
      support: {
        questionIds: ['question-market'],
        evidenceIds: [],
        confidence: 0.6,
        status: 'provisional',
        validationNeeded: '验证真实用户的信任判断。',
        sourceContributionUnitIds: sourceIds,
      },
    }],
    contentBlocks: [],
    limitations: [],
    openQuestions: [],
    riskDisclosures: [],
    requestedArtifactBindings: [],
  };
}

test('reviewed ledger maps every exact source unit to Canonical once', () => {
  const result = buildReviewedContributionLedger({
    bundle,
    canonical: canonical(),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(result.review.verdict, 'pass');
  assert.deepEqual(result.ledger.entries, [{
    contributionArtifactId: artifactId,
    invocationId: 'invocation:market',
    sourceUnitKey: 'market-1',
    sourceSemanticHash: result.ledger.entries[0]!.sourceSemanticHash,
    disposition: 'included',
    canonicalNodeIds: ['evidence-finding-001'],
    reviewIssueIds: [],
  }]);
});

test('generic deliverable ledger verifies required Contributions against reachable Canonical text', () => {
  const result = buildGenericReviewedContributionLedger({
    bundle,
    deliverable: {
      coverage: {
        questionBindings: [{ questionId: 'question-market', summaryIds: ['summary-market'] }],
      },
      findingGraph: {
        findings: [],
        analyses: [],
        subQuestionSummaries: [{
          id: 'summary-market',
          findingIds: [],
          analysisIds: [],
          summary: '众筹项目需要更强的可信度说明。',
        }],
        overallConclusions: [],
      },
    },
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(result.review.verdict, 'pass');
  assert.deepEqual(result.ledger.entries.map(({ disposition, canonicalNodeIds }) => ({
    disposition, canonicalNodeIds,
  })), [{ disposition: 'included', canonicalNodeIds: ['summary-market'] }]);
});

test('generic deliverable ledger blocks required Contribution omission', () => {
  assert.throws(() => buildGenericReviewedContributionLedger({
    bundle,
    deliverable: {
      coverage: { questionBindings: [] },
      findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] },
    },
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted');
});

test('required owner units cannot be silently omitted', () => {
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: canonical([]),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted');
});

test('different-title contradictory Contributions enter the Conflict Set and Canonical open questions', () => {
  const conflicting = structuredClone(bundle);
  conflicting.orderedInvocationIds.push('invocation:competitor');
  conflicting.entries.push({
    ...structuredClone(conflicting.entries[0]!),
    invocationId: 'invocation:competitor',
    skillId: 'competitive-web-research',
    artifactId: 'artifact-contribution-competitor',
    contribution: {
      ...structuredClone(conflicting.entries[0]!.contribution),
      invocationId: 'invocation:competitor',
      skillId: 'competitive-web-research',
      units: [{
        ...structuredClone(conflicting.entries[0]!.contribution.units[0]!),
        key: 'market-2',
        title: '另一项市场判断',
        statement: '众筹项目不需要额外的可信度说明。',
      }],
    },
  });
  const firstSourceId = contributionUnitId(artifactId, 'market-1');
  const secondSourceId = contributionUnitId('artifact-contribution-competitor', 'market-2');
  const target = canonical([firstSourceId]);
  target.evidenceFindings.push({
    id: 'evidence-finding-002',
    statement: '众筹项目不需要额外的可信度说明。',
    support: {
      questionIds: ['question-market'], evidenceIds: [], confidence: 0.4,
      status: 'provisional', validationNeeded: '验证相反假设。',
      sourceContributionUnitIds: [secondSourceId],
    },
  });
  const result = buildReviewedContributionLedger({
    bundle: conflicting,
    canonical: target,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.ok(result.review.issues.some(({ type }) => type === 'conflict'));
  assert.ok(result.ledger.entries.every(({ disposition }) => disposition === 'conflicted'));
  assert.ok(target.openQuestions.some((question) => question.includes('Conflicting Contribution units')));
});

test('same-Question units cannot be bulk-attributed when one contradictory unit is omitted', () => {
  const conflicting = structuredClone(bundle);
  conflicting.entries[0]!.contribution.units.push({
    key: 'market-2',
    kind: 'finding',
    title: '相反结论',
    statement: '众筹项目不需要可信度说明。',
    requestedArtifactTypes: ['strategy_map'],
    support: {
      questionIds: ['question-market'],
      evidenceIds: [],
      status: 'provisional',
      confidence: 0.4,
      validationNeeded: '验证相反假设。',
    },
  });
  assert.throws(() => buildReviewedContributionLedger({
    bundle: conflicting,
    canonical: canonical(),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted');
});

test('provisional Contribution units cannot be promoted to supported Canonical content', () => {
  const promoted = canonical();
  promoted.evidenceFindings[0]!.support.status = 'supported';
  promoted.evidenceFindings[0]!.support.evidenceIds = ['E1'];
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: promoted,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'provisional_promoted');
});

test('Canonical content cannot cite a source unit while rewriting it to unrelated text', () => {
  const rewritten = canonical();
  rewritten.evidenceFindings[0]!.statement = 'An unrelated claim that the Contributor did not make.';
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: rewritten,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'unauthorized_source_rewrite');
});

test('one exact target cannot authorize a second rewritten target for the same source unit', () => {
  const multiplyMapped = canonical();
  multiplyMapped.evidenceFindings.push({
    id: 'evidence-finding-002',
    statement: 'An unrelated second claim.',
    support: {
      questionIds: ['question-market'], evidenceIds: [], confidence: 0.5,
      status: 'provisional', validationNeeded: 'Validate.',
      sourceContributionUnitIds: [contributionUnitId(artifactId, 'market-1')],
    },
  });
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: multiplyMapped,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'unauthorized_source_rewrite');
});

test('Canonical content cannot cite a Contribution unit outside its Question scope', () => {
  const mismatched = canonical();
  mismatched.evidenceFindings[0]!.support.questionIds = ['question-other'];
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: mismatched,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'source_scope_mismatch');
});

test('Canonical content cannot cite an unknown Contribution unit', () => {
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: canonical(['artifact-unknown:unit-1']),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'unknown_source_unit');
});
