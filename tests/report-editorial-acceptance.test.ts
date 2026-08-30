import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  ControlArtifact,
  ControlTaskDetail,
} from '../database/control-plane.ts';
import {
  REPORT_REVIEW_DIMENSION_IDS,
  REPORT_REVIEW_V2_DIMENSION_IDS,
  type PassedReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
} from '../packages/api-contract/report-editorial.ts';
import type { ReportEditorialIntentV2 } from '../packages/api-contract/report-editorial-showcase.ts';
import type {
  ContributionLedgerV1,
  EvidenceManifest,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import { EvidenceService } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  buildResearchPlanEditorialMaterialV1,
  buildResearchStrategyEditorialMaterialV1,
} from '../apps/orchestrator-runtime/src/report/report-editorial-material-builder.ts';
import { deriveEditorialPlacementPolicy } from '../apps/orchestrator-runtime/src/report/report-editorial-placement-policy.ts';
import { ReportEditorialPlanner } from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  ModelCallRecordInput,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import {
  reportEditorialAcceptanceCliResult,
  ReportEditorialAcceptanceGateError,
  runReportEditorialAcceptance,
} from '../scripts/report-editorial-acceptance.ts';
import {
  researchStrategyCoverageV2,
  researchStrategyFindingGraphV2,
  researchStrategyPayloadV2,
} from './fixtures/research-strategy-v2.ts';

const TASK_ID = 'task-1';
const PLAN_ID = 'plan-1';
const ATTEMPT_ID = 'attempt-1';

function emptyIntent(): ReportEditorialIntentV1 {
  return {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [],
    copyFragments: [],
  };
}

function showcaseIntent(material: ReportEditorialMaterialV1): ReportEditorialIntentV2 {
  const policy = deriveEditorialPlacementPolicy(material);
  const supportingIds = new Set(policy.systemSupportingUnitIds);
  const primaryUnits = material.presentationUnits.filter(({ id }) => !supportingIds.has(id));
  const supportingUnits = material.presentationUnits.filter(({ id }) => supportingIds.has(id));
  const component = (units: typeof material.presentationUnits) => ({
    kind: 'narrative-list' as const,
    variant: 'list' as const,
    emphasis: 'primary' as const,
    span: 'full' as const,
    unitRefs: units.map(({ id }) => id),
    sourceLeafIds: [...new Set(units.flatMap(({ leafIds }) => leafIds))],
  });
  return {
    version: 'report-editorial-intent-v2',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [],
    copyFragments: [],
    showcase: {
      profileId: 'editorial-showcase-v1',
      sections: [
        {
          purpose: 'decision',
          layout: 'single',
          components: [component(primaryUnits)],
        },
        ...(supportingUnits.length > 0 ? [{
          purpose: 'evidence' as const,
          layout: 'single' as const,
          components: [{ ...component(supportingUnits), emphasis: 'secondary' as const }],
        }] : []),
      ],
    },
  };
}

function hash(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  storageUri: string;
  bytes: Buffer;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    kind: input.kind,
    state: 'SEALED',
    storageUri: input.storageUri,
    contentSha256: hash(input.bytes),
    byteSize: input.bytes.byteLength,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
  };
}

class FixtureArtifactAccess {
  constructor(readonly rows: ControlArtifact[]) {}

  async listArtifactsByStorageUri(storageUri: string): Promise<ControlArtifact[]> {
    return this.rows.filter((row) => row.storageUri === storageUri);
  }

  async getTaskDetail(taskId: string): Promise<ControlTaskDetail | null> {
    if (taskId !== TASK_ID) return null;
    return {
      id: TASK_ID,
      conversationId: 'conversation-1',
      originalInput: 'fixture',
      ownerUserId: 'owner-1',
      conversationOwnerUserId: 'owner-1',
      structuredTask: {
        version: 'research-task-v2',
        sensitivity: 'public',
        pii_detected: false,
      },
      state: 'completed',
      stateVersion: 1,
      activePlanVersionId: PLAN_ID,
      currentAttemptId: ATTEMPT_ID,
      activeRequirementVersionId: null,
    };
  }

  async readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    const stored = this.rows.find(({ id }) => id === artifactId);
    if (!stored || stored.state !== 'SEALED') throw new Error(`Artifact ${artifactId} is not SEALED`);
    const bytes = await readFile(stored.storageUri);
    if (bytes.byteLength !== stored.byteSize || hash(bytes) !== stored.contentSha256) {
      throw new Error(`Artifact ${artifactId} hash mismatch`);
    }
    return { artifact: stored, value: JSON.parse(bytes.toString('utf8')) as T };
  }
}

class TestReceiptRecorder {
  readonly calls: ModelCallRecordInput[] = [];

  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    this.calls.push(input);
    return 'acceptance-test-receipt';
  }
}

class CountingBlueprintLlm implements LLMClient {
  calls = 0;
  lastSchemaName: string | undefined;
  readonly identity: LLMProviderIdentity;

  constructor(
    private readonly blueprint: unknown,
    mode: 'real' | 'mock' = 'real',
  ) {
    this.identity = {
      provider: mode === 'real' ? 'acceptance_test' : 'acceptance_fixture',
      endpointHost: 'local',
      requestedModel: 'editorial-test-model',
      mode,
      eligibleAsReal: mode === 'real',
    };
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls += 1;
    this.lastSchemaName = options.schemaName;
    const data = this.blueprint;
    return {
      data: structuredClone(data) as T,
      promptHash: hash('acceptance-test'),
      modelName: this.identity.requestedModel,
      modelVersion: 'test-v1',
      traceId: 'acceptance-test',
      tokens: { prompt: 10, completion: 5, total: 15 },
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('not used');
  }
}

interface Fixture {
  root: string;
  attemptDir: string;
  outputDir: string;
  access: FixtureArtifactAccess;
  deliverable: ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2>;
  review: PassedReportReviewArtifact;
  ledger: ContributionLedgerV1;
  evidenceManifest: EvidenceManifest;
}

interface ResearchPlanFixture {
  root: string;
  attemptDir: string;
  outputDir: string;
  access: FixtureArtifactAccess;
  deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload>;
  review: PassedReportReviewArtifact;
  evidenceManifest: EvidenceManifest;
}

async function writeArtifact(
  path: string,
  value: unknown,
  metadata: Omit<Parameters<typeof artifact>[0], 'storageUri' | 'bytes'>,
): Promise<ControlArtifact> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  await writeFile(path, bytes);
  return artifact({ ...metadata, storageUri: path, bytes });
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'editorial-acceptance-')));
  const attemptDir = join(root, 'current-control', 'tasks', TASK_ID, 'attempts', ATTEMPT_ID);
  await mkdir(join(attemptDir, 'deliverables'), { recursive: true });
  await mkdir(join(attemptDir, 'reports'), { recursive: true });
  await mkdir(join(attemptDir, 'evidence'), { recursive: true });
  await mkdir(join(attemptDir, 'steps'), { recursive: true });

  const deliverable: ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2> = {
    version: 'research-deliverable-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableType: 'research_strategy_report',
    evidenceManifestArtifactId: 'evidence-1',
    methodSummary: 'Reviewed synthesis.',
    findingGraph: researchStrategyFindingGraphV2(),
    payload: researchStrategyPayloadV2(),
    recommendations: [{
      id: 'recommendation-Q1',
      summaryIds: ['summary-Q1'],
      statement: 'Ship a trust card.',
    }],
    coverage: researchStrategyCoverageV2(),
    risksAndOpenIssues: [],
    capabilityProvenance: [],
  };
  const review: PassedReportReviewArtifact = {
    version: 'report-review-v2',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableArtifactId: 'deliverable-1',
    verdict: 'pass',
    dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
  const ledger: ContributionLedgerV1 = {
    version: 'contribution-ledger-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    entries: [{
      contributionArtifactId: 'contribution-1',
      invocationId: 'invocation-1',
      sourceUnitKey: 'unit-1',
      sourceSemanticHash: `sha256:${'f'.repeat(64)}`,
      disposition: 'included',
      canonicalNodeIds: ['content-block-001'],
      reviewIssueIds: [],
    }],
  };
  const evidenceValue = { output: { items: [{ statement: 'Verified source information is a decision signal.' }] } };
  const evidenceArtifact = await writeArtifact(
    join(attemptDir, 'steps', '1-tool_output.json'),
    evidenceValue,
    {
      id: 'evidence-source-1',
      kind: 'tool_output',
      schemaVersion: 'tool-output-v1',
    },
  );
  const evidenceManifest = new EvidenceService().createManifest({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: evidenceArtifact.id,
      artifactContentSha256: evidenceArtifact.contentSha256!,
      jsonPointer: '/output/items/0',
      sourceUrl: 'https://example.test/pet-food',
      sensitivity: 'public',
      redaction: 'none',
    }],
  }, {
    resolveArtifact: (artifactId) => artifactId === evidenceArtifact.id
      ? {
          artifact: {
            id: evidenceArtifact.id,
            contentSha256: evidenceArtifact.contentSha256!,
          },
          value: evidenceValue,
        }
      : null,
  });
  const rows = await Promise.all([
    writeArtifact(join(attemptDir, 'deliverables', 'final-r0.json'), deliverable, {
      id: 'deliverable-1',
      kind: 'deliverable',
      schemaVersion: 'research-deliverable-v1-review-gated',
    }),
    writeArtifact(join(attemptDir, 'reports', 'review-r0.json'), review, {
      id: 'review-1',
      kind: 'report_review',
      schemaVersion: 'report-review-v2',
    }),
    writeArtifact(join(attemptDir, 'deliverables', 'contribution-ledger-r0.json'), ledger, {
      id: 'ledger-1',
      kind: 'contribution_ledger',
      schemaVersion: 'contribution-ledger-v1',
    }),
    writeArtifact(join(attemptDir, 'evidence', 'manifest.json'), evidenceManifest, {
      id: 'evidence-1',
      kind: 'evidence_manifest',
      schemaVersion: 'evidence-v1',
    }),
  ]);
  rows.push(evidenceArtifact);
  return {
    root,
    attemptDir,
    outputDir: join(root, 'acceptance-output'),
    access: new FixtureArtifactAccess(rows),
    deliverable,
    review,
    ledger,
    evidenceManifest,
  };
}

async function createResearchPlanFixture(): Promise<ResearchPlanFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'editorial-plan-acceptance-')));
  const attemptDir = join(root, 'current-control', 'tasks', TASK_ID, 'attempts', ATTEMPT_ID);
  await mkdir(join(attemptDir, 'deliverables'), { recursive: true });
  await mkdir(join(attemptDir, 'reports'), { recursive: true });
  await mkdir(join(attemptDir, 'evidence'), { recursive: true });
  await mkdir(join(attemptDir, 'steps'), { recursive: true });

  const payload: ResearchPlanPayload = {
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
      inclusionCriteria: ['存在可核验商品页'],
      exclusionCriteria: ['已停止销售'],
    },
    researchQuestions: ['内容触达与货架转化如何协同？'],
    comparisonDimensions: [{
      id: 'promotion-chain',
      name: '推广链路',
      purpose: '比较内容、搜索与交易承接',
      collectionFields: ['内容主题', '搜索承接', '交易机制'],
    }],
    sourcePlan: [{
      evidenceClass: 'public_source',
      sourceTypes: ['品牌官网', '电商商品页'],
      purpose: '核验公开主张与货架信息',
    }],
    executionPlan: [{
      phase: '范围收敛',
      activities: ['确认样本与比较维度'],
      duration: '1 个工作日',
      outputs: ['样本清单'],
    }, {
      phase: '证据采集',
      activities: ['采集公开页面并记录证据'],
      duration: '2 个工作日',
      outputs: ['证据索引'],
    }],
    collectionTemplate: [{
      field: '核心卖点原文',
      description: '商品页公开价值主张',
      evidenceRequired: true,
    }],
    analysisMethods: ['横向维度对比'],
    deliverables: ['推广研究报告'],
    qualityChecks: ['每项事实绑定可追溯来源'],
  };
  const deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload> = {
    version: 'research-deliverable-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: 'evidence-plan-manifest',
    methodSummary: '公开来源核验与结构化对比。',
    findingGraph: {
      findings: [{
        id: 'finding-plan-1',
        kind: 'fact',
        statement: '品牌商品页同时承担信息解释与转化承接。',
        evidenceIds: ['E1'],
      }],
      analyses: [{
        id: 'analysis-plan-1',
        statement: '研究需要覆盖内容到交易的完整链路。',
        findingIds: ['finding-plan-1'],
      }],
      subQuestionSummaries: [{
        id: 'summary-plan-1',
        summary: '推广链路需要联合观察。',
        findingIds: ['finding-plan-1'],
        analysisIds: ['analysis-plan-1'],
      }],
      overallConclusions: [{
        id: 'conclusion-plan-1',
        statement: '先收敛样本，再开展完整链路研究。',
        summaryIds: ['summary-plan-1'],
      }],
    },
    payload,
    recommendations: [{
      id: 'recommendation-plan-1',
      statement: '先执行代表品牌小样本验证。',
      summaryIds: ['summary-plan-1'],
    }],
    coverage: {
      questionBindings: [{ questionId: 'Q1', summaryIds: ['summary-plan-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'SC1',
        conclusionIds: ['conclusion-plan-1'],
        recommendationIds: ['recommendation-plan-1'],
      }],
    },
    risksAndOpenIssues: ['公开页面可能随时间变化。'],
    capabilityProvenance: [],
  };
  const review: PassedReportReviewArtifact = {
    version: 'report-review-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableArtifactId: 'deliverable-plan-1',
    verdict: 'pass',
    dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
  };
  const evidenceOutput = {
    items: [{
      statement: '商品页承担解释与转化承接。',
      url: 'https://example.test/pet-food-plan',
    }],
  };
  const evidenceValue = {
    output: evidenceOutput,
    redactedOutputHash: hash(JSON.stringify(evidenceOutput)),
  };
  const evidenceArtifact = await writeArtifact(
    join(attemptDir, 'steps', '1-tool_output.json'),
    evidenceValue,
    {
      id: 'evidence-source-plan-1',
      kind: 'tool_output',
      schemaVersion: 'tool-output-v1',
    },
  );
  const evidenceManifest = new EvidenceService().createManifest({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      artifactId: evidenceArtifact.id,
      artifactContentSha256: evidenceArtifact.contentSha256!,
      jsonPointer: '/output/items/0',
      sourceUrl: 'https://example.test/pet-food-plan',
      toolId: 'fixture-public-source',
      toolTier: 'core',
      toolProof: {
        implementationId: 'fixture-public-source-v1',
        executionMode: 'real',
        redactedOutputHash: hash(JSON.stringify(evidenceOutput)),
      },
      sensitivity: 'public',
      redaction: 'none',
    }],
  }, {
    resolveArtifact: (artifactId) => artifactId === evidenceArtifact.id
      ? {
          artifact: { id: evidenceArtifact.id, contentSha256: evidenceArtifact.contentSha256! },
          value: evidenceValue,
        }
      : null,
  });
  const rows = await Promise.all([
    writeArtifact(join(attemptDir, 'deliverables', 'final-r0.json'), deliverable, {
      id: 'deliverable-plan-1',
      kind: 'deliverable',
      schemaVersion: 'research-deliverable-v1-review-gated',
    }),
    writeArtifact(join(attemptDir, 'reports', 'review-r0.json'), review, {
      id: 'review-plan-1',
      kind: 'report_review',
      schemaVersion: 'report-review-v1',
    }),
    writeArtifact(join(attemptDir, 'evidence', 'manifest.json'), evidenceManifest, {
      id: 'evidence-plan-manifest',
      kind: 'evidence_manifest',
      schemaVersion: 'evidence-v1',
    }),
  ]);
  rows.push(evidenceArtifact);
  return {
    root,
    attemptDir,
    outputDir: join(root, 'acceptance-output'),
    access: new FixtureArtifactAccess(rows),
    deliverable,
    review,
    evidenceManifest,
  };
}

async function sourceBytes(fixture: Fixture): Promise<Buffer[]> {
  return Promise.all([
    readFile(join(fixture.attemptDir, 'deliverables', 'final-r0.json')),
    readFile(join(fixture.attemptDir, 'reports', 'review-r0.json')),
    readFile(join(fixture.attemptDir, 'deliverables', 'contribution-ledger-r0.json')),
    readFile(join(fixture.attemptDir, 'evidence', 'manifest.json')),
    readFile(join(fixture.attemptDir, 'steps', '1-tool_output.json')),
  ]);
}

function createPlanner(
  fixture: Fixture,
  blueprint?: unknown,
  providerMode: 'real' | 'mock' = 'real',
): {
  planner: ReportEditorialPlanner;
  llm: CountingBlueprintLlm;
  receipts: TestReceiptRecorder;
} {
  const [deliverableArtifact, reviewArtifact] = fixture.access.rows;
  const material = buildResearchStrategyEditorialMaterialV1({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    requiredQuestionIds: ['Q1'],
    deliverable: { artifact: deliverableArtifact!, value: fixture.deliverable },
    review: { artifact: reviewArtifact!, value: fixture.review },
  });
  const llm = new CountingBlueprintLlm(
    blueprint ?? emptyIntent(),
    providerMode,
  );
  const receipts = new TestReceiptRecorder();
  return {
    planner: new ReportEditorialPlanner({ llm: new ReceiptLLMClient(llm, receipts) }),
    llm,
    receipts,
  };
}

function createResearchPlanPlanner(fixture: ResearchPlanFixture): {
  planner: ReportEditorialPlanner;
  llm: CountingBlueprintLlm;
  receipts: TestReceiptRecorder;
} {
  const [deliverableArtifact, reviewArtifact] = fixture.access.rows;
  const material = buildResearchPlanEditorialMaterialV1({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    requiredQuestionIds: ['Q1'],
    deliverable: { artifact: deliverableArtifact!, value: fixture.deliverable },
    review: { artifact: reviewArtifact!, value: fixture.review },
  });
  const llm = new CountingBlueprintLlm(emptyIntent());
  const receipts = new TestReceiptRecorder();
  return {
    planner: new ReportEditorialPlanner({ llm: new ReceiptLLMClient(llm, receipts) }),
    llm,
    receipts,
  };
}

function uncalledTelemetry(llm: CountingBlueprintLlm) {
  return {
    structuredCallCount: llm.calls,
    receiptCount: 0,
    candidateCaptured: false,
    provider: llm.identity.provider,
    providerMode: llm.identity.mode,
    requestedModel: llm.identity.requestedModel,
  };
}

test('acceptance run calls the Planner once, preserves source files, and writes an independent HTML report', async () => {
  const fixture = await createFixture();
  try {
    const before = await sourceBytes(fixture);
    const { planner, llm, receipts } = createPlanner(fixture);
    const summary = await runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: fixture.outputDir,
      expectedModel: llm.identity.requestedModel,
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => ({
        structuredCallCount: llm.calls,
        receiptCount: receipts.calls.length,
        candidateCaptured: true,
        provider: llm.identity.provider,
        providerMode: llm.identity.mode,
        requestedModel: llm.identity.requestedModel,
        actualModel: llm.identity.requestedModel,
        receipt: {
          id: 'acceptance-test-receipt',
          stage: receipts.calls[0]?.stage ?? 'missing',
          status: receipts.calls[0]?.status ?? 'failed',
          provider: receipts.calls[0]?.provider ?? 'missing',
          requestedModel: receipts.calls[0]?.requestedModel ?? 'missing',
          actualModel: receipts.calls[0]?.actualModel ?? 'missing',
          promptHash: receipts.calls[0]?.promptHash ?? 'missing',
        },
      }),
    });

    assert.equal(llm.calls, 1);
    assert.equal(receipts.calls.length, 1);
    assert.equal(summary.planner.invocationCount, 1);
    assert.equal(summary.planner.structuredModelCallCount, 1);
    assert.equal(summary.planner.resultMode, 'model');
    assert.equal(summary.planner.selectedBlueprint.source, 'model');
    assert.equal(summary.runKind, 'model_acceptance');
    assert.equal(summary.modelAcceptanceEligible, true);
    assert.equal(summary.planner.receipt?.status, 'succeeded');
    assert.equal(summary.deterministicComparison.presentationUnits.equal, true);
    assert.equal(summary.deterministicComparison.leafUnits.equal, true);
    assert.equal(summary.deterministicComparison.auditRecords.equal, true);
    assert.equal(summary.deterministicComparison.traceByLeafId.modelMatchesMaterial, true);
    assert.equal(summary.deterministicComparison.actionPriorities.modelMatchesMaterial, true);
    assert.equal(summary.sourceArtifacts.evidenceManifest.id, 'evidence-1');
    assert.deepEqual(
      summary.sourceArtifacts.referencedEvidenceArtifacts.map(({ id }) => id),
      ['evidence-source-1'],
    );
    assert.deepEqual(await sourceBytes(fixture), before);

    for (const name of [
      'selected-blueprint.json',
      'deterministic-blueprint.json',
      'report-document.json',
      'deterministic-report-document.json',
      'render-manifest.json',
      'report.html',
      'acceptance-summary.json',
    ]) {
      assert.equal((await readFile(join(fixture.outputDir, name))).byteLength > 0, true, name);
    }
    const report = JSON.parse(
      await readFile(join(fixture.outputDir, 'report-document.json'), 'utf8'),
    ) as { copyMode: string; notices: Array<{ code: string }> };
    assert.equal(report.copyMode, 'fallback');
    assert.equal(report.notices.filter(({ code }) => code === 'copy_fallback').length, 1);
    const html = await readFile(join(fixture.outputDir, 'report.html'), 'utf8');
    assert.match(html, /<!doctype html>/u);
    assert.match(html, /Content-Security-Policy/u);
    assert.match(html, /编辑文案缺失或未通过校验的部分已使用受审原文/u);
    assert.match(html, /Open strategy report/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('acceptance run executes one Intent v2 call and writes the compiled Showcase outputs', async () => {
  const fixture = await createFixture();
  try {
    const [deliverableArtifact, reviewArtifact] = fixture.access.rows;
    const material = buildResearchStrategyEditorialMaterialV1({
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      requiredQuestionIds: ['Q1'],
      deliverable: { artifact: deliverableArtifact!, value: fixture.deliverable },
      review: { artifact: reviewArtifact!, value: fixture.review },
    });
    const { planner, llm, receipts } = createPlanner(fixture, showcaseIntent(material));
    const summary = await runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: fixture.outputDir,
      expectedModel: llm.identity.requestedModel,
      enableEditorialShowcase: true,
      requireModelResult: true,
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => ({
        structuredCallCount: llm.calls,
        receiptCount: receipts.calls.length,
        candidateCaptured: true,
        provider: llm.identity.provider,
        providerMode: llm.identity.mode,
        requestedModel: llm.identity.requestedModel,
        actualModel: llm.identity.requestedModel,
        receipt: {
          id: 'acceptance-test-receipt',
          stage: receipts.calls[0]?.stage ?? 'missing',
          status: receipts.calls[0]?.status ?? 'failed',
          provider: receipts.calls[0]?.provider ?? 'missing',
          requestedModel: receipts.calls[0]?.requestedModel ?? 'missing',
          actualModel: receipts.calls[0]?.actualModel ?? 'missing',
          promptHash: receipts.calls[0]?.promptHash ?? 'missing',
        },
      }),
    });

    assert.equal(llm.calls, 1);
    assert.equal(llm.lastSchemaName, 'report-editorial-intent-v2');
    assert.equal(receipts.calls.length, 1);
    assert.equal(summary.modelAcceptanceEligible, true);
    assert.equal(summary.showcase?.generationMode, 'model');
    assert.equal(summary.showcase?.profileId, 'editorial-showcase-v1');
    assert.match(summary.showcase?.showcaseOutlineSignature ?? '', /^sha256:[a-f0-9]{64}$/u);
    assert.equal(summary.outputs['editorial-presentation-spec.json']?.byteSize! > 0, true);
    assert.equal(summary.outputs['editorial-showcase.html']?.byteSize! > 0, true);
    const sealedSpec = JSON.parse(
      await readFile(join(fixture.outputDir, 'editorial-presentation-spec.json'), 'utf8'),
    ) as { binding: Record<string, unknown> };
    const evidenceArtifact = fixture.access.rows.find(({ kind }) => kind === 'evidence_manifest');
    assert.equal(sealedSpec.binding.evidenceManifestArtifactId, evidenceArtifact?.id);
    assert.equal(sealedSpec.binding.evidenceManifestContentSha256, evidenceArtifact?.contentSha256);
    assert.equal(sealedSpec.binding.evidenceManifestHash, fixture.evidenceManifest.manifestHash);
    const html = await readFile(join(fixture.outputDir, 'editorial-showcase.html'), 'utf8');
    assert.match(html, /source-evidence-manifest-sha256/u);
    assert.match(html, /editorial-showcase-v1/u);
    assert.doesNotMatch(html, /<img|<svg|<canvas/iu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('acceptance auto-detects research_plan, allows a missing Ledger, and writes v4 rich blocks', async () => {
  const fixture = await createResearchPlanFixture();
  try {
    const sourcePaths = [
      join(fixture.attemptDir, 'deliverables', 'final-r0.json'),
      join(fixture.attemptDir, 'reports', 'review-r0.json'),
      join(fixture.attemptDir, 'evidence', 'manifest.json'),
      join(fixture.attemptDir, 'steps', '1-tool_output.json'),
    ];
    const before = await Promise.all(sourcePaths.map((path) => readFile(path)));
    const { planner, llm, receipts } = createResearchPlanPlanner(fixture);
    const summary = await runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: fixture.outputDir,
      expectedModel: llm.identity.requestedModel,
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => ({
        structuredCallCount: llm.calls,
        receiptCount: receipts.calls.length,
        candidateCaptured: true,
        provider: llm.identity.provider,
        providerMode: llm.identity.mode,
        requestedModel: llm.identity.requestedModel,
        actualModel: llm.identity.requestedModel,
        receipt: {
          id: 'acceptance-test-receipt',
          stage: receipts.calls[0]?.stage ?? 'missing',
          status: receipts.calls[0]?.status ?? 'failed',
          provider: receipts.calls[0]?.provider ?? 'missing',
          requestedModel: receipts.calls[0]?.requestedModel ?? 'missing',
          actualModel: receipts.calls[0]?.actualModel ?? 'missing',
          promptHash: receipts.calls[0]?.promptHash ?? 'missing',
        },
      }),
    });

    assert.equal(llm.calls, 1);
    assert.equal(llm.lastSchemaName, 'report-editorial-intent-v1');
    assert.equal(receipts.calls.length, 1);
    assert.equal(summary.sourceArtifacts.contributionLedger, undefined);
    assert.equal(summary.material.auditRecordCount, 0);
    assert.equal(summary.material.presentationCountByShape.records, 5);
    assert.equal(summary.material.presentationCountByShape.stages, 1);
    assert.equal(summary.deterministicComparison.presentationUnits.equal, true);
    assert.equal(summary.deterministicComparison.leafUnits.equal, true);
    assert.equal(summary.deterministicComparison.auditRecords.equal, true);
    assert.equal(summary.deterministicComparison.traceByLeafId.modelMatchesMaterial, true);
    assert.equal(summary.deterministicComparison.actionPriorities.modelMatchesMaterial, true);
    assert.deepEqual(await Promise.all(sourcePaths.map((path) => readFile(path))), before);

    const report = JSON.parse(
      await readFile(join(fixture.outputDir, 'report-document.json'), 'utf8'),
    ) as { version: string; sections: Array<{ blocks: Array<{ type: string }> }> };
    assert.equal(report.version, 'report-document-v4');
    const blockTypes = report.sections.flatMap(({ blocks }) => blocks.map(({ type }) => type));
    assert.ok(blockTypes.includes('card-grid'));
    assert.ok(blockTypes.includes('stage-flow'));
    const html = await readFile(join(fixture.outputDir, 'report.html'), 'utf8');
    assert.match(html, /class="card-grid"/u);
    assert.match(html, /class="stage-flow"/u);
    assert.match(html, /活动：确认样本与比较维度/u);
    assert.match(html, /产出：样本清单/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fixture reprojection is never reported as fresh model acceptance evidence', async () => {
  const fixture = await createFixture();
  try {
    const { planner, llm, receipts } = createPlanner(fixture, undefined, 'mock');
    const summary = await runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: fixture.outputDir,
      expectedModel: llm.identity.requestedModel,
      requireModelResult: true,
      runKind: 'fixture_reprojection',
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => ({
        structuredCallCount: llm.calls,
        receiptCount: receipts.calls.length,
        candidateCaptured: true,
        provider: llm.identity.provider,
        providerMode: llm.identity.mode,
        requestedModel: llm.identity.requestedModel,
        actualModel: llm.identity.requestedModel,
        receipt: {
          id: 'acceptance-test-receipt',
          stage: receipts.calls[0]?.stage ?? 'missing',
          status: receipts.calls[0]?.status ?? 'failed',
          provider: receipts.calls[0]?.provider ?? 'missing',
          requestedModel: receipts.calls[0]?.requestedModel ?? 'missing',
          actualModel: receipts.calls[0]?.actualModel ?? 'missing',
          promptHash: receipts.calls[0]?.promptHash ?? 'missing',
        },
      }),
    });

    assert.equal(summary.runKind, 'fixture_reprojection');
    assert.equal(summary.modelAcceptanceEligible, false);
    assert.equal(summary.planner.resultMode, 'fixture_reprojection');
    assert.equal(summary.planner.selectedBlueprint.source, 'fixture_reprojection');
    assert.equal(summary.planner.providerMode, 'mock');
    assert.equal(summary.planner.receipt?.status, 'succeeded');
    const persistedSummary = JSON.parse(
      await readFile(join(fixture.outputDir, 'acceptance-summary.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(persistedSummary.runKind, 'fixture_reprojection');
    assert.equal(persistedSummary.modelAcceptanceEligible, false);
    assert.deepEqual(reportEditorialAcceptanceCliResult(summary, fixture.outputDir), {
      status: 'ok',
      runKind: 'fixture_reprojection',
      modelAcceptanceEligible: false,
      outputDir: fixture.outputDir,
      plannerMode: 'fixture_reprojection',
      presentationUnitsEqual: true,
      leafUnitsEqual: true,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('A-model acceptance rejects a schema-invalid model result that falls back', async () => {
  const fixture = await createFixture();
  try {
    const invalidCandidate = {
      version: 'report-editorial-intent-v1',
      style: 'editorial',
      density: 'comfortable',
      mainSections: [{
        headingMode: 'view_label',
        view: 'answers',
        prominence: 'primary',
        blocks: [{
          presentation: 'answer',
          unitRefs: ['answer-Q1', 'SECRET MODEL BODY MUST NOT LEAK'],
          visibility: 'always',
        }],
      }],
      copyFragments: [],
    };
    const { planner, llm, receipts } = createPlanner(fixture, invalidCandidate);
    await assert.rejects(runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: fixture.outputDir,
      expectedModel: llm.identity.requestedModel,
      requireModelResult: true,
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => ({
        structuredCallCount: llm.calls,
        receiptCount: receipts.calls.length,
        candidateCaptured: true,
        lastStructuredCandidate: invalidCandidate,
        provider: llm.identity.provider,
        providerMode: llm.identity.mode,
        requestedModel: llm.identity.requestedModel,
        actualModel: llm.identity.requestedModel,
        receipt: {
          id: 'acceptance-test-receipt',
          stage: receipts.calls[0]?.stage ?? 'missing',
          status: receipts.calls[0]?.status ?? 'failed',
          provider: receipts.calls[0]?.provider ?? 'missing',
          requestedModel: receipts.calls[0]?.requestedModel ?? 'missing',
          actualModel: receipts.calls[0]?.actualModel ?? 'missing',
          promptHash: receipts.calls[0]?.promptHash ?? 'missing',
        },
      }),
    }), (error) => {
      assert.ok(error instanceof ReportEditorialAcceptanceGateError);
      assert.equal(error.diagnostic.fallbackReasonCode, 'invalid_blueprint');
      assert.equal(error.diagnostic.candidateCaptured, true);
      assert.equal(error.diagnostic.stages[0]?.stage, 'schema');
      assert.equal(error.diagnostic.stages[0]?.status, 'failed');
      assert.match(error.diagnostic.stages[0]?.issues.join('\n') ?? '', /more than 1 items/u);
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /SECRET MODEL BODY/u);
      return true;
    });
    assert.equal(llm.calls, 1);
    assert.equal(receipts.calls.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('acceptance run rejects an output directory inside the historical Attempt', async () => {
  const fixture = await createFixture();
  try {
    const { planner, llm } = createPlanner(fixture);
    await assert.rejects(runReportEditorialAcceptance({
      attemptDir: fixture.attemptDir,
      outputDir: join(fixture.attemptDir, 'acceptance-output'),
      expectedModel: llm.identity.requestedModel,
    }, {
      repository: fixture.access,
      artifacts: fixture.access,
      planner,
      modelTelemetry: () => uncalledTelemetry(llm),
    }), /independent from the historical Attempt/u);
    assert.equal(llm.calls, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('acceptance run rejects invalid SEALED hashes and Task bindings', async (context) => {
  await context.test('hash mismatch', async () => {
    const fixture = await createFixture();
    try {
      const { planner, llm } = createPlanner(fixture);
      fixture.access.rows[0]!.contentSha256 = `sha256:${'0'.repeat(64)}`;
      await assert.rejects(runReportEditorialAcceptance({
        attemptDir: fixture.attemptDir,
        outputDir: fixture.outputDir,
        expectedModel: llm.identity.requestedModel,
      }, {
        repository: fixture.access,
        artifacts: fixture.access,
        planner,
        modelTelemetry: () => uncalledTelemetry(llm),
      }), /hash mismatch/u);
      assert.equal(llm.calls, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await context.test('Task binding mismatch', async () => {
    const fixture = await createFixture();
    try {
      const { planner, llm } = createPlanner(fixture);
      fixture.access.rows[0]!.taskId = 'another-task';
      await assert.rejects(runReportEditorialAcceptance({
        attemptDir: fixture.attemptDir,
        outputDir: fixture.outputDir,
        expectedModel: llm.identity.requestedModel,
      }, {
        repository: fixture.access,
        artifacts: fixture.access,
        planner,
        modelTelemetry: () => uncalledTelemetry(llm),
      }), /expected Task, Plan, Attempt/u);
      assert.equal(llm.calls, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
