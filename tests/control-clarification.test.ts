import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createControlPlanningRouter, type ControlPlanningPort } from '../apps/agent-api/src/routes/control-planning.ts';
import { createControlTasksRouter, type ControlTasksRuntime } from '../apps/agent-api/src/routes/control-tasks.ts';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { closePool, pool } from '../database/db.ts';
import { createUser } from '../database/repository.ts';
import type { ControlTaskDetail } from '../database/control-plane.ts';
import type { CurrentPlanningResponse } from '../apps/agent-api/src/routes/control-planning.ts';

process.env.JWT_SECRET = 'clarification-test-secret';

const suffix = `${Date.now()}-${process.pid}`;
const owner = { id: 'clarify-owner', email: `clarify-owner-${suffix}@example.test` };
const foreign = { id: 'clarify-foreign', email: `clarify-foreign-${suffix}@example.test` };
let ownerToken = '';
let foreignToken = '';

const requirement = {
  version: 'research-task-v2' as const,
  task_type: 'user_research_planning' as const,
  business_domain: 'product',
  research_goal: 'understand product experience',
  target_audience: [],
  scope: [],
  constraints: [],
  success_criteria: [],
  expected_deliverables: [],
  assumptions: [{ key: 'scope', value: 'public web', editable: true }],
  ambiguities: [{ id: 'audience', statement: 'target audience is unknown', blocking: true }],
  clarification_questions: [{ key: 'audience', question: 'Who is the target user?', rationale: 'The audience changes the research method.' }],
  blocking_issues: [],
  sensitivity: 'public' as const,
  pii_detected: false,
};

const task: ControlTaskDetail = {
  id: 'task-clarify',
  conversationId: 'conversation-clarify',
  originalInput: '$user-research-planning understand product experience',
  ownerUserId: owner.id,
  conversationOwnerUserId: owner.id,
  structuredTask: requirement,
  state: 'awaiting_clarification',
  stateVersion: 1,
  activePlanVersionId: null,
  currentAttemptId: null,
  activeRequirementVersionId: 'requirement-v1',
};

const clarificationResult: CurrentPlanningResponse = {
  kind: 'current',
  status: 'clarification_required',
  conversationId: task.conversationId,
  task: { id: task.id, state: task.state, stateVersion: task.stateVersion, activePlanVersionId: null, currentAttemptId: null },
  structuredTask: requirement,
  activatedNodes: [],
  candidates: [],
};

const candidatesResult: CurrentPlanningResponse = {
  kind: 'current',
  status: 'current_candidates',
  conversationId: task.conversationId,
  task: { ...clarificationResult.task, state: 'awaiting_selection', stateVersion: 2 },
  structuredTask: {
    task_type: requirement.task_type,
    business_domain: requirement.business_domain,
    research_goal: requirement.research_goal,
    assumptions: requirement.assumptions,
    confirmations: [],
    blocking_issues: [],
    sensitivity: requirement.sensitivity,
    pii_detected: requirement.pii_detected,
  },
  activatedNodes: ['D1_research_goal'],
  candidates: [],
};

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(baseUrl: string, path: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function clarificationRepository(getTaskDetail: (id: string) => Promise<ControlTaskDetail | null>) {
  const commands = new Map<string, { requestHash: string; reservationToken: string; response?: unknown }>();
  const commandKey = (taskId: string, commandType: string, idempotencyKey: string) =>
    `${taskId}:${commandType}:${idempotencyKey}`;
  return {
    getTaskDetail,
    async getCommand(taskId: string, commandType: string, idempotencyKey: string) {
      const command = commands.get(commandKey(taskId, commandType, idempotencyKey));
      return command ? { requestHash: command.requestHash, response: command.response } : null;
    },
    async reserveCommand(input: { taskId: string; commandType: string; idempotencyKey: string; requestHash: string }) {
      const key = commandKey(input.taskId, input.commandType, input.idempotencyKey);
      const existing = commands.get(key);
      if (existing?.requestHash !== undefined && existing.requestHash !== input.requestHash) {
        return { status: 'conflict' as const };
      }
      if (existing?.response !== undefined) return { status: 'replay' as const, response: existing.response };
      if (existing) return { status: 'pending' as const };
      const reservationToken = `reservation-${commands.size + 1}`;
      commands.set(key, { requestHash: input.requestHash, reservationToken });
      return { status: 'reserved' as const, reservationToken };
    },
    async waitForCommand() {
      return { status: 'timeout' as const };
    },
    async completeCommand(input: { taskId: string; commandType: string; idempotencyKey: string; reservationToken: string; response: unknown }) {
      const key = commandKey(input.taskId, input.commandType, input.idempotencyKey);
      const command = commands.get(key);
      if (!command || command.reservationToken !== input.reservationToken) throw new Error('reservation fence lost');
      command.response = input.response;
    },
    async releaseCommand(input: { taskId: string; commandType: string; idempotencyKey: string; reservationToken: string }) {
      const key = commandKey(input.taskId, input.commandType, input.idempotencyKey);
      if (commands.get(key)?.reservationToken === input.reservationToken) commands.delete(key);
    },
  };
}

before(async () => {
  const createdOwner = await createUser({ email: owner.email, passwordHash: 'hash', displayName: 'owner' });
  const createdForeign = await createUser({ email: foreign.email, passwordHash: 'hash', displayName: 'foreign' });
  owner.id = createdOwner.id;
  foreign.id = createdForeign.id;
  task.ownerUserId = owner.id;
  task.conversationOwnerUserId = owner.id;
  ownerToken = signToken({ userId: owner.id, email: owner.email });
  foreignToken = signToken({ userId: foreign.id, email: foreign.email });
});

after(async () => {
  await closePool();
});

test('plan returns clarification_required union and SSE emits conversation before clarification result', async () => {
  const port: ControlPlanningPort = {
    async plan(_input, _onProgress, onConversation) {
      onConversation?.(clarificationResult.conversationId);
      return clarificationResult;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlPlanningRouter(port));
  const { server, baseUrl } = await listen(app);
  try {
    const response = await post(baseUrl, '/api/control-tasks/plan', ownerToken, { originalInput: 'ambiguous request' });
    assert.equal((await response.json() as { status?: unknown }).status, 'clarification_required');

    const stream = await post(baseUrl, '/api/control-tasks/plan/stream', ownerToken, { originalInput: 'ambiguous request' });
    const text = await stream.text();
    assert.ok(text.indexOf('event: conversation') < text.indexOf('event: result'));
    assert.match(text, /clarification_required/);
  } finally {
    server.close();
  }
});

test('foreign and missing clarification tasks are both 404', async () => {
  const runtime = {
    repository: { getTaskDetail: async (id: string) => id === task.id ? task : null },
    workflow: {},
    getDeliverable: async () => null,
    clarification: { clarify: async () => clarificationResult },
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const foreignResponse = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, foreignToken, {
      expectedVersion: 1, clarificationAnswers: {}, assumptionEdits: {}, idempotencyKey: 'foreign',
    });
    const missingResponse = await post(baseUrl, '/api/control-tasks/missing/clarify', ownerToken, {
      expectedVersion: 1, clarificationAnswers: {}, assumptionEdits: {}, idempotencyKey: 'missing',
    });
    assert.equal(foreignResponse.status, 404);
    assert.equal(missingResponse.status, 404);
  } finally {
    server.close();
  }
});

test('clarify keeps awaiting_clarification when a blocking answer is missing and returns candidates when complete', async () => {
  let calls = 0;
  const repository = clarificationRepository(async () => task);
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      clarify: async (input: {
        answers: Record<string, unknown>;
        assumptionEdits?: Record<string, string>;
        commandReservation: { idempotencyKey: string; requestHash: string; reservationToken: string };
      }) => {
        calls += 1;
        assert.deepEqual(input.answers, calls === 1 ? {} : { audience: 'new users' });
        assert.deepEqual(input.assumptionEdits, { scope: 'mobile app' });
        const response = calls === 1 ? clarificationResult : candidatesResult;
        if (response.status !== 'clarification_required') {
          await repository.completeCommand({
            ...input.commandReservation,
            taskId: task.id,
            commandType: 'clarification',
            response,
          });
        }
        return response;
      },
    },
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const incomplete = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1, clarificationAnswers: {}, assumptionEdits: { scope: 'mobile app' }, idempotencyKey: 'clarify-1',
    });
    assert.equal((await incomplete.json() as { status?: unknown }).status, 'clarification_required');

    const complete = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1, clarificationAnswers: { audience: 'new users' }, assumptionEdits: { scope: 'mobile app' }, idempotencyKey: 'clarify-2',
    });
    assert.equal((await complete.json() as { status?: unknown }).status, 'current_candidates');
  } finally {
    server.close();
  }
});

test('clarify rejects client plan fields and replays an idempotency key with the same response', async () => {
  let calls = 0;
  const repository = clarificationRepository(async () => task);
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      clarify: async (input: {
        commandReservation: { idempotencyKey: string; requestHash: string; reservationToken: string };
      }) => {
        calls += 1;
        await repository.completeCommand({
          ...input.commandReservation,
          taskId: task.id,
          commandType: 'clarification',
          response: candidatesResult,
        });
        return candidatesResult;
      },
    },
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const rejected = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1, clarificationAnswers: { audience: 'new users' }, assumptionEdits: {}, idempotencyKey: 'reject', plan: {}, planHash: 'client',
    });
    assert.equal(rejected.status, 400);

    const body = { expectedVersion: 1, clarificationAnswers: { audience: 'new users' }, assumptionEdits: {}, idempotencyKey: 'replay' };
    const first = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, body);
    const firstText = await first.text();
    const second = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, body);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), firstText);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});
