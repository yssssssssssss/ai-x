import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUser, createConversation, writeMessage, listMessages,
  createResearchTask, listRecentTasks, writeExecutionLog, listExecutionLog,
  writeDecisionState, listDecisionStates, writeArtifact, listArtifacts,
  writeFeedback,
} from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// P0-02 验收:建用户/会话/消息/任务/日志/产物,按 owner 查最近任务,按 task_id 查 log/decision。
// 碰真实库:需先 createdb user_research_ai && pnpm db:migrate。

let userId: string;
let convId: string;
let taskId: string;

before(async () => {
  const u = await createUser({
    email: `rt-${Date.now()}@test.local`,
    displayName: 'roundtrip',
    passwordHash: 'x',
  });
  userId = u.id;
});

after(async () => {
  await closePool();
});

test('会话 + 消息回放', async () => {
  const conv = await createConversation({ ownerUserId: userId, title: 'rt-conv' });
  convId = conv.id;
  await writeMessage({ conversationId: convId, senderType: 'user', messageType: 'text', content: { text: 'hi' } });
  await writeMessage({ conversationId: convId, senderType: 'assistant', messageType: 'plan', content: { steps: [] } });
  const msgs = await listMessages(convId);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sender_type, 'user');
});

test('任务 + 按 owner 查最近任务', async () => {
  const t = await createResearchTask({
    conversationId: convId, ownerUserId: userId,
    originalInput: '直播竞品研究', taskType: 'competitive_research',
    structuredTask: { task_type: 'competitive_research' },
    runWorkspaceUri: 'run-workspaces/rt',
  });
  taskId = t.id;
  const recent = await listRecentTasks(userId);
  assert.ok(recent.some((r) => r.id === taskId));
  assert.equal(recent[0].task_type, 'competitive_research');
});

test('决策状态 + 执行日志按 task_id 查', async () => {
  await writeDecisionState({
    taskId, nodeKey: 'D5_competitive', state: 'need_execute',
    reason: '用户提到竞品', confidence: 0.9, finalState: 'need_execute',
  });
  await writeExecutionLog({
    taskId, stepNo: 1, stepName: 'search', actorType: 'tool',
    actorId: 'tavily-web-search', status: 'succeeded', modelName: 'mock-llm',
  });
  const states = await listDecisionStates(taskId);
  const log = await listExecutionLog(taskId);
  assert.equal(states.length, 1);
  assert.equal(states[0].node_key, 'D5_competitive');
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'succeeded');
});

test('产物 + 反馈', async () => {
  const a = await writeArtifact({
    taskId, conversationId: convId, artifactType: 'report',
    title: '报告', storageUri: 'run-workspaces/rt/report.json',
  });
  const arts = await listArtifacts(taskId);
  assert.ok(arts.some((x) => x.id === a.id));

  const f = await writeFeedback({ taskId, userId, rating: 5, adopted: true, comment: '好' });
  assert.ok(f.id);
});

test('execution_log UNIQUE(task_id, step_no) upsert 生效', async () => {
  await writeExecutionLog({ taskId, stepNo: 1, stepName: 'search', actorType: 'tool', actorId: 'tavily-web-search', status: 'failed' });
  const log = await listExecutionLog(taskId);
  const step1 = log.filter((l) => l.step_no === 1);
  assert.equal(step1.length, 1, 'step_no=1 应只有一行(upsert 而非重复插入)');
});
