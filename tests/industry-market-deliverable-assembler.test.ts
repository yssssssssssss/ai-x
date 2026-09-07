import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleIndustryMarketDeliverable,
  IndustryMarketAssemblyError,
} from '../apps/orchestrator-runtime/src/report/industry-market-deliverable-assembler.ts';
import type { SynthesisMaterial } from '../apps/orchestrator-runtime/src/report/synthesis-materializer.ts';
import type { EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { ProblemGraph } from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { validIndustryMarketPayload } from './fixtures/industry-market.ts';

const taskId = 'task-industry';
const planVersionId = 'plan-industry';
const attemptId = 'attempt-industry';

function requirement(): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'industry_market_analysis',
    outcome_mode: 'answer',
    business_domain: 'pet-food',
    research_goal: '形成宠物食品行业与京东频道策略报告',
    target_audience: ['频道产品与设计团队'],
    scope: ['中国大陆线上宠物食品'],
    constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: '形成可追溯的行业结论与策略' }],
    expected_deliverables: ['industry_market_analysis_report'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
    industry_scope: {
      category: '宠物食品',
      subcategories: ['猫用冻干'],
      exclusions: ['线下渠道'],
      analysis_depth: 'medium',
      primary_focus: '竞品与设计策略',
      secondary_focuses: ['用户洞察'],
      decision_audience: ['频道产品与设计团队'],
      decision_goal: '确定频道改版优先级',
      time_window: '最近十二个月',
    },
    available_material_roles: ['competitor_screenshots'],
    unavailable_material_roles: ['internal_metrics_dataset'],
  };
}

function graph(): ProblemGraph {
  return {
    version: 'problem-graph-v1',
    questions: [{
      id: 'question-1',
      statement: '宠物食品行业与频道策略应该如何制定？',
      rationale: '形成决策依据。',
      priority: 'required',
      success_criterion_ids: ['criterion-1'],
      evidence_requirements: [{
        id: 'industry-market-analysis-report',
        acceptedClasses: ['public_source', 'screenshot', 'knowledge', 'user_input', 'dataset'],
        minimumCount: 1,
        required: true,
      }],
      acceptance_criteria: ['结论可追溯。'],
      depends_on: [],
    }],
  };
}

function manifest(): EvidenceManifest {
  return {
    version: 'evidence-v1',
    taskId,
    planVersionId,
    attemptId,
    collectedAt: '2026-09-03T00:00:00.000Z',
    manifestHash: 'sha256:fixture',
    entries: [{
      id: 'E1-1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'tavily-web-search',
      toolTier: 'core',
      artifactId: 'artifact-evidence',
      artifactContentSha256: `sha256:${'1'.repeat(64)}`,
      jsonPointer: '/output/results/0',
      sourceUrl: 'https://example.com/source',
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: `sha256:${'2'.repeat(64)}`,
      },
      sensitivity: 'public',
      redaction: 'none',
    }],
  };
}

function materials(
  payload = validIndustryMarketPayload(),
  reviewerVerdict: 'pass' | 'revise' = 'pass',
) {
  return [{
    stepNo: 8,
    actorType: 'skill' as const,
    actorId: 'industry-market-analysis',
    questionIds: ['question-1'],
    artifactId: 'artifact-skill',
    artifactContentSha256: `sha256:${'3'.repeat(64)}`,
    value: {
      version: 'skill-output-v2',
      status: 'succeeded',
      summary: 'Industry draft ready.',
      payload: { ...payload, schemaVersion: 'industry-market-content-draft-v1' },
      limitations: [],
    },
    semanticRole: 'analysis' as const,
  }, {
    stepNo: 9,
    actorType: 'reviewer' as const,
    actorId: 'reviewer.research-lead',
    questionIds: ['question-1'],
    artifactId: 'artifact-review',
    artifactContentSha256: `sha256:${'4'.repeat(64)}`,
    value: {
      version: 'reviewer-step-output-v1', verdict: reviewerVerdict, issues: [],
      conditions: [{ id: 'review-gap', statement: '审阅要求补充内部经营数据。', disposition: 'limitation' }],
    },
    semanticRole: 'review' as const,
  }];
}

test('assembles one reviewed Industry Skill draft into the canonical deliverable', () => {
  const draft = validIndustryMarketPayload();
  draft.scope.category = 'LLM 草案中的非权威品类描述';
  draft.strategyChains[0]!.categoryAssetRefs.push('missing-asset');
  const materialsWithPlanReview: SynthesisMaterial[] = [
    ...materials(draft, 'revise'),
    {
      stepNo: 11,
      actorType: 'reviewer',
      actorId: 'research-quality-reviewer',
      questionIds: ['question-1'],
      artifactId: 'artifact-plan-review',
      artifactContentSha256: `sha256:${'5'.repeat(64)}`,
      value: { version: 'reviewer-step-output-v1', verdict: 'revise', issues: ['plan-level review'] },
      semanticRole: 'review',
    },
  ];
  const result = assembleIndustryMarketDeliverable({
    taskId,
    planVersionId,
    attemptId,
    evidenceManifestArtifactId: 'artifact-manifest',
    requirement: requirement(),
    problemGraph: graph(),
    evidenceManifest: manifest(),
    materials: materialsWithPlanReview,
    gaps: ['internal_metrics_dataset is unavailable'],
    capabilityProvenance: [{ id: 'industry-market-analysis', type: 'skill' }],
  });

  assert.equal(result.deliverableType, 'industry_market_analysis_report');
  assert.equal(result.payload.schemaVersion, 'industry-market-analysis-v1');
  assert.deepEqual(result.payload.scope, {
    category: '宠物食品',
    subcategories: ['猫用冻干'],
    exclusions: ['线下渠道'],
    analysisDepth: 'medium',
    primaryFocus: '竞品与设计策略',
    secondaryFocuses: ['用户洞察'],
    decisionAudience: ['频道产品与设计团队'],
    decisionGoal: '确定频道改版优先级',
    timeWindow: '最近十二个月',
  });
  assert.equal(result.findingGraph.findings[0]?.statement, '当前样本强调冻干与配方宣称。');
  assert.deepEqual(result.payload.strategyChains[0]?.categoryAssetRefs, ['asset-1']);
  assert.ok(result.risksAndOpenIssues.includes('缺少真实用户数据。'));
  assert.ok(result.risksAndOpenIssues.includes('审阅要求补充内部经营数据。'));
  assert.ok(result.risksAndOpenIssues.includes('internal_metrics_dataset is unavailable'));
  assert.deepEqual(result.coverage.questionBindings.map(({ questionId }) => questionId), ['question-1']);
});

test('Industry assembly keeps Joyspace Knowledge out of factual support', () => {
  const knowledgeManifest = manifest();
  knowledgeManifest.entries[0] = {
    ...knowledgeManifest.entries[0]!,
    kind: 'knowledge_excerpt',
    evidenceClass: 'knowledge',
    toolId: 'joyspace-read',
    toolTier: 'optional',
    sensitivity: 'internal',
    sourceUrl: 'https://joyspace.jd.com/pages/method',
  };
  assert.throws(() => assembleIndustryMarketDeliverable({
    taskId, planVersionId, attemptId, evidenceManifestArtifactId: 'artifact-manifest',
    requirement: requirement(), problemGraph: graph(), evidenceManifest: knowledgeManifest,
    materials: materials(), gaps: [], capabilityProvenance: [],
  }), /non-factual Evidence/u);
});

test('Industry assembly rejects unknown Evidence, Contribution, and opportunity references', () => {
  const unknownEvidence = validIndustryMarketPayload();
  unknownEvidence.validatedFindings[0]!.support.evidenceIds = ['E404'];
  assert.throws(() => assembleIndustryMarketDeliverable({
    taskId,
    planVersionId,
    attemptId,
    evidenceManifestArtifactId: 'artifact-manifest',
    requirement: requirement(),
    problemGraph: graph(),
    evidenceManifest: manifest(),
    materials: materials(unknownEvidence),
    gaps: [],
    capabilityProvenance: [],
  }), IndustryMarketAssemblyError);

  const unknownContribution = validIndustryMarketPayload();
  unknownContribution.validatedFindings[0]!.support.sourceContributionUnitIds = ['missing-artifact:unit-1'];
  assert.throws(() => assembleIndustryMarketDeliverable({
    taskId,
    planVersionId,
    attemptId,
    evidenceManifestArtifactId: 'artifact-manifest',
    requirement: requirement(),
    problemGraph: graph(),
    evidenceManifest: manifest(),
    materials: materials(unknownContribution),
    gaps: [],
    capabilityProvenance: [],
  }), /unknown Contribution unit/u);

  const brokenOpportunity = validIndustryMarketPayload();
  brokenOpportunity.strategyChains[0]!.opportunityId = 'missing-opportunity';
  assert.throws(() => assembleIndustryMarketDeliverable({
    taskId,
    planVersionId,
    attemptId,
    evidenceManifestArtifactId: 'artifact-manifest',
    requirement: requirement(),
    problemGraph: graph(),
    evidenceManifest: manifest(),
    materials: materials(brokenOpportunity),
    gaps: [],
    capabilityProvenance: [],
  }), IndustryMarketAssemblyError);
});
