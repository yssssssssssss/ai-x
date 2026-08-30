import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ReportEditorialBlueprintV1,
  ReportEditorialMaterialV1,
} from '../packages/api-contract/report-editorial.ts';
import {
  REPORT_EDITORIAL_PLANNER_LIMITS,
  REPORT_EDITORIAL_PLANNER_PROMPT,
  ReportEditorialPlanner,
  buildReportEditorialPlannerInputV1,
  productionReportEditorialPlannerDataPolicy,
} from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import { createDeterministicReportEditorialBlueprintV1 } from '../apps/orchestrator-runtime/src/report/report-editorial-blueprint.ts';
import {
  LLMInvocationError,
  type LLMProviderIdentity,
  type LLMResult,
  type StructuredLLMCallOptions,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  MissingModelReceiptError,
  ModelDriftError,
} from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';

const SHA = `sha256:${'a'.repeat(64)}`;

function trace(pointer: string, questionIds: string[] = []) {
  return {
    supportMode: 'direct' as const,
    origins: [{
      artifactId: 'deliverable-1',
      contentSha256: SHA,
      schemaVersion: 'research-strategy-content-v2',
      jsonPointer: pointer,
      sourceNodeIds: [pointer],
      reviewState: 'passed' as const,
    }],
    support: {
      questionIds,
      evidenceIds: ['E1'],
      findingIds: ['F1'],
      summaryIds: ['S1'],
      status: 'supported' as const,
      confidence: 0.9,
    },
  };
}

function materialFixture(): ReportEditorialMaterialV1 {
  return {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      deliverableArtifactId: 'deliverable-1',
      deliverableContentSha256: SHA,
      reportReviewArtifactId: 'review-1',
    },
    document: {
      title: '宠物食品电商推广报告',
      decisionContext: '确定电商推广优先策略。',
      executiveAnswer: '优先建立可信内容，再分层投放。',
      deliverableType: 'research_strategy_report',
      requestedArtifactTypes: ['research_report'],
    },
    presentationUnits: [{
      id: 'answer-Q1',
      semanticKind: 'direct_answer',
      title: '应该如何推广？',
      shape: 'record',
      leafIds: ['leaf-answer-Q1'],
      leafId: 'leaf-answer-Q1',
      fields: [
        { key: 'answer', label: '答案', value: '以可信内容降低首次购买阻力。' },
        { key: 'action', label: '行动', value: '先建设成分与适口性证据。' },
      ],
    }, {
      id: 'content-context',
      semanticKind: 'narrative',
      title: '市场背景',
      shape: 'text',
      leafIds: ['leaf-context'],
      leafId: 'leaf-context',
      text: '消费者需要同时判断安全性、适口性与价格。',
    }, {
      id: 'asset-product',
      semanticKind: 'visual_asset',
      title: '商品页截图',
      shape: 'asset',
      leafIds: ['leaf-asset'],
      leafId: 'leaf-asset',
      assetRef: {
        assetId: 'asset-secret-id',
        manifestArtifactId: 'manifest-secret-id',
        contentSha256: `sha256:${'b'.repeat(64)}`,
        manifestHash: `sha256:${'c'.repeat(64)}`,
        mediaType: 'image/png',
        exportPolicy: 'allow',
      },
      sourceSummary: {
        kind: 'browser_capture',
        pageTitle: '公开商品详情页',
        domain: 'example.test',
        capturedAt: '2026-08-27T00:00:00.000Z',
      },
      canonicalBindingIds: ['F1'],
    }, {
      id: 'chart-price',
      semanticKind: 'verified_chart',
      title: '价格带分布',
      shape: 'chart',
      leafIds: ['leaf-chart'],
      leafId: 'leaf-chart',
      chartRef: {
        chartId: 'chart-secret-id',
        chartSpecArtifactId: 'chart-spec-secret-id',
        chartSpecArtifactContentSha256: `sha256:${'d'.repeat(64)}`,
        assetId: 'chart-asset-secret-id',
        manifestArtifactId: 'chart-manifest-secret-id',
      },
      specHash: `sha256:${'e'.repeat(64)}`,
      spec: {
        version: 'chart-spec-v1',
        chartId: 'chart-secret-id',
        type: 'comparison',
        title: '价格带分布',
        categories: ['低价', '中价'],
        series: [{
          key: 'share',
          label: '占比',
          values: [30, 70],
          evidenceIds: [['E1'], ['E1']],
        }],
      },
      table: {
        caption: 'SECRET FULL TABLE ALTERNATIVE',
        columns: ['低价', '中价'],
        rows: [{ key: 'share', label: '占比', cells: [30, 70], evidenceIds: [['E1'], ['E1']] }],
      },
      dataArtifactRef: {
        artifactId: 'data-secret-id',
        contentSha256: `sha256:${'f'.repeat(64)}`,
        schemaVersion: 'chart-data-v1',
      },
      evidenceIds: ['E1'],
      canonicalBindingIds: ['F1'],
    }],
    leafTraceIndex: {
      'leaf-answer-Q1': trace('/payload/directAnswers/0/private-secret-pointer', ['Q1']),
      'leaf-context': trace('/payload/contentBlocks/0/private-secret-pointer', ['Q1']),
      'leaf-asset': trace('/visual-assets/private-secret-pointer', ['Q1']),
      'leaf-chart': trace('/charts/private-secret-pointer', ['Q1']),
    },
    constraints: {
      requiredQuestionIds: ['Q1'],
      requiredPresentationUnitIds: ['answer-Q1', 'content-context', 'asset-product', 'chart-price'],
      requiredLeafUnitIds: ['leaf-answer-Q1', 'leaf-context', 'leaf-asset', 'leaf-chart'],
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: {
        'answer-Q1': ['answer', 'record-table', 'list'],
        'content-context': ['paragraph', 'fact', 'list'],
        'asset-product': ['image'],
        'chart-price': ['chart', 'record-table'],
      },
    },
  };
}

type LlmBehavior =
  | unknown
  | Error
  | ((options: StructuredLLMCallOptions) => unknown | Promise<unknown>);

class PlannerLlm {
  readonly calls: StructuredLLMCallOptions[] = [];
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'editorial-model',
    mode: 'real',
    eligibleAsReal: true,
  };

  constructor(private readonly behavior: LlmBehavior) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    if (this.behavior instanceof Error) throw this.behavior;
    const data = typeof this.behavior === 'function'
      ? await this.behavior(options)
      : this.behavior;
    return {
      data: data as T,
      promptHash: SHA,
      modelName: 'editorial-model',
      modelVersion: '2026-08-27',
      traceId: 'trace-editorial',
      receiptId: 'receipt-editorial',
      tokens: { prompt: 120, completion: 40, total: 160 },
    };
  }
}

function modelBlueprint(material: ReportEditorialMaterialV1): ReportEditorialBlueprintV1 {
  const blueprint = createDeterministicReportEditorialBlueprintV1(material);
  return {
    ...blueprint,
    style: 'editorial',
    density: 'compact',
    sections: [...blueprint.sections].reverse(),
  };
}

function planInput(material = materialFixture()) {
  return {
    material,
    attemptId: 'attempt-1',
    stepNo: 12,
    expectedModel: 'editorial-model',
  };
}

test('Planner-safe input keeps reviewed prose but removes Artifact, trace, binary, and full Chart details', () => {
  const safe = buildReportEditorialPlannerInputV1(materialFixture());
  const serialized = JSON.stringify(safe);

  assert.match(serialized, /消费者需要同时判断安全性/u);
  assert.match(serialized, /公开商品详情页/u);
  assert.match(serialized, /"pointCount":2/u);
  assert.match(serialized, /"confidence":0\.9/u);
  assert.doesNotMatch(serialized, /asset-secret-id|manifest-secret-id|chart-spec-secret-id/u);
  assert.doesNotMatch(serialized, /SECRET FULL TABLE ALTERNATIVE|private-secret-pointer/u);
  assert.equal('binding' in safe, false);
  assert.equal('leafTraceIndex' in safe, false);
  assert.match(REPORT_EDITORIAL_PLANNER_PROMPT, /requiredView、requiredVisibility 与 allowedPresentations/u);
  assert.match(REPORT_EDITORIAL_PLANNER_PROMPT, /每个 Block 只能引用一个 unit/u);
  assert.match(REPORT_EDITORIAL_PLANNER_PROMPT, /record-table 不得混合 source shape/u);
  assert.match(REPORT_EDITORIAL_PLANNER_PROMPT, /requested_artifact_binding 不能放入 appendix/u);
});

test('uses one structured LLM call and accepts only a reference Blueprint through the shared coverage gate', async () => {
  const material = materialFixture();
  const llm = new PlannerLlm(modelBlueprint(material));
  const times = [100, 112];
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
    now: () => times.shift() ?? 112,
  }).plan(planInput(material));

  assert.equal(result.mode, 'model');
  assert.equal(result.blueprint.style, 'editorial');
  assert.equal(result.editorialCopy, undefined);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]?.prompt, REPORT_EDITORIAL_PLANNER_PROMPT);
  assert.equal(llm.calls[0]?.schemaName, 'report-editorial-blueprint-v1');
  assert.deepEqual(llm.calls[0]?.receipt, {
    stage: 'report_editorial_planner',
    attemptId: 'attempt-1',
    stepNo: 12,
    contextManifestHash: result.diagnostics.plannerInputSha256,
    expectedModel: 'editorial-model',
  });
  assert.equal(result.diagnostics.receiptId, 'receipt-editorial');
  assert.equal(result.diagnostics.promptTokens, 120);
  assert.equal(result.diagnostics.completionTokens, 40);
  assert.equal(result.diagnostics.latencyMs, 12);
  assert.match(result.diagnostics.plannerInputSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('a denied data policy falls back without calling the LLM or exposing an error', async () => {
  const llm = new PlannerLlm(modelBlueprint(materialFixture()));
  let inspectedProvider: LLMProviderIdentity | undefined;
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
    dataPolicy: (_safeInput, provider) => {
      inspectedProvider = provider;
      return false;
    },
  }).plan(planInput());

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'data_policy_denied');
  assert.deepEqual(result.warnings, ['data_policy_denied']);
  assert.equal(llm.calls.length, 0);
  assert.equal(inspectedProvider, llm.identity);
});

test('production data policy only allows classified public or internal non-PII material', async () => {
  const allowedClassifications = [
    {
      taskSensitivity: 'public' as const,
      piiDetected: false,
      hasSensitiveOrBlockedEvidence: false,
    },
    {
      taskSensitivity: 'internal' as const,
      piiDetected: false,
      hasSensitiveOrBlockedEvidence: false,
    },
  ];
  for (const dataClassification of allowedClassifications) {
    const llm = new PlannerLlm(modelBlueprint(materialFixture()));
    const result = await new ReportEditorialPlanner({
      llm,
      estimatePromptTokens: () => 1_000,
      dataPolicy: productionReportEditorialPlannerDataPolicy,
    }).plan({ ...planInput(), dataClassification });
    assert.equal(result.mode, 'model');
    assert.equal(llm.calls.length, 1);
  }

  const deniedClassifications = [
    undefined,
    {
      taskSensitivity: 'confidential' as const,
      piiDetected: false,
      hasSensitiveOrBlockedEvidence: false,
    },
    {
      taskSensitivity: 'public' as const,
      piiDetected: true,
      hasSensitiveOrBlockedEvidence: false,
    },
    {
      taskSensitivity: 'internal' as const,
      piiDetected: false,
      hasSensitiveOrBlockedEvidence: true,
    },
  ];
  for (const dataClassification of deniedClassifications) {
    const llm = new PlannerLlm(modelBlueprint(materialFixture()));
    const result = await new ReportEditorialPlanner({
      llm,
      estimatePromptTokens: () => 1_000,
      dataPolicy: productionReportEditorialPlannerDataPolicy,
    }).plan({
      ...planInput(),
      ...(dataClassification ? { dataClassification } : {}),
    });
    assert.equal(result.mode, 'fallback');
    assert.equal(result.reasonCode, 'data_policy_denied');
    assert.equal(llm.calls.length, 0);
  }

  const safeInput = buildReportEditorialPlannerInputV1(materialFixture());
  assert.equal(productionReportEditorialPlannerDataPolicy(
    safeInput,
    { ...new PlannerLlm(null).identity, mode: 'mock' },
    allowedClassifications[0],
  ), false);
  assert.equal(productionReportEditorialPlannerDataPolicy(
    safeInput,
    { ...new PlannerLlm(null).identity, eligibleAsReal: false },
    allowedClassifications[0],
  ), false);
});

test('a prompt budget violation falls back before the only allowed LLM attempt', async () => {
  const llm = new PlannerLlm(modelBlueprint(materialFixture()));
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => REPORT_EDITORIAL_PLANNER_LIMITS.promptTokens + 1,
  }).plan(planInput());

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'material_budget_exceeded');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(
    result.blueprint.sections.flatMap(({ blocks }) => blocks.flatMap(({ unitRefs }) => unitRefs)),
    materialFixture().constraints.requiredPresentationUnitIds,
  );
});

test('provider failures use deterministic fallback without a Planner retry', async () => {
  const llm = new PlannerLlm(new LLMInvocationError(
    'timeout',
    true,
    null,
    'provider timeout with sensitive detail',
  ));
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan(planInput());

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'provider_failure');
  assert.deepEqual(result.warnings, ['provider_failure']);
  assert.equal(llm.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive detail/u);
});

test('model drift and missing receipts fail closed instead of producing a fallback report', async () => {
  const integrityErrors = [
    new ModelDriftError('editorial-model', 'unexpected-model'),
    new MissingModelReceiptError(new Error('receipt store unavailable')),
  ];

  for (const integrityError of integrityErrors) {
    const llm = new PlannerLlm(integrityError);
    await assert.rejects(
      new ReportEditorialPlanner({
        llm,
        estimatePromptTokens: () => 1_000,
      }).plan(planInput()),
      (error) => error === integrityError,
    );
    assert.equal(llm.calls.length, 1);
  }
});

test('schema-invalid, unknown, and duplicate references fall back as invalid_blueprint', async () => {
  const material = materialFixture();
  const invalidOutputs: unknown[] = [
    { ...modelBlueprint(material), unexpected: 'not allowed' },
    {
      ...modelBlueprint(material),
      sections: [{
        headingMode: 'view_label',
        view: 'topics',
        prominence: 'supporting',
        blocks: [{ presentation: 'paragraph', unitRefs: ['unknown-unit'], visibility: 'always' }],
      }],
    },
    (() => {
      const duplicate = structuredClone(modelBlueprint(material));
      duplicate.sections[0]!.blocks.push(structuredClone(duplicate.sections[0]!.blocks[0]!));
      return duplicate;
    })(),
  ];

  for (const output of invalidOutputs) {
    const llm = new PlannerLlm(output);
    const result = await new ReportEditorialPlanner({
      llm,
      estimatePromptTokens: () => 1_000,
    }).plan(planInput(material));
    assert.equal(result.mode, 'fallback');
    assert.equal(result.reasonCode, 'invalid_blueprint');
    assert.equal(llm.calls.length, 1);
  }
});

test('a model block that groups multiple single-unit presentations falls back before projection', async () => {
  const material = materialFixture();
  material.presentationUnits.push({
    id: 'content-context-2',
    semanticKind: 'narrative',
    title: '补充背景',
    shape: 'text',
    leafIds: ['leaf-context-2'],
    leafId: 'leaf-context-2',
    text: '不同渠道的信任建立路径并不相同。',
  });
  material.leafTraceIndex['leaf-context-2'] = trace('/payload/contentBlocks/1', ['Q1']);
  material.constraints.requiredPresentationUnitIds.push('content-context-2');
  material.constraints.requiredLeafUnitIds.push('leaf-context-2');
  material.constraints.projectionProfilesByUnitId['content-context-2'] = ['paragraph', 'fact', 'list'];
  const invalid = modelBlueprint(material);
  const firstContextBlock = invalid.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ unitRefs }) => unitRefs.includes('content-context'))!;
  firstContextBlock.unitRefs.push('content-context-2');
  invalid.sections = invalid.sections.map((section) => ({
    ...section,
    blocks: section.blocks.filter(({ unitRefs }) => !(
      unitRefs.length === 1 && unitRefs[0] === 'content-context-2'
    )),
  }));

  const llm = new PlannerLlm(invalid);
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan(planInput(material));

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'invalid_blueprint');
  assert.equal(llm.calls.length, 1);
});

test('model output cannot bypass a disabled rich-presentation Writer', async () => {
  const material = materialFixture();
  const rich = modelBlueprint(material);
  const answer = rich.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ unitRefs }) => unitRefs.includes('answer-Q1'))!;
  answer.presentation = 'record-table';
  const result = await new ReportEditorialPlanner({
    llm: new PlannerLlm(rich),
    estimatePromptTokens: () => 1_000,
  }).plan({
    ...planInput(material),
    presentationOptions: { recordTable: false, graph: false, priorityBoard: false },
  });

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'incompatible_presentation');
  assert.equal(
    result.blueprint.sections.flatMap(({ blocks }) => blocks)
      .find(({ unitRefs }) => unitRefs.includes('answer-Q1'))?.presentation,
    'answer',
  );
});

test('oversized Blueprint output is discarded as a budget fallback before validation', async () => {
  const material = materialFixture();
  const oversized = modelBlueprint(material);
  oversized.sections = Array.from({ length: 2_000 }, () => structuredClone(oversized.sections[0]!));
  const result = await new ReportEditorialPlanner({
    llm: new PlannerLlm(oversized),
    estimatePromptTokens: () => 1_000,
  }).plan(planInput(material));

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'material_budget_exceeded');
  assert.ok((result.diagnostics.outputBytes ?? 0) > REPORT_EDITORIAL_PLANNER_LIMITS.outputBytes);
});

test('AbortSignal and cancelled provider errors propagate instead of producing fallback', async () => {
  const cancellation = new Error('lease lost');
  const controller = new AbortController();
  const llm = new PlannerLlm(() => {
    controller.abort(cancellation);
    throw new Error('provider wrapper error');
  });
  let caught: unknown;
  try {
    await new ReportEditorialPlanner({
      llm,
      estimatePromptTokens: () => 1_000,
    }).plan({ ...planInput(), cancellationSignal: controller.signal });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, cancellation);
  assert.equal(llm.calls.length, 1);

  const providerCancellation = new LLMInvocationError('cancelled', false, null, 'cancelled');
  await assert.rejects(
    new ReportEditorialPlanner({
      llm: new PlannerLlm(providerCancellation),
      estimatePromptTokens: () => 1_000,
    }).plan(planInput()),
    (error) => error === providerCancellation,
  );
});
