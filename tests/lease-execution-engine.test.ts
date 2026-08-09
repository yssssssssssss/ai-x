import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  ExecutionAuthenticityError,
  LeaseExecutionEngine,
} from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  FakeO2Adapter,
  TavilyAdapter,
  ToolInvocationError,
  ToolRouter,
  type ToolAdapter,
  type ToolInvokeResult,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { getConfigRoot, setConfigRoot, type ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlExecutionLease,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import { loadEnv } from '../database/db.ts';

loadEnv();
const skipRealTavily = !process.env.TAVILY_TEST;

class ScopedEngineDatabase implements MigrationDatabase {
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

class CountingRealTavilyAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'test-tavily-real-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'api.tavily.test';
  }

  async invoke(options: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    return {
      output: {
        answer: null,
        response_time: 0.1,
        results: [{
          title: 'Source',
          url: 'https://source.test/article',
          snippet: 'verified public source owner@example.com 13800138000 api_key=secret-value',
          score: 0.9,
          published_date: null,
        }],
      },
      latencyMs: 1,
      receipt: {
        declaredAdapterType: options.manifest.adapter_type,
        resolvedAdapterType: this.adapterType,
        implementationId: this.implementationId,
        executionMode: this.executionMode,
        endpointHost: this.endpointHost(),
        status: 'ok',
        latencyMs: 1,
      },
    };
  }
}

class FailingRealAdapter implements ToolAdapter {
  readonly implementationId = 'test-failing-real-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  constructor(readonly adapterType: ToolManifest['adapter_type']) {}

  endpointHost(): string {
    return 'dependency.test';
  }

  async invoke(options: { toolId: string }): Promise<never> {
    this.calls += 1;
    throw new ToolInvocationError(options.toolId, {
      kind: 'network',
      retryable: true,
      providerStatus: null,
      sanitizedMessage: 'dependency unavailable',
    });
  }
}

class ConfigBreakingAdapter extends FailingRealAdapter {
  constructor(private readonly breakConfig: () => void) {
    super('tavily');
  }

  override async invoke(options: { toolId: string }): Promise<never> {
    this.breakConfig();
    return super.invoke(options);
  }
}

class InvalidSchemaRealAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'test-invalid-schema-real-v1';
  readonly executionMode = 'real' as const;

  endpointHost(): string {
    return 'api.tavily.test';
  }

  async invoke(options: { manifest: ToolManifest }): Promise<ToolInvokeResult> {
    return {
      output: { results: 'invalid' },
      latencyMs: 1,
      receipt: {
        declaredAdapterType: options.manifest.adapter_type,
        resolvedAdapterType: this.adapterType,
        implementationId: this.implementationId,
        executionMode: this.executionMode,
        endpointHost: this.endpointHost(),
        status: 'ok',
        latencyMs: 1,
      },
    };
  }
}

class SensitiveBusinessRealAdapter extends CountingRealTavilyAdapter {
  override async invoke(options: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const result = await super.invoke(options);
    return {
      ...result,
      output: {
        answer: null,
        response_time: 0.1,
        results: [{
          title: 'Internal roadmap',
          url: 'https://source.test/internal',
          snippet: 'confidential internal-only roadmap',
          score: 0.9,
          published_date: null,
        }],
      },
    };
  }
}

class ExpiringRealAdapter extends CountingRealTavilyAdapter {
  constructor(private readonly expire: () => Promise<void>) {
    super();
  }

  override async invoke(options: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const result = await super.invoke(options);
    await this.expire();
    return result;
  }
}

class CountingRealLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'pinned-model',
    mode: 'real',
    eligibleAsReal: true,
  };
  calls = 0;

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls += 1;
    const data = options.schemaName.startsWith('skill:')
      ? {
          comparison_matrix: [{ competitor: 'A', dimension: '体验', assessment: 'ok', source: 'tool_result' }],
          differentiation_opportunities: ['verified'],
          sources: ['https://source.test/article'],
        }
      : { ok: true };
    return {
      data: data as T,
      promptHash: `sha256:${createHash('sha256').update(options.prompt).digest('hex')}`,
      modelName: 'pinned-model',
      modelVersion: 'pinned-model',
      traceId: `trace-${this.calls}`,
      tokens: { prompt: 10, completion: 5, total: 15 },
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    this.calls += 1;
    return {
      text: `result:${options.receipt.stage}`,
      promptHash: `sha256:${createHash('sha256').update(options.prompt).digest('hex')}`,
      modelName: 'pinned-model',
      modelVersion: 'pinned-model',
      traceId: `trace-${this.calls}`,
      tokens: { prompt: 4, completion: 2, total: 6 },
    };
  }
}

class CountingMockLLM extends CountingRealLLM {
  override readonly identity: LLMProviderIdentity = {
    provider: 'mock',
    endpointHost: 'local-mock',
    requestedModel: 'mock-model',
    mode: 'mock',
    eligibleAsReal: false,
  };
}

const schema = `lease_engine_${randomUUID().replaceAll('-', '')}`;
const artifactRoot = mkdtempSync(join(tmpdir(), 'lease-engine-artifacts-'));
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedEngineDatabase(database, schema);
let ownerId = '';
let conversationId = '';

function leaseHash(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
  rmSync(artifactRoot, { recursive: true, force: true });
});

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_830_934,
  });
  const connection = await scopedDatabase.connect();
  try {
    const owner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'engine owner', 'x', 'member') RETURNING id`,
      [`engine-${Date.now()}@test.local`],
    );
    ownerId = String(owner.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, 'lease engine') RETURNING id`,
      [ownerId],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
});

const planSteps = [
  {
    step_no: 1,
    step_name: '公开资料检索',
    actor_type: 'tool' as const,
    actor_id: 'tavily-web-search',
    input: { query: 'digital human competitors' },
    requires_approval: false,
  },
  {
    step_no: 2,
    step_name: '竞品分析',
    actor_type: 'skill' as const,
    actor_id: 'digital-human-competitive-analysis',
    requires_approval: false,
  },
  {
    step_no: 3,
    step_name: '摘要',
    actor_type: 'llm' as const,
    actor_id: 'summary',
    requires_approval: false,
  },
  {
    step_no: 4,
    step_name: '复核',
    actor_type: 'reviewer' as const,
    actor_id: 'review',
    requires_approval: false,
  },
];

async function claimedExecution(
  expiresAt = new Date(Date.now() + 60_000),
  steps = planSteps,
): Promise<{
  repository: ControlPlaneRepository;
  lease: ControlExecutionLease;
}> {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'lease-only execution',
    taskType: 'competitive_research',
    structuredTask: { research_goal: 'compare digital human products' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { task_id: task.id, steps },
    planHash: `sha256:${randomUUID()}`,
  });
  const leaseToken = randomUUID();
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: 'engine-worker',
    leaseTokenHash: leaseHash(leaseToken),
    leaseExpiresAt: expiresAt,
  });
  return {
    repository,
    lease: {
      taskId: task.id,
      planVersionId: plan.id,
      attemptId: claim.attemptId,
      leaseOwner: 'engine-worker',
      leaseToken,
    },
  };
}

function buildEngine(
  repository: ControlPlaneRepository,
  tools: ToolRouter,
  llm: LLMClient,
): LeaseExecutionEngine {
  return new LeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools,
    llm,
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
  });
}

test('rejects an invalid lease before Tool or LLM side effects', async () => {
  const { repository, lease } = await claimedExecution();
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const router = new ToolRouter().register(adapter);
  const engine = buildEngine(repository, router, llm);

  await assert.rejects(
    () => engine.execute({ lease: { ...lease, leaseToken: 'wrong' }, expectedModel: 'pinned-model' }),
    ControlPlaneConflictError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
});

test('executes the current plan with real Tool provenance and complete model receipts', async () => {
  const { repository, lease } = await claimedExecution();
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT storage_uri FROM control_artifacts WHERE attempt_id = $1 AND kind = 'tool_output'`,
      [lease.attemptId],
    );
    const storageUri = artifacts.rows[0]?.storage_uri;
    if (typeof storageUri !== 'string') assert.fail('tool artifact storage_uri must be a string');
    const persisted: unknown = JSON.parse(readFileSync(storageUri, 'utf8'));
    assert.ok(persisted && typeof persisted === 'object');
    assert.ok('output' in persisted);
    const serialized = JSON.stringify(persisted);
    assert.match(serialized, /verified public source/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /secret-value/);
    assert.doesNotMatch(serialized, /owner@example\.com|13800138000/);
    assert.match(serialized, /\[REDACTED_EMAIL\]|\[REDACTED_PHONE\]/);
  } finally {
    connection.release();
  }

  assert.equal(result.status, 'completed');
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 4);
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].toolProvenance?.executionMode, 'real');
  assert.equal(steps[0].toolProvenance?.implementationId, 'test-tavily-real-v1');
  const calls = await repository.listModelCalls(lease.attemptId);
  assert.deepEqual(calls.map((call) => call.stage), ['skill', 'llm', 'reviewer', 'synthesis']);
  const attempts = await repository.listAttempts(lease.taskId);
  assert.equal(attempts[0]?.state, 'completed');
});

test('rejects fake adapter qualification before invoking it and pauses the attempt', async () => {
  const { repository, lease } = await claimedExecution();
  const fake = new FakeO2Adapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().registerAs('tavily', fake), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(llm.calls, 0);
  const attempts = await repository.listAttempts(lease.taskId);
  assert.equal(attempts[0]?.state, 'paused');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps[0]?.failure?.kind, 'authenticity');
  assert.equal(steps[0]?.failure?.declaredAdapterType, 'tavily');
  assert.equal(steps[0]?.failure?.resolvedAdapterType, 'fake');
  assert.equal(steps[0]?.failure?.executionMode, 'fake');
});

test('derives retry and skip actions from Tool tier instead of error text', async () => {
  const core = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const coreAdapter = new FailingRealAdapter('tavily');
  const coreResult = await buildEngine(
    core.repository,
    new ToolRouter().register(coreAdapter),
    new CountingRealLLM(),
  ).execute({ lease: core.lease, expectedModel: 'pinned-model' });
  assert.equal(coreResult.status, 'paused');
  assert.equal(coreResult.failure?.toolTier, 'core');
  assert.deepEqual(coreResult.failure?.allowedActions, ['retry', 'abort']);
  const coreSteps = await core.repository.listExecutionSteps(core.lease.attemptId);
  assert.match(String(coreSteps[0]?.toolProvenance?.registryHash), /^sha256:/);
  assert.match(String(coreSteps[0]?.toolProvenance?.manifestHash), /^sha256:/);
  assert.match(String(coreSteps[0]?.toolProvenance?.inputSchemaHash), /^sha256:/);
  assert.match(String(coreSteps[0]?.toolProvenance?.outputSchemaHash), /^sha256:/);
  assert.match(String(coreSteps[0]?.toolProvenance?.inputHash), /^sha256:/);
  assert.equal(coreSteps[0]?.toolProvenance?.executionMode, 'real');
  assert.equal(coreSteps[0]?.toolProvenance?.status, 'failed');

  const optionalSteps = [
    planSteps[0],
    {
      ...planSteps[0],
      step_no: 2,
      actor_id: 'ai-spider-search',
    },
  ];
  const optional = await claimedExecution(new Date(Date.now() + 60_000), optionalSteps);
  const optionalAdapter = new FailingRealAdapter('internal_api');
  const optionalRouter = new ToolRouter()
    .register(new CountingRealTavilyAdapter())
    .register(optionalAdapter);
  const optionalResult = await buildEngine(
    optional.repository,
    optionalRouter,
    new CountingRealLLM(),
  ).execute({ lease: optional.lease, expectedModel: 'pinned-model' });
  assert.equal(optionalResult.status, 'paused');
  assert.equal(optionalResult.failure?.toolTier, 'optional');
  assert.deepEqual(optionalResult.failure?.allowedActions, ['retry', 'skip', 'abort']);
});

test('discards Tool output when the lease is lost while awaiting the provider', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const expire = async () => {
    const connection = await scopedDatabase.connect();
    try {
      await connection.query(
        `UPDATE control_execution_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [lease.attemptId],
      );
    } finally {
      connection.release();
    }
    await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  };
  const engine = buildEngine(
    repository,
    new ToolRouter().register(new ExpiringRealAdapter(expire)),
    new CountingRealLLM(),
  );

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT count(*) AS count FROM control_artifacts WHERE attempt_id = $1`,
      [lease.attemptId],
    );
    assert.equal(Number(artifacts.rows[0]?.count), 0);
  } finally {
    connection.release();
  }
});


test('provenance capture failure cannot mask the Tool failure or leave execution active', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const originalRoot = getConfigRoot();
  const missingRoot = mkdtempSync(join(tmpdir(), 'missing-config-root-'));
  const adapter = new ConfigBreakingAdapter(() => setConfigRoot(missingRoot));
  try {
    const result = await buildEngine(
      repository,
      new ToolRouter().register(adapter),
      new CountingRealLLM(),
    ).execute({ lease, expectedModel: 'pinned-model' });
    assert.equal(result.status, 'paused');
    assert.equal(result.failure?.kind, 'network');
    assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  } finally {
    setConfigRoot(originalRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
test('persists the real Tool receipt when output schema validation fails', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const result = await buildEngine(
    repository,
    new ToolRouter().register(new InvalidSchemaRealAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'schema');
  const receipt = result.failure?.receipt;
  assert.ok(receipt && typeof receipt === 'object');
  assert.ok('implementationId' in receipt);
  assert.ok('executionMode' in receipt);
  assert.equal(receipt.implementationId, 'test-invalid-schema-real-v1');
  assert.equal(receipt.executionMode, 'real');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.match(String(steps[0]?.toolProvenance?.outputHash), /^sha256:/);
});

test('blocks sensitive business output before artifact persistence', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const result = await buildEngine(
    repository,
    new ToolRouter().register(new SensitiveBusinessRealAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'safety');
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT count(*) AS count FROM control_artifacts WHERE attempt_id = $1`,
      [lease.attemptId],
    );
    assert.equal(Number(artifacts.rows[0]?.count), 0);
  } finally {
    connection.release();
  }
});

test('rejects a plan without the required core Tavily step before side effects', async () => {
  const llmOnlyPlan = [{ ...planSteps[2], step_no: 1 }];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), llmOnlyPlan);
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('rejects mock LLM before Tool or synthesis side effects', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingMockLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'mock-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('real Tavily runs only through a valid lease and persists real provenance', { skip: skipRealTavily }, async () => {
  const toolOnlyPlan = [planSteps[0]];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), toolOnlyPlan);
  const engine = buildEngine(
    repository,
    new ToolRouter().register(new TavilyAdapter()),
    new CountingRealLLM(),
  );

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps[0]?.toolProvenance?.implementationId, 'tavily');
  assert.equal(steps[0]?.toolProvenance?.executionMode, 'real');
  assert.equal(steps[0]?.toolProvenance?.resolvedAdapterType, 'tavily');
  const refs = steps[0]?.toolProvenance?.sourceRefs;
  assert.ok(Array.isArray(refs) && refs.some((ref) => typeof ref === 'string' && ref.startsWith('http')));
});
