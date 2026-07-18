import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { buildOrchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { createUser, createConversation, listExecutionLog, listArtifacts } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// Task A 集成验收:$ 直呼无 schema 的 KB skill,执行端到端跑完(修复前崩在 loadSkillBody/loadSkillSchemas)。
// 强制 Mock LLM:确定性、不花 token、不依赖内网。
process.env.LLM_PROVIDER = 'mock';

let userId: string;
let convId: string;
const cleanupDirs: string[] = [];

before(async () => {
  const u = await createUser({ email: `dexec-${Date.now()}@test.local`, displayName: 'dexec', passwordHash: 'x' });
  userId = u.id;
  const c = await createConversation({ ownerUserId: userId, title: 'dexec-conv' });
  convId = c.id;
});

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

test('$ 直呼无 schema KB skill → executePhase 跑完、有 report、skill 步 succeeded', async () => {
  const orch = buildOrchestrator();

  // 计划:确定性单步 skill 计划(competitive-analysis 无 JSON schema)。
  const plan = await orch.planPhase({
    originalInput: '$competitive-analysis 对比拼多多直播',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(plan.workspaceUri);

  const steps = plan.candidates[0].steps;
  assert.equal(steps[0].actor_id, 'competitive-analysis', '直呼应命中该 KB skill');

  // 选中直呼那份候选(直呼支路 id='depth'),finalize 出 plan.json
  await orch.selectPlan({ taskId: plan.taskId, candidateId: 'depth' });

  // 执行:模拟确认后执行。修复前会崩在 loadSkillBody(读目录 EISDIR)/loadSkillSchemas(undefined path)。
  const { reportArtifactId } = await orch.executePhase({ taskId: plan.taskId, conversationId: convId });
  assert.ok(reportArtifactId, '应产出 report artifact');

  const log = await listExecutionLog(plan.taskId);
  const skillStep = log.find((l) => l.actor_id === 'competitive-analysis');
  assert.ok(skillStep, '应有 competitive-analysis 步日志');
  assert.equal(skillStep?.status, 'succeeded', '无 schema KB skill 步应 succeeded');

  const arts = await listArtifacts(plan.taskId);
  assert.ok(arts.some((a) => a.artifact_type === 'report'), '应有 report 类型 artifact');
});
