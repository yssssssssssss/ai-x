import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { buildOrchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { createUser, createConversation, listExecutionLog } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// $ 直呼支路验收:跳过引导循环 + 路由 LLM,产出单步 skill 计划,仍过确认闸门。
// 强制走 Mock LLM(确定性、不花 token、不依赖内网)。
process.env.LLM_PROVIDER = 'mock';

let userId: string;
let convId: string;
const cleanupDirs: string[] = [];

before(async () => {
  const u = await createUser({ email: `direct-${Date.now()}@test.local`, displayName: 'direct', passwordHash: 'x' });
  userId = u.id;
  const c = await createConversation({ ownerUserId: userId, title: 'direct-conv' });
  convId = c.id;
});

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

test('直呼命中 active skill → 单步 skill 计划、activatedNodes 空、无 execution_log', async () => {
  const orch = buildOrchestrator();
  // competitive-analysis 是 registry 中 active 的 KB 派生 skill(orchestrator/skill-registry.yaml)。
  const r = await orch.planPhase({
    originalInput: '$competitive-analysis 对比拼多多直播',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(r.workspaceUri);

  // 跳过引导循环:不激活任何决策节点
  assert.deepEqual(r.activatedNodes, [], '直呼不应激活决策节点');

  // 确定性单步 skill 计划
  const steps = (r.plan as { steps: Array<{ actor_type: string; actor_id: string }> }).steps;
  assert.equal(steps.length, 1, '直呼应为单步计划');
  assert.equal(steps[0].actor_type, 'skill');
  assert.equal(steps[0].actor_id, 'competitive-analysis');

  // 确认闸门未越过:planPhase 后无 execution_log
  const log = await listExecutionLog(r.taskId);
  assert.equal(log.length, 0, '确认前不得有 execution_log');
});

test('直呼未知 skill → 抛错并列可用清单', async () => {
  const orch = buildOrchestrator();
  // 名字须字母开头才会进直呼支路;此 id 不在 registry → getSkill 返回 null → 抛错列清单。
  await assert.rejects(
    () => orch.planPhase({
      originalInput: '$nonexistent-skill-xyz 随便什么参数',
      conversationId: convId, ownerUserId: userId,
    }),
    (err: Error) => {
      assert.match(err.message, /未知 skill/);
      assert.match(err.message, /可用 skill/);
      return true;
    },
  );
});
