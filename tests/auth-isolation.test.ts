import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { Pool } from 'pg';
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneRepository,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import type { closePool as ClosePool } from '../database/db.ts';
import type {
  createConversation as CreateConversation,
  createUser as CreateUser,
  listMessages as ListMessages,
  writeMessage as WriteMessage,
} from '../database/repository.ts';
import type { CurrentExecutionPlan } from '../packages/api-contract/research-deliverable.ts';

class ScopedMigrationDatabase implements MigrationDatabase {
  constructor(
    private readonly database: Pool,
    private readonly schema: string,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const client = await this.database.connect();
    await client.query(`SET search_path TO "${this.schema}", public`);
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows };
      },
      release() {
        client.release();
      },
    };
  }
}

type MessageRow = {
  id: string;
  sender_type: string;
  message_type: string;
  content: unknown;
};

type OwnerAwareListMessages = (
  conversationId: string,
  ownerUserId: string,
) => Promise<MessageRow[]>;
type RepositoryModule = {
  createConversation: typeof CreateConversation;
  createUser: typeof CreateUser;
  listMessages: typeof ListMessages;
  writeMessage: typeof WriteMessage;
};
try {
  process.loadEnvFile('.env');
} catch {
  // An absent local .env is valid; the fallback database below remains the test target.
}

const schema = `auth_isolation_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedMigrationDatabase(database, schema);
const controlRepository = new ControlPlaneRepository(scopedDatabase);
const originalJwtSecret = process.env.JWT_SECRET;
const originalPgOptions = process.env.PGOPTIONS;

let repository: RepositoryModule;
let closeRepositoryPool: typeof ClosePool | undefined;
let ownerUserId = '';
let foreignUserId = '';
let inactiveUserId = '';
let inactiveUserEmail = '';
const inactiveUserDisplayName = 'inactive auth user';
let conversationId = '';
let currentTaskId = '';
let currentPlanVersionId = '';

function restoreEnvironment(name: 'JWT_SECRET' | 'PGOPTIONS', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function loadRequireJwtSecret(): Promise<() => string> {
  // This import intentionally probes a not-yet-exported API without making type-checking fail first.
  const authModule = await import('../apps/agent-api/src/auth.ts') as unknown as Record<string, unknown>;
  assert.equal(
    typeof authModule.requireJwtSecret,
    'function',
    'auth module must export requireJwtSecret()',
  );
  return authModule.requireJwtSecret as () => string;
}

function currentFixturePlan(label: string): Omit<CurrentExecutionPlan, 'task_id'> {
  const questionId = `${label}-question`;
  return {
    deliverable_type: 'research_plan',
    evidence_requirements: [],
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: questionId,
        statement: `${label} research question`,
        rationale: 'authorization fixture',
        priority: 'optional',
        success_criterion_ids: [],
        evidence_requirements: [],
        acceptance_criteria: ['fixture completes'],
        depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'auth-fixture-model',
      modelVersion: '1',
      promptHash: 'sha256:auth-fixture-problem-graph',
      traceId: 'trace-auth-fixture-problem-graph',
    },
    capability_decisions: { eligible: [], rejected: [] },
    steps: [{
      step_no: 1,
      step_name: label,
      actor_type: 'llm',
      actor_id: 'research-synthesis',
      question_ids: [questionId],
      depends_on: [],
      input: {},
      input_bindings: [],
      expected_outputs: [{ pointer: '/result', description: 'fixture result' }],
      acceptance_criteria: ['fixture completes'],
      requires_approval: false,
      fallback_actor_ids: [],
    }],
    candidate_metadata: { title: label, rationale: 'fixture', tradeoffs: 'fixture only' },
    activated_nodes: [],
  };
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_831_011,
  });

  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  // Static imports would construct the shared pool before its scoped PGOPTIONS is installed.
  repository = await import('../database/repository.ts');
  ({ closePool: closeRepositoryPool } = await import('../database/db.ts'));
  await database.query(
    `INSERT INTO "${schema}".control_model_calls
       (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
        prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
     VALUES ('11111111-1111-4111-8111-111111111111', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
             'auth-fixture-model', 'auth-fixture-model', '1', 'sha256:auth-fixture-problem-graph',
             NULL, 'trace-auth-fixture-problem-graph', 'succeeded', now(), now())`,
  );

  const owner = await repository.createUser({
    email: `auth-owner-${randomUUID()}@test.local`,
    displayName: 'auth owner',
    passwordHash: 'x',
  });
  const foreign = await repository.createUser({
    email: `auth-foreign-${randomUUID()}@test.local`,
    displayName: 'foreign owner',
    passwordHash: 'x',
  });
  inactiveUserEmail = `auth-inactive-${randomUUID()}@test.local`;
  const inactive = await repository.createUser({
    email: inactiveUserEmail,
    displayName: inactiveUserDisplayName,
    passwordHash: 'x',
  });
  inactiveUserId = inactive.id;
  await database.query(
    `UPDATE "${schema}".users SET status = 'inactive', updated_at = now() WHERE id = $1`,
    [inactiveUserId],
  );
  ownerUserId = owner.id;
  foreignUserId = foreign.id;

  const conversation = await repository.createConversation({
    ownerUserId,
    title: 'owner-only conversation',
  });
  conversationId = conversation.id;
  await repository.writeMessage({
    conversationId,
    senderType: 'user',
    messageType: 'text',
    content: { text: 'owner-visible message' },
  });
  const current = await controlRepository.createTaskWithCandidates({
    conversationId,
    ownerUserId,
    originalInput: 'owner-only Current task',
    taskType: 'competitive_research',
    structuredTask: { confirmations: [], blocking_issues: [] },
    candidates: [
      {
        candidateId: 'depth',
        plan: currentFixturePlan('depth public research'),
        pendingInputs: [],
      },
      {
        candidateId: 'speed',
        plan: currentFixturePlan('speed public research'),
        pendingInputs: [],
      },
    ],
  });
  currentTaskId = current.task.id;
  currentPlanVersionId = current.candidates[0]!.id;
});

afterEach(() => {
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
});

after(async () => {
  try {
    await closeRepositoryPool?.();
  } finally {
    try {
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await database.end();
      restoreEnvironment('JWT_SECRET', originalJwtSecret);
      restoreEnvironment('PGOPTIONS', originalPgOptions);
    }
  }
});

test('requireJwtSecret fails closed when JWT_SECRET is missing', async () => {
  delete process.env.JWT_SECRET;
  const requireJwtSecret = await loadRequireJwtSecret();

  assert.throws(() => requireJwtSecret(), /JWT_SECRET/);
});

test('requireJwtSecret returns the configured JWT_SECRET value', async () => {
  const configuredSecret = `test-only-${randomUUID()}`;
  process.env.JWT_SECRET = configuredSecret;
  const requireJwtSecret = await loadRequireJwtSecret();

  assert.equal(requireJwtSecret(), configuredSecret);
});

test('agent API factory fails closed when JWT_SECRET is missing', async () => {
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  process.env.JWT_SECRET = '';
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');

  assert.throws(() => createAgentApiApp(), /JWT_SECRET/);
});

test('agent API factory starts when JWT_SECRET is configured', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');

  assert.doesNotThrow(() => createAgentApiApp());
});

test('conversation routes reject inactive users without leaking user details', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const server = createAgentApiApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const request = (userId: string, email: string) => fetch(
    `http://127.0.0.1:${address.port}/api/conversations`,
    { headers: { Authorization: `Bearer ${signToken({ userId, email })}` } },
  );

  try {
    const ownerResponse = await request(ownerUserId, `${ownerUserId}@test.local`);
    assert.equal(ownerResponse.status, 200);
    await ownerResponse.json();

    const inactiveResponse = await request(inactiveUserId, inactiveUserEmail);
    assert.equal(inactiveResponse.status, 401);
    const inactiveBody = await inactiveResponse.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(inactiveBody), ['error']);
    assert.equal(typeof inactiveBody.error, 'string');
    const error = inactiveBody.error as string;
    assert.equal(error.includes(inactiveUserId), false);
    assert.equal(error.includes(inactiveUserEmail), false);
    assert.equal(error.includes(inactiveUserDisplayName), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('conversation messages route returns 404 for foreign and missing conversations', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const server = createAgentApiApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const request = (targetConversationId: string, userId: string) => fetch(
    `http://127.0.0.1:${address.port}/api/conversations/${targetConversationId}/messages`,
    { headers: { Authorization: `Bearer ${signToken({ userId, email: `${userId}@test.local` })}` } },
  );

  try {
    const ownerResponse = await request(conversationId, ownerUserId);
    assert.equal(ownerResponse.status, 200);
    const ownerBody = await ownerResponse.json() as { messages: MessageRow[] };
    assert.equal(ownerBody.messages.length, 1);

    const foreignResponse = await request(conversationId, foreignUserId);
    assert.equal(foreignResponse.status, 404);

    const missingResponse = await request(randomUUID(), ownerUserId);
    assert.equal(missingResponse.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Current task GET and every command hide foreign and missing task IDs behind 404', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const server = createAgentApiApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const missingTaskId = randomUUID();
  const commands = [
    {
      name: 'select',
      body: { expectedVersion: 0, planVersionId: currentPlanVersionId },
    },
    {
      name: 'confirm',
      body: {
        expectedVersion: 0,
        planVersionId: currentPlanVersionId,
        confirmationAnswers: {},
        inputRoles: [],
      },
    },
    {
      name: 'approve',
      body: {
        expectedVersion: 0,
        planVersionId: currentPlanVersionId,
        gateKey: 'step:1',
        decision: 'approved',
      },
    },
    {
      name: 'revise',
      body: {
        expectedVersion: 0,
        candidateId: 'depth',
        plan: { steps: [] },
        planHash: `sha256:${'a'.repeat(64)}`,
        pendingInputs: [],
      },
    },
    { name: 'resume', body: { expectedVersion: 0, action: 'retry' } },
    {
      name: 'execute',
      body: { expectedVersion: 0, planVersionId: currentPlanVersionId },
    },
  ];

  try {
    for (const target of [
      { label: 'foreign', taskId: currentTaskId, token: foreignToken },
      { label: 'missing', taskId: missingTaskId, token: ownerToken },
    ]) {
      const getResponse = await fetch(`${baseUrl}/api/control-tasks/${target.taskId}`, {
        headers: { authorization: `Bearer ${target.token}` },
      });
      assert.equal(getResponse.status, 404, `${target.label} GET`);
      await getResponse.text();
      const deliverableResponse = await fetch(
        `${baseUrl}/api/control-tasks/${target.taskId}/deliverable`,
        { headers: { authorization: `Bearer ${target.token}` } },
      );
      const deliverableBody = await deliverableResponse.json() as Record<string, unknown>;
      assert.equal(deliverableResponse.status, 404, `${target.label} deliverable GET`);
      assert.deepEqual(Object.keys(deliverableBody), ['error']);
      assert.equal(JSON.stringify(deliverableBody).includes(target.taskId), false);

      for (const command of commands) {
        const response = await fetch(
          `${baseUrl}/api/control-tasks/${target.taskId}/${command.name}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${target.token}`,
              'content-type': 'application/json',
              'idempotency-key': `${target.label}-${command.name}-${randomUUID()}`,
            },
            body: JSON.stringify(command.body),
          },
        );
        const body = await response.json() as Record<string, unknown>;
        assert.equal(response.status, 404, `${target.label} ${command.name}`);
        assert.deepEqual(Object.keys(body), ['error']);
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes(currentTaskId), false);
        assert.equal(serialized.includes(missingTaskId), false);
      }
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('visual Asset route serves owner bytes and hides foreign, missing, and blocked Assets behind one 404', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const assetBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const allowedAssetId = randomUUID();
  const allowedV2AssetId = randomUUID();
  const blockedAssetId = randomUUID();
  const missingAssetId = randomUUID();
  const missingPolicyAssetId = randomUUID();
  const malformedSourceAssetId = randomUUID();
  const malformedDerivationAssetId = randomUUID();
  const wrongSchemaVersionAssetId = randomUUID();
  const v1BodyV2MarkerAssetId = randomUUID();
  const v2BodyV1MarkerAssetId = randomUUID();
  const storageUri = `/private/tasks/${currentTaskId}/visuals/${allowedAssetId}.png`;
  const reads: Array<{ taskId: string; assetId: string; ownerUserId: string }> = [];
  const readVisualAsset = async (input: {
    taskId: string;
    assetId: string;
    ownerUserId: string;
  }) => {
    reads.push(input);
    if (input.taskId !== currentTaskId || input.ownerUserId !== ownerUserId) return null;
    const readableAssetIds: readonly string[] = [
      allowedAssetId,
      allowedV2AssetId,
      blockedAssetId,
      missingPolicyAssetId,
      malformedSourceAssetId,
      malformedDerivationAssetId,
      wrongSchemaVersionAssetId,
      v1BodyV2MarkerAssetId,
      v2BodyV1MarkerAssetId,
    ];
    if (!readableAssetIds.includes(input.assetId)) return null;
    const isV2 = input.assetId === allowedV2AssetId || input.assetId === v2BodyV1MarkerAssetId;
    const manifest: Record<string, unknown> = {
      version: isV2 ? 'visual-asset-manifest-v2' : 'visual-asset-manifest-v1',
      taskId: currentTaskId,
      planVersionId: currentPlanVersionId,
      attemptId: 'attempt-route-fixture',
      assetId: input.assetId,
      contentSha256: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/png',
      byteSize: assetBytes.byteLength,
      width: 1,
      height: 1,
      exportPolicy: input.assetId === blockedAssetId ? 'block' : 'allow',
      source: isV2 ? {
        kind: 'browser_capture',
        artifactId: 'tool-output-route-fixture',
        artifactContentSha256: `sha256:${'c'.repeat(64)}`,
        jsonPointer: '/output/captures/0',
        attachmentId: 'capture-1',
        sourcePageUrl: 'https://shop.example.test/product',
        finalUrl: 'https://shop.example.test/product?view=assistant',
        pageTitle: 'Route fixture browser capture',
        capturedAt: '2026-08-19T08:00:00.000Z',
        captureMode: 'full_page_screenshot',
        viewport: { width: 1440, height: 900 },
      } : { kind: 'user_upload', fileName: 'route-fixture.png' },
      derivedFrom: null,
      derivation: null,
      manifestHash: `sha256:${'b'.repeat(64)}`,
    };
    if (input.assetId === missingPolicyAssetId) delete manifest.exportPolicy;
    if (input.assetId === malformedSourceAssetId) {
      manifest.source = { kind: 'tool_artifact', url: 'https://cdn.example.test/unbound.png' };
    }
    if (input.assetId === malformedDerivationAssetId) manifest.derivation = { kind: 'heatmap' };
    return {
      artifact: {
        id: input.assetId,
        storageUri,
        contentSha256: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 'visual-asset-v1',
      },
      manifestArtifact: {
        id: `${input.assetId}-manifest`,
        schemaVersion: input.assetId === wrongSchemaVersionAssetId
          ? 'visual-asset-manifest-v0'
          : input.assetId === v1BodyV2MarkerAssetId
            ? 'visual-asset-manifest-v2'
            : input.assetId === v2BodyV1MarkerAssetId
              ? 'visual-asset-manifest-v1'
              : manifest.version,
      },
      bytes: assetBytes,
      manifest,
    };
  };
  const controlRuntime = {
    repository: controlRepository,
    workflow: {},
    getDeliverable: async () => null,
    readVisualAsset,
  };
  const server = createAgentApiApp({ controlRuntime: controlRuntime as never }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });
  const request = (assetId: string, token: string) => fetch(
    `${baseUrl}/api/control-tasks/${currentTaskId}/assets/${assetId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  try {
    const ownerResponse = await request(allowedAssetId, ownerToken);
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ownerResponse.arrayBuffer()), assetBytes);
    assert.equal(ownerResponse.headers.get('x-storage-uri'), null);

    const ownerV2Response = await request(allowedV2AssetId, ownerToken);
    assert.equal(ownerV2Response.status, 200);
    assert.equal(ownerV2Response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ownerV2Response.arrayBuffer()), assetBytes);

    const hiddenResponses = [
      await request(allowedAssetId, foreignToken),
      await request(missingAssetId, ownerToken),
      await request(blockedAssetId, ownerToken),
      await request(missingPolicyAssetId, ownerToken),
      await request(malformedSourceAssetId, ownerToken),
      await request(malformedDerivationAssetId, ownerToken),
      await request(wrongSchemaVersionAssetId, ownerToken),
      await request(v1BodyV2MarkerAssetId, ownerToken),
      await request(v2BodyV1MarkerAssetId, ownerToken),
    ];
    const hiddenBodies: Array<Record<string, unknown>> = [];
    for (const response of hiddenResponses) {
      assert.equal(response.status, 404);
      const body = await response.json() as Record<string, unknown>;
      hiddenBodies.push(body);
      assert.deepEqual(Object.keys(body), ['error']);
      const serialized = JSON.stringify(body);
      for (const hiddenId of [
        allowedAssetId,
        allowedV2AssetId,
        missingAssetId,
        blockedAssetId,
        missingPolicyAssetId,
        malformedSourceAssetId,
        malformedDerivationAssetId,
        wrongSchemaVersionAssetId,
        v1BodyV2MarkerAssetId,
        v2BodyV1MarkerAssetId,
      ]) {
        assert.equal(serialized.includes(hiddenId), false);
      }
      assert.equal(serialized.includes(storageUri), false);
    }
    for (const body of hiddenBodies.slice(1)) assert.deepEqual(body, hiddenBodies[0]);
    assert.deepEqual(reads, [
      { taskId: currentTaskId, assetId: allowedAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: allowedV2AssetId, ownerUserId },
      { taskId: currentTaskId, assetId: missingAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: blockedAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: missingPolicyAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: malformedSourceAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: malformedDerivationAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: wrongSchemaVersionAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: v1BodyV2MarkerAssetId, ownerUserId },
      { taskId: currentTaskId, assetId: v2BodyV1MarkerAssetId, ownerUserId },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('foreign and missing planning conversations return 404 without SSE existence disclosure', async () => {
  process.env.JWT_SECRET = `test-only-${randomUUID()}`;
  const leakedConversationId = conversationId;
  const controlPlanning = {
    async plan(input: { conversationId?: string }): Promise<never> {
      if (input.conversationId === leakedConversationId) {
        throw new ControlPlaneAuthorizationError(
          `conversation ${leakedConversationId} is not owned by ${foreignUserId}`,
        );
      }
      throw new ControlPlaneConflictError(`conversation ${input.conversationId} does not exist`);
    },
  };
  // Static import would load the app and shared DB pool before this test installs its scoped environment.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const server = createAgentApiApp({ controlPlanning }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });
  const missingConversationId = randomUUID();

  try {
    for (const target of [
      { conversationId: leakedConversationId, token: foreignToken },
      { conversationId: missingConversationId, token: ownerToken },
    ]) {
      const response = await fetch(`${baseUrl}/api/control-tasks/plan`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          originalInput: '不得探测 conversation 是否存在',
          conversationId: target.conversationId,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 404);
      assert.deepEqual(Object.keys(body), ['error']);
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes(leakedConversationId), false);
      assert.equal(serialized.includes(missingConversationId), false);
      assert.equal(serialized.includes(foreignUserId), false);
    }

    const streamResponse = await fetch(`${baseUrl}/api/control-tasks/plan/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${foreignToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        originalInput: 'SSE 不得泄露 foreign conversation',
        conversationId: leakedConversationId,
      }),
    });
    const streamBody = await streamResponse.text();
    const eventNames = [...streamBody.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(eventNames, ['error']);
    assert.equal(streamBody.includes(leakedConversationId), false);
    assert.equal(streamBody.includes(foreignUserId), false);
    assert.equal(streamBody.includes('not owned'), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('listMessages returns owner messages and hides them from a foreign owner', async () => {
  const listMessages = repository.listMessages as unknown as OwnerAwareListMessages;

  const ownerMessages = await listMessages(conversationId, ownerUserId);
  assert.equal(ownerMessages.length, 1);
  assert.deepEqual(ownerMessages[0]?.content, { text: 'owner-visible message' });

  const foreignMessages = await listMessages(conversationId, foreignUserId);
  assert.deepEqual(foreignMessages, []);
});
