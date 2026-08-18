import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolActorRunner } from '../apps/orchestrator-runtime/src/runners/tool-runner.ts';
import { SkillActorRunner } from '../apps/orchestrator-runtime/src/runners/skill-runner.ts';
import { LlmActorRunner } from '../apps/orchestrator-runtime/src/runners/llm-runner.ts';
import { ReviewerActorRunner } from '../apps/orchestrator-runtime/src/runners/reviewer-runner.ts';
import type { ExecCtx } from '../apps/orchestrator-runtime/src/runners/actor-runner.ts';
import type { PlanStep } from '../apps/orchestrator-runtime/src/plan-types.ts';
import type { RunWorkspace } from '../apps/orchestrator-runtime/src/run-workspace.ts';
import type { LLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type { ToolAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import type { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// Runner 单测:聚焦 Runner 自身语义(空占位清洗、图像回填、artifact.kind 路由等),
// 通过 interface 测(Runner 契约),不与 orchestrator 端到端集成重复。

function makeCtx(over: Partial<ExecCtx> = {}): ExecCtx {
  const writtenRefs: Array<{ stepNo: number; output: unknown }> = [];
  const ws = {
    uri: '/tmp/fake-ws',
    writeToolOutput(stepNo: number, output: unknown): string {
      writtenRefs.push({ stepNo, output });
      return `/tmp/fake-ws/tool_outputs/step${stepNo}.json`;
    },
  } as unknown as RunWorkspace;
  return {
    taskId: 't1',
    conversationId: 'c1',
    researchGoal: '直播 数字人 竞品',
    ws,
    plan: { steps: [], task_id: 't1' },
    graphHash: 'h',
    uploads: [],
    toolOutputs: [],
    reviewNotes: [],
    stepFailures: [],
    usedCapabilities: [],
    toolOutputRefs: [],
    ...over,
  };
}

// ---- ToolActorRunner --------------------------------------------------

test('tool-runner: tool 不存在时抛错', async () => {
  const skillLoader = { getTool: () => null } as unknown as SkillLoader;
  const runner = new ToolActorRunner(skillLoader, {} as ToolAdapter, {} as SchemaValidator);
  const step: PlanStep = { step_no: 1, step_name: 't', actor_type: 'tool', actor_id: 'ghost' };
  await assert.rejects(() => runner.run(step, makeCtx()), /ghost/);
});

test('tool-runner: 空占位清洗 + 图像 dataUrl 回填', async () => {
  // 用真的 vision-brand-lab manifest(有 image_input_fields.role=design)。
  const skillLoader = {
    getTool: (id: string) =>
      id === 'vision-brand-lab' ? { id: 'vision-brand-lab', path: 'tools/vision-brand-lab/manifest.yaml' } : null,
  } as unknown as SkillLoader;

  let capturedInput: Record<string, unknown> | undefined;
  const adapter = {
    invoke: async (opts: { toolId: string; input: object; manifest: unknown }) => {
      capturedInput = opts.input as Record<string, unknown>;
      return { output: { snapshot_id: 's1', summary: '' } };
    },
  } as unknown as ToolAdapter;

  // validator 不做实际校验(避免绑死 schema 结构),只允许通过。
  const validator = { validateFileOrThrow: () => undefined } as unknown as SchemaValidator;

  const runner = new ToolActorRunner(skillLoader, adapter, validator);

  const step: PlanStep = {
    step_no: 1,
    step_name: '视觉品牌评估',
    actor_type: 'tool',
    actor_id: 'vision-brand-lab',
    input: {
      briefText: 'x',
      // LLM 生成的空占位:顶层空对象 + 数组内空对象都应被剔除
      designImages: [{}],
      extraObj: {},
    },
  };
  const ctx = makeCtx({ uploads: [{ role: 'designImage', dataUrl: 'data:image/png;base64,AAAA' }] });

  const artifact = await runner.run(step, ctx);

  // 关键 1:空占位剔除(extraObj 应被删除),但图像回填后 designImages 应存在
  assert.equal(capturedInput?.extraObj, undefined, 'extraObj 空占位应被剔除');
  // 关键 2:designImages 被上传 dataUrl 覆盖(multiple=true → 包一层数组)
  const imgs = capturedInput?.designImages;
  assert.ok(Array.isArray(imgs) && imgs.length === 1, 'designImages 应回填为 [{dataUrl}]');
  assert.equal((imgs?.[0] as { dataUrl: string })?.dataUrl, 'data:image/png;base64,AAAA');

  // 关键 3:artifact.kind == 'tool_output' 且 manifestHash 存在
  assert.equal(artifact.kind, 'tool_output');
  assert.equal(artifact.actorId, 'vision-brand-lab');
  assert.ok(artifact.outputRef.includes('step1.json'));
  if (artifact.kind === 'tool_output') {
    assert.ok(artifact.manifestHash, 'manifestHash 应写出');
  }
});

// ---- SkillActorRunner -------------------------------------------------

test('skill-runner: skill 不存在时抛错', async () => {
  const skillLoader = { getSkill: () => null } as unknown as SkillLoader;
  const runner = new SkillActorRunner(
    {} as LLMClient,
    skillLoader,
    {} as SchemaValidator,
  );
  const step: PlanStep = { step_no: 1, step_name: 's', actor_type: 'skill', actor_id: 'ghost' };
  await assert.rejects(() => runner.run(step, makeCtx()), /ghost/);
});

test('skill-runner:使用 effective output schema 校验统一 Skill 输出', async () => {
  const outputSchema = { type: 'object', required: ['version'] };
  const skillLoader = {
    getSkill: (id: string) => (id === 's1' ? { id: 's1', name: 'S1', output_schema: 'envelope.json' } : null),
    loadSkillBody: () => ({ body: 'BODY', hash: 'skill-hash-1', path: 'skills/s1/SKILL.md' }),
    loadSkillSchemas: () => ({ output: outputSchema }),
  } as unknown as SkillLoader;

  const llm = {
    generateStructured: async () => ({
      data: { version: 'skill-output-v2' },
      tokens: { prompt: 10, completion: 20, total: 30 },
    }),
    generateText: async () => ({ text: '', tokens: { prompt: 0, completion: 0, total: 0 } }),
  } as unknown as LLMClient;

  let validated: unknown;
  const validator = {
    validateSchemaOrThrow: (schema: object) => {
      validated = schema;
    },
  } as unknown as SchemaValidator;

  const runner = new SkillActorRunner(llm, skillLoader, validator);
  const step: PlanStep = { step_no: 2, step_name: 's', actor_type: 'skill', actor_id: 's1' };
  const artifact = await runner.run(step, makeCtx());

  assert.equal(validated, outputSchema);
  assert.equal(artifact.kind, 'skill_output');
  if (artifact.kind === 'skill_output') {
    assert.equal(artifact.manifestHash, 'skill-hash-1');
    assert.deepEqual(artifact.output, { version: 'skill-output-v2' });
    assert.equal(artifact.tokens?.total, 30);
  }
});

// ---- LlmActorRunner ---------------------------------------------------

test('llm-runner: artifact 是 llm_note、output 形如 {note}', async () => {
  const llm = {
    generateStructured: async () => ({ data: {}, tokens: { prompt: 0, completion: 0, total: 0 } }),
    generateText: async () => ({ text: '简明小结', tokens: { prompt: 3, completion: 5, total: 8 } }),
  } as unknown as LLMClient;

  const runner = new LlmActorRunner(llm);
  const step: PlanStep = { step_no: 3, step_name: '中间总结', actor_type: 'llm', actor_id: 'llm-summary' };
  const artifact = await runner.run(step, makeCtx());

  assert.equal(artifact.kind, 'llm_note');
  if (artifact.kind === 'llm_note') {
    assert.deepEqual(artifact.output, { note: '简明小结' });
    assert.equal(artifact.tokens?.total, 8);
  }
});

// ---- ReviewerActorRunner ---------------------------------------------

test('reviewer-runner: artifact 是 review_note(不进 toolOutputs)', async () => {
  const llm = {
    generateStructured: async () => ({ data: {}, tokens: { prompt: 0, completion: 0, total: 0 } }),
    generateText: async () => ({ text: '未标注来源', tokens: { prompt: 4, completion: 2, total: 6 } }),
  } as unknown as LLMClient;

  const runner = new ReviewerActorRunner(llm);
  const step: PlanStep = { step_no: 4, step_name: '复核', actor_type: 'reviewer', actor_id: 'reviewer-quality' };
  const artifact = await runner.run(step, makeCtx());

  assert.equal(artifact.kind, 'review_note');
  if (artifact.kind === 'review_note') {
    assert.equal(artifact.review, '未标注来源');
    assert.equal(artifact.tokens?.total, 6);
  }
});
