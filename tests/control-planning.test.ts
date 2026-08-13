import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { TextDecoder } from 'node:util';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import type { Express } from 'express';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { closePool } from '../database/db.ts';
import type {
  ControlPlanCandidatesResponse,
  CurrentPlanCandidate,
  PlanControlTaskRequest,
} from '../packages/api-contract/control-workflow.ts';
import type { PlanProgress } from '../packages/api-contract/plan.ts';

interface ControlPlanningInput extends PlanControlTaskRequest {
  ownerUserId: string;
}

interface PlannedAgentApiDependencies {
  controlPlanning: {
    plan(
      input: ControlPlanningInput,
      onProgress?: (event: PlanProgress) => void,
      onConversation?: (conversationId: string) => void,
    ): Promise<ControlPlanCandidatesResponse>;
  };
}

type PlannedCreateAgentApiApp = (dependencies: PlannedAgentApiDependencies) => Express;

const originalJwtSecret = process.env.JWT_SECRET;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
let activeOwnerUserId = '';

before(async () => {
  const result = await database.query(
    `INSERT INTO users (email, display_name, password_hash, role, status)
     VALUES ($1, 'control planning owner', 'x', 'member', 'active')
     RETURNING id`,
    [`control-planning-${randomUUID()}@test.local`],
  );
  activeOwnerUserId = String(result.rows[0]?.id);
});

after(async () => {
  if (activeOwnerUserId) {
    await database.query('DELETE FROM users WHERE id = $1', [activeOwnerUserId]);
  }
  await closePool();
  await database.end();
});

function restoreJwtSecret(): void {
  if (originalJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
    return;
  }
  process.env.JWT_SECRET = originalJwtSecret;
}

test('POST /api/control-tasks/plan plans Current candidates for the authenticated owner without client plan mutation', async () => {
  process.env.JWT_SECRET = `control-planning-test-${randomUUID()}`;
  const ownerUserId = activeOwnerUserId;
  const conversationId = '00000000-0000-0000-0000-000000000201';
  const taskId = '00000000-0000-0000-0000-000000000301';
  const originalInput = '请为宠物辅食市场生成可信研究计划，保留这段原始 Query。';
  const candidates: [CurrentPlanCandidate, CurrentPlanCandidate] = [
    {
      planVersionId: '00000000-0000-0000-0000-000000000401',
      candidateId: 'depth',
      title: '深度研究',
      rationale: '优先覆盖证据深度与完整性',
      tradeoffs: '耗时更长',
      planHash: 'sha256:depth-plan',
      plan: {
        task_id: taskId,
        deliverable_type: 'research_plan',
        evidence_requirements: [
          {
            id: 'public-market-sources',
            acceptedClasses: ['public_source'],
            minimumCount: 3,
            required: true,
          },
        ],
        steps: [
          {
            step_no: 1,
            step_name: '公开来源调研',
            actor_type: 'tool',
            actor_id: 'tavily-search',
          },
        ],
      },
      pendingInputs: [],
    },
    {
      planVersionId: '00000000-0000-0000-0000-000000000402',
      candidateId: 'speed',
      title: '快速研究',
      rationale: '优先形成可执行研究框架',
      tradeoffs: '证据覆盖较窄',
      planHash: 'sha256:speed-plan',
      plan: {
        task_id: taskId,
        deliverable_type: 'research_plan',
        evidence_requirements: [
          {
            id: 'public-market-sources',
            acceptedClasses: ['public_source'],
            minimumCount: 1,
            required: true,
          },
        ],
        steps: [
          {
            step_no: 1,
            step_name: '快速公开来源调研',
            actor_type: 'tool',
            actor_id: 'tavily-search',
          },
        ],
      },
      pendingInputs: [],
    },
  ];
  const plannedResponse: ControlPlanCandidatesResponse = {
    kind: 'current',
    conversationId,
    task: {
      id: taskId,
      state: 'awaiting_selection',
      stateVersion: 0,
      activePlanVersionId: null,
      currentAttemptId: null,
    },
    structuredTask: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: '形成可信的市场研究计划',
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: ['research-planning', 'public-source-evidence'],
    candidates,
  };
  const planningInputs: ControlPlanningInput[] = [];
  const controlPlanning: PlannedAgentApiDependencies['controlPlanning'] = {
    async plan(input) {
      planningInputs.push(input);
      return plannedResponse;
    },
  };
  const requestBody: PlanControlTaskRequest = { originalInput, conversationId };
  let server: Server | undefined;

  try {
    const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
    // Module-boundary exception: server.ts loads .env during evaluation, so install the
    // test-only JWT secret before dynamically importing the app factory.
    const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
    const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
    server = createServer(createApp({ controlPlanning }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/control-tasks/plan`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as ControlPlanCandidatesResponse;
    assert.deepEqual(planningInputs, [{ originalInput, ownerUserId, conversationId }]);
    assert.deepEqual(Object.keys(requestBody).sort(), ['conversationId', 'originalInput']);
    assert.equal(body.kind, 'current');
    assert.equal(body.conversationId, conversationId);
    assert.equal(body.task.state, 'awaiting_selection');
    assert.deepEqual(body.structuredTask, plannedResponse.structuredTask);
    assert.deepEqual(body.activatedNodes, plannedResponse.activatedNodes);
    assert.deepEqual(
      body.candidates.map(({ candidateId, planVersionId }) => ({ candidateId, planVersionId })),
      [
        { candidateId: 'depth', planVersionId: candidates[0].planVersionId },
        { candidateId: 'speed', planVersionId: candidates[1].planVersionId },
      ],
    );
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    restoreJwtSecret();
  }
});

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

function parseSseEvents(body: string): ParsedSseEvent[] {
  return body
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      assert.ok(eventLine, `SSE block is missing event: ${block}`);
      assert.ok(dataLine, `SSE block is missing data: ${block}`);
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as unknown,
      };
    });
}

interface PendingSseStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  body: string;
}

async function settleWithinIoTurns<T>(promise: Promise<T>, label: string): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  void promise.then(
    (value) => { outcome = { ok: true, value }; },
    (error: unknown) => { outcome = { ok: false, error }; },
  );
  for (let turn = 0; turn < 64 && !outcome; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(outcome, `${label} did not settle while the planning promise was pending`);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function readSseUntil(
  stream: PendingSseStream,
  predicate: (body: string) => boolean,
  label: string,
): Promise<string> {
  while (!predicate(stream.body)) {
    const chunk = await settleWithinIoTurns(stream.reader.read(), label);
    assert.equal(chunk.done, false, `${label} ended before the expected event`);
    stream.body += stream.decoder.decode(chunk.value, { stream: true });
  }
  return stream.body;
}

test('POST /api/control-tasks/plan/stream emits conversation, progress, and Current result SSE events', async () => {
  process.env.JWT_SECRET = `control-planning-stream-test-${randomUUID()}`;
  const ownerUserId = activeOwnerUserId;
  const conversationId = '00000000-0000-0000-0000-000000000211';
  const taskId = '00000000-0000-0000-0000-000000000311';
  const originalInput = '流式生成宠物辅食市场可信研究计划';
  const progress: PlanProgress = {
    phase: 'candidates',
    status: 'done',
    label: '生成候选计划',
    detail: 'depth · speed',
  };
  const plannedResponse: ControlPlanCandidatesResponse = {
    kind: 'current',
    conversationId,
    task: {
      id: taskId,
      state: 'awaiting_selection',
      stateVersion: 0,
      activePlanVersionId: null,
      currentAttemptId: null,
    },
    structuredTask: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: '形成可信的市场研究计划',
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: ['D5_competitive', 'D6_evidence'],
    candidates: [],
  };
  const planningInputs: ControlPlanningInput[] = [];
  const controlPlanning: PlannedAgentApiDependencies['controlPlanning'] = {
    async plan(input, onProgress) {
      planningInputs.push(input);
      onProgress?.(progress);
      return plannedResponse;
    },
  };
  let server: Server | undefined;

  try {
    const token = signToken({ userId: ownerUserId, email: 'stream-owner@test.local' });
    // Module-boundary exception: server.ts reads JWT configuration during evaluation,
    // so this test must install its isolated secret before loading the app factory.
    const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
    const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
    server = createServer(createApp({ controlPlanning }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/control-tasks/plan/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ originalInput, conversationId }),
      },
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(planningInputs, [{ originalInput, ownerUserId, conversationId }]);
    assert.deepEqual(events.map((event) => event.event), [
      'conversation',
      'progress',
      'result',
    ]);
    assert.deepEqual(events[0]?.data, { conversationId });
    assert.deepEqual(events[1]?.data, progress);
    assert.deepEqual(events[2]?.data, plannedResponse);
    const result = events[2]?.data as unknown as Record<string, unknown>;
    assert.equal(result.kind, 'current');
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    restoreJwtSecret();
  }
});

test('new-conversation SSE publishes conversation and progress before planning resolves', async () => {
  process.env.JWT_SECRET = `control-planning-new-conversation-${randomUUID()}`;
  const conversationId = '00000000-0000-0000-0000-000000000212';
  const taskId = '00000000-0000-0000-0000-000000000312';
  const originalInput = '未提供 conversationId 时也要实时返回规划进度';
  const progress: PlanProgress = {
    phase: 'understand',
    status: 'start',
    label: '理解任务需求',
  };
  const plannedResponse: ControlPlanCandidatesResponse = {
    kind: 'current',
    conversationId,
    task: {
      id: taskId,
      state: 'awaiting_selection',
      stateVersion: 0,
      activePlanVersionId: null,
      currentAttemptId: null,
    },
    structuredTask: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: originalInput,
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: [],
    candidates: [],
  };
  let releasePlanning = (): void => {};
  let markPlanningEntered = (): void => {};
  const planningGate = new Promise<void>((resolve) => { releasePlanning = resolve; });
  const planningEntered = new Promise<void>((resolve) => { markPlanningEntered = resolve; });
  const controlPlanning: PlannedAgentApiDependencies['controlPlanning'] = {
    async plan(_input, onProgress, onConversation) {
      onConversation?.(conversationId);
      onProgress?.(progress);
      markPlanningEntered();
      await planningGate;
      return plannedResponse;
    },
  };
  let server: Server | undefined;
  let responsePromise: Promise<Response> | undefined;
  let stream: PendingSseStream | undefined;

  try {
    const token = signToken({ userId: activeOwnerUserId, email: 'new-stream-owner@test.local' });
    // Module-boundary exception: JWT configuration must be installed before server.ts evaluation.
    const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
    const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
    server = createServer(createApp({ controlPlanning }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    responsePromise = fetch(`http://127.0.0.1:${address.port}/api/control-tasks/plan/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ originalInput }),
    });
    await planningEntered;
    const response = await settleWithinIoTurns(
      responsePromise,
      'SSE response before planning resolution',
    );
    assert.ok(response.body);
    stream = { reader: response.body.getReader(), decoder: new TextDecoder(), body: '' };
    const prefix = await readSseUntil(
      stream,
      (body) => body.includes(
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
      ) && body.includes(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`),
      'conversation and progress prefix',
    );
    const prefixEvents = parseSseEvents(prefix);

    assert.deepEqual(prefixEvents.map((event) => event.event), ['conversation', 'progress']);
    assert.deepEqual(prefixEvents[0]?.data, { conversationId });
    assert.deepEqual(prefixEvents[1]?.data, progress);
    assert.equal(prefix.includes('event: result\n'), false);

    releasePlanning();
    const completed = await readSseUntil(
      stream,
      (body) => body.includes(`event: result\ndata: ${JSON.stringify(plannedResponse)}\n\n`),
      'planning result',
    );
    assert.deepEqual(parseSseEvents(completed).map((event) => event.event), [
      'conversation',
      'progress',
      'result',
    ]);
  } finally {
    releasePlanning();
    await stream?.reader.cancel().catch(() => {});
    await responsePromise?.catch(() => {});
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    restoreJwtSecret();
  }
});

test('new-conversation SSE emits conversation before an error when planning fails', async () => {
  process.env.JWT_SECRET = `control-planning-new-conversation-error-${randomUUID()}`;
  const conversationId = '00000000-0000-0000-0000-000000000213';
  const controlPlanning: PlannedAgentApiDependencies['controlPlanning'] = {
    async plan(_input, _onProgress, onConversation) {
      onConversation?.(conversationId);
      throw new Error('planning fixture failed');
    },
  };
  let server: Server | undefined;

  try {
    const token = signToken({ userId: activeOwnerUserId, email: 'new-stream-error@test.local' });
    // Module-boundary exception: JWT configuration must be installed before server.ts evaluation.
    const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
    const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
    server = createServer(createApp({ controlPlanning }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/control-tasks/plan/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ originalInput: '失败也要先返回新会话' }),
    });
    const events = parseSseEvents(await response.text());

    assert.deepEqual(events.map((event) => event.event), ['conversation', 'error']);
    assert.deepEqual(events[0]?.data, { conversationId });
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    restoreJwtSecret();
  }
});
