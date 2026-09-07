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

test('generic Industry ledger records transformed Contributor mappings as review conditions', () => {
  const sourceId = contributionUnitId(artifactId, 'market-1');
  const result = buildGenericReviewedContributionLedger({
    bundle,
    deliverable: {
      coverage: { questionBindings: [] },
      findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] },
      risksAndOpenIssues: [],
      payload: {
        schemaVersion: 'industry-market-analysis-v1',
        mappedNodes: [{
          id: 'industry-node-1',
          statement: 'A transformed interpretation of the source contribution.',
          support: {
            questionIds: ['question-market'],
            sourceContributionUnitIds: [sourceId],
            status: 'provisional',
          },
        }],
      },
    },
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });

  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.ok(result.review.issues.some((issue) => (
    issue.type === 'unauthorized_source_rewrite'
    && issue.sourceUnitIds.includes(sourceId)
  )));
  assert.equal(result.ledger.entries[0]?.disposition, 'included');
  assert.deepEqual(result.ledger.entries[0]?.canonicalNodeIds, ['industry-node-1']);
});

test('generic Industry ledger records cross-Question mappings as review conditions', () => {
  const sourceId = contributionUnitId(artifactId, 'market-1');
  const result = buildGenericReviewedContributionLedger({
    bundle,
    deliverable: {
      coverage: { questionBindings: [] },
      findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] },
      risksAndOpenIssues: [],
      payload: {
        schemaVersion: 'industry-market-analysis-v1',
        mappedNodes: [{
          id: 'industry-node-other',
          statement: bundle.entries[0]!.contribution.units[0]!.statement,
          support: {
            questionIds: ['question-other'],
            sourceContributionUnitIds: [sourceId],
            status: 'provisional',
          },
        }],
      },
    },
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });

  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.ok(result.review.issues.some((issue) => (
    issue.type === 'scope_mismatch'
    && issue.sourceUnitIds.includes(sourceId)
  )));
  assert.equal(result.ledger.entries[0]?.disposition, 'included');
});

test('generic deliverable ledger records required provisional Contribution omission', () => {
  const omittedBundle = structuredClone(bundle);
  omittedBundle.entries[0]!.contribution.units.push({
    ...structuredClone(omittedBundle.entries[0]!.contribution.units[0]!),
    key: 'market-2',
    statement: 'A second provisional contribution remains unselected.',
  });
  const deliverable = {
    coverage: { questionBindings: [] },
    findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] },
    risksAndOpenIssues: [] as string[],
  };
  const result = buildGenericReviewedContributionLedger({
    bundle: omittedBundle,
    deliverable,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.equal(result.review.issues[0]?.disposition, 'omitted');
  assert.deepEqual(result.ledger.entries.map(({ disposition }) => disposition), ['omitted', 'omitted']);
  assert.equal(deliverable.risksAndOpenIssues.length, 1);
  assert.match(deliverable.risksAndOpenIssues[0]!, /demand-market/u);
});

test('required provisional owner units are explicitly omitted and disclosed', () => {
  const target = canonical([]);
  const result = buildReviewedContributionLedger({
    bundle,
    canonical: target,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.equal(result.review.issues[0]?.disposition, 'omitted');
  assert.equal(result.ledger.entries[0]?.disposition, 'omitted');
  assert.equal(target.openQuestions.length, 1);
  assert.match(target.openQuestions[0]!, /demand-market/u);
});

test('required supported owner units cannot be omitted', () => {
  const supported = structuredClone(bundle);
  supported.entries[0]!.contribution.units[0]!.support = {
    questionIds: ['question-market'],
    evidenceIds: ['E1'],
    status: 'supported',
    confidence: 0.8,
    validationNeeded: '',
  };
  assert.throws(() => buildReviewedContributionLedger({
    bundle: supported,
    canonical: canonical([]),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted');
  assert.throws(() => buildGenericReviewedContributionLedger({
    bundle: supported,
    deliverable: {
      coverage: { questionBindings: [] },
      findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] },
    },
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted');
});

test('required owner matching includes Contribution type instead of depending on requirement order', () => {
  const supported = structuredClone(bundle);
  supported.entries[0]!.contribution.units[0]!.support = {
    questionIds: ['question-market'],
    evidenceIds: ['E1'],
    status: 'supported',
    confidence: 0.8,
    validationNeeded: '',
  };
  const orderedRequirements = [{
    ...requirements[0]!,
    id: 'demand-journey',
    demand_type: 'journey' as const,
    required: false,
  }, requirements[0]!];
  assert.throws(() => buildReviewedContributionLedger({
    bundle: supported,
    canonical: canonical([]),
    contributionRequirements: orderedRequirements,
    synthesisArtifactId: 'artifact-synthesis',
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'required_owner_omitted'
    && error.issueIds.includes('demand-market'));
});

test('non-attributable structured payload context is removed and remains auditable as omitted', () => {
  const contextBundle = structuredClone(bundle);
  contextBundle.entries[0]!.contribution.units[0] = {
    ...contextBundle.entries[0]!.contribution.units[0]!,
    key: 'payload-001',
    statement: '{"strategy":"context only"}',
  };
  const sourceId = contributionUnitId(artifactId, 'payload-001');
  const target = canonical([sourceId]);
  target.evidenceFindings[0]!.statement = 'A separately evidenced canonical conclusion.';
  target.evidenceFindings[0]!.support = {
    questionIds: ['question-other'],
    evidenceIds: ['E1'],
    status: 'supported',
    confidence: 0.8,
    validationNeeded: '',
    sourceContributionUnitIds: [sourceId],
  };
  const result = buildReviewedContributionLedger({
    bundle: contextBundle,
    canonical: target,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
    nonAttributableSourceUnitIds: new Set([sourceId]),
  });
  assert.deepEqual(target.evidenceFindings[0]!.support.sourceContributionUnitIds, []);
  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.equal(result.ledger.entries[0]!.disposition, 'omitted');
  assert.equal(target.openQuestions.length, 1);
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

test('same-Question provisional units receive exact included or omitted dispositions', () => {
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
  const target = canonical();
  const result = buildReviewedContributionLedger({
    bundle: conflicting,
    canonical: target,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.deepEqual(
    result.ledger.entries.map(({ disposition }) => disposition),
    ['included', 'omitted'],
  );
  assert.equal(result.review.verdict, 'pass_with_conditions');
  assert.equal(target.openQuestions.filter((question) => question.includes('demand-market')).length, 1);
});

test('provisional Contribution units promoted to supported Canonical content are recorded as a provisional_promoted issue (pass_with_conditions)', () => {
  const promoted = canonical();
  promoted.evidenceFindings[0]!.support.status = 'supported';
  promoted.evidenceFindings[0]!.support.evidenceIds = ['E1'];
  const { review, ledger } = buildReviewedContributionLedger({
    bundle,
    canonical: promoted,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(review.verdict, 'pass_with_conditions');
  assert.ok(review.issues.some((issue) => issue.type === 'provisional_promoted'
    && issue.sourceUnitIds.includes(contributionUnitId(artifactId, 'market-1'))));
  assert.ok(ledger.entries.some((entry) => entry.sourceUnitKey === 'market-1'
    && entry.disposition === 'included'));
});

test('Canonical content citing a source unit while rewriting it to unrelated text is recorded as unauthorized_source_rewrite (pass_with_conditions)', () => {
  const rewritten = canonical();
  rewritten.evidenceFindings[0]!.statement = 'An unrelated claim that the Contributor did not make.';
  const { review, ledger } = buildReviewedContributionLedger({
    bundle,
    canonical: rewritten,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(review.verdict, 'pass_with_conditions');
  assert.ok(review.issues.some((issue) => issue.type === 'unauthorized_source_rewrite'
    && issue.sourceUnitIds.includes(contributionUnitId(artifactId, 'market-1'))));
  assert.ok(ledger.entries.some((entry) => entry.sourceUnitKey === 'market-1'
    && entry.disposition === 'included'));
});

test('one exact target cannot silence a second rewritten target; rewritten second target is recorded (pass_with_conditions)', () => {
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
  const { review, ledger } = buildReviewedContributionLedger({
    bundle,
    canonical: multiplyMapped,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(review.verdict, 'pass_with_conditions');
  assert.ok(review.issues.some((issue) => issue.type === 'unauthorized_source_rewrite'
    && issue.targetNodeIds.includes('evidence-finding-002')));
  assert.ok(ledger.entries.some((entry) => entry.sourceUnitKey === 'market-1'
    && entry.disposition === 'included'));
});

test('Canonical content citing a Contribution unit outside its Question scope is recorded as a scope_mismatch issue (pass_with_conditions)', () => {
  const mismatched = canonical();
  mismatched.evidenceFindings[0]!.support.questionIds = ['question-other'];
  const { review, ledger } = buildReviewedContributionLedger({
    bundle,
    canonical: mismatched,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(review.verdict, 'pass_with_conditions');
  assert.ok(review.issues.some((issue) => issue.type === 'scope_mismatch'
    && issue.sourceUnitIds.includes(contributionUnitId(artifactId, 'market-1'))));
  assert.ok(ledger.entries.some((entry) => entry.disposition === 'included'
    && entry.sourceUnitKey === 'market-1'));
});

test('Direct-answer node citing a Contribution unit outside its Question scope is recorded, not thrown', () => {
  const mismatched = canonical([]);
  mismatched.directAnswers.push({
    questionId: 'question-other',
    question: '另一个问题',
    answer: '众筹项目需要更强的可信度说明。',
    answerStatus: 'provisional',
    businessImplication: '',
    recommendedAction: '',
    validationNeeded: '',
    evidenceIds: [],
    confidence: 0.6,
    sourceContributionUnitIds: [contributionUnitId(artifactId, 'market-1')],
  });
  const { review, ledger } = buildReviewedContributionLedger({
    bundle,
    canonical: mismatched,
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
  });
  assert.equal(review.verdict, 'pass_with_conditions');
  const issue = review.issues.find((item) => item.type === 'scope_mismatch');
  assert.ok(issue);
  assert.ok(issue.targetNodeIds.includes('direct-answer:question-other'));
  assert.ok(ledger.entries.some((entry) => entry.sourceUnitKey === 'market-1'
    && entry.disposition === 'included'));
});

test('Canonical content cannot cite an unknown Contribution unit', () => {
  const unknownSourceId = 'artifact-unknown:unit-1';
  assert.throws(() => buildReviewedContributionLedger({
    bundle,
    canonical: canonical([unknownSourceId]),
    contributionRequirements: requirements,
    synthesisArtifactId: 'artifact-synthesis',
    nonAttributableSourceUnitIds: new Set([unknownSourceId]),
  }), (error: unknown) => error instanceof MultiSkillContentFidelityError
    && error.code === 'unknown_source_unit');
});
