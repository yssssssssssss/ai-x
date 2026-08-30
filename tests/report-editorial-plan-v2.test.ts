import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
} from '../packages/api-contract/report-editorial.ts';
import type { ReportEditorialIntentV2 } from '../packages/api-contract/report-editorial-showcase.ts';
import {
  REPORT_EDITORIAL_INTENT_V1_PROMPT,
  REPORT_EDITORIAL_INTENT_V2_PROMPT,
  ReportEditorialPlanner,
} from '../apps/orchestrator-runtime/src/report/report-editorial-planner.ts';
import {
  assertEditorialPlacementPolicy,
  deriveEditorialPlacementPolicy,
} from '../apps/orchestrator-runtime/src/report/report-editorial-placement-policy.ts';
import type {
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

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
      executiveAnswer: '优先建立可信内容。',
      deliverableType: 'research_strategy_report',
      requestedArtifactTypes: ['research_report'],
    },
    presentationUnits: [{
      id: 'answer-Q1',
      semanticKind: 'direct_answer',
      title: '推广结论',
      shape: 'record',
      leafIds: ['leaf-answer'],
      leafId: 'leaf-answer',
      fields: [{
        key: 'answer',
        label: '答案',
        value: '2026年8月27日启动 P0 内容建设，以 100元预算验证 30% 转化目标，依据 E1，详见 https://example.test/pet。',
      }],
    }, {
      id: 'topic-context',
      semanticKind: 'narrative',
      title: '市场背景',
      shape: 'text',
      leafIds: ['leaf-topic'],
      leafId: 'leaf-topic',
      text: '用户会同时比较成分透明度与适口性。',
    }, {
      id: 'risk-trust',
      semanticKind: 'risk',
      title: '信任风险',
      shape: 'text',
      leafIds: ['leaf-risk'],
      leafId: 'leaf-risk',
      text: '缺少可验证依据会放大首次购买阻力。',
    }],
    leafTraceIndex: {
      'leaf-answer': trace('/answers/0', ['Q1']),
      'leaf-topic': trace('/topics/0', ['Q1']),
      'leaf-risk': trace('/risks/0', ['Q1']),
    },
    constraints: {
      requiredQuestionIds: ['Q1'],
      requiredPresentationUnitIds: ['answer-Q1', 'topic-context', 'risk-trust'],
      requiredLeafUnitIds: ['leaf-answer', 'leaf-topic', 'leaf-risk'],
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: {
        'answer-Q1': ['answer', 'record-table', 'list'],
        'topic-context': ['paragraph', 'fact', 'list'],
        'risk-trust': ['fact', 'paragraph', 'list'],
      },
    },
  };
}

class PlannerLlm {
  readonly calls: StructuredLLMCallOptions[] = [];
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'editorial-model',
    mode: 'real',
    eligibleAsReal: true,
  };

  constructor(private readonly output: unknown) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    if (this.output instanceof Error) throw this.output;
    return {
      data: this.output as T,
      promptHash: SHA,
      modelName: 'editorial-model',
      modelVersion: '2026-08-27',
      traceId: 'trace-editorial-v2',
      receiptId: 'receipt-editorial-v2',
      tokens: { prompt: 200, completion: 80, total: 280 },
    };
  }
}

function plannerIntent(): ReportEditorialIntentV1 {
  return {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'first_source_title',
      view: 'answers',
      prominence: 'primary',
      blocks: [{ presentation: 'answer', unitRefs: ['answer-Q1'], visibility: 'always' }],
    }, {
      headingMode: 'first_source_title',
      view: 'topics',
      prominence: 'supporting',
      blocks: [{ presentation: 'paragraph', unitRefs: ['topic-context'], visibility: 'always' }],
    }, {
      headingMode: 'first_source_title',
      view: 'evidence',
      prominence: 'primary',
      blocks: [{ presentation: 'fact', unitRefs: ['risk-trust'], visibility: 'always' }],
    }],
    copyFragments: [],
  };
}

function input(material: ReportEditorialMaterialV1) {
  return {
    material,
    attemptId: 'attempt-1',
    stepNo: 12,
    expectedModel: 'editorial-model',
    enableEditorialCopy: true,
  };
}

test('Intent v1 uses one structured call for partial structure and Copy while leaving Canonical material unchanged', async () => {
  const material = materialFixture();
  const before = structuredClone(material);
  const output = plannerIntent();
  output.copyFragments = [{
    target: { kind: 'report_title' },
    text: '从信任建设开始的宠物食品电商推广',
    sourceLeafIds: ['leaf-answer'],
  }, {
    target: { kind: 'executive_summary' },
    text: '优先建设可信内容，同时正视首次购买阻力。',
    sourceLeafIds: ['leaf-answer', 'leaf-risk'],
  }, {
    target: { kind: 'section_transition', sectionIndex: 0 },
    text: '结论明确后，需要回到用户比较商品时的真实判断。',
    sourceLeafIds: ['leaf-answer', 'leaf-topic'],
  }, {
    target: { kind: 'block_digest', sectionIndex: 1, blockIndex: 0 },
    text: '用户会同时比较成分透明度与适口性。',
    sourceLeafIds: ['leaf-topic'],
  }];
  const llm = new PlannerLlm(output);
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan(input(material));

  assert.equal(result.mode, 'model');
  assert.equal(result.blueprint.style, 'editorial');
  assert.equal(result.editorialCopy?.fragments.length, 4);
  assert.deepEqual(result.editorialCopy?.rejectedFragments, []);
  assert.ok(result.diagnostics.intentCompiler);
  assert.equal(result.diagnostics.intentCompiler.copyAcceptedCount, 4);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]?.schemaName, 'report-editorial-intent-v1');
  assert.equal(llm.calls[0]?.prompt, REPORT_EDITORIAL_INTENT_V1_PROMPT);
  assert.match(REPORT_EDITORIAL_INTENT_V1_PROMPT, /允许只引用 Material 的一部分 unit/u);
  assert.match(REPORT_EDITORIAL_INTENT_V1_PROMPT, /placementPolicy/u);
  assert.match(REPORT_EDITORIAL_INTENT_V1_PROMPT, /soft-required/u);
  assert.deepEqual(material, before);
});

test('Intent v1 drops only invalid Copy fragments and records compact deterministic reasons', async () => {
  const material = materialFixture();
  const output = plannerIntent();
  output.copyFragments = [{
    target: { kind: 'report_title' },
    text: '可信内容驱动增长',
    sourceLeafIds: ['leaf-answer'],
  }, {
    target: { kind: 'report_title' },
    text: '第二个标题',
    sourceLeafIds: ['leaf-answer'],
  }, {
    target: { kind: 'executive_summary' },
    text: '市场背景说明了购买判断。',
    sourceLeafIds: ['leaf-topic'],
  }, {
    target: { kind: 'section_title', sectionIndex: 1 },
    text: '结论',
    sourceLeafIds: ['leaf-answer'],
  }, {
    target: { kind: 'section_lead', sectionIndex: 1 },
    text: '<strong>市场背景</strong>',
    sourceLeafIds: ['leaf-topic'],
  }, {
    target: { kind: 'section_title', sectionIndex: 2 },
    text: '超长章节标题'.repeat(12),
    sourceLeafIds: ['leaf-risk'],
  }, {
    target: { kind: 'section_transition', sectionIndex: 2 },
    text: '不存在的下一节',
    sourceLeafIds: ['leaf-risk'],
  }, {
    target: { kind: 'block_digest', sectionIndex: 0, blockIndex: 0 },
    text: '追加 31% 转化、101元预算、P2、E9 和 https://invented.test。',
    sourceLeafIds: ['leaf-answer'],
  }, {
    target: { kind: 'section_lead', sectionIndex: 2 },
    text: '风险提示',
    sourceLeafIds: ['missing-leaf'],
  }];
  const result = await new ReportEditorialPlanner({
    llm: new PlannerLlm(output),
    estimatePromptTokens: () => 1_000,
  }).plan(input(material));

  assert.equal(result.mode, 'model');
  assert.deepEqual(result.editorialCopy?.fragments.map(({ target }) => target), [
    { kind: 'report_title' },
  ]);
  const rejected = result.editorialCopy?.rejectedFragments ?? [];
  assert.equal(rejected.length, 8);
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('duplicate_target')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('source_scope_mismatch')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('not_plain_text')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('length_limit')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('target_out_of_range')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('unsupported_protected_token')));
  assert.ok(rejected.some(({ reasonCodes }) => reasonCodes.includes('unknown_source_leaf_id')));
});

test('Intent v1 locally downgrades a disabled presentation without discarding the model result', async () => {
  const material = materialFixture();
  const output = plannerIntent();
  output.mainSections[0]!.blocks[0] = {
    presentation: 'record-table',
    unitRefs: ['answer-Q1'],
    visibility: 'always',
  };
  const llm = new PlannerLlm(output);
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan({ ...input(material), presentationOptions: { recordTable: false } });

  assert.equal(result.mode, 'model');
  assert.equal(llm.calls.length, 1);
  assert.equal(
    result.blueprint.sections.flatMap(({ blocks }) => blocks)
      .find(({ unitRefs }) => unitRefs.includes('answer-Q1'))?.presentation,
    'answer',
  );
  assert.equal(result.diagnostics.intentCompiler?.presentationDowngradeCount, 1);
});

test('Intent v1 provider failure makes one call and returns a policy-compliant deterministic report', async () => {
  const material = materialFixture();
  const llm = new PlannerLlm(new Error('provider unavailable'));
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan(input(material));

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'provider_failure');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(result.editorialCopy, { fragments: [], rejectedFragments: [] });
  assert.ok(result.diagnostics.intentCompiler);
  assertEditorialPlacementPolicy(
    material,
    result.blueprint,
    deriveEditorialPlacementPolicy(material),
  );
});

test('Intent v2 adds a content-driven Showcase Spec to the existing single structured call', async () => {
  const material = materialFixture();
  const v1 = plannerIntent();
  const output: ReportEditorialIntentV2 = {
    ...v1,
    version: 'report-editorial-intent-v2',
    showcase: {
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
        purpose: 'validation',
        layout: 'single',
        components: [{
          kind: 'validation-list',
          variant: 'ledger',
          emphasis: 'primary',
          span: 'full',
          unitRefs: ['risk-trust'],
          sourceLeafIds: ['leaf-risk'],
        }],
      }],
    },
  };
  const llm = new PlannerLlm(output);
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan({ ...input(material), enableEditorialShowcase: true });

  assert.equal(result.mode, 'model');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]?.schemaName, 'report-editorial-intent-v2');
  assert.equal(llm.calls[0]?.prompt, REPORT_EDITORIAL_INTENT_V2_PROMPT);
  assert.doesNotMatch(REPORT_EDITORIAL_INTENT_V2_PROMPT, /只返回符合 report-editorial-intent-v1/u);
  assert.match(REPORT_EDITORIAL_INTENT_V2_PROMPT, /editorial-hero=statement/u);
  assert.equal(result.showcaseSpec?.generationMode, 'model');
  assert.equal(result.showcaseSpec?.profileId, 'editorial-showcase-v1');
  assert.deepEqual(
    new Set(result.showcaseSpec?.sections.flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds))),
    new Set(material.constraints.requiredPresentationUnitIds),
  );
});

test('Intent v2 provider failure returns both existing report fallback and deterministic Showcase fallback', async () => {
  const material = materialFixture();
  const llm = new PlannerLlm(new Error('provider unavailable'));
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan({ ...input(material), enableEditorialShowcase: true });

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'provider_failure');
  assert.equal(llm.calls.length, 1);
  assert.equal(result.showcaseSpec?.generationMode, 'fallback');
  assert.match(result.showcaseSpec?.showcaseOutlineSignature ?? '', /^sha256:[a-f0-9]{64}$/u);
});

test('Intent v1 falls back to a policy-compliant deterministic compilation when structure is invalid', async () => {
  const material = materialFixture();
  const output = plannerIntent();
  output.mainSections[0]!.blocks[0]!.unitRefs = ['unknown-unit'];
  output.copyFragments = [{
    target: { kind: 'report_title' },
    text: '仍然有效的文案',
    sourceLeafIds: ['leaf-answer'],
  }];
  const llm = new PlannerLlm(output);
  const result = await new ReportEditorialPlanner({
    llm,
    estimatePromptTokens: () => 1_000,
  }).plan(input(material));

  assert.equal(result.mode, 'fallback');
  assert.equal(result.reasonCode, 'invalid_blueprint');
  assert.deepEqual(result.editorialCopy, { fragments: [], rejectedFragments: [] });
  assert.ok(result.diagnostics.intentCompiler);
  assert.equal(llm.calls.length, 1);
  assertEditorialPlacementPolicy(
    material,
    result.blueprint,
    deriveEditorialPlacementPolicy(material),
  );
  assert.deepEqual(
    new Set(result.blueprint.sections.flatMap(({ blocks }) => blocks.flatMap(({ unitRefs }) => unitRefs))),
    new Set(material.constraints.requiredPresentationUnitIds),
  );
});
