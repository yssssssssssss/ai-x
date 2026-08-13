import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Express } from 'express';
import { Pool } from 'pg';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import type { ResearchPlanningResult } from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import {
  MockLLMClient,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type StructuredLLMCallOptions,
  type TextLLMCallOptions,
  type TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import {
  ToolRouter,
  type ToolAdapter,
  type ToolInvokeResult,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { ControlPlaneRepository } from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import type {
  ControlExecutionResult,
  ControlPlanCandidatesResponse,
  ControlWorkflowState,
} from '../packages/api-contract/control-workflow.ts';

interface ConversationAdapter {
  create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
  requireOwned(input: { conversationId: string; ownerUserId: string }): Promise<{ id: string }>;
}

interface ControlRuntimeOverrides {
  repository: ControlPlaneRepository;
  conversations: ConversationAdapter;
  planning?: {
    plan(input: { originalInput: string }): Promise<ResearchPlanningResult>;
  };
  tools: ToolRouter;
  llm: LLMClient;
  validator: SchemaValidator;
  skillLoader: SkillLoader;
  artifacts: ControlArtifactStore;
  expectedActualModel?: string;
}

interface ControlRuntimeHarness {
  controlPlanning: {
    plan(input: {
      originalInput: string;
      conversationId?: string;
      ownerUserId: string;
    }): Promise<ControlPlanCandidatesResponse>;
  };
}

interface ControlRuntimeModule {
  buildControlRuntime(overrides: ControlRuntimeOverrides): ControlRuntimeHarness;
}

type PlannedCreateAgentApiApp = (dependencies: { controlRuntime: unknown }) => Express;
type ClosePool = () => Promise<void>;

type ExecutionResponse = ControlExecutionResult & {
  state: ControlWorkflowState;
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
};

class ScopedIntegrationDatabase implements MigrationDatabase {
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

class OfflineRealTavilyAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'offline-real-tavily-fixture-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'tavily.fixture.test';
  }

  async invoke(options: {
    toolId: string;
    input: object;
    manifest: ToolManifest;
  }): Promise<ToolInvokeResult> {
    this.calls += 1;
    return {
      output: {
        answer: null,
        response_time: 0.01,
        results: [{
          title: '宠物辅食公开市场资料',
          url: evidenceUrl,
          snippet: '公开页面展示宠物辅食产品定位、适用场景与品牌信息。',
          score: 0.99,
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

class OfflineEligibleRealLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'offline-fixture',
    endpointHost: 'llm.fixture.test',
    requestedModel: 'fixture-real-model',
    mode: 'real',
    eligibleAsReal: true,
  };
  calls = 0;

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls += 1;
    const data = options.schemaName.startsWith('skill:')
      ? {
          comparison_matrix: [{
            competitor: '公开竞品 A',
            dimension: '产品定位',
            assessment: '公开来源支持其宠物辅食场景定位',
            source: 'tool_result',
          }],
          differentiation_opportunities: ['按宠物类型与使用场景细分研究样本'],
          sources: [evidenceUrl],
        }
      : options.schemaName === 'research-plan-deliverable-content'
        ? validDeliverableDraft(
            (options.context as { verifiedEvidence?: Array<{ evidenceId?: unknown }> } | undefined)
              ?.verifiedEvidence?.[0]?.evidenceId,
          )
        : { ok: true };
    return {
      data: data as T,
      promptHash: hashPrompt(options.prompt),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-real-model-v1',
      traceId: `trace-structured-${this.calls}`,
      tokens: { prompt: 12, completion: 8, total: 20 },
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    this.calls += 1;
    return {
      text: `offline ${options.receipt.stage} result grounded in ${evidenceUrl}`,
      promptHash: hashPrompt(options.prompt),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-real-model-v1',
      traceId: `trace-text-${this.calls}`,
      tokens: { prompt: 8, completion: 4, total: 12 },
    };
  }
}

class PlanningModelFixtureLLM implements LLMClient {
  readonly identity: LLMProviderIdentity;
  private readonly fixtures: MockLLMClient;

  constructor(
    requestedModel: string,
    private readonly actualModel: string,
  ) {
    this.identity = {
      provider: 'planning-model-fixture',
      endpointHost: 'planning-model.fixture.test',
      requestedModel,
      mode: 'mock',
      eligibleAsReal: false,
    };
    this.fixtures = new MockLLMClient();
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const generated = await this.fixtures.generateStructured<T>(options);
    return {
      ...generated,
      modelName: this.actualModel,
      modelVersion: `${this.actualModel}-fixture-v1`,
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    const generated = await this.fixtures.generateText(options);
    return {
      ...generated,
      modelName: this.actualModel,
      modelVersion: `${this.actualModel}-fixture-v1`,
    };
  }
}

const originalJwtSecret = process.env.JWT_SECRET;
const originalPgOptions = process.env.PGOPTIONS;
const schema = `control_api_integration_${randomUUID().replaceAll('-', '')}`;
const artifactRoot = mkdtempSync(join(tmpdir(), 'control-api-integration-artifacts-'));
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedIntegrationDatabase(database, schema);
const repository = new ControlPlaneRepository(scopedDatabase);
const evidenceUrl = 'https://evidence.test/pet-supplement-market';
const runtimeModulePath: string = '../apps/agent-api/src/control-runtime.ts';
const runtimeModuleFile = new URL(runtimeModulePath, import.meta.url);

let ownerUserId = '';
let foreignUserId = '';
let conversationId = '';
let server: Server | undefined;
let closeSharedPool: ClosePool | undefined;

function hashPrompt(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
}

function restoreEnvironment(name: 'JWT_SECRET' | 'PGOPTIONS', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function validDeliverableDraft(evidenceId: unknown = 'missing-evidence'): Record<string, unknown> {
  return {
    methodSummary: '使用离线真实模式适配器采集公开资料，并按冻结研究维度形成计划。',
    findingGraph: {
      findings: [{
        id: 'F1',
        kind: 'fact',
        evidenceIds: [String(evidenceId)],
        statement: '公开页面提供了可核验的宠物辅食产品与品牌信息。',
      }],
      analyses: [{
        id: 'A1',
        findingIds: ['F1'],
        statement: '公开事实足以支持研究样本与产品定位维度设计。',
      }],
      subQuestionSummaries: [{
        id: 'S1',
        findingIds: ['F1'],
        analysisIds: ['A1'],
        summary: '公开资料支持以产品定位作为首个比较维度。',
      }],
      overallConclusions: [{
        id: 'C1',
        summaryIds: ['S1'],
        statement: '研究计划应优先覆盖产品定位、适用宠物与使用场景。',
      }],
    },
    payload: {
      title: '宠物辅食竞品研究计划',
      researchGoal: '形成基于公开证据的宠物辅食竞品研究计划',
      scope: {
        market: '中国大陆宠物辅食市场',
        subjects: ['犬用辅食', '猫用辅食'],
        timeWindow: '最近十二个月',
      },
      competitorSampling: {
        strategy: '按公开市场影响力与产品覆盖分层抽样',
        targetCount: 6,
        inclusionCriteria: ['存在可核验的公开产品资料'],
        exclusionCriteria: ['无公开资料或已停止销售'],
      },
      researchQuestions: ['主要竞品如何定位宠物类型与消费场景？'],
      comparisonDimensions: [{
        id: 'positioning',
        name: '产品定位',
        purpose: '比较目标宠物、消费场景与核心卖点',
        collectionFields: ['目标宠物', '消费场景', '核心卖点'],
      }],
      sourcePlan: [{
        evidenceClass: 'public_source',
        sourceTypes: ['品牌官网', '公开商品页'],
        purpose: '核验产品信息与品牌定位',
      }],
      executionPlan: [{
        phase: '公开资料采集',
        activities: ['检索并记录入样品牌公开资料'],
        duration: '2 个工作日',
        outputs: ['竞品信息采集表'],
      }],
      collectionTemplate: [{
        field: '核心卖点',
        description: '品牌对产品价值的公开表述',
        evidenceRequired: true,
      }],
      analysisMethods: ['横向维度对比'],
      deliverables: ['竞品研究计划'],
      qualityChecks: ['每项事实均关联可追溯公开来源'],
    },
    recommendations: [{
      id: 'R1',
      summaryIds: ['S1'],
      statement: '按产品定位维度继续采集公开信息。',
    }],
    risksAndOpenIssues: [],
  };
}

function planningResult(originalInput: string): ResearchPlanningResult {
  const steps = (mode: 'depth' | 'speed') => [
    {
      step_no: 1,
      step_name: `${mode} 公开来源检索`,
      actor_type: 'tool' as const,
      actor_id: 'tavily-web-search',
      input: {
        query: originalInput,
        max_results: 3,
        search_depth: mode === 'depth' ? 'advanced' : 'basic',
        include_answer: false,
      },
      requires_approval: false,
    },
    {
      step_no: 2,
      step_name: `${mode} 竞品分析`,
      actor_type: 'skill' as const,
      actor_id: 'digital-human-competitive-analysis',
      requires_approval: false,
    },
    {
      step_no: 3,
      step_name: `${mode} 研究摘要`,
      actor_type: 'llm' as const,
      actor_id: 'research-synthesis',
      requires_approval: false,
    },
    {
      step_no: 4,
      step_name: `${mode} 证据复核`,
      actor_type: 'reviewer' as const,
      actor_id: 'evidence-reviewer',
      requires_approval: false,
    },
  ];
  return {
    task: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: '形成基于公开证据的宠物辅食竞品研究计划',
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: ['D5_competitive', 'D6_evidence'],
    decisionStates: [],
    candidates: [
      {
        id: 'depth',
        title: '深度研究',
        rationale: '优先覆盖更多研究维度',
        tradeoffs: '执行时间更长',
        steps: steps('depth'),
        assumptions: [],
        activated_nodes: ['D5_competitive', 'D6_evidence'],
      },
      {
        id: 'speed',
        title: '快速研究',
        rationale: '优先形成可信的最小闭环',
        tradeoffs: '研究维度更聚焦',
        steps: steps('speed'),
        assumptions: [],
        activated_nodes: ['D5_competitive', 'D6_evidence'],
      },
    ],
    guidanceSources: [],
    provenance: {
      modelName: 'offline-planning-fixture',
      modelVersion: '1',
      promptHash: hashPrompt(originalInput),
      traceId: 'trace-offline-planning',
    },
  };
}

function conversationAdapter(): ConversationAdapter {
  return {
    async create(input) {
      const connection = await scopedDatabase.connect();
      try {
        const result = await connection.query(
          `INSERT INTO conversations (owner_user_id, title)
           VALUES ($1, $2) RETURNING id`,
          [input.ownerUserId, input.title],
        );
        return { id: String(result.rows[0]?.id) };
      } finally {
        connection.release();
      }
    },
    async requireOwned(input) {
      const connection = await scopedDatabase.connect();
      try {
        const result = await connection.query(
          `SELECT id FROM conversations WHERE id = $1 AND owner_user_id = $2`,
          [input.conversationId, input.ownerUserId],
        );
        const id = result.rows[0]?.id;
        if (typeof id !== 'string') throw new Error('conversation is not owned by requester');
        return { id };
      } finally {
        connection.release();
      }
    },
  };
}

async function loadControlRuntimeModule(): Promise<ControlRuntimeModule> {
  assert.equal(
    existsSync(runtimeModuleFile),
    true,
    'production control runtime composition module must exist',
  );
  // The planned production module is absent in this RED. Keep the path dynamic so
  // the explicit existence assertion, rather than the module loader, states the gap.
  const moduleExports = await import(runtimeModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.buildControlRuntime, 'function');
  return moduleExports as unknown as ControlRuntimeModule;
}

async function closeServer(): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
  });
}

async function postJson(
  baseUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_831_015,
  });
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  process.env.JWT_SECRET = `control-api-integration-${randomUUID()}`;

  const connection = await scopedDatabase.connect();
  try {
    const ownerEmail = `owner-${randomUUID()}@test.local`;
    const foreignEmail = `foreign-${randomUUID()}@test.local`;
    const users = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role, status)
       VALUES
         ($1, 'control api owner', 'x', 'member', 'active'),
         ($2, 'control api foreign user', 'x', 'member', 'active')
       RETURNING id, email`,
      [ownerEmail, foreignEmail],
    );
    const userIds = new Map(users.rows.map((row) => [String(row.email), String(row.id)]));
    ownerUserId = userIds.get(ownerEmail) ?? '';
    foreignUserId = userIds.get(foreignEmail) ?? '';
    assert.ok(ownerUserId);
    assert.ok(foreignUserId);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, 'offline Current integration') RETURNING id`,
      [ownerUserId],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
});

after(async () => {
  const errors: unknown[] = [];
  try {
    await closeServer();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeSharedPool?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch (error) {
    errors.push(error);
  }
  try {
    await database.end();
  } catch (error) {
    errors.push(error);
  }
  rmSync(artifactRoot, { recursive: true, force: true });
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
  restoreEnvironment('PGOPTIONS', originalPgOptions);
  if (errors.length) throw new AggregateError(errors, 'control API integration cleanup failed');
});

test('production control runtime completes the offline Current API flow and serves the owner deliverable', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const tavily = new OfflineRealTavilyAdapter();
  const llm = new OfflineEligibleRealLLM();
  const tools = new ToolRouter().register(tavily);
  const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const controlRuntime = await buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    planning: {
      async plan(input) {
        return planningResult(input.originalInput);
      },
    },
    tools,
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts,
  });

  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  ({ closePool: closeSharedPool } = await import('../database/db.ts'));
  const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
  server = createServer(createApp({ controlRuntime }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });

  const planResponse = await postJson(baseUrl, '/api/control-tasks/plan', ownerToken, {
    originalInput: '请生成基于公开证据的宠物辅食竞品研究计划',
    conversationId,
  });
  assert.equal(planResponse.status, 200);
  const planned = await planResponse.json() as ControlPlanCandidatesResponse;
  assert.equal(planned.kind, 'current');
  assert.deepEqual(planned.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
  for (const candidate of planned.candidates) {
    assert.deepEqual(
      candidate.plan.steps.map((step) => step.actor_type),
      ['tool', 'skill', 'llm', 'reviewer'],
    );
  }
  const speed = planned.candidates.find((candidate) => candidate.candidateId === 'speed');
  assert.ok(speed);

  const selectResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/select`,
    ownerToken,
    { expectedVersion: planned.task.stateVersion, planVersionId: speed.planVersionId },
    `select-${randomUUID()}`,
  );
  assert.equal(selectResponse.status, 200);
  const selected = await selectResponse.json() as { state: string; stateVersion: number };
  assert.equal(selected.state, 'awaiting_confirmation');

  const confirmResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/confirm`,
    ownerToken,
    {
      expectedVersion: selected.stateVersion,
      planVersionId: speed.planVersionId,
      confirmationAnswers: {},
      inputRoles: [],
    },
    `confirm-${randomUUID()}`,
  );
  assert.equal(confirmResponse.status, 200);
  const confirmed = await confirmResponse.json() as { state: string; stateVersion: number };
  assert.equal(confirmed.state, 'ready');

  const executeResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/execute`,
    ownerToken,
    { expectedVersion: confirmed.stateVersion, planVersionId: speed.planVersionId },
    `execute-${randomUUID()}`,
  );
  if (executeResponse.status !== 200) {
    const failedTask = await repository.getTaskDetail(planned.task.id);
    const failedSteps = failedTask?.currentAttemptId
      ? await repository.listExecutionSteps(failedTask.currentAttemptId)
      : [];
    assert.fail(JSON.stringify({
      response: await executeResponse.clone().json(),
      state: failedTask?.state,
      failures: failedSteps.map((step) => step.failure),
    }));
  }
  assert.equal(executeResponse.status, 200, await executeResponse.clone().text());
  const execution = await executeResponse.json() as ExecutionResponse;
  assert.equal(execution.executionDisabled, false);
  assert.equal(execution.state, 'completed', JSON.stringify(execution));
  assert.equal(execution.status, 'completed', JSON.stringify(execution));
  assert.match(execution.deliverableArtifactId, /^[0-9a-f-]{36}$/);
  assert.match(execution.evidenceManifestArtifactId, /^[0-9a-f-]{36}$/);

  const ownerDeliverableResponse = await fetch(
    `${baseUrl}/api/control-tasks/${planned.task.id}/deliverable`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  assert.equal(ownerDeliverableResponse.status, 200);
  const ownerDeliverableBody: unknown = await ownerDeliverableResponse.json();
  assertRecord(ownerDeliverableBody);
  const envelope = ownerDeliverableBody.deliverable ?? ownerDeliverableBody;
  assertRecord(envelope);
  assert.equal(envelope.taskId, planned.task.id);
  assert.equal(envelope.deliverableType, 'research_plan');
  assert.equal(envelope.evidenceManifestArtifactId, execution.evidenceManifestArtifactId);
  assert.match(JSON.stringify(ownerDeliverableBody), new RegExp(evidenceUrl.replaceAll('.', '\\.'), 'u'));

  const foreignDeliverableResponse = await fetch(
    `${baseUrl}/api/control-tasks/${planned.task.id}/deliverable`,
    { headers: { authorization: `Bearer ${foreignToken}` } },
  );
  assert.equal(foreignDeliverableResponse.status, 404);
  const missingDeliverableResponse = await fetch(
    `${baseUrl}/api/control-tasks/${randomUUID()}/deliverable`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  assert.equal(missingDeliverableResponse.status, 404);

  const steps = await repository.listExecutionSteps(execution.attemptId);
  assert.deepEqual(
    steps.map(({ actorType, state }) => ({ actorType, state })),
    [
      { actorType: 'tool', state: 'succeeded' },
      { actorType: 'skill', state: 'succeeded' },
      { actorType: 'llm', state: 'succeeded' },
      { actorType: 'reviewer', state: 'succeeded' },
    ],
  );
  assert.equal(steps[0]?.toolProvenance?.executionMode, 'real');
  assert.equal(steps[0]?.toolProvenance?.implementationId, tavily.implementationId);
  assert.equal(tavily.calls, 1);

  const modelReceipts = await repository.listModelCalls(execution.attemptId);
  assert.deepEqual(modelReceipts.map(({ stage, status }) => ({ stage, status })), [
    { stage: 'skill', status: 'succeeded' },
    { stage: 'llm', status: 'succeeded' },
    { stage: 'reviewer', status: 'succeeded' },
    { stage: 'deliverable', status: 'succeeded' },
  ]);
  for (const receipt of modelReceipts) {
    assert.equal(receipt.provider, llm.identity.provider);
    assert.equal(receipt.endpointHost, llm.identity.endpointHost);
    assert.equal(receipt.requestedModel, llm.identity.requestedModel);
    assert.equal(receipt.actualModel, llm.identity.requestedModel);
    assert.match(receipt.promptHash, /^sha256:/);
    assert.ok(receipt.traceId);
    assert.ok(receipt.tokens);
  }

  const connection = await scopedDatabase.connect();
  try {
    const terminalArtifacts = await connection.query(
      `SELECT id, kind, state
       FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('deliverable', 'evidence_manifest', 'execution_summary')
       ORDER BY kind`,
      [execution.attemptId],
    );
    assert.deepEqual(
      terminalArtifacts.rows.map((row) => ({ kind: row.kind, state: row.state })),
      [
        { kind: 'deliverable', state: 'SEALED' },
        { kind: 'evidence_manifest', state: 'SEALED' },
      ],
    );
    assert.equal(
      terminalArtifacts.rows.find((row) => row.kind === 'deliverable')?.id,
      execution.deliverableArtifactId,
    );
    assert.equal(
      terminalArtifacts.rows.find((row) => row.kind === 'evidence_manifest')?.id,
      execution.evidenceManifestArtifactId,
    );

    const referencedArtifacts = await connection.query(
      `SELECT id, kind, storage_uri, content_sha256
       FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('tool_output', 'evidence_manifest')`,
      [execution.attemptId],
    );
    const toolArtifact = referencedArtifacts.rows.find((row) => row.kind === 'tool_output');
    const manifestArtifact = referencedArtifacts.rows.find((row) => row.kind === 'evidence_manifest');
    assert.ok(toolArtifact);
    assert.ok(manifestArtifact);
    const toolStorageUri = String(toolArtifact.storage_uri);
    const manifestStorageUri = String(manifestArtifact.storage_uri);
    const originalToolContent = readFileSync(toolStorageUri, 'utf8');
    const originalManifestContent = readFileSync(manifestStorageUri, 'utf8');
    const originalManifestHash = String(manifestArtifact.content_sha256);
    const ownerDeliverableUrl = `${baseUrl}/api/control-tasks/${planned.task.id}/deliverable`;
    const revalidationFailures: string[] = [];
    const expectOwnerReadRejected = async (mutation: string): Promise<void> => {
      const response = await fetch(ownerDeliverableUrl, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      if (response.status === 200) revalidationFailures.push(mutation);
    };

    try {
      writeFileSync(toolStorageUri, JSON.stringify({ tampered: true }));
      await expectOwnerReadRejected('referenced Tool Artifact content');
    } finally {
      writeFileSync(toolStorageUri, originalToolContent);
    }

    const mutateManifestEntry = async (
      mutation: string,
      mutate: (entry: Record<string, unknown>) => void,
    ): Promise<void> => {
      const manifestValue: unknown = JSON.parse(originalManifestContent);
      assertRecord(manifestValue);
      assert.ok(Array.isArray(manifestValue.entries));
      const entry = manifestValue.entries[0];
      assertRecord(entry);
      mutate(entry);
      const mutatedContent = JSON.stringify(manifestValue, null, 2);
      const mutatedHash = `sha256:${createHash('sha256').update(mutatedContent).digest('hex')}`;
      try {
        writeFileSync(manifestStorageUri, mutatedContent);
        await connection.query(
          `UPDATE control_artifacts SET content_sha256 = $2 WHERE id = $1`,
          [manifestArtifact.id, mutatedHash],
        );
        await expectOwnerReadRejected(mutation);
      } finally {
        writeFileSync(manifestStorageUri, originalManifestContent);
        await connection.query(
          `UPDATE control_artifacts SET content_sha256 = $2 WHERE id = $1`,
          [manifestArtifact.id, originalManifestHash],
        );
      }
    };

    await mutateManifestEntry('Evidence JSON pointer', (entry) => {
      entry.jsonPointer = '/output/results/999';
    });
    await mutateManifestEntry('Evidence Artifact hash', (entry) => {
      entry.artifactContentSha256 = `sha256:${'0'.repeat(64)}`;
    });
    assert.deepEqual(revalidationFailures, []);
  } finally {
    connection.release();
  }
});


test('production ControlRuntime rejects planning model drift before task persistence and records a failed receipt', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const originalInput = `planning-model-drift-${randomUUID()}`;
  const expectedModel = 'expected-planning-model';
  const requestedModel = 'gateway-routing-alias';
  const actualModel = 'unexpected-planning-model';
  const receiptConnection = await scopedDatabase.connect();
  const existingReceipts = await receiptConnection.query(
    'SELECT id FROM control_model_calls WHERE attempt_id IS NULL',
  );
  receiptConnection.release();
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new PlanningModelFixtureLLM(requestedModel, actualModel),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
  });

  await assert.rejects(
    () => runtime.controlPlanning.plan({ originalInput, conversationId, ownerUserId }),
    /model drift/i,
  );

  const connection = await scopedDatabase.connect();
  try {
    const persisted = await connection.query(
      `SELECT
         (SELECT count(*)::int FROM control_tasks WHERE original_input = $1) AS tasks,
         (SELECT count(*)::int
          FROM control_plan_versions AS plan
          JOIN control_tasks AS task ON task.id = plan.task_id
          WHERE task.original_input = $1) AS candidates`,
      [originalInput],
    );
    const receipts = await connection.query(
      `SELECT stage, requested_model, actual_model, status, failure_json
       FROM control_model_calls
       WHERE attempt_id IS NULL AND NOT (id = ANY($1::uuid[]))
       ORDER BY stage`,
      [existingReceipts.rows.map((row) => row.id)],
    );

    assert.deepEqual(persisted.rows[0], { tasks: 0, candidates: 0 });
    assert.deepEqual(receipts.rows, [{
      stage: 'task_understanding',
      requested_model: requestedModel,
      actual_model: actualModel,
      status: 'failed',
      failure_json: {
        kind: 'model_drift',
        expectedModel,
        actualModel,
      },
    }]);
  } finally {
    connection.release();
  }
});

test('production ControlRuntime persists planning candidates only when every planning receipt matches the model pin', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const originalInput = `planning-model-match-${randomUUID()}`;
  const expectedModel = 'expected-planning-model';
  const requestedModel = 'gateway-routing-alias';
  const receiptConnection = await scopedDatabase.connect();
  const existingReceipts = await receiptConnection.query(
    'SELECT id FROM control_model_calls WHERE attempt_id IS NULL',
  );
  receiptConnection.release();
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new PlanningModelFixtureLLM(requestedModel, expectedModel),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
  });

  const planned = await runtime.controlPlanning.plan({
    originalInput,
    conversationId,
    ownerUserId,
  });

  const connection = await scopedDatabase.connect();
  try {
    const persisted = await connection.query(
      `SELECT
         (SELECT count(*)::int FROM control_tasks WHERE original_input = $1) AS tasks,
         (SELECT count(*)::int
          FROM control_plan_versions AS plan
          JOIN control_tasks AS task ON task.id = plan.task_id
          WHERE task.original_input = $1) AS candidates`,
      [originalInput],
    );
    const receipts = await connection.query(
      `SELECT stage, requested_model, actual_model, status, failure_json
       FROM control_model_calls
       WHERE attempt_id IS NULL AND NOT (id = ANY($1::uuid[]))
       ORDER BY stage`,
      [existingReceipts.rows.map((row) => row.id)],
    );

    assert.equal(planned.task.state, 'awaiting_selection');
    assert.deepEqual(planned.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
    assert.deepEqual(persisted.rows[0], { tasks: 1, candidates: 2 });
    assert.deepEqual(
      receipts.rows.map((row) => ({
        stage: row.stage,
        requestedModel: row.requested_model,
        actualModel: row.actual_model,
        status: row.status,
        failure: row.failure_json,
      })),
      [
        {
          stage: 'planning',
          requestedModel,
          actualModel: expectedModel,
          status: 'succeeded',
          failure: null,
        },
        {
          stage: 'planning_decision',
          requestedModel,
          actualModel: expectedModel,
          status: 'succeeded',
          failure: null,
        },
        {
          stage: 'task_understanding',
          requestedModel,
          actualModel: expectedModel,
          status: 'succeeded',
          failure: null,
        },
      ],
    );
  } finally {
    connection.release();
  }
});