import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { closePool, pool } from '../database/db.ts';
import {
  createConversation,
  createResearchTask,
  createUser,
} from '../database/repository.ts';

const originalJwtSecret = process.env.JWT_SECRET;
const originalWorkspaceRoot = process.env.RUN_WORKSPACE_ROOT;
const workspaceRoot = mkdtempSync(join(tmpdir(), 'legacy-mutation-route-'));

function restoreEnvironment(name: 'JWT_SECRET' | 'RUN_WORKSPACE_ROOT', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(async () => {
  await closePool();
  rmSync(workspaceRoot, { recursive: true, force: true });
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
  restoreEnvironment('RUN_WORKSPACE_ROOT', originalWorkspaceRoot);
});

test('legacy POST routes are gone without DB or workspace writes while legacy GET history remains readable', async () => {
  process.env.JWT_SECRET = 'legacy-mutation-test-secret';
  process.env.RUN_WORKSPACE_ROOT = workspaceRoot;
  const owner = await createUser({
    email: `legacy-read-owner-${randomUUID()}@test.local`,
    displayName: 'legacy read owner',
    passwordHash: 'x',
  });
  const conversation = await createConversation({ ownerUserId: owner.id, title: 'legacy history' });
  const legacyTask = await createResearchTask({
    conversationId: conversation.id,
    ownerUserId: owner.id,
    originalInput: '可读取的 Legacy 历史任务',
    taskType: 'competitive_research',
    structuredTask: { task_type: 'competitive_research' },
    runWorkspaceUri: join(workspaceRoot, 'legacy-history'),
  });
  const before = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM conversations WHERE owner_user_id = $1) AS conversations,
       (SELECT count(*)::int FROM research_tasks WHERE owner_user_id = $1) AS tasks,
       (SELECT count(*)::int FROM user_feedback WHERE user_id = $1) AS feedback`,
    [owner.id],
  );
  // Module-boundary exception: RunWorkspace captures RUN_WORKSPACE_ROOT during server.ts evaluation.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const server = createServer(createAgentApiApp());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = signToken({ userId: owner.id, email: owner.email });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  try {
    const mutations = [
      { path: '/api/tasks/plan', body: { originalInput: '不得创建 Legacy task' } },
      { path: '/api/tasks/plan/stream', body: { originalInput: '不得流式创建 Legacy task' } },
      { path: `/api/tasks/${legacyTask.id}/feedback`, body: { rating: 5, adopted: true } },
      ...['select', 'execute', 'resume'].map((command) => ({
        path: `/api/tasks/${legacyTask.id}/${command}`,
        body: {},
      })),
    ];
    const statuses: number[] = [];
    for (const mutation of mutations) {
      const response = await fetch(`${baseUrl}${mutation.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(mutation.body),
      });
      statuses.push(response.status);
      await response.text();
    }

    const listResponse = await fetch(`${baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const detailResponse = await fetch(`${baseUrl}/api/tasks/${legacyTask.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = await listResponse.json() as { kind: string; tasks: Array<{ id: string }> };
    const detailBody = await detailResponse.json() as { kind: string; task: { id: string } };
    const afterWrites = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE owner_user_id = $1) AS conversations,
         (SELECT count(*)::int FROM research_tasks WHERE owner_user_id = $1) AS tasks,
         (SELECT count(*)::int FROM user_feedback WHERE user_id = $1) AS feedback`,
      [owner.id],
    );

    assert.deepEqual(statuses, mutations.map(() => 410));
    assert.deepEqual(afterWrites.rows[0], before.rows[0]);
    assert.equal(readdirSync(workspaceRoot).length, 0);
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.kind, 'legacy');
    assert.ok(listBody.tasks.some((task) => task.id === legacyTask.id));
    assert.equal(detailResponse.status, 200);
    assert.equal(detailBody.kind, 'legacy');
    assert.equal(detailBody.task.id, legacyTask.id);
  } finally {
    server.close();
    await once(server, 'close');
    await pool.query('DELETE FROM task_decision_states WHERE task_id IN (SELECT id FROM research_tasks WHERE owner_user_id = $1)', [owner.id]);
    await pool.query('DELETE FROM execution_log WHERE task_id IN (SELECT id FROM research_tasks WHERE owner_user_id = $1)', [owner.id]);
    await pool.query('DELETE FROM artifacts WHERE task_id IN (SELECT id FROM research_tasks WHERE owner_user_id = $1)', [owner.id]);
    await pool.query('DELETE FROM user_feedback WHERE user_id = $1', [owner.id]);
    await pool.query('DELETE FROM research_tasks WHERE owner_user_id = $1', [owner.id]);
    await pool.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_user_id = $1)', [owner.id]);
    await pool.query('DELETE FROM conversations WHERE owner_user_id = $1', [owner.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
    if (existsSync(workspaceRoot)) {
      for (const entry of readdirSync(workspaceRoot)) {
        rmSync(join(workspaceRoot, entry), { recursive: true, force: true });
      }
    }
  }
});
