import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ReportResult,
  SkillDefinition,
  SolutionPlan,
} from '../packages/api-contract/skill-native.ts';
import {
  RegistryToolPort,
  SkillNativeExecutionEngine,
  type SkillNativeToolPersistence,
  type SkillNativeToolPort,
} from '../apps/orchestrator-runtime/src/skill-native/execution.ts';
import {
  renderReportHtml,
  renderReportMarkdown,
} from '../apps/orchestrator-runtime/src/skill-native/html-renderer.ts';
import {
  ToolInvocationError,
  type ToolAdapter,
  type ToolInvokeOptions,
  type ToolInvokeResult,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
/*
 * Keep the adapter seam explicit here: these tests exercise the production
 * registry/schema boundary without invoking an external Tool.
 */
import type {
  SkillNativeToolCallRecordInput,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

function skill(id: string): SkillDefinition {
  return {
    version: 'skill-definition-v1',
    id,
    name: id,
    description: id,
    whenToUse: id,
    inputs: [],
    knowledge: [],
    tools: [{ id: 'search', required: true }],
    report: { title: `${id} report`, summaryInstruction: 'summary', sections: ['One', 'Two'] },
    allowPartial: true,
    body: `# ${id}`,
    sourcePath: `skills/${id}/SKILL.md`,
    contentHash: `sha256:${id}`,
  };
}

function plan(mode: 'single_skill' | 'multi_skill'): SolutionPlan {
  const skills = mode === 'single_skill' ? [skill('final')] : [skill('support'), skill('final')];
  const invocations = skills.map((item, index) => ({
    id: `skill-${index + 1}-${item.id}`,
    skill: item,
    dependsOn: index === 0 ? [] : ['skill-1-support'],
    failurePolicy: index === 0 && mode === 'multi_skill' ? 'gap' as const : 'stop' as const,
  }));
  return {
    version: 'skill-native-plan-v1',
    taskId: 'task',
    solutionId: mode,
    title: 'Combined report',
    rationale: 'test',
    tradeoffs: 'test',
    mode,
    requirement: {
      version: 'requirement-context-v1',
      goal: 'goal',
      scope: [],
      assumptions: [],
      gaps: [],
      inputs: [],
    },
    invocations,
    finalReportInvocationId: invocations.at(-1)!.id,
    questions: [],
  };
}

class CountingLlm implements LLMClient {
  readonly identity = {
    provider: 'test', endpointHost: 'local', requestedModel: 'test', mode: 'mock' as const, eligibleAsReal: false,
  };
  readonly calls: string[] = [];
  readonly contexts: object[] = [];

  constructor(private readonly fail: ReadonlySet<string> = new Set()) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const skillId = options.schemaName.replace(/^skill:/u, '');
    this.calls.push(skillId);
    this.contexts.push(options.context ?? {});
    if (this.fail.has(skillId)) throw new Error(`${skillId} failed`);
    const context = options.context as { allowedSources?: Array<{ id: string }> };
    const sourceId = context.allowedSources?.[0]?.id;
    const data: ReportResult = {
      version: 'report-result-v1',
      title: `${skillId} report`,
      summary: `${skillId} summary`,
      status: 'complete',
      sections: ['One', 'Two'].map((title, index) => ({
        id: `generated-${index}`,
        title,
        blocks: [{ type: 'text', text: `${skillId} ${title}`, ...(sourceId ? { sourceIds: [sourceId] } : {}) }],
      })),
      sources: sourceId ? [{ id: sourceId, kind: 'tool', label: 'forged', url: 'https://forged.example' }] : [],
      gaps: [],
    };
    return {
      data: data as T,
      promptHash: 'sha256:prompt',
      modelName: 'test',
      modelVersion: '1',
      traceId: 'trace',
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('not used');
  }
}

class CountingTools implements SkillNativeToolPort {
  readonly calls: string[] = [];
  async invoke(input: { toolId: string; skill: SkillDefinition }): Promise<{ output: object; sources: Array<{ id: string; kind: 'tool'; label: string; url: string }> }> {
    this.calls.push(`${input.skill.id}:${input.toolId}`);
    return {
      output: { results: [{ title: 'Real source', url: 'https://example.com' }] },
      sources: [{ id: 'source-real', kind: 'tool', label: 'Real source', url: 'https://example.com' }],
    };
  }
}

test('single executes one Skill call and returns it directly', async () => {
  const llm = new CountingLlm();
  const tools = new CountingTools();
  const result = await new SkillNativeExecutionEngine({ llm, tools }).execute({ plan: plan('single_skill') });
  assert.deepEqual(llm.calls, ['final']);
  assert.deepEqual(tools.calls, ['final:search']);
  assert.equal(result.status, 'complete');
  assert.equal(result.report?.title, 'final report');
  assert.equal(result.report?.sources[0]?.url, 'https://example.com');
});

test('multi executes each Skill once and final failure falls back deterministically', async () => {
  const llm = new CountingLlm(new Set(['final']));
  const tools = new CountingTools();
  const result = await new SkillNativeExecutionEngine({ llm, tools }).execute({ plan: plan('multi_skill') });
  assert.deepEqual(llm.calls, ['support', 'final']);
  assert.equal(result.status, 'partial');
  assert.equal(result.report?.title, 'Combined report');
  assert.match(result.report?.summary ?? '', /最终综合失败/u);
  assert.deepEqual(result.report?.sections.map(({ title }) => title), [
    'support · One',
    'support · Two',
  ]);
});

test('support failure is a Gap and does not suppress the single final synthesis call', async () => {
  const llm = new CountingLlm(new Set(['support']));
  const result = await new SkillNativeExecutionEngine({ llm, tools: new CountingTools() }).execute({ plan: plan('multi_skill') });
  assert.deepEqual(llm.calls, ['support', 'final']);
  assert.equal(result.status, 'partial');
  assert.ok(result.report?.gaps.some(({ id }) => id === 'skill:skill-1-support'));
});

test('a stop failure propagates through skipped descendants', async () => {
  const chained = plan('multi_skill');
  chained.invocations = [
    { id: 'one', skill: skill('stop-parent'), dependsOn: [], failurePolicy: 'stop' },
    { id: 'two', skill: skill('gap-child'), dependsOn: ['one'], failurePolicy: 'gap' },
    { id: 'three', skill: skill('final'), dependsOn: ['two'], failurePolicy: 'stop' },
  ];
  chained.finalReportInvocationId = 'three';
  const llm = new CountingLlm(new Set(['stop-parent']));
  const tools = new CountingTools();

  const result = await new SkillNativeExecutionEngine({ llm, tools }).execute({ plan: chained });

  assert.deepEqual(llm.calls, ['stop-parent']);
  assert.deepEqual(tools.calls, ['stop-parent:search']);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.skillResults.map(({ invocationId }) => invocationId), ['one', 'two', 'three']);
});

test('a partial Tool result becomes a Gap instead of a complete report', async () => {
  const partialTools: SkillNativeToolPort = {
    async invoke() {
      return {
        output: { status: 'partial_failed', summary: '只完成部分分析' },
        partialFailure: 'vision-brand-lab: partial_failed',
      };
    },
  };
  const result = await new SkillNativeExecutionEngine({
    llm: new CountingLlm(),
    tools: partialTools,
  }).execute({ plan: plan('single_skill') });

  assert.equal(result.status, 'partial');
  assert.ok(result.report?.gaps.some(({ id }) => id === 'tool:skill-1-final:search'));
});

test('a failed Skill uses its one frozen replacement and reports the downgrade', async () => {
  const replacementPlan = plan('single_skill');
  replacementPlan.invocations[0]!.failurePolicy = 'replace';
  replacementPlan.invocations[0]!.replacementSkill = skill('backup');
  const llm = new CountingLlm(new Set(['final']));
  const tools = new CountingTools();

  const result = await new SkillNativeExecutionEngine({ llm, tools }).execute({ plan: replacementPlan });

  assert.deepEqual(llm.calls, ['final', 'backup']);
  assert.deepEqual(tools.calls, ['final:search', 'backup:search']);
  assert.equal(result.status, 'partial');
  assert.equal(result.report?.title, 'backup report');
  assert.ok(result.report?.gaps.some(({ id }) => id === 'replacement:skill-1-final'));
});

test('a resumed replacement result keeps the replacement Skill identity', async () => {
  const replacementPlan = plan('single_skill');
  replacementPlan.invocations[0]!.failurePolicy = 'replace';
  replacementPlan.invocations[0]!.replacementSkill = skill('backup');
  const first = await new SkillNativeExecutionEngine({
    llm: new CountingLlm(new Set(['final'])),
    tools: new CountingTools(),
  }).execute({ plan: replacementPlan });
  assert.ok(first.report);

  const llm = new CountingLlm();
  const tools = new CountingTools();
  const steps: Array<{ skillId: string }> = [];
  const resumed = await new SkillNativeExecutionEngine({ llm, tools }).execute({
    plan: replacementPlan,
    priorResults: new Map([[
      replacementPlan.finalReportInvocationId,
      { skillId: 'backup', report: first.report },
    ]]),
    onStep: (step) => { steps.push(step); },
  });

  assert.deepEqual(llm.calls, []);
  assert.deepEqual(tools.calls, []);
  assert.equal(resumed.skillResults[0]?.skillId, 'backup');
  assert.equal(steps[0]?.skillId, 'backup');
});

test('a failed replacement does not recurse or create an empty report', async () => {
  const replacementPlan = plan('single_skill');
  replacementPlan.invocations[0]!.failurePolicy = 'replace';
  replacementPlan.invocations[0]!.replacementSkill = skill('backup');
  const llm = new CountingLlm(new Set(['final', 'backup']));

  const result = await new SkillNativeExecutionEngine({ llm, tools: new CountingTools() }).execute({
    plan: replacementPlan,
  });

  assert.deepEqual(llm.calls, ['final', 'backup']);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
});

test('a failed ReportResult is not promoted to a partial deliverable', async () => {
  class FailedReportLlm extends CountingLlm {
    override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      const result = await super.generateStructured<T>(options);
      (result.data as ReportResult).status = 'failed';
      return result;
    }
  }
  const result = await new SkillNativeExecutionEngine({
    llm: new FailedReportLlm(),
    tools: new CountingTools(),
  }).execute({ plan: plan('single_skill') });

  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
  assert.equal(result.skillResults[0]?.status, 'failed');
});

test('a table row with the wrong number of cells fails instead of losing content', async () => {
  class InvalidTableLlm extends CountingLlm {
    override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      const result = await super.generateStructured<T>(options);
      (result.data as ReportResult).sections[0]!.blocks = [{
        type: 'table',
        columns: ['A'],
        rows: [['one', 'silently lost before this guard']],
      }];
      return result;
    }
  }
  const result = await new SkillNativeExecutionEngine({
    llm: new InvalidTableLlm(),
    tools: new CountingTools(),
  }).execute({ plan: plan('single_skill') });

  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
  assert.match(result.skillResults[0]?.error ?? '', /wrong number of cells/u);
});

test('each Skill sees only its bound inputs and final synthesis receives every successful support result', async () => {
  const supportA = skill('support-a');
  const supportB = skill('support-b');
  const final = skill('final');
  const invocations = [
    { id: 'one', skill: supportA, dependsOn: [], failurePolicy: 'gap' as const },
    { id: 'two', skill: supportB, dependsOn: ['one'], failurePolicy: 'gap' as const },
    { id: 'three', skill: final, dependsOn: ['two'], failurePolicy: 'stop' as const },
  ];
  const chained: SolutionPlan = {
    ...plan('multi_skill'),
    invocations,
    finalReportInvocationId: 'three',
    requirement: {
      version: 'requirement-context-v1',
      goal: 'goal',
      scope: [],
      assumptions: [],
      gaps: [{ id: 'gap-a', message: 'A gap', skillIds: [supportA.id] }],
      inputs: [
        { inputId: 'a', source: 'conversation', value: 'support-a@example.com', skillIds: [supportA.id] },
        { inputId: 'b', source: 'conversation', value: 'B only', skillIds: [supportB.id] },
        { inputId: 'final', source: 'conversation', value: 'Final only', skillIds: [final.id] },
      ],
    },
  };
  const llm = new CountingLlm();
  await new SkillNativeExecutionEngine({ llm, tools: new CountingTools() }).execute({ plan: chained });

  const contexts = llm.contexts as Array<{
    requirement: SolutionPlan['requirement'];
    allowedSources: Array<{ id: string }>;
    upstreamReports: Array<{ invocationId: string }>;
  }>;
  assert.deepEqual(contexts.map(({ requirement }) => requirement.inputs.map(({ inputId }) => inputId)), [
    ['a'], ['b'], ['final'],
  ]);
  assert.equal(contexts[0]?.requirement.inputs[0]?.value, '[REDACTED_EMAIL]');
  assert.deepEqual(contexts[0]?.requirement.gaps.map(({ id }) => id), ['gap-a']);
  assert.deepEqual(contexts[1]?.requirement.gaps, []);
  assert.deepEqual(contexts[2]?.upstreamReports.map(({ invocationId }) => invocationId), ['one', 'two']);
  assert.ok(contexts[2]?.allowedSources.some(({ id }) => id === 'source-real'));
});

test('the complete scoped Requirement is redacted before model egress', async () => {
  const redactionPlan = plan('single_skill');
  redactionPlan.requirement = {
    ...redactionPlan.requirement,
    goal: '联系 owner@example.com 或 13800138000',
    scope: ['负责人 backup@example.com'],
    assumptions: ['电话 13900139000'],
    gaps: [{ id: 'gap', message: '请找 reviewer@example.com', skillIds: ['final'] }],
  };
  const llm = new CountingLlm();

  await new SkillNativeExecutionEngine({ llm, tools: new CountingTools() }).execute({ plan: redactionPlan });

  const requirement = (llm.contexts[0] as { requirement: SolutionPlan['requirement'] }).requirement;
  const serialized = JSON.stringify(requirement);
  assert.ok(!serialized.includes('owner@example.com'));
  assert.ok(!serialized.includes('13800138000'));
  assert.ok(!serialized.includes('backup@example.com'));
  assert.ok(!serialized.includes('13900139000'));
  assert.ok(!serialized.includes('reviewer@example.com'));
  assert.match(serialized, /REDACTED_EMAIL/u);
  assert.match(serialized, /REDACTED_PHONE/u);
});

test('sensitive business data anywhere in the scoped Requirement blocks model egress', async () => {
  const blockedPlan = plan('single_skill');
  blockedPlan.requirement.assumptions = ['包含商业机密'];
  const llm = new CountingLlm();
  const tools = new CountingTools();

  const result = await new SkillNativeExecutionEngine({ llm, tools }).execute({ plan: blockedPlan });

  assert.equal(result.status, 'failed');
  assert.deepEqual(llm.calls, []);
  assert.deepEqual(tools.calls, []);
  assert.match(result.skillResults[0]?.error ?? '', /sensitive business data/u);
});

test('an image block may reference only an Artifact authorized in the invocation context', async () => {
  class ForgedImageLlm extends CountingLlm {
    override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      const result = await super.generateStructured<T>(options);
      const report = result.data as ReportResult;
      report.sections[0]!.blocks = [{ type: 'image', artifactId: 'forged-artifact', alt: '伪造图片' }];
      return result;
    }
  }
  const result = await new SkillNativeExecutionEngine({
    llm: new ForgedImageLlm(),
    tools: new CountingTools(),
  }).execute({ plan: plan('single_skill') });

  assert.equal(result.status, 'partial');
  assert.equal(result.report?.sections[0]?.blocks[0]?.type, 'text');
  assert.ok(result.report?.gaps.some(({ id }) => id.startsWith('image:final:')));
  assert.ok(result.warnings.some((warning) => warning.includes('unknown image artifact')));
});

test('renderer escapes untrusted content and never emits remote image resources', () => {
  const report: ReportResult = {
    version: 'report-result-v1',
    title: '<script>alert(1)</script>',
    summary: '" onmouseover="alert(1)',
    status: 'partial',
    sections: [{
      id: 'x\" onclick=\"alert(1)',
      title: '<img src=x onerror=alert(1)>',
      blocks: [
        { type: 'text', text: '<script>bad()</script>' },
        { type: 'list', items: ['<b>unsafe</b>'] },
        { type: 'table', columns: ['<x>'], rows: [['&']] },
        { type: 'image', artifactId: 'remote', alt: '<bad>' },
      ],
    }],
    sources: [{ id: 'source', kind: 'tool', label: '<source>', url: 'javascript:alert(1)' }],
    gaps: [{ id: 'gap', message: '<gap>', skillIds: ['skill'] }],
  };
  const html = renderReportHtml(report, { artifactUrl: () => 'https://evil.example/image.png' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>bad()</script>'));
  assert.ok(!html.includes('onclick="alert(1)'));
  assert.ok(!html.includes('https://evil.example/image.png'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.match(html, /@page\{size:A4/u);

  const markdown = renderReportMarkdown({
    ...report,
    sections: [{
      ...report.sections[0]!,
      blocks: [{ type: 'table', columns: ['列 | 一'], rows: [['第一行\n第二行']] }],
    }],
  });
  assert.ok(markdown.includes('| 列 \\| 一 |'));
  assert.ok(markdown.includes('| 第一行<br>第二行 |'));
});

test('Knowledge content and its source id enter the frozen Skill execution context', async () => {
  const llm = new CountingLlm();
  const frozenPlan = plan('single_skill');
  frozenPlan.invocations[0]!.skill.knowledge = [{
    id: 'method-one',
    required: true,
    title: '方法一',
    sourcePath: 'knowledge-base/methods/method-one.md',
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'approved',
    content: '只使用这段冻结的方法正文。',
  }];

  const result = await new SkillNativeExecutionEngine({ llm, tools: new CountingTools() }).execute({ plan: frozenPlan });
  assert.equal(result.status, 'complete');
  const context = llm.contexts[0] as {
    knowledge: Array<{ id: string; content: string }>;
    allowedSources: Array<{ id: string; kind: string }>;
  };
  assert.deepEqual(context.knowledge, [{
    id: 'knowledge:method-one',
    title: '方法一',
    sourcePath: 'knowledge-base/methods/method-one.md',
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'approved',
    content: '只使用这段冻结的方法正文。',
  }]);
  assert.ok(context.allowedSources.some((source) => source.id === 'knowledge:method-one' && source.kind === 'knowledge'));
});

class CapturingAdapter implements ToolAdapter {
  readonly adapterType = 'rest_json' as const;
  readonly implementationId = 'skill-native-schema-test';
  readonly executionMode = 'fake' as const;
  readonly inputs = new Map<string, object>();

  async invoke(options: ToolInvokeOptions): Promise<ToolInvokeResult> {
    this.inputs.set(options.toolId, options.input);
    const output = options.toolId === 'joyspace-read'
      ? {
          version: 'joyspace-read-output-v1',
          operation: 'search',
          status: 'empty',
          documents: [],
          runtime: { o2: 'test', webcli: 'test' },
        }
      : options.toolId === 'tavily-web-search' || options.toolId === 'ai-spider-search'
        ? { results: [] }
        : options.toolId === 'virtual-user-lab'
          ? {
              status: 'insufficient_inputs',
              isSimulated: true,
              summary: '输入不足',
              digitalPersonas: [],
              reviews: [],
              aggregate: {
                scoreSummary: {},
                sharedPainPoints: [],
                sharedHighlights: [],
                divergences: [],
                churnRisks: [],
              },
              recommendations: [],
              warnings: [],
              boundaryNotes: ['仅供测试'],
            }
          : { status: 'insufficient_inputs' };
    return {
      output,
      latencyMs: 1,
      receipt: {
        declaredAdapterType: options.manifest.adapter_type,
        resolvedAdapterType: options.manifest.adapter_type,
        implementationId: this.implementationId,
        executionMode: this.executionMode,
        endpointHost: null,
        status: 'ok',
        latencyMs: 1,
      },
    };
  }
}

test('every active Tool has a schema-valid native input mapping', async () => {
  const adapter = new CapturingAdapter();
  const port = new RegistryToolPort(adapter);
  const toolIds = [
    'joyspace-read',
    'tavily-web-search',
    'ai-spider-search',
    'aesthetic-quant-lab',
    'attention-analysis-lab',
    'experience-model-lab',
    'virtual-user-lab',
    'vision-brand-lab',
  ];
  const imageBytes = Buffer.from([137, 80, 78, 71]);
  const toolSkill = skill('tool-test');
  const requirement: SolutionPlan['requirement'] = {
    version: 'requirement-context-v1',
    goal: '分析测试品类',
    scope: ['测试品类'],
    assumptions: [],
    gaps: [],
    inputs: [
      { inputId: 'research_goal', source: 'conversation', value: '分析测试品类', skillIds: [toolSkill.id] },
      { inputId: 'competitors', source: 'conversation', value: ['甲', '乙'], skillIds: [toolSkill.id] },
      { inputId: 'dimensions', source: 'conversation', value: ['体验', '商业化'], skillIds: [toolSkill.id] },
      {
        inputId: 'notes',
        source: 'upload',
        value: { content: '联系 researcher@example.com 或 13800138000' },
        skillIds: [toolSkill.id],
      },
      {
        inputId: 'designImage',
        source: 'upload',
        value: { artifactId: 'image-1', name: 'screen.png', mediaType: 'image/png' },
        skillIds: [toolSkill.id],
      },
    ],
  };
  for (const toolId of toolIds) {
    const invocation = port.invoke({
      toolId,
      invocationId: 'skill-1-tool-test',
      skill: toolSkill,
      requirement,
      signal: new AbortController().signal,
      readArtifact: async (artifactId) => artifactId === 'image-1' ? {
        id: artifactId,
        taskId: 'task',
        ownerUserId: 'owner',
        projectId: 'project',
        inputId: 'designImage',
        fileName: 'screen.png',
        mediaType: 'image/png',
        bytes: imageBytes,
        contentSha256: `sha256:${'b'.repeat(64)}`,
      } : null,
    });
    if (['aesthetic-quant-lab', 'attention-analysis-lab', 'experience-model-lab', 'virtual-user-lab', 'vision-brand-lab'].includes(toolId)) {
      await assert.rejects(invocation, /insufficient_inputs/u);
    } else {
      await invocation;
    }
  }

  const deduplicated = await port.invoke({
    toolId: 'tavily-web-search',
    invocationId: 'skill-1-competitive-web-research',
    skill: skill('competitive-web-research'),
    requirement,
    signal: new AbortController().signal,
  });

  assert.deepEqual([...adapter.inputs.keys()], toolIds);
  assert.deepEqual((adapter.inputs.get('tavily-web-search') as { query: string[] }).query, [
    '甲 体验 分析测试品类',
    '甲 商业化 分析测试品类',
    '乙 体验 分析测试品类',
    '乙 商业化 分析测试品类',
  ]);
  assert.equal(typeof (adapter.inputs.get('aesthetic-quant-lab') as { designImage: { dataUrl: string } }).designImage.dataUrl, 'string');
  assert.equal((adapter.inputs.get('attention-analysis-lab') as { image: { id: string } }).image.id, 'image-1');
  assert.equal((adapter.inputs.get('vision-brand-lab') as { designImages: unknown[] }).designImages.length, 1);
  assert.match(
    (adapter.inputs.get('virtual-user-lab') as { artifactText: string }).artifactText,
    /联系 \[REDACTED_EMAIL\] 或 \[REDACTED_PHONE\]$/u,
  );

  const duplicateCompetitors = structuredClone(requirement);
  duplicateCompetitors.inputs = duplicateCompetitors.inputs.map((item) => (
    item.inputId === 'competitors' ? { ...item, value: ['甲', '甲'] }
      : item.inputId === 'dimensions' ? { ...item, value: [] }
        : item
  ));
  await port.invoke({
    toolId: 'tavily-web-search',
    invocationId: 'skill-2-competitive-web-research',
    skill: skill('competitive-web-research'),
    requirement: duplicateCompetitors,
    signal: new AbortController().signal,
  });
  assert.equal((adapter.inputs.get('tavily-web-search') as { query: string }).query, '甲 分析测试品类');
  assert.equal(deduplicated.partialFailure, 'tavily-web-search: empty results');
});

test('Tavily rejects oversized query matrices instead of silently truncating them', async () => {
  const adapter = new CapturingAdapter();
  const port = new RegistryToolPort(adapter);
  const nativeSkill = skill('competitive-web-research');
  const requirement = plan('single_skill').requirement;
  requirement.inputs = [{
    inputId: 'competitors',
    source: 'conversation',
    value: Array.from({ length: 100 }, (_, index) => `竞品${index}`),
    skillIds: [nativeSkill.id],
  }, {
    inputId: 'dimensions',
    source: 'conversation',
    value: Array.from({ length: 100 }, (_, index) => `维度${index}`),
    skillIds: [nativeSkill.id],
  }];

  await assert.rejects(
    port.invoke({
      toolId: 'tavily-web-search',
      invocationId: 'skill-1-competitive-web-research',
      skill: nativeSkill,
      requirement,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ToolInvocationError);
      assert.equal(error.kind, 'capability');
      assert.match(error.sanitizedMessage, /10000.*20/u);
      return true;
    },
  );
  assert.equal(adapter.inputs.has('tavily-web-search'), false);
});

test('single-image Tools run once for every uploaded image', async () => {
  const inputs: object[] = [];
  const adapter: ToolAdapter = {
    adapterType: 'rest_json',
    implementationId: 'multi-image-test',
    executionMode: 'fake',
    async invoke(options): Promise<ToolInvokeResult> {
      inputs.push(options.input);
      return {
        output: { status: 'available' },
        latencyMs: 1,
        receipt: {
          declaredAdapterType: options.manifest.adapter_type,
          resolvedAdapterType: options.manifest.adapter_type,
          implementationId: 'multi-image-test',
          executionMode: 'fake',
          endpointHost: null,
          status: 'ok',
          latencyMs: 1,
        },
      };
    },
  };
  const nativeSkill = skill('competitive-app-analysis');
  const requirement = plan('single_skill').requirement;
  requirement.inputs = [{
    inputId: 'competitor_screenshots',
    source: 'upload',
    value: [{ artifactId: 'image-1' }, { artifactId: 'image-2' }],
    skillIds: [nativeSkill.id],
  }];

  const result = await new RegistryToolPort(adapter).invoke({
    toolId: 'aesthetic-quant-lab',
    invocationId: 'skill-1-competitive-app-analysis',
    skill: nativeSkill,
    requirement,
    signal: new AbortController().signal,
    readArtifact: async (artifactId) => ({
      id: artifactId,
      taskId: 'task',
      ownerUserId: 'owner',
      projectId: 'project',
      inputId: 'competitor_screenshots',
      fileName: `${artifactId}.png`,
      mediaType: 'image/png',
      bytes: Buffer.from([137, 80, 78, 71]),
      contentSha256: `sha256:${'b'.repeat(64)}`,
    }),
  });

  assert.deepEqual(inputs.map((value) => (
    value as { designImage: { id: string } }
  ).designImage.id), ['image-1', 'image-2']);
  assert.deepEqual(result.output, {
    results: [{ status: 'available' }, { status: 'available' }],
  });
});

test('Joyspace, AI Spider, and Lab outputs expose traceable native sources', async () => {
  const adapter: ToolAdapter = {
    adapterType: 'rest_json',
    implementationId: 'source-shapes',
    executionMode: 'fake',
    async invoke(options): Promise<ToolInvokeResult> {
      const output = options.toolId === 'joyspace-read'
        ? {
            version: 'joyspace-read-output-v1',
            operation: 'view',
            status: 'available',
            document: {
              title: '内部研究文档',
              body: '正文',
              author: '研究员',
              url: 'https://joyspace.jd.com/doc/123',
              contentSha256: `sha256:${'a'.repeat(64)}`,
            },
            runtime: { o2: 'test', webcli: 'test' },
          }
        : options.toolId === 'ai-spider-search'
          ? {
              results: [{
                source_app: '竞品 App',
                scenario: '商详页',
                oss_url: 'https://oss.example.com/screen.png',
                design_analysis: '层级清晰',
                ops_analysis: null,
                search_mode: 'vector',
              }],
            }
          : { status: 'available', summary: '体验模型匹配完成' };
      return {
        output,
        latencyMs: 1,
        receipt: {
          declaredAdapterType: options.manifest.adapter_type,
          resolvedAdapterType: options.manifest.adapter_type,
          implementationId: 'source-shapes',
          executionMode: 'fake',
          endpointHost: null,
          status: 'ok',
          latencyMs: 1,
        },
        ...(options.toolId === 'joyspace-read' ? {
          knowledgeAttachments: [{
            attachmentId: 'doc-123',
            title: '内部研究文档',
            body: '正文',
            sourceUrl: 'https://joyspace.jd.com/doc/123',
            author: '研究员',
            updatedAt: null,
            contentSha256: `sha256:${'a'.repeat(64)}`,
            sensitivity: 'internal' as const,
          }],
        } : {}),
      };
    },
  };
  const port = new RegistryToolPort(adapter);
  const nativeSkill = skill('source-test');
  const requirement = plan('single_skill').requirement;
  const invoke = (toolId: string) => port.invoke({
    toolId,
    invocationId: 'skill-1-source-test',
    skill: nativeSkill,
    requirement,
    signal: new AbortController().signal,
  });

  const joyspace = await invoke('joyspace-read');
  const spider = await invoke('ai-spider-search');
  const lab = await invoke('experience-model-lab');

  assert.ok(joyspace.sources?.some(({ label, url }) => label === '内部研究文档' && url === 'https://joyspace.jd.com/doc/123'));
  assert.ok(spider.sources?.some(({ label, url }) => label === '竞品 App · 商详页' && url === 'https://oss.example.com/screen.png'));
  assert.ok(lab.sources?.some(({ label, url }) => label === '体验模型实验室输出' && url === undefined));
});

test('Tool output and both success and failure receipts are persisted', async () => {
  const calls: SkillNativeToolCallRecordInput[] = [];
  const persistence: SkillNativeToolPersistence = {
    async writeArtifact() {},
    async recordToolCall(call) { calls.push(call); },
  };
  const successAdapter: ToolAdapter = {
    adapterType: 'tavily',
    implementationId: 'test-success',
    executionMode: 'fake',
    async invoke(options) {
      return {
        output: { results: [{ title: 'Source', url: 'https://example.com', snippet: 'Contact owner@example.com' }] },
        latencyMs: 1,
        receipt: {
          declaredAdapterType: options.manifest.adapter_type,
          resolvedAdapterType: 'tavily',
          implementationId: 'test-success',
          executionMode: 'fake',
          endpointHost: 'example.com',
          status: 'ok',
          latencyMs: 1,
        },
      };
    },
  };
  const requirement = plan('single_skill').requirement;
  const nativeSkill = skill('receipt-test');
  await new RegistryToolPort(successAdapter, undefined, persistence).invoke({
    toolId: 'tavily-web-search',
    invocationId: 'skill-1-receipt-test',
    skill: nativeSkill,
    requirement,
    signal: new AbortController().signal,
    attemptId: 'attempt-success',
    scope: { taskId: 'task', ownerUserId: 'owner', projectId: 'project' },
  });

  const failureAdapter: ToolAdapter = {
    adapterType: 'tavily',
    implementationId: 'test-failure',
    executionMode: 'fake',
    async invoke(options): Promise<ToolInvokeResult> {
      throw new ToolInvocationError(options.toolId, {
        kind: 'network',
        retryable: true,
        sanitizedMessage: 'network unavailable',
        receipt: {
          declaredAdapterType: options.manifest.adapter_type,
          resolvedAdapterType: 'tavily',
          implementationId: 'test-failure',
          executionMode: 'fake',
          endpointHost: 'example.com',
          status: 'failed',
          latencyMs: 1,
        },
      });
    },
  };
  await assert.rejects(
    new RegistryToolPort(failureAdapter, undefined, persistence).invoke({
      toolId: 'tavily-web-search',
      invocationId: 'skill-1-receipt-test',
      skill: nativeSkill,
      requirement,
      signal: new AbortController().signal,
      attemptId: 'attempt-failure',
      scope: { taskId: 'task', ownerUserId: 'owner', projectId: 'project' },
    }),
    /network unavailable/u,
  );

  assert.deepEqual(calls.map(({ status }) => status), ['succeeded', 'failed']);
  assert.deepEqual(calls[0]?.output, {
    results: [{ title: 'Source', url: 'https://example.com', snippet: 'Contact [REDACTED_EMAIL]' }],
  });
  assert.equal(calls[0]?.receipt?.status, 'ok');
  assert.equal(calls[1]?.failure?.kind, 'network');
  assert.equal(calls[1]?.receipt?.status, 'failed');
});

test('renderer allows bounded local data images and rejects unsafe data MIME types', () => {
  const report: ReportResult = {
    version: 'report-result-v1',
    title: '图片报告',
    summary: '摘要',
    status: 'complete',
    sections: [{
      id: 'images',
      title: '图片',
      blocks: [
        { type: 'image', artifactId: 'safe', alt: '安全图片' },
        { type: 'image', artifactId: 'unsafe', alt: '不安全图片' },
      ],
    }],
    sources: [],
    gaps: [],
  };
  const html = renderReportHtml(report, {
    artifactUrl: (artifactId) => artifactId === 'safe'
      ? 'data:image/png;base64,iVBORw0KGgo='
      : 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
  });
  assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/u);
  assert.doesNotMatch(html, /image\/svg\+xml/u);
  assert.match(html, /图片不可用：不安全图片/u);

  const markdown = renderReportMarkdown(report, {
    artifactUrl: (artifactId) => artifactId === 'safe'
      ? 'data:image/png;base64,iVBORw0KGgo='
      : 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
  });
  assert.match(markdown, /!\[安全图片\]\(data:image\/png;base64,iVBORw0KGgo=\)/u);
  assert.doesNotMatch(markdown, /image\/svg\+xml/u);
  assert.match(markdown, /图片不可用：不安全图片/u);
});
