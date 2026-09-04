import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import type {
  SkillNativeTaskView,
  SkillNativeZeroPublication,
} from '../packages/api-contract/skill-native.ts';
import { createSkillNativeTasksRouter, type SkillNativeTasksHttpPort } from '../apps/agent-api/src/routes/skill-native-tasks.ts';
import { SkillNativeWorkflowError } from '../apps/orchestrator-runtime/src/skill-native/service.ts';
import { SkillNativeStoreError, type SkillNativeArtifactRecord } from '../apps/orchestrator-runtime/src/skill-native/store.ts';
import { SkillNativeZeroPublisher } from '../apps/agent-api/src/integrations/zero/skill-native-zero-publisher.ts';
import type { ZeroPublicationMcp } from '../apps/agent-api/src/integrations/zero/zero-publication-service.ts';

const now = new Date('2026-09-04T00:00:00Z').toISOString();
const task: SkillNativeTaskView = {
  id: 'task-1',
  projectId: 'project-1',
  originalInput: '研究目标',
  orchestrationMode: 'single_skill',
  state: 'completed',
  stateVersion: 4,
  selectedSolutionId: 'solution',
  currentAttemptId: 'attempt',
  candidates: [],
  plan: null,
  executionSteps: [],
  report: {
    version: 'report-result-v1',
    title: '报告',
    summary: '摘要',
    status: 'complete',
    sections: [{ id: 'one', title: '结论', blocks: [{ type: 'text', text: '内容' }] }],
    sources: [],
    gaps: [],
  },
  warnings: [],
  failure: null,
  createdAt: now,
  updatedAt: now,
};

const artifact: SkillNativeArtifactRecord = {
  id: 'artifact-1',
  taskId: task.id,
  ownerUserId: 'owner',
  projectId: task.projectId,
  inputId: 'designImage',
  fileName: 'screen.png',
  mediaType: 'image/png',
  bytes: Buffer.from([137, 80, 78, 71]),
  contentSha256: 'sha256:test',
};

let lastOwner = '';
const service: SkillNativeTasksHttpPort = {
  catalog: () => ({ skills: [], unavailableSkills: [], solutions: [], invalidSolutions: [] }),
  list: async (ownerUserId) => {
    lastOwner = ownerUserId;
    return [];
  },
  create: async (ownerUserId) => {
    lastOwner = ownerUserId;
    return task;
  },
  get: async (taskId, ownerUserId) => {
    if (taskId !== task.id || ownerUserId !== 'owner') throw new SkillNativeWorkflowError('not_found', '任务不存在');
    return task;
  },
  select: async () => { throw new SkillNativeStoreError('conflict', '任务状态已变化'); },
  confirm: async () => task,
  execute: async () => task,
  cancel: async () => task,
  resume: async () => task,
  replan: async () => task,
  html: async (taskId, ownerUserId) => taskId === task.id && ownerUserId === 'owner'
    ? '<!doctype html><meta charset="utf-8"><img src="data:image/png;base64,iVBORw0KGgo=">'
    : null,
  markdown: async () => '# 报告\n',
  artifact: async (taskId, ownerUserId, artifactId) => (
    taskId === task.id && ownerUserId === 'owner' && artifactId === artifact.id ? artifact : null
  ),
  skillResult: async (taskId, ownerUserId, invocationId) => (
    taskId === task.id && ownerUserId === 'owner' && invocationId === 'support'
      ? task.report
      : null
  ),
  publishZero: async (): Promise<SkillNativeZeroPublication> => {
    throw new SkillNativeWorkflowError('unavailable', 'Zero 发布失败');
  },
};

function auth(req: Request, res: ExpressResponse, next: NextFunction): void {
  const owner = req.header('Authorization')?.replace(/^Bearer\s+/u, '');
  if (!owner) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.userId = owner;
  next();
}

const app = express();
app.use('/api/research-tasks', createSkillNativeTasksRouter(service, auth));
const server = createServer(app);
let origin = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { Authorization: 'Bearer owner', ...init.headers },
  });
}

test('native task routes require authentication and pass the authenticated owner', async () => {
  const unauthorized = await fetch(`${origin}/api/research-tasks`);
  assert.equal(unauthorized.status, 401);
  const malformed = await fetch(`${origin}/api/research-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 401);
  const response = await request('/api/research-tasks');
  assert.equal(response.status, 200);
  assert.equal(lastOwner, 'owner');
});

test('native task request validation rejects removed legacy input fields', async () => {
  const response = await request('/api/research-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalInput: '研究目标',
      orchestrationMode: 'single_skill',
      inputs: { research_goal: { source: 'conversation', value: '目标', referenceId: 'legacy' } },
    }),
  });
  assert.equal(response.status, 400);
});

test('native task JSON parser accepts one 10 MiB base64 image payload', async () => {
  const response = await request('/api/research-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalInput: '设计稿评审',
      orchestrationMode: 'single_skill',
      inputs: {
        design_images: {
          source: 'upload',
          value: {
            name: 'screen.png',
            mediaType: 'image/png',
            dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(10 * 1024 * 1024 * 4 / 3))}`,
          },
        },
      },
    }),
  });
  assert.equal(response.status, 201);
});

test('Zero publication rejects non-loopback callers before invoking the publisher', async () => {
  const { requireLoopbackPeer } = await import('../apps/agent-api/src/middleware.ts');
  let status = 0;
  let body: unknown;
  let nextCalled = false;
  requireLoopbackPeer(
    { socket: { remoteAddress: '10.0.0.8' } } as unknown as Request,
    {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as unknown as ExpressResponse,
    () => { nextCalled = true; },
  );
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'Zero publication is available only on this machine', code: 'zero_local_only' });
  assert.equal(nextCalled, false);
});

test('native task routes distinguish not found and optimistic-concurrency conflicts', async () => {
  const missing = await request('/api/research-tasks/missing');
  assert.equal(missing.status, 404);
  const conflict = await request('/api/research-tasks/task-1/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 3, solutionId: 'solution' }),
  });
  assert.equal(conflict.status, 409);
});

test('report and Artifact responses are private, nosniff, scoped, and allow only local data images', async () => {
  const report = await request('/api/research-tasks/task-1/report.html');
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('cache-control'), 'private, no-store');
  assert.equal(report.headers.get('x-content-type-options'), 'nosniff');
  assert.match(report.headers.get('content-security-policy') ?? '', /img-src 'self' data:/u);

  const image = await request('/api/research-tasks/task-1/artifacts/artifact-1');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), artifact.bytes);

  const foreign = await fetch(`${origin}/api/research-tasks/task-1/artifacts/artifact-1`, {
    headers: { Authorization: 'Bearer other' },
  });
  assert.equal(foreign.status, 404);

  const result = await request('/api/research-tasks/task-1/results/support.json');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(result.headers.get('content-disposition') ?? '', /attachment/u);
  assert.equal((await result.json() as { title: string }).title, '报告');

  const foreignResult = await fetch(`${origin}/api/research-tasks/task-1/results/support.json`, {
    headers: { Authorization: 'Bearer other' },
  });
  assert.equal(foreignResult.status, 404);
});

test('a failed Zero publication does not remove the completed report', async () => {
  const failed = await request('/api/research-tasks/task-1/publications/zero', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 4, target: { mode: 'current_page' } }),
  });
  assert.equal(failed.status, 409);
  const report = await request('/api/research-tasks/task-1/report.html');
  assert.equal(report.status, 200);
});

test('native Zero publisher prepares and finalizes a draft without cleanup', async () => {
  const events: string[] = [];
  const zero = {
    async getStatus() { events.push('status'); return { available: true, authenticated: true }; },
    async getCurrentTarget() {
      events.push('target');
      return { fileKey: 'file-1', pageId: '1:2', pageName: '研究报告' };
    },
    async createHtmlDraft() {
      events.push('create');
      return { rootNodeId: '3:4', x: 0, y: 0, width: 100, height: 100 };
    },
    async finalizeDraft() { events.push('finalize'); return { finalRootNodeId: '3:4' }; },
    async cleanupDraft() { events.push('cleanup'); },
  } as unknown as ZeroPublicationMcp;
  const publisher = new SkillNativeZeroPublisher(zero);
  const draft = await publisher.prepare({
    taskId: 'task-1',
    title: '报告',
    html: '<!doctype html>',
  });
  assert.deepEqual(events, ['status', 'target', 'create']);
  const published = await publisher.finalize(draft);
  assert.deepEqual(events, ['status', 'target', 'create', 'finalize']);
  assert.deepEqual(published, {
    taskId: 'task-1', fileKey: 'file-1', pageId: '1:2', pageName: '研究报告', rootNodeId: '3:4',
  });
});

test('native Zero publisher keeps a prepared draft when finalization fails so it can be replayed', async () => {
  const events: string[] = [];
  const zero = {
    async getStatus() { return { available: true, authenticated: true }; },
    async getCurrentTarget() { return { fileKey: 'file-1', pageId: '1:2', pageName: '研究报告' }; },
    async createHtmlDraft() { events.push('create'); return { rootNodeId: '3:4', x: 0, y: 0, width: 100, height: 100 }; },
    async finalizeDraft() { events.push('finalize'); throw new Error('finalize failed'); },
    async cleanupDraft(input: { rootNodeId: string }) { events.push(`cleanup:${input.rootNodeId}`); },
  } as unknown as ZeroPublicationMcp;
  const publisher = new SkillNativeZeroPublisher(zero);
  const draft = await publisher.prepare({ taskId: 'task-1', title: '报告', html: '<!doctype html>' });
  await assert.rejects(publisher.finalize(draft), /finalize failed/u);
  assert.deepEqual(events, ['create', 'finalize']);
});
