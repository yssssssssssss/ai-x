import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditorialSummaryGenerator,
  EditorialSummaryGenerationError,
  validateEditorialSummaryHtml,
} from '../apps/orchestrator-runtime/src/report/editorial-summary-generator.ts';
import { buildEditorialSummarySource } from '../apps/orchestrator-runtime/src/report/editorial-summary-source.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { hashPrompt } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

function sourceFixture() {
  const { material } = showcaseFixture();
  return buildEditorialSummarySource({ material, reportReview: { verdict: 'pass' } }).source;
}

function planFor(source: ReturnType<typeof sourceFixture>) {
  return {
    version: 'editorial-summary-plan-v1',
    title: '面向决策的研究摘要',
    editorialThesis: '让证据边界直接参与决策阅读。',
    decisionFrame: ['先确认事实，再安排验证。'],
    storyArc: [{
      id: 'decision',
      title: '核心判断',
      purpose: '回答研究问题并说明行动边界。',
      sourceIds: source.atoms.flatMap(({ sourceUnitIds }) => sourceUnitIds),
      suggestedVisualForm: '由当前内容关系决定的决策画布',
    }],
    visualDirection: {
      thesis: '克制的证据型编辑设计',
      typography: '高对比中文标题与紧凑正文',
      colorLogic: '颜色只区分证据状态',
      layoutLogic: '结论先行，依据就近展开',
      interactionLogic: '只为查看详细依据提供交互',
    },
  } as const;
}

function htmlFor(source: ReturnType<typeof sourceFixture>, marker = '原始摘要') {
  const sourceIds = source.atoms.flatMap(({ sourceUnitIds }) => sourceUnitIds).join(' ');
  const detailIds = source.groups.map(({ id }) => id).join(' ');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>面向决策的研究摘要</title><style>body{font-family:sans-serif}</style></head><body><main><section data-summary-section-id="decision" data-source-ids="${sourceIds}" data-detail-section-ids="${detailIds}"><h1>${marker}</h1><p>先确认事实，再安排验证。</p></section></main></body></html>`;
}

class SummaryLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway', endpointHost: 'llm-gw.jd.local', requestedModel: 'summary-model', mode: 'real', eligibleAsReal: true,
  };
  readonly structuredPrompts: string[] = [];
  readonly textPrompts: string[] = [];
  private structuredIndex = 0;
  private textIndex = 0;

  constructor(
    private readonly structuredValues: unknown[],
    private readonly textValues: string[],
  ) {}

  async generateStructured<T>(opts: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.structuredPrompts.push(opts.prompt);
    const data = this.structuredValues[this.structuredIndex++] as T;
    return {
      data,
      promptHash: hashPrompt(opts.prompt, opts.context, opts.schemaName),
      modelName: 'summary-model-v1',
      modelVersion: 'summary-model-v1',
      traceId: `trace-structured-${this.structuredIndex}`,
      receiptId: `receipt-structured-${this.structuredIndex}`,
      providerIdentity: this.identity,
      expectedModel: 'summary-model-v1',
    };
  }

  async generateText(opts: TextLLMCallOptions): Promise<TextLLMResult> {
    this.textPrompts.push(opts.prompt);
    const text = this.textValues[this.textIndex++]!;
    return {
      text,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: 'summary-model-v1',
      modelVersion: 'summary-model-v1',
      traceId: `trace-text-${this.textIndex}`,
      receiptId: `receipt-text-${this.textIndex}`,
      providerIdentity: this.identity,
      expectedModel: 'summary-model-v1',
    };
  }
}

const passingFidelity = {
  version: 'editorial-summary-fidelity-v1',
  verdict: 'pass',
  issues: [],
} as const;

test('generates a free-form HTML summary through the public generator seam', async () => {
  const source = sourceFixture();
  const llm = new SummaryLLM([planFor(source), passingFidelity], [htmlFor(source)]);
  let fences = 0;
  const result = await new EditorialSummaryGenerator({
    llm,
    expectedActualModel: 'summary-model-v1',
  }).generate({ source, beforeModelCall: async () => { fences += 1; } });

  assert.equal(result.plan.version, 'editorial-summary-plan-v1');
  assert.match(result.htmlBytes.toString('utf8'), /data-summary-section-id="decision"/u);
  assert.equal(result.validation.verdict, 'pass');
  assert.equal(result.fidelity.verdict, 'pass');
  assert.equal(result.modelCalls.map(({ stage }) => stage).join(','), [
    'editorial_summary_plan',
    'editorial_summary_html',
    'editorial_summary_fidelity',
  ].join(','));
  assert.equal(fences, 3);
  assert.doesNotMatch(
    [...llm.structuredPrompts, ...llm.textPrompts].join('\n'),
    /京东众筹|五阶段河流|Persona Matrix|showcase-hero|universal-editorial-showcase/u,
  );
  assert.match(llm.textPrompts[0]!, /不得生成 JavaScript/u);
  assert.doesNotMatch(llm.textPrompts[0]!, /少量交互 JavaScript|内联 script/u);
});

test('drops an extra hallucinated binding when the same block keeps a valid source binding', async () => {
  const source = sourceFixture();
  const html = htmlFor(source).replace(
    'data-source-ids="',
    `data-source-ids="esa_${'0'.repeat(64)} `,
  );
  const llm = new SummaryLLM([planFor(source), passingFidelity], [html]);
  const result = await new EditorialSummaryGenerator({
    llm,
    expectedActualModel: 'summary-model-v1',
  }).generate({ source });

  assert.doesNotMatch(result.htmlBytes.toString('utf8'), new RegExp(`esa_${'0'.repeat(64)}`, 'u'));
  assert.equal(result.validation.verdict, 'pass');
});

test('rejects script elements and inline event handlers', () => {
  const source = sourceFixture();
  const interactive = htmlFor(source).replace('</body>', '<script>document.documentElement.dataset.mode="brief"</script></body>');
  assert.throws(
    () => validateEditorialSummaryHtml({ source, html: interactive }),
    (error: unknown) => error instanceof EditorialSummaryGenerationError
      && error.code === 'SUMMARY_HTML_INVALID',
  );

  const inlineHandler = htmlFor(source).replace('<h1>', '<h1 onclick="alert(1)">');
  assert.throws(
    () => validateEditorialSummaryHtml({ source, html: inlineHandler }),
    (error: unknown) => error instanceof EditorialSummaryGenerationError
      && error.code === 'SUMMARY_HTML_INVALID',
  );
});

test('repairs a script-bearing candidate before storing downloadable HTML bytes', async () => {
  const source = sourceFixture();
  const unsafe = htmlFor(source).replace('</body>', '<script>document.body.dataset.mode="brief"</script></body>');
  const safe = htmlFor(source, '已移除可执行脚本');
  const llm = new SummaryLLM([planFor(source), passingFidelity], [unsafe, safe]);
  const result = await new EditorialSummaryGenerator({
    llm,
    expectedActualModel: 'summary-model-v1',
  }).generate({ source });

  assert.equal(llm.textPrompts.length, 2);
  assert.doesNotMatch(result.htmlBytes.toString('utf8'), /<script\b/iu);
  assert.match(result.htmlBytes.toString('utf8'), /已移除可执行脚本/u);
});

test('rejects an HTML summary that introduces a source-external URL', async () => {
  const source = sourceFixture();
  const unsafe = htmlFor(source).replace('</main>', '<a href="https://invented.example/path">外部事实</a></main>');
  const llm = new SummaryLLM([planFor(source)], [unsafe, unsafe]);

  await assert.rejects(
    () => new EditorialSummaryGenerator({ llm, expectedActualModel: 'summary-model-v1' }).generate({ source }),
    (error: unknown) => error instanceof EditorialSummaryGenerationError
      && error.code === 'SUMMARY_HTML_INVALID',
  );
});

test('performs one focused revision and never appends a generic catch-all appendix', async () => {
  const source = sourceFixture();
  const firstReview = {
    version: 'editorial-summary-fidelity-v1',
    verdict: 'revise',
    issues: [{
      code: 'qualification_lost',
      sectionId: 'decision',
      sourceIds: [source.atoms[0]!.sourceUnitIds[0]!],
      instruction: '恢复该判断的暂定边界。',
    }],
  };
  const repaired = htmlFor(source, '已恢复证据边界');
  const llm = new SummaryLLM(
    [planFor(source), firstReview, passingFidelity],
    [htmlFor(source), repaired],
  );
  const result = await new EditorialSummaryGenerator({
    llm,
    expectedActualModel: 'summary-model-v1',
  }).generate({ source });

  assert.match(result.htmlBytes.toString('utf8'), /已恢复证据边界/u);
  assert.equal(llm.textPrompts.length, 2);
  assert.match(llm.textPrompts[1]!, /只修订审校指出的章节/u);
  assert.doesNotMatch(llm.textPrompts[1]!, /追加.*完整底稿|catch-all/iu);
  assert.equal(result.fidelity.verdict, 'pass');
});
