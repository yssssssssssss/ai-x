import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { MockLLMClient, defaultFixtures } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { FakeO2Adapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { Orchestrator, collectParallelToolBatch, type PlanStep } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { createConversation, createUser } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

process.env.LLM_PROVIDER = 'mock';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class DelayedFakeAdapter extends FakeO2Adapter {
  active = 0;
  maxActive = 0;

  override async invoke(opts: Parameters<FakeO2Adapter['invoke']>[0]) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await wait(140);
      return await super.invoke(opts);
    } finally {
      this.active -= 1;
    }
  }
}

const cleanupDirs: string[] = [];
let userId: string;
let conversationId: string;

before(async () => {
  const user = await createUser({ email: `parallel-${Date.now()}@test.local`, displayName: 'parallel', passwordHash: 'x' });
  userId = user.id;
  const conversation = await createConversation({ ownerUserId: userId, title: 'parallel' });
  conversationId = conversation.id;
});

after(async () => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  await closePool();
});

test('仅连续的显式独立工具步骤组成并发批次', () => {
  const steps: PlanStep[] = [
    { step_no: 1, step_name: '工具一', actor_type: 'tool', actor_id: 'a', depends_on: [] },
    { step_no: 2, step_name: '工具二', actor_type: 'tool', actor_id: 'b', depends_on: [] },
    { step_no: 3, step_name: 'Skill', actor_type: 'skill', actor_id: 's', depends_on: [1, 2] },
  ];
  assert.deepEqual(collectParallelToolBatch(steps, 0).map((step) => step.step_no), [1, 2]);
  assert.deepEqual(collectParallelToolBatch([{ ...steps[0], depends_on: undefined }], 0).map((step) => step.step_no), [1]);
  assert.deepEqual(collectParallelToolBatch(steps, 0, 1).map((step) => step.step_no), [1]);
});

test('显式独立工具并发执行，后续 reviewer 仍等待批次完成', async () => {
  const fixtures = structuredClone(defaultFixtures) as Record<string, unknown>;
  (fixtures['execution-plan-candidates'] as { candidates: Array<{ id: string; steps: unknown[] }> }).candidates[0] = {
    id: 'depth',
    title: '并发检索',
    rationale: '两个检索工具互不依赖。',
    tradeoffs: '受并发上限控制。',
    steps: [
      { step_no: 1, step_name: '公开资料检索', actor_type: 'tool', actor_id: 'tavily-web-search', input: { query: '数字人' }, depends_on: [] },
      { step_no: 2, step_name: '内部资料检索', actor_type: 'tool', actor_id: 'joyspace-search', input: { query: '数字人' }, depends_on: [] },
      { step_no: 3, step_name: '质量复核', actor_type: 'reviewer', actor_id: 'reviewer', depends_on: [1, 2] },
    ],
    assumptions: [],
  } as never;
  const toolAdapter = new DelayedFakeAdapter();
  const runtime = buildRuntime({ llm: new MockLLMClient(fixtures), toolAdapter });
  const orchestrator = new Orchestrator(runtime);
  const plan = await orchestrator.planPhase({ originalInput: '并发检索测试', conversationId, ownerUserId: userId });
  cleanupDirs.push(plan.workspaceUri);
  await orchestrator.selectPlan({ taskId: plan.taskId, candidateId: 'depth' });

  const result = await orchestrator.executePhase({ taskId: plan.taskId, conversationId });

  assert.equal(result.status, 'completed');
  assert.equal(toolAdapter.maxActive, 2, '两个无依赖工具步骤必须同时执行');
});
