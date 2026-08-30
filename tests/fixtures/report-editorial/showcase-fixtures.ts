import type { ReportEditorialMaterialV1 } from '../../../packages/api-contract/report-editorial.ts';
import type { ReportEditorialShowcaseIntentV1 } from '../../../packages/api-contract/report-editorial-showcase.ts';
import type { EvidenceManifest } from '../../../packages/api-contract/research-deliverable.ts';

export const SHOWCASE_FIXTURE_SHA = `sha256:${'a'.repeat(64)}`;

function trace(
  pointer: string,
  status: 'supported' | 'provisional' | 'unanswered',
  confidence: number | undefined,
  evidenceIds: string[],
) {
  return {
    supportMode: 'direct' as const,
    origins: [{
      artifactId: 'deliverable-1',
      contentSha256: SHOWCASE_FIXTURE_SHA,
      schemaVersion: 'research-strategy-content-v2',
      jsonPointer: pointer,
      sourceNodeIds: [pointer],
      reviewState: 'passed' as const,
    }],
    support: {
      questionIds: ['Q1'],
      evidenceIds,
      findingIds: [],
      summaryIds: [],
      status,
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

export function showcaseMaterialFixture(): ReportEditorialMaterialV1 {
  return {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      deliverableArtifactId: 'deliverable-1',
      deliverableContentSha256: SHOWCASE_FIXTURE_SHA,
      reportReviewArtifactId: 'review-1',
    },
    document: {
      title: '研究策略报告',
      decisionContext: '决定下一阶段的产品策略。',
      executiveAnswer: '先确认状态，再推进增长。',
      deliverableType: 'research_strategy_report',
      requestedArtifactTypes: ['research_report'],
    },
    presentationUnits: [{
      id: 'answer-Q1',
      semanticKind: 'direct_answer',
      title: '当前结论',
      shape: 'record',
      leafIds: ['leaf-answer'],
      leafId: 'leaf-answer',
      fields: [{ key: 'answer', label: '答案', value: '当前状态仍需验证。' }],
    }, {
      id: 'mind-model',
      semanticKind: 'mind_model',
      title: '用户心智',
      shape: 'graph',
      leafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
      nodes: [{ id: 'n1', leafId: 'leaf-node-1', label: '支持者', description: '理解规则并判断回报。' }, {
        id: 'n2', leafId: 'leaf-node-2', label: '履约关注者', description: '查询项目结果与履约。' }],
      edges: [{ id: 'e1', leafId: 'leaf-edge', from: 'n1', to: 'n2', label: '支持后进入履约关注' }],
    }, {
      id: 'action-plan',
      semanticKind: 'action_plan',
      title: '行动路线',
      shape: 'actions',
      leafIds: ['leaf-action-p0', 'leaf-action-p1'],
      actions: [{ leafId: 'leaf-action-p0', priority: 'P0', action: '验证入口与链路' }, {
        leafId: 'leaf-action-p1', priority: 'P1', action: '治理遗留页面' }],
    }, {
      id: 'open-question',
      semanticKind: 'open_question',
      title: '待验证问题',
      shape: 'text',
      leafIds: ['leaf-question'],
      leafId: 'leaf-question',
      text: '当前是否仍有稳定入口？',
    }],
    leafTraceIndex: {
      'leaf-answer': trace('/payload/directAnswers/0', 'provisional', 0.74, ['E1-1']),
      'leaf-node-1': trace('/payload/contentBlocks/0/nodes/0', 'supported', 0.8, ['E1-1']),
      'leaf-node-2': trace('/payload/contentBlocks/0/nodes/1', 'provisional', 0.56, ['E1-3']),
      'leaf-edge': trace('/payload/contentBlocks/0/edges/0', 'provisional', 0.55, ['E1-1', 'E1-3']),
      'leaf-action-p0': trace('/payload/contentBlocks/1/actions/0', 'provisional', 0.72, ['E1-1']),
      'leaf-action-p1': trace('/payload/contentBlocks/1/actions/1', 'provisional', 0.64, ['E1-3']),
      'leaf-question': trace('/payload/openQuestions/0', 'unanswered', undefined, ['E1-3']),
    },
    constraints: {
      requiredQuestionIds: ['Q1'],
      requiredPresentationUnitIds: ['answer-Q1', 'mind-model', 'action-plan', 'open-question'],
      requiredLeafUnitIds: [
        'leaf-answer', 'leaf-node-1', 'leaf-node-2', 'leaf-edge',
        'leaf-action-p0', 'leaf-action-p1', 'leaf-question',
      ],
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: {
        'answer-Q1': ['answer', 'record-table', 'list'],
        'mind-model': ['graph', 'list'],
        'action-plan': ['priority-board', 'record-table', 'list'],
        'open-question': ['fact', 'list'],
      },
    },
  };
}

export function showcaseIntentFixture(): ReportEditorialShowcaseIntentV1 {
  return {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'decision',
      layout: 'split',
      components: [{
        kind: 'editorial-hero',
        variant: 'statement',
        emphasis: 'hero',
        span: 'full',
        unitRefs: ['answer-Q1'],
        sourceLeafIds: ['leaf-answer'],
      }],
    }, {
      purpose: 'profiles',
      layout: 'asymmetric',
      components: [{
        kind: 'profile-grid',
        variant: 'asymmetric',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['mind-model'],
        sourceLeafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
      }],
    }, {
      purpose: 'actions',
      layout: 'columns',
      components: [{
        kind: 'priority-lanes',
        variant: 'lanes',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['action-plan'],
        sourceLeafIds: ['leaf-action-p0', 'leaf-action-p1'],
      }],
    }],
  };
}

export function showcaseEvidenceManifestFixture(): EvidenceManifest {
  return {
    version: 'evidence-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    collectedAt: '2026-08-30T00:00:00.000Z',
    manifestHash: SHOWCASE_FIXTURE_SHA,
    entries: [{
      id: 'E1-1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'search',
      toolTier: 'core',
      artifactId: 'tool-1',
      artifactContentSha256: SHOWCASE_FIXTURE_SHA,
      jsonPointer: '/output/0',
      sourceUrl: 'https://example.test/evidence-1',
      sensitivity: 'public',
      redaction: 'none',
    }, {
      id: 'E1-3',
      kind: 'knowledge_excerpt',
      evidenceClass: 'knowledge',
      artifactId: 'knowledge-1',
      artifactContentSha256: SHOWCASE_FIXTURE_SHA,
      jsonPointer: '/content',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  };
}
