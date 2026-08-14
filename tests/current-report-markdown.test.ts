import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type { CurrentReportPackageResponse, ReportReviewArtifact } from '../packages/api-contract/control-workflow.ts';
import type {
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../packages/api-contract/research-deliverable.ts';

type CurrentResearchPlanResponse = CurrentReportPackageResponse<ResearchPlanPayload> & {
  evidenceManifest: CurrentReportPackageResponse<ResearchPlanPayload>['evidenceManifest'] & {
    storageUri: string;
    contentSha256: string;
  };
};
type LegacyCurrentResearchPlanResponse = Extract<
  CurrentResearchPlanResponse,
  { presentationMode: 'legacy_text' }
>;

interface CurrentReportMarkdownModule {
  currentResearchPlanToMarkdown(response: CurrentResearchPlanResponse): string;
}

const currentReportMarkdownModulePath: string = '../apps/web/src/current-report-markdown.ts';
const currentReportMarkdownModuleFile = new URL(currentReportMarkdownModulePath, import.meta.url);

async function loadCurrentReportMarkdownModule(): Promise<CurrentReportMarkdownModule> {
  assert.equal(
    existsSync(currentReportMarkdownModuleFile),
    true,
    'Current research plan Markdown module must exist',
  );
  // Keep the planned module path non-literal so the existence assertion is the intentional RED.
  const moduleExports = await import(currentReportMarkdownModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.currentResearchPlanToMarkdown, 'function');
  return moduleExports as unknown as CurrentReportMarkdownModule;
}

const sourceUrl = 'https://research.example.test/sources/pet-food-market';
const manifestArtifactId = 'internal-artifact-evidence-manifest-1';
const evidenceArtifactId = 'internal-artifact-public-source-1';
const manifestContentSha256 = `sha256:${'a'.repeat(64)}`;
const evidenceContentSha256 = `sha256:${'b'.repeat(64)}`;
const manifestHash = `sha256:${'c'.repeat(64)}`;
const storageUri = '/private/research/tasks/task-current-report/evidence-manifest.json';

function buildResponse(
  risksAndOpenIssues: string[] = [
    '公开页面内容可能随时间变化',
    '长尾品牌公开资料存在覆盖缺口',
  ],
): LegacyCurrentResearchPlanResponse {
  const payload: ResearchPlanPayload = {
    title: '宠物辅食竞品研究计划',
    researchGoal: '识别宠物辅食市场主要竞品的产品、价格与渠道差异',
    scope: {
      market: '中国大陆宠物辅食市场',
      subjects: ['犬用辅食', '猫用辅食'],
      timeWindow: '最近十二个月',
    },
    competitorSampling: {
      strategy: '按市场影响力与产品覆盖度分层抽样',
      targetCount: 6,
      inclusionCriteria: ['公开渠道可获取产品、价格与品牌信息'],
      exclusionCriteria: ['已停止销售且无可核验公开资料'],
    },
    researchQuestions: [
      '主要竞品如何定位目标宠物与消费场景？',
      '竞品在价格带与销售渠道上有何差异？',
    ],
    comparisonDimensions: [{
      id: 'product-positioning',
      name: '产品定位',
      purpose: '比较目标宠物、消费场景与核心卖点',
      collectionFields: ['目标宠物', '消费场景', '核心卖点'],
    }],
    sourcePlan: [{
      evidenceClass: 'public_source',
      sourceTypes: ['品牌官网', '电商商品页'],
      purpose: '核验产品信息、价格与品牌定位',
    }],
    executionPlan: [{
      phase: '竞品信息采集',
      activities: ['检索并记录入样品牌的公开资料'],
      duration: '2 个工作日',
      outputs: ['竞品信息采集表'],
    }],
    collectionTemplate: [{
      field: '核心卖点原文',
      description: '品牌对产品价值的公开表述',
      evidenceRequired: true,
    }],
    analysisMethods: ['横向维度对比'],
    deliverables: ['竞品研究报告', '证据索引表'],
    qualityChecks: ['每项事实均关联可追溯公开来源', '推断与事实分开展示'],
  };

  const deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload> = {
    version: 'research-deliverable-v1',
    taskId: 'task-current-report',
    planVersionId: 'plan-current-report-v1',
    attemptId: 'attempt-current-report-1',
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: manifestArtifactId,
    methodSummary: '检索公开产品页并按预设维度归纳证据',
    findingGraph: {
      findings: [
        {
          id: 'F1',
          kind: 'fact',
          evidenceIds: ['E1'],
          statement: '公开产品页显示主要品牌均强调适口性与营养补充',
        },
        {
          id: 'F2',
          kind: 'inference',
          findingIds: ['F1'],
          statement: '适口性可能是该市场的基础竞争门槛',
        },
      ],
      analyses: [{
        id: 'A1',
        findingIds: ['F1', 'F2'],
        statement: '事实与推断共同支持产品定位维度的后续比较',
      }],
      subQuestionSummaries: [{
        id: 'S1',
        findingIds: ['F1', 'F2'],
        analysisIds: ['A1'],
        summary: '公开资料支持以适口性和营养价值为核心比较轴',
      }],
      overallConclusions: [{
        id: 'C1',
        summaryIds: ['S1'],
        statement: '研究执行应优先核验品牌定位与核心卖点',
      }],
    },
    payload,
    recommendations: [{
      id: 'R1',
      summaryIds: ['S1'],
      statement: '按产品定位维度继续采集六个样本的可追溯公开信息',
    }],
    coverage: {
      questionBindings: [{ questionId: 'question-positioning', summaryIds: ['S1'] }],
      successCriterionBindings: [{
        successCriterionId: 'criterion-traceable',
        conclusionIds: ['C1'],
        recommendationIds: ['R1'],
      }],
    },
    risksAndOpenIssues,
    capabilityProvenance: [
      { id: 'tavily-web-search', type: 'tool' },
      { id: 'pinned-research-model', type: 'llm' },
    ],
  };

  const evidenceManifest: CurrentResearchPlanResponse['evidenceManifest'] = {
    version: 'evidence-v1',
    taskId: deliverable.taskId,
    planVersionId: deliverable.planVersionId,
    attemptId: deliverable.attemptId,
    collectedAt: '2026-08-11T00:00:00.000Z',
    manifestHash,
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'tavily-web-search',
      toolTier: 'core',
      artifactId: evidenceArtifactId,
      artifactContentSha256: evidenceContentSha256,
      jsonPointer: '/output/results/0',
      sourceUrl,
      stepNo: 1,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: `sha256:${'d'.repeat(64)}`,
      },
      sensitivity: 'public',
      redaction: 'none',
    }],
    storageUri,
    contentSha256: manifestContentSha256,
  };

  return { presentationMode: 'legacy_text', deliverable, evidenceManifest };
}

function buildCurrentResponse(): Extract<CurrentResearchPlanResponse, { presentationMode: 'current_text' }> {
  const legacy = buildResponse();
  const reportReview: ReportReviewArtifact & { verdict: 'pass' } = {
    version: 'report-review-v1',
    taskId: legacy.deliverable.taskId,
    planVersionId: legacy.deliverable.planVersionId,
    attemptId: legacy.deliverable.attemptId,
    deliverableArtifactId: 'deliverable-current-report-1',
    verdict: 'pass',
    dimensions: [
      'requirement_coverage',
      'question_coverage',
      'evidence_coverage',
      'reasoning_quality',
      'recommendation_quality',
      'visual_quality',
      'risk_disclosure',
    ].map((id) => ({ id, passed: true, issues: [] })) as ReportReviewArtifact['dimensions'],
    revisionRound: 0,
  };
  return {
    ...legacy,
    presentationMode: 'current_text',
    deliverable: legacy.deliverable as ResearchDeliverableEnvelope<ResearchPlanPayload>,
    reportReview,
  };
}

function assertIncludes(markdown: string, expected: string, label: string): void {
  assert.ok(markdown.includes(expected), `${label} must be rendered`);
}

function assertLineIncludes(markdown: string, expected: string[], label: string): void {
  const line = markdown.split('\n').find((candidate) => (
    expected.every((value) => candidate.includes(value))
  ));
  assert.ok(line, `${label} must render ${expected.join(', ')} on one line`);
}

function assertAppearsInOrder(markdown: string, expected: string[]): void {
  let cursor = -1;
  for (const value of expected) {
    const index = markdown.indexOf(value, cursor + 1);
    assert.ok(index > cursor, `${value} must appear after the preceding FindingGraph node`);
    cursor = index;
  }
}

test('currentResearchPlanToMarkdown renders the complete current research plan with public evidence', async () => {
  const { currentResearchPlanToMarkdown } = await loadCurrentReportMarkdownModule();
  const markdown = currentResearchPlanToMarkdown(buildResponse());

  assertIncludes(markdown, '宠物辅食竞品研究计划', 'title');
  assertIncludes(markdown, '识别宠物辅食市场主要竞品的产品、价格与渠道差异', 'research goal');
  assertIncludes(markdown, '中国大陆宠物辅食市场', 'scope market');
  assertIncludes(markdown, '犬用辅食', 'scope subject');
  assertIncludes(markdown, '猫用辅食', 'scope subject');
  assertIncludes(markdown, '最近十二个月', 'scope time window');
  assert.match(markdown, /(?:目标样本数|样本数|目标数量)[^\n]*6/u, 'target sample count must be rendered');
  assertIncludes(markdown, '按市场影响力与产品覆盖度分层抽样', 'sampling strategy');
  assertIncludes(markdown, '公开渠道可获取产品、价格与品牌信息', 'inclusion criterion');
  assertIncludes(markdown, '已停止销售且无可核验公开资料', 'exclusion criterion');
  assertIncludes(markdown, '主要竞品如何定位目标宠物与消费场景？', 'research question');
  assertIncludes(markdown, '产品定位', 'comparison dimension');
  assertIncludes(markdown, '目标宠物', 'comparison collection field');
  assertIncludes(markdown, '核心卖点原文', 'collection template field');
  assertIncludes(markdown, '品牌对产品价值的公开表述', 'collection template description');
  assertIncludes(markdown, '品牌官网', 'source plan');
  assertIncludes(markdown, '核验产品信息、价格与品牌定位', 'source purpose');
  assertIncludes(markdown, '竞品信息采集', 'execution phase');
  assertIncludes(markdown, '2 个工作日', 'execution duration');
  assertIncludes(markdown, '竞品信息采集表', 'execution output');
  assertIncludes(markdown, '横向维度对比', 'analysis method');
  assertIncludes(markdown, '竞品研究报告', 'deliverable');
  assertIncludes(markdown, '每项事实均关联可追溯公开来源', 'quality check');
  assert.match(
    markdown,
    /公开产品页显示主要品牌均强调适口性与营养补充[^\n]*\[E1\]/u,
    'finding must cite its evidence ID',
  );
  assertLineIncludes(
    markdown,
    ['[F1]', '公开产品页显示主要品牌均强调适口性与营养补充', '[E1]'],
    'fact node',
  );
  assertLineIncludes(
    markdown,
    ['[F2]', '适口性可能是该市场的基础竞争门槛', '[F1]'],
    'inference node',
  );
  assertLineIncludes(
    markdown,
    ['[A1]', '事实与推断共同支持产品定位维度的后续比较', '[F1]', '[F2]'],
    'analysis node',
  );
  assertLineIncludes(
    markdown,
    ['[S1]', '公开资料支持以适口性和营养价值为核心比较轴', '[F1]', '[F2]', '[A1]'],
    'sub-question summary node',
  );
  assertLineIncludes(
    markdown,
    ['[C1]', '研究执行应优先核验品牌定位与核心卖点', '[S1]'],
    'overall conclusion node',
  );
  assertAppearsInOrder(markdown, ['[F1]', '[F2]', '[A1]', '[S1]', '[C1]']);
  assertIncludes(markdown, `[${sourceUrl}](${sourceUrl})`, 'clickable public source URL');
  assertIncludes(markdown, '按产品定位维度继续采集六个样本的可追溯公开信息', 'recommendation');
  assertLineIncludes(
    markdown,
    ['按产品定位维度继续采集六个样本的可追溯公开信息', '[S1]'],
    'recommendation summary reference',
  );
  assertIncludes(markdown, '公开页面内容可能随时间变化', 'risk');
  assertIncludes(markdown, '长尾品牌公开资料存在覆盖缺口', 'gap');
  assertIncludes(markdown, 'tavily-web-search', 'tool capability provenance');
  assertIncludes(markdown, 'pinned-research-model', 'model capability provenance');

  assert.doesNotMatch(markdown, /storageUri/u);
  assert.doesNotMatch(markdown, /contentSha256/u);
  assert.ok(!markdown.includes(storageUri), 'storage URI must not leak');
  assert.ok(!markdown.includes(manifestContentSha256), 'manifest content hash must not leak');
  assert.ok(!markdown.includes(evidenceContentSha256), 'evidence content hash must not leak');
  assert.ok(!markdown.includes(manifestHash), 'manifest hash must not leak');
  assert.ok(!markdown.includes(manifestArtifactId), 'manifest artifact ID must not leak');
  assert.ok(!markdown.includes(evidenceArtifactId), 'evidence artifact ID must not leak');
  assert.match(markdown, /\[E1\]/u, 'public Evidence ID may be rendered');
});

test('currentResearchPlanToMarkdown renders a pass-reviewed current_text package', async () => {
  const { currentResearchPlanToMarkdown } = await loadCurrentReportMarkdownModule();
  const markdown = currentResearchPlanToMarkdown(buildCurrentResponse());

  assertIncludes(markdown, '宠物辅食竞品研究计划', 'current report title');
});

test('currentResearchPlanToMarkdown rejects multimodal until the Phase 5 renderer exists', async () => {
  const { currentResearchPlanToMarkdown } = await loadCurrentReportMarkdownModule();
  const multimodal = {
    ...buildCurrentResponse(),
    presentationMode: 'multimodal',
  } as CurrentResearchPlanResponse;

  assert.throws(
    () => currentResearchPlanToMarkdown(multimodal),
    /multimodal|phase 5|renderer/i,
  );
});

test('currentResearchPlanToMarkdown omits the risk heading when risks are empty', async () => {
  const { currentResearchPlanToMarkdown } = await loadCurrentReportMarkdownModule();
  const markdown = currentResearchPlanToMarkdown(buildResponse([]));

  assert.doesNotMatch(markdown, /^#{1,6}\s+.*(?:风险|risks?).*$/imu);
});

test('currentResearchPlanToMarkdown rejects a recommendation with a dangling summary reference', async () => {
  const { currentResearchPlanToMarkdown } = await loadCurrentReportMarkdownModule();
  const response = buildResponse();
  response.deliverable.recommendations[0]!.summaryIds = ['S404'];

  assert.throws(
    () => currentResearchPlanToMarkdown(response),
    /S404.*summary|summary.*S404/i,
  );
});
