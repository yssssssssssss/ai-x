import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  createZeroIntegrationRouter,
  createZeroPublicationRouter,
  type ZeroPublicationHttpPort,
} from '../apps/agent-api/src/routes/zero-publications.ts';
import { ZeroPublicationServiceError } from '../apps/agent-api/src/integrations/zero/zero-publication-service.ts';
import type { ControlZeroPublication } from '../database/control-plane.ts';

const taskId = '22222222-2222-4222-8222-222222222222';
const publicationId = '33333333-3333-4333-8333-333333333333';
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function row(overrides: Partial<ControlZeroPublication> = {}): ControlZeroPublication {
  const now = new Date();
  return {
    id: publicationId, taskId, ownerUserId: 'owner-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    reportPackageArtifactId: 'package-1', reportPackageHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'idem-1', requestHash: `sha256:${'b'.repeat(64)}`, templateVersion: 'zero-report-v1',
    status: 'queued', stage: 'checking_zero', progress: 0, zeroFileKey: 'file-1', zeroPageId: '30:1',
    zeroPageName: '[p]demo', draftRootNodeId: null, finalRootNodeId: null, updatePublicationId: null,
    updateRootNodeId: null, zeroNodeMap: null, imageManifest: null, screenshotManifest: null,
    receiptArtifactId: null, failure: null, leaseOwner: null, leaseExpiresAt: null,
    createdAt: now, updatedAt: now, completedAt: null, ...overrides,
  };
}

function auth(req: Request, _res: Response, next: NextFunction): void {
  req.userId = 'owner-1';
  next();
}

async function app(port: ZeroPublicationHttpPort) {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/integrations/zero', createZeroIntegrationRouter(port, auth));
  instance.use('/api/control-tasks', createZeroPublicationRouter(port, auth));
  const server = createServer(instance);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  const tcpPort = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${tcpPort}`;
}

function fakePort(overrides: Partial<ZeroPublicationHttpPort> = {}): ZeroPublicationHttpPort {
  return {
    async status() { return { available: true, authenticated: true, version: '3.12.8', currentFileKey: 'file-1', currentPageId: '30:1', currentPageName: '[p]demo' }; },
    async create() { return row(); },
    async execute() { return row({ status: 'completed', progress: 100, finalRootNodeId: '31:2', completedAt: new Date() }); },
    async get() { return row(); },
    ...overrides,
  };
}

test('Zero publication routes require frozen request fields and Idempotency-Key', async () => {
  const base = await app(fakePort());
  const missing = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' } }),
  });
  assert.equal(missing.status, 400);
  const forbidden = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem' },
    body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' }, updateRootNodeId: '31:1' }),
  });
  assert.equal(forbidden.status, 400);
});

test('Zero publication routes create, execute asynchronously, and read owner-scoped status', async () => {
  let executed = 0;
  const base = await app(fakePort({ async execute() { executed += 1; return row({ status: 'completed' }); } }));
  const status = await fetch(`${base}/api/integrations/zero/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).available, true);
  const created = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem' },
    body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' } }),
  });
  assert.equal(created.status, 202);
  assert.equal((await created.json()).publicationId, publicationId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executed, 1);
  const read = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero/${publicationId}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).id, publicationId);
});

test('Zero publication routes hide foreign tasks and classify offline integration', async () => {
  const base = await app(fakePort({
    async create() { throw new ZeroPublicationServiceError('task_not_found', 'Task does not exist'); },
    async status() { return { available: false, authenticated: false, reason: 'offline' }; },
  }));
  assert.equal((await fetch(`${base}/api/integrations/zero/status`)).status, 200);
  const response = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem' },
    body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' } }),
  });
  assert.equal(response.status, 404);
});

test('Zero publication routes map report_not_completed to an exact 409 response', async () => {
  const base = await app(fakePort({
    async create() {
      throw new ZeroPublicationServiceError(
        'report_not_completed',
        'Task is not in the expected completed state',
      );
    },
  }));
  const response = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem' },
    body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' } }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Task is not in the expected completed state',
    code: 'report_not_completed',
    retryable: false,
  });
});

test('Zero publication routes map offline creation to 503 and idempotency conflicts to 409', async () => {
  for (const [error, expected] of [
    [new ZeroPublicationServiceError('zero_offline', 'Zero is offline', true), 503],
    [new ZeroPublicationServiceError('idempotency_conflict', 'conflict'), 409],
  ] as const) {
    const base = await app(fakePort({ async create() { throw error; } }));
    const response = await fetch(`${base}/api/control-tasks/${taskId}/publications/zero`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem' },
      body: JSON.stringify({ expectedTaskState: 'completed', target: { mode: 'current_page' } }),
    });
    assert.equal(response.status, expected);
  }
});
