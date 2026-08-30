import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ControlArtifact } from '../database/control-plane.ts';
import {
  REPORT_REVIEW_V2_DIMENSION_IDS,
  type PassedReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../packages/api-contract/research-deliverable.ts';
import {
  assertReportEditorialBlueprintIntegrity,
  assertReportEditorialMaterialIntegrity,
} from '../packages/report-rendering/report-editorial-validation.ts';
import { createDeterministicReportEditorialBlueprintV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-blueprint.ts';
import { buildResearchPlanEditorialMaterialV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts';
import { buildReportEditorialPlannerInputV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import {
  projectEditorialCardGridBlockV4,
  projectEditorialStageFlowBlockV4,
} from '../apps/orchestrator-runtime/src/report/report-editorial-rich-block-projector.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const DELIVERABLE_SHA = `sha256:${'a'.repeat(64)}`;
const REVIEW_SHA = `sha256:${'b'.repeat(64)}`;

function artifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  contentSha256: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: 'task-plan-1',
    planVersionId: 'plan-plan-1',
    attemptId: 'attempt-plan-1',
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/fixtures/${input.id}.json`,
    contentSha256: input.contentSha256,
    byteSize: 4096,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
  };
}

function researchPlanPayload(): ResearchPlanPayload {
  return {
    title: '宠物食品电商推广研究计划',
    researchGoal: '识别宠物食品在电商渠道的有效推广路径',
    scope: {
      market: '中国大陆电商市场',
      subjects: ['犬粮', '猫粮'],
      timeWindow: '最近十二个月',
    },
    competitorSampling: {
      strategy: '按品牌声量与渠道覆盖分层抽样',
      targetCount: 8,
      inclusionCriteria: ['具备可核验商品页'],
      exclusionCriteria: ['已停止销售'],
    },
    researchQuestions: ['消费者为何选择特定品牌？', '内容与货架如何协同？'],
    comparisonDimensions: [{
      id: 'dimension-positioning',
      name: '产品定位',
      purpose: '比较核心卖点与消费场景',
      collectionFields: ['目标宠物', '核心卖点'],
    }],
    sourcePlan: [{
      evidenceClass: 'public_source',
      sourceTypes: ['品牌官网', '电商商品页'],
      purpose: '核验商品事实与公开主张',
    }],
    executionPlan: [{
      phase: '范围收敛',
      activities: ['确认样本与维度'],
      duration: '1 个工作日',
      outputs: ['样本清单'],
    }, {
      phase: '证据采集',
      activities: ['采集并核验公开页面'],
      duration: '2 个工作日',
      outputs: ['证据索引'],
    }],
    collectionTemplate: [{
      field: '核心卖点原文',
      description: '商品页中的原始价值主张',
      evidenceRequired: true,
    }],
    analysisMethods: ['横向维度对比', '推广链路归纳'],
    deliverables: ['推广研究报告', '证据索引表'],
    qualityChecks: ['事实均绑定可追溯来源', '事实与推断分开表达'],
  };
}

function researchPlanInput() {
  const deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload> = {
    version: 'research-deliverable-v1',
    taskId: 'task-plan-1',
    planVersionId: 'plan-plan-1',
    attemptId: 'attempt-plan-1',
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    methodSummary: '以公开来源核验为主，并对事实和推断分层整理。',
    findingGraph: {
      findings: [{
        id: 'finding-fact-1',
        kind: 'fact',
        statement: '头部品牌同时经营内容触达与货架转化。',
        evidenceIds: ['evidence-1'],
      }, {
        id: 'finding-inference-1',
        kind: 'inference',
        statement: '推广研究需要同时观察内容与交易链路。',
        findingIds: ['finding-fact-1'],
      }],
      analyses: [{
        id: 'analysis-1',
        statement: '单看广告曝光无法解释最终转化差异。',
        findingIds: ['finding-fact-1', 'finding-inference-1'],
      }],
      subQuestionSummaries: [{
        id: 'summary-1',
        summary: '研究应覆盖从种草到交易的完整链路。',
        findingIds: ['finding-fact-1', 'finding-inference-1'],
        analysisIds: ['analysis-1'],
      }],
      overallConclusions: [{
        id: 'conclusion-1',
        statement: '先收敛样本和链路，再启动规模化采集。',
        summaryIds: ['summary-1'],
      }],
    },
    payload: researchPlanPayload(),
    recommendations: [{
      id: 'recommendation-1',
      statement: '先完成八个代表品牌的小样本验证。',
      summaryIds: ['summary-1'],
    }],
    coverage: {
      questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'criterion-1',
        conclusionIds: ['conclusion-1'],
        recommendationIds: ['recommendation-1'],
      }],
    },
    risksAndOpenIssues: ['公开页面可能随时间变化。'],
    capabilityProvenance: [],
  };
  const review: PassedReportReviewArtifact = {
    version: 'report-review-v2',
    taskId: 'task-plan-1',
    planVersionId: 'plan-plan-1',
    attemptId: 'attempt-plan-1',
    deliverableArtifactId: 'deliverable-plan-1',
    verdict: 'pass',
    dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
  return {
    taskId: 'task-plan-1',
    planVersionId: 'plan-plan-1',
    attemptId: 'attempt-plan-1',
    requiredQuestionIds: ['question-1'],
    deliverable: {
      artifact: artifact({
        id: 'deliverable-plan-1',
        kind: 'deliverable',
        schemaVersion: 'research-deliverable-v1-review-gated',
        contentSha256: DELIVERABLE_SHA,
      }),
      value: deliverable,
    },
    review: {
      artifact: artifact({
        id: 'review-plan-1',
        kind: 'report_review',
        schemaVersion: review.version,
        contentSha256: REVIEW_SHA,
      }),
      value: review,
    },
  };
}

test('research_plan adapter preserves the reviewed payload, analysis envelope, coverage, and leaf trace', () => {
  const material = buildResearchPlanEditorialMaterialV1(researchPlanInput());
  assert.doesNotThrow(() => assertReportEditorialMaterialIntegrity(material));
  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-material-v1.schema.json',
    material,
  ));
  assert.equal(material.document.deliverableType, 'research_plan');
  assert.equal(material.binding.deliverableContentSha256, DELIVERABLE_SHA);

  const serialized = JSON.stringify(material);
  for (const value of [
    '识别宠物食品在电商渠道的有效推广路径',
    '中国大陆电商市场',
    '按品牌声量与渠道覆盖分层抽样',
    '消费者为何选择特定品牌？',
    '比较核心卖点与消费场景',
    '核验商品事实与公开主张',
    '商品页中的原始价值主张',
    '横向维度对比',
    '推广研究报告',
    '事实均绑定可追溯来源',
    '确认样本与维度',
    '1 个工作日',
    '样本清单',
    '头部品牌同时经营内容触达与货架转化。',
    '推广研究需要同时观察内容与交易链路。',
    '单看广告曝光无法解释最终转化差异。',
    '研究应覆盖从种草到交易的完整链路。',
    '先收敛样本和链路，再启动规模化采集。',
    '先完成八个代表品牌的小样本验证。',
    '公开页面可能随时间变化。',
    'criterion-1',
  ]) assert.ok(serialized.includes(value), `missing reviewed value: ${value}`);

  const pointers = Object.values(material.leafTraceIndex)
    .flatMap(({ origins }) => origins.map(({ jsonPointer }) => jsonPointer));
  for (const pointer of [
    '/payload/researchGoal',
    '/payload/scope',
    '/payload/competitorSampling',
    '/payload/researchQuestions/0',
    '/payload/comparisonDimensions/0',
    '/payload/sourcePlan/0',
    '/payload/executionPlan/0',
    '/payload/collectionTemplate/0',
    '/payload/analysisMethods/0',
    '/payload/deliverables/0',
    '/payload/qualityChecks/0',
    '/findingGraph/findings/0',
    '/findingGraph/findings/1',
    '/findingGraph/analyses/0',
    '/findingGraph/subQuestionSummaries/0',
    '/findingGraph/overallConclusions/0',
    '/recommendations/0',
    '/risksAndOpenIssues/0',
    '/coverage/questionBindings/0',
    '/coverage/successCriterionBindings/0',
  ]) assert.ok(pointers.includes(pointer), `missing source pointer: ${pointer}`);
  assert.equal(pointers.some((pointer) => pointer.startsWith('/steps')), false);
  assert.ok(Object.values(material.leafTraceIndex).some(
    ({ support }) => support.questionIds.includes('question-1') && support.summaryIds.includes('summary-1'),
  ));
});

test('research_plan deterministic blueprint uses only explicit records and phases for rich presentation', () => {
  const material = buildResearchPlanEditorialMaterialV1(researchPlanInput());
  const blueprint = createDeterministicReportEditorialBlueprintV1(material);
  assert.doesNotThrow(() => assertReportEditorialBlueprintIntegrity(material, blueprint));
  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    'schemas/report-editorial-blueprint-v1.schema.json',
    blueprint,
  ));
  const blocks = blueprint.sections.flatMap(({ blocks: sectionBlocks }) => sectionBlocks);
  assert.ok(blocks.some(({ presentation }) => presentation === 'card-grid'));
  assert.ok(blocks.some(({ presentation }) => presentation === 'stage-flow'));

  const linear = createDeterministicReportEditorialBlueprintV1(material, {
    cardGrid: false,
    stageFlow: false,
  });
  assert.equal(linear.sections.flatMap(({ blocks: value }) => value)
    .some(({ presentation }) => presentation === 'card-grid' || presentation === 'stage-flow'), false);
  assert.doesNotThrow(() => assertReportEditorialBlueprintIntegrity(material, linear));

  const plannerInput = buildReportEditorialPlannerInputV1(material);
  const records = plannerInput.presentationUnits.find(({ shape }) => shape === 'records');
  const stages = plannerInput.presentationUnits.find(({ shape }) => shape === 'stages');
  assert.equal(records?.shape, 'records');
  assert.equal(stages?.shape, 'stages');
  if (records?.shape === 'records') assert.ok(records.allowedPresentations.includes('card-grid'));
  if (stages?.shape === 'stages') {
    assert.ok(stages.allowedPresentations.includes('stage-flow'));
    assert.deepEqual(stages.stages[0]?.activities, ['确认样本与维度']);
    assert.deepEqual(stages.stages[0]?.outputs, ['样本清单']);
  }
});

test('research_plan adapter rejects a Review bound to another Deliverable', () => {
  const input = researchPlanInput();
  input.review.value.deliverableArtifactId = 'other-deliverable';
  assert.throws(
    () => buildResearchPlanEditorialMaterialV1(input),
    /final pass Review bound to the Deliverable/u,
  );
});

test('v4 rich-block projectors preserve structured record and execution-stage content', () => {
  const material = buildResearchPlanEditorialMaterialV1(researchPlanInput());
  const records = material.presentationUnits.find(({ id }) => id === 'research-plan:overview');
  const stages = material.presentationUnits.find(({ id }) => id === 'research-plan:execution');
  assert.equal(records?.shape, 'records');
  assert.equal(stages?.shape, 'stages');
  if (records?.shape !== 'records' || stages?.shape !== 'stages') assert.fail('missing rich units');

  const cardGrid = projectEditorialCardGridBlockV4(records, {
    id: 'block-card-grid',
    title: records.title,
    visibility: 'always',
    unitRefs: [records.id],
    leafRefs: [...records.leafIds],
  });
  assert.match(cardGrid.cards[1]?.body ?? '', /市场：中国大陆电商市场/u);
  assert.match(cardGrid.cards[2]?.body ?? '', /目标数量：8/u);

  const stageFlow = projectEditorialStageFlowBlockV4(stages, {
    id: 'block-stage-flow',
    title: stages.title,
    visibility: 'always',
    unitRefs: [stages.id],
    leafRefs: [...stages.leafIds],
  });
  assert.equal(stageFlow.stages[0]?.label, '范围收敛');
  assert.equal(stageFlow.stages[0]?.timeLabel, '1 个工作日');
  assert.match(stageFlow.stages[0]?.description ?? '', /活动：确认样本与维度/u);
  assert.match(stageFlow.stages[0]?.description ?? '', /产出：样本清单/u);
});
