import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INDUSTRY_REPORT_REVIEW_DIMENSION_IDS,
} from '../packages/api-contract/control-workflow.ts';
import type { ResearchDeliverableEnvelope } from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { ReportReviewService } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import { validIndustryMarketPayload } from './fixtures/industry-market.ts';

const taskId = 'task-industry';
const planVersionId = 'plan-industry';
const attemptId = 'attempt-industry';
const deliverableArtifactId = 'deliverable-industry';

function requirement(): ResearchTaskV2 {
  return {
    version: 'research-task-v2', task_type: 'industry_market_analysis', outcome_mode: 'answer',
    business_domain: 'pet-food', research_goal: '形成宠物食品行业与频道策略报告',
    target_audience: ['频道团队'], scope: ['中国大陆线上市场'], constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: '结论可追溯' }],
    expected_deliverables: ['industry_market_analysis_report'], assumptions: [], ambiguities: [],
    clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
    industry_scope: {
      category: '宠物食品', subcategories: ['猫用冻干'], exclusions: ['线下渠道'],
      analysis_depth: 'medium', primary_focus: '竞品与设计策略', secondary_focuses: ['用户洞察'],
      decision_audience: ['频道团队'], decision_goal: '确定改版优先级', time_window: '最近十二个月',
    },
    available_material_roles: ['competitor_screenshots'],
    unavailable_material_roles: ['internal_metrics_dataset'],
  };
}

function deliverable(): ResearchDeliverableEnvelope<ReturnType<typeof validIndustryMarketPayload>> {
  return {
    version: 'research-deliverable-v1', taskId, planVersionId, attemptId,
    deliverableType: 'industry_market_analysis_report', evidenceManifestArtifactId: 'manifest-1',
    methodSummary: 'Industry Market Analysis',
    findingGraph: {
      findings: [{ id: 'finding-1', kind: 'fact', evidenceIds: ['E1-1'], statement: '当前样本强调冻干与配方宣称。' }],
      analyses: [{ id: 'analysis-question-1', findingIds: ['finding-1'], statement: '形成证据透明度判断。' }],
      subQuestionSummaries: [{ id: 'summary-question-1', findingIds: ['finding-1'], analysisIds: ['analysis-question-1'], summary: '应优先提高证据透明度。' }],
      overallConclusions: [{ id: 'conclusion-question-1', summaryIds: ['summary-question-1'], statement: '应优先提高证据透明度。' }],
    },
    payload: validIndustryMarketPayload(),
    recommendations: [{ id: 'recommendation-question-1', summaryIds: ['summary-question-1'], statement: '增加配方证据卡。' }],
    coverage: {
      questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-question-1'] }],
      successCriterionBindings: [{ successCriterionId: 'criterion-1', conclusionIds: ['conclusion-question-1'], recommendationIds: ['recommendation-question-1'] }],
    },
    risksAndOpenIssues: ['缺少真实用户数据。'],
    capabilityProvenance: [],
  };
}

test('ReportReviewService selects report-review-v3 for Industry', async () => {
  const writes: Array<{ schemaVersion?: string; value: unknown }> = [];
  const service = new ReportReviewService({
    llm: {
      async generateStructured<T>() {
        return {
          data: {
            verdict: 'pass',
            dimensions: INDUSTRY_REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
          } as T,
          modelName: 'fixture-model', modelVersion: 'v1', promptHash: 'sha256:fixture', traceId: 'trace-fixture',
        };
      },
    },
    artifacts: {
      async writeJson(input) {
        writes.push(input);
        return { id: 'review-artifact', state: 'SEALED' };
      },
    },
  });

  const result = await service.review({
    task: { id: taskId }, plan: { id: planVersionId }, attempt: { id: attemptId },
    deliverableArtifactId, deliverable: deliverable(),
    successCriterionIds: ['criterion-1'], questionIds: ['question-1'], evidenceIds: ['E1-1'],
    requirement: requirement(), expectedModel: 'fixture-model',
    activeLease: { taskId, planVersionId, attemptId, leaseOwner: 'worker-1', leaseToken: 'token-1' },
  });

  assert.equal(result.version, 'report-review-v3');
  assert.equal(result.verdict, 'pass');
  assert.equal(result.status, 'completed');
  assert.equal(writes[0]?.schemaVersion, 'report-review-v3');
});
