import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { FakeO2Adapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { createUser, createConversation, listExecutionLog, listArtifacts } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// P0-01 验收:计划-确认-执行闸门、执行写日志、失败回放。
// 碰真实库:需先 createdb user_research_ai && pnpm db:migrate。
// 单测强制走 Mock LLM:确定性、不花 token、不依赖内网(不受 .env 默认 gateway 影响)。
process.env.LLM_PROVIDER = 'mock';

let userId: string;
let convId: string;
const cleanupDirs: string[] = [];

before(async () => {
  const u = await createUser({ email: `spike-${Date.now()}@test.local`, displayName: 'spike', passwordHash: 'x' });
  userId = u.id;
  const c = await createConversation({ ownerUserId: userId, title: 'spike-conv' });
  convId = c.id;
});

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

test('planPhase:按 task_type 只激活相关节点子集,生成计划,不写 execution_log', async () => {
  const orch = buildOrchestrator();
  const r = await orch.planPhase({
    originalInput: '我要为直播场域做一次数字人竞品研究',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(r.workspaceUri);

  // 竞品任务不应激活 D2(用户人群)/ D4(体验现状)
  assert.ok(r.activatedNodes.includes('D5_competitive'));
  assert.ok(!r.activatedNodes.includes('D2_target_audience'), '竞品任务不应激活 D2');
  assert.ok(!r.activatedNodes.includes('D4_experience_status'), '竞品任务不应激活 D4');

  // 闸门:planPhase 后不应有任何 execution_log
  const log = await listExecutionLog(r.taskId);
  assert.equal(log.length, 0, '确认前不得有 execution_log');

  // plan.json 落盘
  assert.ok(existsSync(join(r.workspaceUri, 'plan.json')));
});

test('executePhase:确认后执行,每步 succeeded,产出 report artifact', async () => {
  const orch = buildOrchestrator();
  const r = await orch.planPhase({
    originalInput: '直播数字人竞品研究',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(r.workspaceUri);

  const { reportArtifactId } = await orch.executePhase({ taskId: r.taskId, conversationId: convId });
  assert.ok(reportArtifactId);

  const log = await listExecutionLog(r.taskId);
  assert.ok(log.length >= 2, '应有 tool + skill 两步');
  assert.ok(log.every((l) => l.status === 'succeeded'), '所有步骤应 succeeded');

  const arts = await listArtifacts(r.taskId);
  assert.ok(arts.some((a) => a.artifact_type === 'report'));
});

test('失败回放:tool 失败 → 该步 failed + failures.jsonl,不整体重跑', async () => {
  // 注入会失败的 FakeO2Adapter
  const orch = buildOrchestrator({ toolAdapter: new FakeO2Adapter({ failOnToolIds: ['o2-web-search'] }) });
  const r = await orch.planPhase({
    originalInput: '直播数字人竞品研究(失败用例)',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(r.workspaceUri);

  await assert.rejects(
    () => orch.executePhase({ taskId: r.taskId, conversationId: convId }),
    /执行失败/,
  );

  const log = await listExecutionLog(r.taskId);
  const step1 = log.find((l) => l.step_no === 1);
  assert.equal(step1?.status, 'failed', 'step 1 应为 failed');
  // 后续步骤未执行(不整体重跑,停在失败步)
  assert.ok(!log.some((l) => l.step_no === 2 && l.status === 'succeeded'), '失败后不应继续执行 step 2');

  // failures.jsonl 可回放
  const failPath = join(r.workspaceUri, 'failures.jsonl');
  assert.ok(existsSync(failPath), 'failures.jsonl 应存在');
  const line = readFileSync(failPath, 'utf8').trim().split('\n')[0];
  const rec = JSON.parse(line);
  assert.equal(rec.selected_tool, 'o2-web-search');
  assert.ok(rec.context_manifest_ref, '失败记录应含 context_manifest_ref 供回放');
});
