import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrchestrator } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { createUser, createConversation, listExecutionLog } from '../database/repository.ts';
import { closePool } from '../database/db.ts';

// Task B 集成:planPhase 正常路径把召回的知识条目写进 context_manifest.loaded_sources(type=knowledge)。
// 走 Mock LLM,碰真实库(同 spike.test.ts)。
process.env.LLM_PROVIDER = 'mock';

let userId: string;
let convId: string;
const cleanupDirs: string[] = [];

before(async () => {
  const u = await createUser({ email: `guid-${Date.now()}@test.local`, displayName: 'guid', passwordHash: 'x' });
  userId = u.id;
  const c = await createConversation({ ownerUserId: userId, title: 'guid-conv' });
  convId = c.id;
});

after(async () => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  await closePool();
});

test('planPhase(正常路径):召回知识条目写入 context_manifest 且不破坏原路径', async () => {
  const orch = buildOrchestrator();
  const r = await orch.planPhase({
    originalInput: '我要为直播场域做数字人竞品研究',
    conversationId: convId, ownerUserId: userId,
  });
  cleanupDirs.push(r.workspaceUri);

  // 正常路径未破坏:激活节点非空、有 plan、确认前无 execution_log
  assert.ok(r.activatedNodes.length > 0, 'activatedNodes 应非空');
  assert.ok(r.activatedNodes.includes('D5_competitive'));
  assert.equal(r.candidates.length, 2, '应产 2 份候选(depth/speed)');
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['depth', 'speed']);
  const log = await listExecutionLog(r.taskId);
  assert.equal(log.length, 0, '确认前不得有 execution_log(仍 awaiting_selection)');

  // context_manifest.loaded_sources 含 type=knowledge 且带 ref
  const manifest = JSON.parse(
    readFileSync(join(r.workspaceUri, 'context_manifest.json'), 'utf8'),
  ) as { loaded_sources: Array<{ type: string; ref: string; hash?: string }> };
  const know = manifest.loaded_sources.filter((s) => s.type === 'knowledge');
  assert.ok(know.length > 0, 'loaded_sources 应含 type=knowledge 来源');
  for (const k of know) assert.ok(k.ref, 'knowledge 来源应带 ref(source_path)');
});
