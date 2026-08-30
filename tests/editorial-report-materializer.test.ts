import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentReportPackageResponse, ReportReviewArtifact } from '../packages/api-contract/control-workflow.ts';
import type {
  ResearchDeliverableEnvelope,
  VisualAssetManifest,
} from '../packages/api-contract/research-deliverable.ts';
import type { ControlArtifact } from '../database/control-plane.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import {
  materializeEditorialReport,
} from '../apps/orchestrator-runtime/src/report/editorial-report-materializer.ts';
import type {
  EditorialDeliverableType,
  FrozenEditorialSource,
  Sha256,
  SourceArtifactRef,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERABLE_ID = '55555555-5555-4555-8555-555555555555';
const MANIFEST_ID = '66666666-6666-4666-8666-666666666666';
const REVIEW_ID = '77777777-7777-4777-8777-777777777777';
const EVIDENCE_ARTIFACT_ID = '88888888-8888-4888-8888-888888888888';
const HASHES = {
  package: `sha256:${'1'.repeat(64)}` as Sha256,
  deliverable: `sha256:${'2'.repeat(64)}` as Sha256,
  manifest: `sha256:${'3'.repeat(64)}` as Sha256,
  review: `sha256:${'4'.repeat(64)}` as Sha256,
  evidence: `sha256:${'5'.repeat(64)}` as Sha256,
};

function artifact(id: string, kind: string, schemaVersion: string, hash: Sha256): ControlArtifact & {
  state: 'SEALED'; contentSha256: Sha256;
} {
  return {
    id,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    kind,
    state: 'SEALED',
    storageUri: `tasks/${TASK_ID}/attempts/${ATTEMPT_ID}/${id}.json`,
    contentSha256: hash,
    byteSize: 1,
    schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
  };
}

function review(): ReportReviewArtifact & { verdict: 'pass' } {
  return {
    version: 'report-review-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableArtifactId: DELIVERABLE_ID,
    verdict: 'pass',
    revisionRound: 0,
    dimensions: [],
  };
}

function baseDeliverable(
  deliverableType: EditorialDeliverableType,
  payload: unknown,
): ResearchDeliverableEnvelope<unknown> {
  return {
    version: 'research-deliverable-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableType,
    evidenceManifestArtifactId: MANIFEST_ID,
    methodSummary: '基于已封存证据进行结构化归纳',
    findingGraph: {
      findings: [{ id: 'finding-1', kind: 'fact', statement: '已验证结论', evidenceIds: ['evidence-1'] }],
      analyses: [{ id: 'analysis-1', statement: '由事实形成分析', findingIds: ['finding-1'] }],
      subQuestionSummaries: [{ id: 'summary-1', summary: '问题结论', findingIds: ['finding-1'], analysisIds: ['analysis-1'] }],
      overallConclusions: [{ id: 'conclusion-1', statement: '总体判断', summaryIds: ['summary-1'] }],
    },
    payload,
    recommendations: [{ id: 'recommendation-1', statement: '执行建议', summaryIds: ['summary-1'] }],
    coverage: {
      questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-1'] }],
      successCriterionBindings: [{ successCriterionId: 'criterion-1', conclusionIds: ['conclusion-1'], recommendationIds: ['recommendation-1'] }],
    },
    risksAndOpenIssues: ['仍需验证边界'],
    capabilityProvenance: [],
  };
}

function source(deliverableType: EditorialDeliverableType, payload: unknown): FrozenEditorialSource {
  const sourceArtifacts: SourceArtifactRef[] = [
    { artifactId: PACKAGE_ID, kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: HASHES.package },
    { artifactId: DELIVERABLE_ID, kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated', contentSha256: HASHES.deliverable },
    { artifactId: MANIFEST_ID, kind: 'evidence_manifest', schemaVersion: 'evidence-v1', contentSha256: HASHES.manifest },
    { artifactId: REVIEW_ID, kind: 'report_review', schemaVersion: 'report-review-v1', contentSha256: HASHES.review },
    { artifactId: EVIDENCE_ARTIFACT_ID, kind: 'tool_output', schemaVersion: 'tool-output-v1', contentSha256: HASHES.evidence },
  ];
  const deliverable = baseDeliverable(deliverableType, payload);
  const evidenceManifest = {
    version: 'evidence-v1' as const,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    collectedAt: '2026-08-27T00:00:00.000Z',
    manifestHash: `sha256:${'6'.repeat(64)}`,
    entries: [{
      id: 'evidence-1',
      kind: 'tool_output' as const,
      evidenceClass: 'dataset' as const,
      artifactId: EVIDENCE_ARTIFACT_ID,
      artifactContentSha256: HASHES.evidence,
      jsonPointer: '/output/value',
      sensitivity: 'internal' as const,
      redaction: 'none' as const,
    }],
  };
  let current: Exclude<CurrentReportPackageResponse, { presentationMode: 'legacy_text' }> = {
    presentationMode: 'current_text',
    deliverable,
    evidenceManifest,
    reportReview: review(),
  };
  let presentationMode: 'current_text' | 'multimodal' = 'current_text';
  let reportDocumentArtifactId: string | undefined;
  let verifiedVisualAssets: VerifiedVisualAsset[] = [];
  if (deliverableType === 'design_audit_report') {
    const reportDocumentId = '99999999-9999-4999-8999-999999999999';
    const originalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const originalManifestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const annotationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const annotationManifestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const reportHash = `sha256:${'7'.repeat(64)}` as Sha256;
    const originalHash = `sha256:${'8'.repeat(64)}` as Sha256;
    const originalManifestHash = `sha256:${'9'.repeat(64)}` as Sha256;
    const annotationHash = `sha256:${'a'.repeat(64)}` as Sha256;
    const annotationManifestHash = `sha256:${'b'.repeat(64)}` as Sha256;
    const originalManifest: VisualAssetManifest = {
      version: 'visual-asset-manifest-v1', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, assetId: originalId, contentSha256: originalHash,
      mediaType: 'image/png', byteSize: 1, width: 1, height: 1, exportPolicy: 'allow',
      source: { kind: 'user_upload', fileName: 'before.png' }, derivedFrom: null,
      derivation: null, manifestHash: originalManifestHash,
    };
    const annotationManifest: VisualAssetManifest = {
      version: 'visual-asset-manifest-v1', taskId: TASK_ID, planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID, assetId: annotationId, contentSha256: annotationHash,
      mediaType: 'image/png', byteSize: 1, width: 1, height: 1, exportPolicy: 'allow',
      source: { kind: 'derived' },
      derivedFrom: { assetId: originalId, manifestArtifactId: originalManifestId, contentSha256: originalHash, manifestHash: originalManifestHash },
      derivation: { kind: 'annotation', overlayArtifactId: 'overlay-1' },
      manifestHash: annotationManifestHash,
    };
    const originalArtifact = artifact(originalId, 'visual_asset', 'visual-asset-v1', originalHash);
    const originalManifestArtifact = artifact(originalManifestId, 'visual_asset_manifest', 'visual-asset-manifest-v1', originalManifestHash);
    const annotationArtifact = artifact(annotationId, 'visual_asset', 'visual-asset-v1', annotationHash);
    const annotationManifestArtifact = artifact(annotationManifestId, 'visual_asset_manifest', 'visual-asset-manifest-v1', annotationManifestHash);
    const reportDocument = {
      version: 'report-document-v1' as const,
      title: '设计审计', subtitle: '已封存结果', executiveSummary: '摘要',
      sections: [{
        id: 'visual-evidence', title: '视觉证据', questionIds: [],
        blocks: [{
          id: 'design-annotation-1', type: 'image-comparison' as const,
          beforeAssetRef: { assetId: originalId, manifestArtifactId: originalManifestId },
          afterAssetRef: { assetId: annotationId, manifestArtifactId: annotationManifestId },
          caption: '入口位置', altText: 'Verified design issue annotation for i1.',
        }],
      }],
    };
    (payload as { annotatedScreenshots: Array<{ assetId: string }> }).annotatedScreenshots[0]!.assetId = annotationId;
    presentationMode = 'multimodal';
    reportDocumentArtifactId = reportDocumentId;
    sourceArtifacts.push(
      { artifactId: reportDocumentId, kind: 'report_document', schemaVersion: 'report-document-v1', contentSha256: reportHash },
      { artifactId: originalId, kind: 'visual_asset', schemaVersion: 'visual-asset-v1', contentSha256: originalHash },
      { artifactId: originalManifestId, kind: 'visual_asset_manifest', schemaVersion: 'visual-asset-manifest-v1', contentSha256: originalManifestHash },
      { artifactId: annotationId, kind: 'visual_asset', schemaVersion: 'visual-asset-v1', contentSha256: annotationHash },
      { artifactId: annotationManifestId, kind: 'visual_asset_manifest', schemaVersion: 'visual-asset-manifest-v1', contentSha256: annotationManifestHash },
    );
    verifiedVisualAssets = [
      { artifact: originalArtifact, manifestArtifact: originalManifestArtifact, bytes: Buffer.from([1]), metadata: { contentType: 'image/png', byteSize: 1, width: 1, height: 1 }, manifest: originalManifest },
      { artifact: annotationArtifact, manifestArtifact: annotationManifestArtifact, bytes: Buffer.from([2]), metadata: { contentType: 'image/png', byteSize: 1, width: 1, height: 1 }, manifest: annotationManifest },
    ];
    current = {
      presentationMode: 'multimodal', deliverable, evidenceManifest, reportReview: review(),
      reportDocument, reportDocumentContentSha256: reportHash,
      visualAssetManifests: [originalManifest, annotationManifest],
    };
  }
  return {
    binding: {
      taskId: TASK_ID,
      taskState: 'completed',
      taskStateVersion: 7,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      reportPackageArtifactId: PACKAGE_ID,
      reportPackageContentSha256: HASHES.package,
    },
    reportPackage: {
      artifact: artifact(PACKAGE_ID, 'report_package', 'report-package-v1', HASHES.package),
      value: {
        version: 'report-package-v1',
        taskId: TASK_ID,
        planVersionId: PLAN_ID,
        attemptId: ATTEMPT_ID,
        presentationMode,
        deliverableArtifactId: DELIVERABLE_ID,
        evidenceManifestArtifactId: MANIFEST_ID,
        reportReviewArtifactId: REVIEW_ID,
        ...(reportDocumentArtifactId === undefined ? {} : { reportDocumentArtifactId }),
      },
    },
    current,
    sourceArtifacts,
    sourcePolicyMetadata: sourceArtifacts.map((item) => ({
      artifactId: item.artifactId,
      contentSha256: item.contentSha256,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    })),
    verifiedVisualAssets,
  };
}

const payloads: Record<EditorialDeliverableType, unknown> = {
  research_plan: {
    title: '增长研究计划', researchGoal: '理解转化阻力',
    scope: { market: '中国', subjects: ['潜在用户'], timeWindow: '近三个月' },
    competitorSampling: { strategy: '分层抽样', targetCount: 5, inclusionCriteria: ['同类产品'], exclusionCriteria: ['已下线'] },
    researchQuestions: ['为何放弃'],
    comparisonDimensions: [{ id: 'd1', name: '信任', purpose: '识别阻力', collectionFields: ['首屏'] }],
    sourcePlan: [{ evidenceClass: 'dataset', sourceTypes: ['访谈'], purpose: '验证动机' }],
    executionPlan: [{ phase: '探索', activities: ['访谈'], duration: '一周', outputs: ['洞察'] }],
    collectionTemplate: [{ field: '阻力', description: '记录原话', evidenceRequired: true }],
    analysisMethods: ['主题分析'], deliverables: ['研究报告'], qualityChecks: ['交叉核验'],
  },
  competitive_analysis_report: {
    competitorSamples: [{ id: 's1', name: '样本 A', rationale: '代表同类路径', evidenceIds: ['evidence-1'] }],
    dimensionMatrix: [{ dimension: '信任', weight: 0.5, values: [{ sampleId: 's1', value: '信息完整', score: 4, evidenceIds: ['evidence-1'] }] }],
    differences: [{ id: 'd1', dimension: '信任', statement: '信息更透明', evidenceIds: ['evidence-1'] }],
    impacts: [{ differenceId: 'd1', audience: '首次用户', statement: '减少不确定性' }],
    actionRecommendations: [{ id: 'a1', differenceIds: ['d1'], priority: 'P0', statement: '补充关键信息' }],
    roadmap: [{ priority: 'P0', statement: '先补基础信息', metric: '完成可用性检查', validationMethod: '任务测试' }],
    instrumentationPlan: ['记录关键行为'], userTestScript: ['完成一次决策任务'],
    visualEvidence: [], screenshotComparisons: [],
  },
  voc_diagnosis_report: {
    datasets: [{ id: 'ds1', name: '客服样本', source: '脱敏工单', recordCount: 10 }],
    themes: [{ id: 't1', label: '信息不清晰', datasetIds: ['ds1'], evidenceIds: ['evidence-1'] }],
    frequencies: [{ themeId: 't1', count: 4, share: 0.4 }],
    sentiments: [{ themeId: 't1', label: 'negative', score: -0.5 }],
    representativeQuotes: [{ themeId: 't1', quote: '不知道下一步做什么', evidenceId: 'evidence-1' }],
    severities: [{ themeId: 't1', level: 'high', rationale: '阻断任务' }],
    priorities: [{ themeId: 't1', level: 'P0', rationale: '高频且严重' }],
  },
  design_audit_report: {
    pages: [{ id: 'p1', name: '详情页', state: '默认态' }],
    issues: [{ id: 'i1', pageId: 'p1', statement: '主次不清' }],
    principles: [{ issueId: 'i1', principle: '视觉层级', rationale: '操作入口竞争' }],
    severities: [{ issueId: 'i1', level: 'major', rationale: '影响完成率' }],
    annotatedScreenshots: [{ issueId: 'i1', assetId: 'asset-1', annotation: '入口位置' }],
    remediations: [{ issueId: 'i1', action: '收敛主操作', acceptanceCriteria: ['首屏唯一主按钮'] }],
    retests: [{ issueId: 'i1', method: '任务测试', expectedResult: '用户能识别主入口' }],
  },
  accessibility_audit_report: {
    platforms: [{ name: 'Web', assistiveTechnology: 'VoiceOver', browser: 'Safari' }],
    pourPrinciples: [{ issueId: 'i1', principle: 'Operable', rationale: '键盘不可达' }],
    components: [{ issueId: 'i1', component: '弹窗', selector: '#dialog' }],
    conformanceLevels: [{ issueId: 'i1', level: 'A', criterion: '键盘操作' }],
    priorities: [{ issueId: 'i1', level: 'P0', rationale: '阻断访问' }],
    screenReaderBehavior: [{ issueId: 'i1', observed: '焦点丢失', expected: '焦点进入弹窗' }],
    remediations: [{ issueId: 'i1', action: '实现焦点陷阱' }],
    verification: [{ issueId: 'i1', method: '键盘巡检', expectedResult: '焦点顺序正确' }],
  },
};

test('materialization is deterministic, preserves scalar types and emits a minimal model context', () => {
  const input = source('research_plan', payloads.research_plan);
  const before = structuredClone(input.current.deliverable);
  const first = materializeEditorialReport(input);
  const second = materializeEditorialReport(input);
  assert.deepEqual(first.materialBytes, second.materialBytes);
  assert.equal(first.materialHash, second.materialHash);
  assert.deepEqual(input.current.deliverable, before);
  const booleanUnit = first.material.units.find(({ sourceRefs }) => sourceRefs[0].jsonPointer.endsWith('/evidenceRequired'));
  assert.equal(booleanUnit?.value, true);
  const context = first.modelContextBytes.toString('utf8');
  assert.equal(context.includes(TASK_ID), false);
  assert.equal(context.includes(DELIVERABLE_ID), false);
  assert.equal(context.includes('/payload/'), false);
});

test('all five registered deliverables use explicit projectors', () => {
  const expectedPointers: Record<EditorialDeliverableType, string> = {
    research_plan: '/payload/competitorSampling/targetCount',
    competitive_analysis_report: '/payload/dimensionMatrix/0/values/0/score',
    voc_diagnosis_report: '/payload/frequencies/0/share',
    design_audit_report: '/payload/remediations/0/acceptanceCriteria/0',
    accessibility_audit_report: '/payload/verification/0/expectedResult',
  };
  for (const deliverableType of Object.keys(payloads) as EditorialDeliverableType[]) {
    const result = materializeEditorialReport(source(deliverableType, payloads[deliverableType]));
    assert.ok(result.material.units.some(({ sourceRefs }) => sourceRefs[0].jsonPointer === expectedPointers[deliverableType]), deliverableType);
    assert.ok(result.material.units.some(({ role }) => role === 'risk'), deliverableType);
  }
});

test('typed projectors preserve every required direct basis edge', () => {
  const competitive = materializeEditorialReport(source(
    'competitive_analysis_report',
    structuredClone(payloads.competitive_analysis_report),
  )).material;
  const difference = competitive.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/differences/0/statement'
  ));
  const action = competitive.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/actionRecommendations/0/statement'
  ));
  const actionPriority = competitive.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/actionRecommendations/0/priority'
  ));
  assert.ok(difference && action && actionPriority);
  assert.ok(action.basisUnitIds.includes(difference.id));
  assert.ok(actionPriority.basisUnitIds.includes(difference.id));

  const voc = materializeEditorialReport(source(
    'voc_diagnosis_report',
    structuredClone(payloads.voc_diagnosis_report),
  )).material;
  const severity = voc.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/severities/0/level'
  ));
  const priority = voc.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/priorities/0/level'
  ));
  assert.ok(severity && priority);
  assert.ok(priority.basisUnitIds.includes(severity.id));

  const design = materializeEditorialReport(source(
    'design_audit_report',
    structuredClone(payloads.design_audit_report),
  )).material;
  const designAction = design.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/remediations/0/action'
  ));
  const designCriterion = design.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/remediations/0/acceptanceCriteria/0'
  ));
  assert.ok(designAction && designCriterion);
  assert.ok(designCriterion.basisUnitIds.includes(designAction.id));

  const accessibility = materializeEditorialReport(source(
    'accessibility_audit_report',
    structuredClone(payloads.accessibility_audit_report),
  )).material;
  const observed = accessibility.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/screenReaderBehavior/0/observed'
  ));
  const expected = accessibility.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/screenReaderBehavior/0/expected'
  ));
  const a11yPriority = accessibility.units.find(({ sourceRefs }) => (
    sourceRefs[0].jsonPointer === '/payload/priorities/0/level'
  ));
  assert.ok(observed && expected && a11yPriority);
  assert.ok(expected.basisUnitIds.includes(observed.id));
  assert.ok(a11yPriority.basisUnitIds.includes(observed.id));
});

test('comparison Assets share one caption/alt pair and retain exact frozen lineage', () => {
  const input = source('design_audit_report', structuredClone(payloads.design_audit_report));
  const result = materializeEditorialReport(input);
  const before = result.material.assets.find(({ visualRole }) => visualRole === 'comparison-before');
  const after = result.material.assets.find(({ visualRole }) => visualRole === 'comparison-after');

  assert.ok(before);
  assert.ok(after);
  assert.equal(after.comparisonGroupId, before.comparisonGroupId);
  assert.equal(after.captionUnitId, before.captionUnitId);
  assert.equal(after.altTextUnitId, before.altTextUnitId);
  assert.equal(after.derivedFromAssetId, before.assetId);
  assert.equal(result.material.units.filter(({ id }) => id === before.captionUnitId).length, 1);
  assert.equal(result.material.units.filter(({ id }) => id === before.altTextUnitId).length, 1);
});

test('design payload Asset must be the annotation side of the frozen ReportDocument comparison', () => {
  const input = source('design_audit_report', structuredClone(payloads.design_audit_report));
  const payload = input.current.deliverable.payload as {
    annotatedScreenshots: Array<{ assetId: string }>;
  };
  payload.annotatedScreenshots[0]!.assetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  assert.throws(
    () => materializeEditorialReport(input),
    /EDITORIAL_RELATION_INVALID: annotatedScreenshots Asset is not the annotation side/u,
  );
});

test('comparison lineage mismatch is a hard failure even when export policy would omit the pair', () => {
  const input = source('design_audit_report', structuredClone(payloads.design_audit_report));
  const after = input.verifiedVisualAssets.find(({ manifest }) => manifest.derivedFrom !== null);
  assert.ok(after);
  after.manifest.exportPolicy = 'mask';
  after.manifest.derivedFrom!.assetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  assert.throws(
    () => materializeEditorialReport(input),
    /EDITORIAL_RELATION_INVALID: ReportDocument comparison .* lineage is invalid/u,
  );
});

test('mask, block, and SVG policies omit a comparison atomically with an explicit warning', () => {
  const cases = [
    { policy: 'mask' as const, code: 'VISUAL_MASK_OMITTED' },
    { policy: 'block' as const, code: 'VISUAL_BLOCKED_OMITTED' },
    { policy: 'svg' as const, code: 'VISUAL_SVG_OMITTED' },
  ];
  for (const item of cases) {
    const input = source('design_audit_report', structuredClone(payloads.design_audit_report));
    const before = input.verifiedVisualAssets.find(({ manifest }) => manifest.derivedFrom === null);
    assert.ok(before);
    if (item.policy === 'svg') before.manifest.mediaType = 'image/svg+xml';
    else before.manifest.exportPolicy = item.policy;

    const result = materializeEditorialReport(input);

    assert.deepEqual(result.material.assets, [], item.policy);
    assert.deepEqual(result.material.materializationWarningCodes, [item.code], item.policy);
    assert.equal(result.warnings.some(({ code }) => code === item.code), true, item.policy);
  }
});

test('blocked or sensitive evidence fails closed', () => {
  const input = source('research_plan', payloads.research_plan);
  input.current.evidenceManifest.entries[0]!.redaction = 'blocked';
  assert.throws(() => materializeEditorialReport(input), /EDITORIAL_SENSITIVE_EVIDENCE/);
});

test('Material retains only canonical credential-free public Evidence URLs', () => {
  const internal = source('research_plan', structuredClone(payloads.research_plan));
  internal.current.evidenceManifest.entries[0]!.sourceUrl = 'https://example.test/private?token=must-not-escape';
  assert.equal(materializeEditorialReport(internal).material.evidence[0]?.sourceUrl, undefined);

  const publicSource = source('research_plan', structuredClone(payloads.research_plan));
  Object.assign(publicSource.current.evidenceManifest.entries[0]!, {
    evidenceClass: 'public_source',
    sensitivity: 'public',
    sourceUrl: 'https://EXAMPLE.test/source',
  });
  assert.equal(
    materializeEditorialReport(publicSource).material.evidence[0]?.sourceUrl,
    'https://example.test/source',
  );

  const credentialed = source('research_plan', structuredClone(payloads.research_plan));
  Object.assign(credentialed.current.evidenceManifest.entries[0]!, {
    evidenceClass: 'public_source',
    sensitivity: 'public',
    sourceUrl: 'https://user:secret@example.test/source',
  });
  assert.equal(materializeEditorialReport(credentialed).material.evidence[0]?.sourceUrl, undefined);
});

test('unknown deliverable types never fall through to a generic projector', () => {
  const input = source('research_plan', payloads.research_plan);
  (input.current.deliverable as ResearchDeliverableEnvelope<unknown>).deliverableType = 'unknown_report';
  assert.throws(() => materializeEditorialReport(input), /EDITORIAL_DELIVERABLE_UNSUPPORTED/);
});
