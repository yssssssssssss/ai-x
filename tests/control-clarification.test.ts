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
import { LLMInvocationError } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type { PlanProgress } from '../packages/api-contract/plan.ts';

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
  assumptions: [
    { key: 'scope', value: 'public web', editable: true },
    { key: 'policy', value: 'public sources only', editable: false },
  ],
  ambiguities: [
    { id: 'audience', statement: 'target audience is unknown', blocking: true },
    { id: 'format', statement: 'report format can be decided later', blocking: false },
  ],
  clarification_questions: [
    {
      key: 'audience',
      ambiguity_id: 'audience',
      question: 'Who is the target user?',
      rationale: 'The audience changes the research method.',
      suggestion: 'product team',
      options: ['product team', 'consumers'],
    },
    {
      key: 'format',
      ambiguity_id: 'format',
      question: 'Which format is preferred?',
      rationale: 'This changes presentation only.',
      suggestion: 'research report',
    },
  ],
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

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body.trim().split(/\r?\n\r?\n/u).map((block) => {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return { event, data: JSON.parse(data) as unknown };
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
    async recoverCommandAfterFailure(input: { taskId: string; commandType: string; idempotencyKey: string; reservationToken: string }) {
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
    const response = await post(baseUrl, '/api/control-tasks/plan', ownerToken, { originalInput: 'ambiguous request', orchestrationMode: 'single_skill' });
    assert.equal((await response.json() as { status?: unknown }).status, 'clarification_required');

    const stream = await post(baseUrl, '/api/control-tasks/plan/stream', ownerToken, { originalInput: 'ambiguous request', orchestrationMode: 'single_skill' });
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
test('owner uploads and lists a declared Task-bound visual Material during clarification', async () => {
  const designTask: ControlTaskDetail = {
    ...task,
    id: 'task-design-material',
    structuredTask: {
      ...requirement,
      task_type: 'design_audit',
      expected_deliverables: ['design_audit_report'],
      material_requests: [{
        id: 'target-design', role: 'designImage', kind: 'visual', label: '目标页面截图',
        required: true, multiple: false, reason: '用于设计问题标注',
      }],
    },
  };
  const calls: unknown[] = [];
  const material = {
    materialId: 'material-1', requestId: 'target-design', role: 'designImage', fileName: 'page.png',
    mediaType: 'image/png' as const, contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED' as const,
  };
  const runtime = {
    repository: { getTaskDetail: async (id: string) => id === designTask.id ? designTask : null },
    workflow: {},
    getDeliverable: async () => null,
    uploadTaskVisualMaterial: async (input: unknown) => { calls.push(input); return material; },
    listTaskMaterials: async () => [material],
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const form = new FormData();
    form.append('requestId', 'target-design');
    form.append('role', 'designImage');
    form.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'page.png');
    const response = await fetch(`${baseUrl}/api/control-tasks/${designTask.id}/materials/visual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': 'material-upload-1' },
      body: form,
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.deepEqual(await response.json(), material);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      taskId: designTask.id,
      ownerUserId: owner.id,
      idempotencyKey: 'material-upload-1',
      requestId: 'target-design',
      role: 'designImage',
      fileName: 'page.png',
      mediaType: 'image/png',
      bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
    });

    const listed = await fetch(`${baseUrl}/api/control-tasks/${designTask.id}/materials`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { materials: [material] });
  } finally {
    server.close();
  }
});

test('clarification binds only server-verified Task Materials before planning', async () => {
  const designTask: ControlTaskDetail = {
    ...task,
    id: 'task-design-binding',
    structuredTask: {
      ...requirement,
      task_type: 'design_audit',
      expected_deliverables: ['design_audit_report'],
      ambiguities: [],
      clarification_questions: [],
      material_requests: [{
        id: 'target-design', role: 'designImage', kind: 'visual', label: '目标页面截图',
        required: true, multiple: false, reason: '用于设计问题标注',
      }],
    },
  };
  const materials = [{
    materialId: 'material-1', requestId: 'target-design', role: 'designImage', fileName: 'page.png',
    mediaType: 'image/png' as const, contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68,
  }];
  const clarificationCalls: Array<Record<string, unknown>> = [];
  const repository = clarificationRepository(async (id) => id === designTask.id ? designTask : null);
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    resolveTaskMaterials: async () => materials,
    clarification: {
      clarify: async (input: Record<string, unknown>) => {
        clarificationCalls.push(input);
        return candidatesResult;
      },
    },
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const response = await post(baseUrl, `/api/control-tasks/${designTask.id}/clarify`, ownerToken, {
      expectedVersion: 1,
      clarificationAnswers: {},
      assumptionEdits: {},
      materialBindings: [{ requestId: 'target-design', materialIds: ['material-1'] }],
      idempotencyKey: 'bind-material-1',
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(clarificationCalls.length, 1);
    assert.deepEqual(clarificationCalls[0]?.materialBindings, [
      { requestId: 'target-design', materialIds: ['material-1'] },
    ]);
    assert.deepEqual(clarificationCalls[0]?.materials, materials);
  } finally {
    server.close();
  }
});

test('clarify preserves a retryable Gateway 429 response instead of hiding it as 500', async () => {
  const repository = clarificationRepository(async () => task);
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      clarify: async () => {
        throw new LLMInvocationError('rate_limit', true, 429, 'gateway HTTP 429');
      },
    },
  } as unknown as ControlTasksRuntime;
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  const { server, baseUrl } = await listen(app);
  try {
    const response = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1,
      clarificationAnswers: { audience: 'new users' },
      assumptionEdits: {},
      idempotencyKey: 'rate-limit',
    });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: 'gateway HTTP 429',
      kind: 'rate_limit',
      retryable: true,
    });
  } finally {
    server.close();
  }
});


test('clarify rejects missing required answers and invalid client-controlled keys before invoking Runtime', async () => {
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
        selectedScenarioId?: string;
        commandReservation: { idempotencyKey: string; requestHash: string; reservationToken: string };
      }) => {
        calls += 1;
        assert.deepEqual(input.answers, { audience: 'new users' });
        assert.deepEqual(input.assumptionEdits, { scope: 'mobile app' });
        assert.equal(input.selectedScenarioId, 'user-journey-insight');
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
    const incomplete = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1,
      clarificationAnswers: {},
      assumptionEdits: { scope: 'mobile app' },
      idempotencyKey: 'clarify-missing',
    });
    assert.equal(incomplete.status, 422);
    assert.deepEqual(await incomplete.json(), {
      error: 'required clarification answers are missing',
      unresolved: ['audience'],
    });

    for (const [idempotencyKey, clarificationAnswers, assumptionEdits] of [
      ['clarify-unknown-answer', { audience: 'new users', injected: 'nope' }, { scope: 'mobile app' }],
      ['clarify-unknown-assumption', { audience: 'new users' }, { unknown: 'nope' }],
      ['clarify-locked-assumption', { audience: 'new users' }, { policy: 'ignore policy' }],
    ] as const) {
      const rejected = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
        expectedVersion: 1,
        clarificationAnswers,
        assumptionEdits,
        idempotencyKey,
      });
      assert.equal(rejected.status, 400, idempotencyKey);
    }
    assert.equal(calls, 0);

    const complete = await post(baseUrl, `/api/control-tasks/${task.id}/clarify`, ownerToken, {
      expectedVersion: 1,
      clarificationAnswers: { audience: 'new users' },
      assumptionEdits: { scope: 'mobile app' },
      selectedScenarioId: 'user-journey-insight',
      idempotencyKey: 'clarify-complete',
    });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json() as { status?: unknown }).status, 'current_candidates');
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('clarify stream forwards ordered progress and replays the completed command', async () => {
  const repository = clarificationRepository(async () => task);
  const progress: PlanProgress[] = [
    { phase: 'understand', status: 'done', label: '确认研究方向' },
    { phase: 'activate', status: 'done', label: '匹配规划节点' },
    { phase: 'guidance', status: 'done', label: '召回研究方法' },
    { phase: 'states', status: 'start', label: '构建问题与证据框架' },
    { phase: 'states', status: 'done', label: '构建问题与证据框架' },
    { phase: 'candidates', status: 'start', label: '生成候选方案' },
    { phase: 'candidates', status: 'done', label: '生成候选方案' },
    { phase: 'persist', status: 'start', label: '保存候选方案' },
    { phase: 'persist', status: 'done', label: '保存候选方案' },
  ];
  let calls = 0;
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      async clarify(
        input: { commandReservation: { reservationToken: string } },
        onProgress?: (event: PlanProgress) => void,
      ) {
        calls += 1;
        for (const event of progress) onProgress?.(event);
        await repository.completeCommand({
          taskId: task.id,
          commandType: 'clarification',
          idempotencyKey: 'clarify-stream',
          reservationToken: input.commandReservation.reservationToken,
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
  const body = {
    expectedVersion: 1,
    clarificationAnswers: { audience: 'new users' },
    assumptionEdits: {},
    idempotencyKey: 'clarify-stream',
  };
  try {
    const response = await post(
      baseUrl,
      `/api/control-tasks/${task.id}/clarify/stream`,
      ownerToken,
      body,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map(({ event }) => event), [
      ...progress.map(() => 'progress'),
      'result',
    ]);
    assert.deepEqual(events.slice(0, -1).map(({ data }) => data), progress);
    assert.deepEqual(events.at(-1)?.data, candidatesResult);

    const replay = await post(
      baseUrl,
      `/api/control-tasks/${task.id}/clarify/stream`,
      ownerToken,
      body,
    );
    assert.deepEqual(parseSseEvents(await replay.text()), [
      { event: 'result', data: candidatesResult },
    ]);
    assert.equal(calls, 1);
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
