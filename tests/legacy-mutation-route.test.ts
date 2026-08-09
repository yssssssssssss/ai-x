import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { tasksRouter } from '../apps/agent-api/src/routes/tasks.ts';

test('legacy task mutation endpoints return 410 before any legacy orchestration can run', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const token = signToken({ userId: '00000000-0000-0000-0000-000000000001', email: 'owner@test.local' });
  try {
    for (const suffix of ['select', 'execute', 'resume']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-id/${suffix}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 410);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});
