import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  ExecutionAuthenticityError,
  LeaseExecutionEngine,
  type LeaseExecutionResult,
} from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import type {
  ChartSpec,
  CurrentPlanStep,
  ResearchDeliverableEnvelope,
} from '../packages/api-contract/research-deliverable.ts';
import type {
  CurrentDeliverableGenerateInput,
  CurrentDeliverableGenerateResult,
} from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import type {
  DeliverableComposer,
  ReportReviewInput,
  ReportReviewResult,
} from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import type {
  ReportReviewArtifact,
  ReportReviewDimension,
} from '../packages/api-contract/control-workflow.ts';
import { CurrentReportValidationError } from '../apps/orchestrator-runtime/src/evidence/report-evidence-validator.ts';
import type {
  EvidenceArtifactResolver,
  EvidenceManifest,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type {
  ReportDocument,
  VerifiedChart,
} from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import {
  VisualAssetService,
  type VerifiedVisualAsset,
} from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import {
  chartTableAlternative,
  renderAndSealChartSvg,
  type ChartTableAlternative,
} from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';
import { chartSpecHash } from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';
import { CurrentReportPackageReader } from '../apps/orchestrator-runtime/src/report/current-report-package-reader.ts';
import { ReportCompositionService } from '../apps/orchestrator-runtime/src/report/report-composition-service.ts';
import {
  LLMInvocationError,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type StructuredLLMCallOptions,
  type TextLLMCallOptions,
  type TextLLMResult,
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
  type ControlArtifact,
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

function assertUnknownRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
}

function canonicalJsonHash(value: unknown): string {
  const canonicalize = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(canonicalize);
    if (child === null || typeof child !== 'object') return child;
    return Object.fromEntries(
      Object.entries(child)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}
type DeliverableAwareExecutionResult = LeaseExecutionResult & {
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
};

interface TestDeliverables {
  generate(input: CurrentDeliverableGenerateInput): Promise<CurrentDeliverableGenerateResult>;
}

interface TestReportReview {
  review(input: ReportReviewInput, composer?: DeliverableComposer): Promise<ReportReviewResult>;
}

interface TestReportCompositionInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requiredQuestionIds: string[];
  deliverable: {
    artifact: ControlArtifact;
    value: ResearchDeliverableEnvelope<Record<string, unknown>>;
  };
  evidenceManifest: { artifact: ControlArtifact; value: EvidenceManifest };
  evidenceArtifactResolver: EvidenceArtifactResolver;
  review: { artifact: ControlArtifact; value: ReportReviewArtifact & { verdict: 'pass' } };
  visualAssets: VerifiedVisualAsset[];
  charts: VerifiedChart[];
  activeLease: ControlExecutionLease;
}

interface TestReportCompositionResult {
  artifact: ControlArtifact;
  document: ReportDocument;
}

interface TestReportComposition {
  composeAndStore(input: TestReportCompositionInput): Promise<TestReportCompositionResult>;
}

interface DiscoverableReportComposition {
  discoverAttemptMaterials(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
  }): Promise<{ visualAssets: VerifiedVisualAsset[]; charts: VerifiedChart[] }>;
}

function passingReviewDimensions(): ReportReviewDimension[] {
  return [
    'requirement_coverage',
    'question_coverage',
    'evidence_coverage',
    'reasoning_quality',
    'recommendation_quality',
    'visual_quality',
    'risk_disclosure',
  ].map((id) => ({ id: id as ReportReviewDimension['id'], passed: true, issues: [] }));
}

class RecordingReportReviewFake implements TestReportReview {
  readonly calls: ReportReviewInput[] = [];

  constructor(
    private readonly implementation: (
      input: ReportReviewInput,
      composer?: DeliverableComposer,
    ) => Promise<ReportReviewResult>,
  ) {}

  async review(input: ReportReviewInput, composer?: DeliverableComposer): Promise<ReportReviewResult> {
    this.calls.push(input);
    return this.implementation(input, composer);
  }
}

function minimalDeliverable(
  input: CurrentDeliverableGenerateInput,
): ResearchDeliverableEnvelope<Record<string, unknown>> {
  return {
    version: 'research-deliverable-v1',
    taskId: input.task.id,
    planVersionId: input.plan.id,
    attemptId: input.attempt.id,
    deliverableType: input.plan.plan.deliverable_type,
    evidenceManifestArtifactId: input.evidenceManifest.artifact.id,
    methodSummary: 'Compare sealed public evidence against the approved research dimensions.',
    findingGraph: {
      findings: [{ id: 'F1', kind: 'fact', evidenceIds: [], statement: 'Fixture fact' }],
      analyses: [{ id: 'A1', findingIds: ['F1'], statement: 'Fixture analysis' }],
      subQuestionSummaries: [{
        id: 'S1',
        findingIds: ['F1'],
        analysisIds: ['A1'],
        summary: 'Fixture summary',
      }],
      overallConclusions: [{ id: 'C1', summaryIds: ['S1'], statement: 'Fixture conclusion' }],
    },
    payload: {
      competitorSamples: [{
        id: 'sample-a',
        name: 'Product A',
        rationale: 'Primary market comparator',
        evidenceIds: ['E1'],
      }],
      dimensionMatrix: [{
        dimension: 'onboarding',
        values: [{ sampleId: 'sample-a', value: 'Guided setup', evidenceIds: ['E1'] }],
      }],
      differences: [{
        id: 'difference-1',
        dimension: 'onboarding',
        statement: 'Product A provides guided setup',
        evidenceIds: ['E1'],
      }],
      impacts: [{
        differenceId: 'difference-1',
        audience: 'First-time users',
        statement: 'Guidance reduces setup uncertainty',
      }],
      actionRecommendations: [{
        id: 'action-1',
        differenceIds: ['difference-1'],
        priority: 'P1',
        statement: 'Prototype a guided setup path',
      }],
      screenshotComparisons: [{
        id: 'screenshot-1',
        dimension: 'onboarding',
        sampleIds: ['sample-a'],
        assetIds: ['asset-screenshot-a'],
        caption: 'Guided setup entry point',
      }],
    },
    recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: 'Fixture recommendation' }],
    coverage: {
      questionBindings: [{ questionId: 'fixture-question', summaryIds: ['S1'] }],
      successCriterionBindings: [{
        successCriterionId: 'fixture-criterion',
        conclusionIds: ['C1'],
        recommendationIds: ['R1'],
      }],
    },
    risksAndOpenIssues: [],
    capabilityProvenance: [{ id: input.expectedModel, type: 'llm' }],
  };
}

class RecordingDeliverablesFake implements TestDeliverables {
  readonly calls: CurrentDeliverableGenerateInput[] = [];

  constructor(
    private readonly implementation: (
      input: CurrentDeliverableGenerateInput,
    ) => Promise<CurrentDeliverableGenerateResult> = async (input) => ({
      deliverable: minimalDeliverable(input),
      deliverableArtifactId: 'deliverable-1',
    }),
  ) {}

  async generate(input: CurrentDeliverableGenerateInput): Promise<CurrentDeliverableGenerateResult> {
    this.calls.push(input);
    return this.implementation(input);
  }
}

type DeliverableAwareLeaseExecutionEngineDependencies = Omit<
  ConstructorParameters<typeof LeaseExecutionEngine>[0],
  'deliverables' | 'reportReview'
> & { deliverables: TestDeliverables; reportReview?: TestReportReview };

const DeliverableAwareLeaseExecutionEngine = LeaseExecutionEngine as unknown as new (
  dependencies: DeliverableAwareLeaseExecutionEngineDependencies,
) => LeaseExecutionEngine;

type ReportCompositionAwareDependencies = DeliverableAwareLeaseExecutionEngineDependencies & {
  reportComposition: TestReportComposition;
};

const ReportCompositionAwareLeaseExecutionEngine = LeaseExecutionEngine as unknown as new (
  dependencies: ReportCompositionAwareDependencies,
) => LeaseExecutionEngine;

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
  readonly inputs: object[] = [];

  endpointHost(): string {
    return 'api.tavily.test';
  }

  async invoke(options: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    this.inputs.push(structuredClone(options.input));
    return {
      output: {
        answer: null,
        response_time: 0.1,
        results: [{
          title: 'Source',
          url: 'https://source.test/article',
          snippet: 'verified public source owner@example.com 13800138000 api_key=secret-value Authorization: Bearer secret-token',
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
class SuccessfulInternalAdapter implements ToolAdapter {
  readonly adapterType = 'internal_api' as const;
  readonly implementationId = 'test-internal-real-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'internal.test';
  }

  async invoke(options: { manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    return {
      output: { results: [] },
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
  readonly contexts: object[] = [];

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    if (options.context) this.contexts.push(options.context);
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
    if (options.context) this.contexts.push(options.context);
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

const echoedSecrets = {
  skill: 'skill-owner@example.test 13800138001 Authorization: Bearer skill-token api_key=skill-key',
  llm: 'llm-owner@example.test 13800138002 Authorization: Bearer llm-token api_key=llm-key',
  reviewer: 'reviewer-owner@example.test 13800138003 Authorization: Bearer reviewer-token api_key=reviewer-key',
} as const;

class EchoingSensitiveRealLLM extends CountingRealLLM {
  override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const result = await super.generateStructured<T>(options);
    if (!options.schemaName.startsWith('skill:')) return result;
    return {
      ...result,
      data: {
        comparison_matrix: [{
          competitor: 'A',
          dimension: '体验',
          assessment: echoedSecrets.skill,
          source: 'tool_result',
        }],
        differentiation_opportunities: [echoedSecrets.skill],
        sources: ['https://source.test/article'],
      } as T,
    };
  }

  override async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    const result = await super.generateText(options);
    const stage = options.receipt.stage === 'reviewer' ? 'reviewer' : 'llm';
    return { ...result, text: echoedSecrets[stage] };
  }
}

class BlockedSensitiveStageLLM extends CountingRealLLM {
  constructor(private readonly blockedStage: 'skill' | 'llm' | 'reviewer') {
    super();
  }

  override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const result = await super.generateStructured<T>(options);
    if (this.blockedStage !== 'skill' || !options.schemaName.startsWith('skill:')) return result;
    return {
      ...result,
      data: {
        comparison_matrix: [{
          competitor: 'A',
          dimension: '体验',
          assessment: 'confidential internal-only roadmap',
          source: 'tool_result',
        }],
        differentiation_opportunities: ['verified'],
        sources: ['https://source.test/article'],
      } as T,
    };
  }

  override async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    const result = await super.generateText(options);
    return options.receipt.stage === this.blockedStage
      ? { ...result, text: 'confidential internal-only roadmap' }
      : result;
  }
}

class InvalidSkillOutputLLM extends CountingRealLLM {
  override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const result = await super.generateStructured<T>(options);
    return { ...result, data: { comparison_matrix: [] } as T };
  }
}

class ConfigBreakingSkillLLM extends CountingRealLLM {
  constructor(private readonly breakConfig: () => void) {
    super();
  }

  override async generateStructured<T>(_options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.breakConfig();
    throw new LLMInvocationError('server', true, 503, 'skill provider unavailable');
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

const planSteps: CurrentPlanStep[] = [
  {
    step_no: 1,
    step_name: '公开资料检索',
    actor_type: 'tool' as const,
    actor_id: 'tavily-web-search',
    question_ids: ['question-1'],
    depends_on: [],
    input: { query: 'digital human competitors' },
    input_bindings: [],
    expected_outputs: [{ pointer: '/results', description: 'public results' }],
    acceptance_criteria: ['returns public evidence'],
    requires_approval: false,
    fallback_actor_ids: [],
  },
  {
    step_no: 2,
    step_name: '竞品分析',
    actor_type: 'skill' as const,
    actor_id: 'digital-human-competitive-analysis',
    question_ids: ['question-1'],
    depends_on: [1],
    input: { business_domain: '' },
    input_bindings: [{
      target_pointer: '/business_domain',
      source_step_no: 1,
      source_pointer: '/results/0/title',
    }],
    expected_outputs: [{ pointer: '/comparison_matrix', description: 'comparison' }],
    acceptance_criteria: ['uses public evidence'],
    requires_approval: false,
    fallback_actor_ids: [],
  },
  {
    step_no: 3,
    step_name: '摘要',
    actor_type: 'llm' as const,
    actor_id: 'summary',
    question_ids: ['question-1'],
    depends_on: [2],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/text', description: 'summary' }],
    acceptance_criteria: ['summarizes analysis'],
    requires_approval: false,
    fallback_actor_ids: [],
  },
  {
    step_no: 4,
    step_name: '复核',
    actor_type: 'reviewer' as const,
    actor_id: 'review',
    question_ids: ['question-1'],
    depends_on: [3],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/review', description: 'review' }],
    acceptance_criteria: ['reviews evidence'],
    requires_approval: false,
    fallback_actor_ids: [],
  },
];

async function claimedExecution(
  expiresAt = new Date(Date.now() + 60_000),
  steps = planSteps,
  planExtras: Record<string, unknown> = {},
  structuredTask: Record<string, unknown> = { research_goal: 'compare digital human products' },
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
    structuredTask,
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: {
      task_id: task.id,
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'competitive-analysis-report',
        acceptedClasses: ['public_source', 'screenshot'],
        minimumCount: 1,
        required: true,
      }],
      ...planExtras,
      steps,
    } as Record<string, unknown>,
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
  deliverables: TestDeliverables = new RecordingDeliverablesFake(),
  reportReview?: TestReportReview,
): LeaseExecutionEngine {
  return new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools,
    llm,
    deliverables,
    ...(reportReview ? { reportReview } : {}),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
  });
}

async function assertNoExecutionArtifacts(attemptId: string): Promise<void> {
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT count(*) AS count FROM control_artifacts WHERE attempt_id = $1`,
      [attemptId],
    );
    assert.equal(Number(artifacts.rows[0]?.count), 0);
  } finally {
    connection.release();
  }
}

async function expireLease(
  repository: ControlPlaneRepository,
  lease: ControlExecutionLease,
): Promise<void> {
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

test('rejects a plan without deliverable type before execution side effects', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    { deliverable_type: undefined },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  await assertNoExecutionArtifacts(lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('rejects a current competitive report without evidence requirements before execution side effects', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    { evidence_requirements: undefined },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  await assertNoExecutionArtifacts(lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('rejects empty evidence requirements before execution side effects', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    { evidence_requirements: [] },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  await assertNoExecutionArtifacts(lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('rejects evidence requirements with no required source before execution side effects', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      evidence_requirements: [{
        id: 'optional-public-source',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: false,
      }],
    },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  await assertNoExecutionArtifacts(lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('resolves a sealed Tool output before validating and invoking the next Tool', async () => {
  const boundToolSteps = [
    planSteps[0],
    {
      ...planSteps[0],
      step_no: 2,
      step_name: '使用已封存标题继续检索',
      depends_on: [1],
      input: { query: '' },
      input_bindings: [{
        target_pointer: '/query',
        source_step_no: 1,
        source_pointer: '/results/0/title',
      }],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), boundToolSteps);
  const adapter = new CountingRealTavilyAdapter();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(adapter.calls, 2);
  assert.deepEqual(adapter.inputs, [
    { query: 'digital human competitors' },
    { query: 'Source' },
  ]);
});

test('rejects a future binding before any actor side effect', async () => {
  const invalidSteps = [
    planSteps[0],
    {
      ...planSteps[1],
      input_bindings: [{
        target_pointer: '/business_domain',
        source_step_no: 2,
        source_pointer: '/comparison_matrix',
      }],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), invalidSteps);
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  await assert.rejects(
    () => buildEngine(repository, new ToolRouter().register(adapter), llm)
      .execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('rejects a dangling sealed source pointer before the target Skill side effect', async () => {
  const invalidSteps = [
    planSteps[0],
    {
      ...planSteps[1],
      input_bindings: [{
        target_pointer: '/business_domain',
        source_step_no: 1,
        source_pointer: '/missing',
      }],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), invalidSteps);
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  await assert.rejects(
    () => buildEngine(repository, new ToolRouter().register(adapter), llm)
      .execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 0);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('executes the current plan with real Tool provenance and complete model receipts', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    planSteps,
    {
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'competitive-analysis-report',
        acceptedClasses: ['public_source', 'screenshot'],
        minimumCount: 1,
        required: true,
      }],
    },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const deliverables = new RecordingDeliverablesFake();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm, deliverables);

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' }) as DeliverableAwareExecutionResult;
  assert.equal(deliverables.calls.length, 1);
  const deliverableInput = deliverables.calls[0];
  if (!deliverableInput) assert.fail('current deliverable generation input must be recorded');
  assert.deepEqual(deliverableInput.task, { id: lease.taskId });
  assert.equal(deliverableInput.plan.id, lease.planVersionId);
  assert.equal(deliverableInput.plan.plan.deliverable_type, 'competitive_analysis_report');
  assert.deepEqual(deliverableInput.plan.plan.steps, planSteps);
  assert.deepEqual(deliverableInput.attempt, { id: lease.attemptId });
  assert.equal(deliverableInput.researchGoal, 'compare digital human products');
  assert.deepEqual(deliverableInput.gaps, []);
  assert.equal(deliverableInput.expectedModel, 'pinned-model');
  assert.equal(deliverableInput.evidenceManifest.artifact.state, 'SEALED');
  assert.match(deliverableInput.evidenceManifest.artifact.contentSha256, /^sha256:/);
  assert.equal(deliverableInput.outputs.length, planSteps.length);
  for (const output of deliverableInput.outputs) {
    assertUnknownRecord(output);
    const artifact = output.artifact;
    assertUnknownRecord(artifact);
    assert.equal(artifact.state, 'SEALED');
    assert.equal(typeof artifact.id, 'string');
    assert.match(String(artifact.contentSha256), /^sha256:/);
  }
  const evidenceEntry = deliverableInput.evidenceManifest.value.entries[0];
  assert.ok(evidenceEntry);
  const resolvedEvidence = deliverableInput.evidenceResolver.resolveArtifact(evidenceEntry.artifactId);
  assert.ok(resolvedEvidence);
  assert.equal(resolvedEvidence.artifact.id, evidenceEntry.artifactId);
  assert.equal(resolvedEvidence.artifact.contentSha256, evidenceEntry.artifactContentSha256);
  assert.equal(result.deliverableArtifactId, 'deliverable-1');
  assert.equal(
    result.evidenceManifestArtifactId,
    deliverableInput.evidenceManifest.artifact.id,
  );
  const steps = await repository.listExecutionSteps(lease.attemptId);
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT id, storage_uri, content_sha256 FROM control_artifacts WHERE attempt_id = $1 AND kind = 'tool_output'`,
      [lease.attemptId],
    );
    const toolArtifactId = artifacts.rows[0]?.id;
    const storageUri = artifacts.rows[0]?.storage_uri;
    const toolArtifactContentSha256 = artifacts.rows[0]?.content_sha256;
    if (typeof toolArtifactId !== 'string') assert.fail('tool artifact id must be a string');
    if (typeof storageUri !== 'string') assert.fail('tool artifact storage_uri must be a string');
    if (typeof toolArtifactContentSha256 !== 'string') assert.fail('tool artifact content_sha256 must be a string');
    const persisted: unknown = JSON.parse(readFileSync(storageUri, 'utf8'));
    assert.ok(persisted && typeof persisted === 'object');
    assert.ok('output' in persisted);
    const persistedOutput = persisted.output;
    assert.ok(persistedOutput && typeof persistedOutput === 'object' && 'results' in persistedOutput);
    const persistedResults = persistedOutput.results;
    assert.ok(Array.isArray(persistedResults));
    const resolvedResult = persistedResults[0];
    assertUnknownRecord(resolvedResult);
    const serialized = JSON.stringify(persisted);
    assert.match(serialized, /verified public source/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /secret-value/);
    assert.doesNotMatch(serialized, /secret-token/);
    assert.doesNotMatch(serialized, /\bBearer\b/i);
    assert.doesNotMatch(serialized, /owner@example\.com|13800138000/);
    assert.match(serialized, /\[REDACTED_EMAIL\]|\[REDACTED_PHONE\]/);
    const evidenceArtifacts = await connection.query(
      `SELECT id, state, storage_uri, content_sha256
       FROM control_artifacts WHERE attempt_id = $1 AND kind = 'evidence_manifest'`,
      [lease.attemptId],
    );
    const evidenceArtifactId = evidenceArtifacts.rows[0]?.id;
    const evidenceArtifactState = evidenceArtifacts.rows[0]?.state;
    const evidenceArtifactContentSha256 = evidenceArtifacts.rows[0]?.content_sha256;
    const evidenceUri = evidenceArtifacts.rows[0]?.storage_uri;
    assert.equal(evidenceArtifactId, deliverableInput.evidenceManifest.artifact.id);
    assert.equal(evidenceArtifactState, 'SEALED');
    assert.equal(
      evidenceArtifactContentSha256,
      deliverableInput.evidenceManifest.artifact.contentSha256,
    );
    if (typeof evidenceUri !== 'string') assert.fail('execution must seal an Evidence Manifest artifact');
    const evidence: unknown = JSON.parse(readFileSync(evidenceUri, 'utf8'));
    assert.ok(evidence && typeof evidence === 'object' && 'entries' in evidence);
    assert.ok(Array.isArray(evidence.entries));
    const evidenceEntry = evidence.entries[0];
    assertUnknownRecord(evidenceEntry);
    const toolProvenance = steps[0]?.toolProvenance ?? {};
    const toolProof = evidenceEntry.toolProof;
    assertUnknownRecord(toolProof);
    assert.equal(toolProvenance.outputArtifactId, toolArtifactId);
    assert.equal(evidenceEntry.artifactId, toolProvenance.outputArtifactId);
    assert.equal(evidenceEntry.artifactContentSha256, toolArtifactContentSha256);
    assert.equal(evidenceEntry.jsonPointer, '/output/results/0');
    assert.equal(evidenceEntry.sourceUrl, resolvedResult.url);
    assert.equal(toolProof.redactedOutputHash, toolProvenance.redactedOutputHash);
    assert.match(String(toolProof.redactedOutputHash), /^sha256:/);
    assert.ok(!('artifactHash' in evidenceEntry));
    assert.ok(!('outputHash' in toolProof));
    assert.equal(evidence.entries[0]?.toolProof?.executionMode, 'real');
    assert.equal(evidence.entries[0]?.sourceUrl, 'https://source.test/article');
    const artifactSchemas = await connection.query(
      `SELECT kind, schema_version FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('tool_output', 'skill_output', 'evidence_manifest')`,
      [lease.attemptId],
    );
    const schemaVersions = Object.fromEntries(
      artifactSchemas.rows.map((row) => [String(row.kind), String(row.schema_version)]),
    );
    assert.equal(schemaVersions.tool_output, 'tool-output-v1');
    assert.equal(schemaVersions.skill_output, 'skill-output-v1');
    assert.equal(schemaVersions.evidence_manifest, 'evidence-v1');
    const legacySummaries = await connection.query(
      `SELECT count(*) AS count FROM control_artifacts
       WHERE attempt_id = $1 AND kind = 'execution_summary'`,
      [lease.attemptId],
    );
    assert.equal(Number(legacySummaries.rows[0]?.count), 0);
  } finally {
    connection.release();
  }

  const serializedContext = JSON.stringify(llm.contexts);
  assert.match(serializedContext, /verified public source/);
  const skillContext = llm.contexts[0];
  assertUnknownRecord(skillContext);
  assert.deepEqual(skillContext.input, { business_domain: 'Source' });
  assert.match(serializedContext, /\[REDACTED\]/);
  assert.doesNotMatch(serializedContext, /secret-token/);
  assert.doesNotMatch(serializedContext, /\bBearer\b/i);

  assert.equal(result.status, 'completed');
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 3);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].toolProvenance?.executionMode, 'real');
  assert.equal(steps[0].toolProvenance?.implementationId, 'test-tavily-real-v1');
  const calls = await repository.listModelCalls(lease.attemptId);
  assert.deepEqual(calls.map((call) => call.stage), ['skill', 'llm', 'reviewer']);
  const skillProvenance = steps[1]?.skillProvenance;
  assert.ok(skillProvenance);
  assert.match(String(skillProvenance.skillBodyHash), /^sha256:/u);
  assert.match(String(skillProvenance.inputSchemaHash), /^sha256:/u);
  assert.match(String(skillProvenance.outputSchemaHash), /^sha256:/u);
  assert.match(String(skillProvenance.inputHash), /^sha256:/u);
  assert.match(String(skillProvenance.outputHash), /^sha256:/u);
  assert.match(String(skillProvenance.promptHash), /^sha256:/u);
  assert.equal(skillProvenance.traceId, 'trace-1');
  assert.equal(skillProvenance.modelReceiptId, calls[0]?.id);
  assert.equal(typeof skillProvenance.outputArtifactId, 'string');
  assert.equal(skillProvenance.status, 'succeeded');
  const attempts = await repository.listAttempts(lease.taskId);
  assert.equal(attempts[0]?.state, 'completed');
});

test('passes finalized success criteria and required ProblemGraph question IDs to report review', async () => {
  const structuredTask = {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'digital humans',
    research_goal: 'compare digital human products',
    target_audience: ['product team'],
    scope: ['public sources'],
    constraints: [],
    success_criteria: [
      { id: 'criterion-evidence', statement: 'Every fact is evidence backed' },
      { id: 'criterion-coverage', statement: 'Every required question is answered' },
    ],
    expected_deliverables: ['competitive analysis report'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
  const problemGraph = {
    version: 'problem-graph-v1',
    questions: [
      {
        id: 'question-required',
        statement: 'What is the evidence-backed differentiation?',
        rationale: 'Required for the research goal',
        priority: 'required',
        success_criterion_ids: ['criterion-evidence', 'criterion-coverage'],
        evidence_requirements: [],
        acceptance_criteria: ['answer is evidence backed'],
        depends_on: [],
      },
      {
        id: 'question-optional',
        statement: 'What adjacent detail may help?',
        rationale: 'Useful but non-blocking',
        priority: 'optional',
        success_criterion_ids: [],
        evidence_requirements: [],
        acceptance_criteria: [],
        depends_on: [],
      },
    ],
  };
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
    { problem_graph: problemGraph },
    structuredTask,
  );
  const review = new RecordingReportReviewFake(async (input) => ({
    version: 'report-review-v1',
    taskId: input.task.id,
    planVersionId: input.plan.id,
    attemptId: input.attempt.id,
    deliverableArtifactId: input.deliverableArtifactId,
    verdict: 'pass',
    dimensions: passingReviewDimensions(),
    revisionRound: 0,
    status: 'completed',
    artifactId: 'review-identifiers',
  }));

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
    new RecordingDeliverablesFake(),
    review,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(review.calls.length, 1);
  assert.deepEqual(review.calls[0]?.successCriterionIds, ['criterion-evidence', 'criterion-coverage']);
  assert.deepEqual(review.calls[0]?.questionIds, ['question-required']);
});

const reviewStructuredTaskFixture = {
  version: 'research-task-v2',
  task_type: 'competitive_research',
  business_domain: 'digital humans',
  research_goal: 'compare digital human products',
  target_audience: ['product team'],
  scope: ['public evidence'],
  constraints: [],
  success_criteria: [{ id: 'criterion-review', statement: 'review every evidence-backed conclusion' }],
  expected_deliverables: ['competitive analysis report'],
  assumptions: [],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'public',
  pii_detected: false,
};
const reviewProblemGraphFixture = {
  version: 'problem-graph-v1',
  questions: [{
    id: 'question-review',
    statement: 'Is the report complete and evidence backed?',
    rationale: 'Required before delivery',
    priority: 'required',
    success_criterion_ids: ['criterion-review'],
    evidence_requirements: [],
    acceptance_criteria: ['the report passes review'],
    depends_on: [],
  }],
};

test('pass Review composes and lease-seals a verified image and Chart ReportDocument for package dispatch', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
    { problem_graph: reviewProblemGraphFixture },
    reviewStructuredTaskFixture,
  );
  const store = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const visualAssets = new VisualAssetService({ artifacts: store });
  const original = await visualAssets.ingest({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    source: {
      kind: 'user_upload',
      fileName: 'verified-source.png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    },
    exportPolicy: 'allow',
  });
  const verifiedImage = await visualAssets.readVerified({
    assetId: original.assetArtifact.id,
    manifestArtifactId: original.manifestArtifact.id,
  });
  const spec: ChartSpec = {
    version: 'chart-spec-v1',
    chartId: 'chart-production-wiring',
    type: 'comparison',
    title: 'Verified comparison with missing numeric observation',
    categories: ['Score'],
    series: [{
      key: 'competitor:a',
      label: 'Competitor A',
      values: [null],
      evidenceIds: [[]],
    }],
    yAxis: { min: 0 },
  };
  const sealedChart = await renderAndSealChartSvg({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    spec,
    evidenceResolver: () => undefined,
    original: {
      assetId: original.assetArtifact.id,
      manifestArtifactId: original.manifestArtifact.id,
    },
    assets: visualAssets,
    artifacts: store,
    activeLease: lease,
    exportPolicy: 'allow',
    width: 800,
    height: 450,
  });
  const verifiedChart = await visualAssets.readVerified({
    assetId: sealedChart.derived.assetArtifact.id,
    manifestArtifactId: sealedChart.derived.manifestArtifact.id,
  });
  const persistedChartInput = await store.readVerifiedJson<{
    version: 'verified-chart-v1';
    taskId: string;
    planVersionId: string;
    attemptId: string;
    spec: ChartSpec;
    specHash: string;
    table: ChartTableAlternative;
    assetRef: { assetId: string; manifestArtifactId: string };
  }>(sealedChart.chartSpecArtifactId);
  const verifiedChartInput = persistedChartInput.value;
  assert.equal(persistedChartInput.artifact.kind, 'chart_spec');
  assert.equal(persistedChartInput.artifact.state, 'SEALED');
  assert.equal(persistedChartInput.artifact.schemaVersion, 'verified-chart-v1');
  assert.deepEqual(verifiedChartInput, {
    version: 'verified-chart-v1',
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    spec,
    specHash: chartSpecHash(spec),
    table: chartTableAlternative(spec),
    assetRef: {
      assetId: verifiedChart.artifact.id,
      manifestArtifactId: verifiedChart.manifestArtifact.id,
    },
  });

  const deliverables = new RecordingDeliverablesFake(async (input) => {
    const value = minimalDeliverable(input);
    const evidenceId = input.evidenceManifest.value.entries[0]?.id;
    assert.ok(evidenceId);
    const fact = value.findingGraph.findings[0];
    assert.ok(fact?.kind === 'fact');
    fact.evidenceIds = [evidenceId];
    value.coverage.questionBindings = [{ questionId: 'question-review', summaryIds: ['S1'] }];
    const artifact = await store.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'deliverable',
      relativePath: 'deliverables/final-r0.json',
      value,
      schemaVersion: 'research-deliverable-v1-review-gated',
      activeLease: input.activeLease,
    });
    return { deliverable: value, deliverableArtifactId: artifact.id };
  });
  const reportReview = new RecordingReportReviewFake(async (input) => {
    const value: ReportReviewArtifact & { verdict: 'pass' } = {
      version: 'report-review-v1',
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      deliverableArtifactId: input.deliverableArtifactId,
      verdict: 'pass',
      dimensions: passingReviewDimensions(),
      revisionRound: 0,
    };
    const artifact = await store.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'report_review',
      relativePath: 'reports/review-r0.json',
      value,
      schemaVersion: 'report-review-v1',
      activeLease: input.activeLease,
    });
    return { ...value, status: 'completed', artifactId: artifact.id };
  });

  const expectedVisualAssetManifests: Array<VerifiedVisualAsset['manifest']> = [
    structuredClone(verifiedImage.manifest),
    structuredClone(verifiedChart.manifest),
  ];
  const productionCompositionDependencies = { artifacts: store, visualAssets, repository };
  const productionComposition = new ReportCompositionService(productionCompositionDependencies);
  let compositionCalls = 0;
  const discovered = await (productionComposition as unknown as DiscoverableReportComposition)
    .discoverAttemptMaterials({
      taskId: lease.taskId,
      planVersionId: lease.planVersionId,
      attemptId: lease.attemptId,
    });
  assert.deepEqual(discovered.visualAssets.map(({ artifact, manifestArtifact }) => ({
    assetId: artifact.id,
    manifestArtifactId: manifestArtifact.id,
  })), [{
    assetId: verifiedImage.artifact.id,
    manifestArtifactId: verifiedImage.manifestArtifact.id,
  }]);
  assert.equal(discovered.charts.length, 1);
  assert.deepEqual(discovered.charts[0], {
    spec,
    specHash: verifiedChartInput.specHash,
    table: verifiedChartInput.table,
    asset: verifiedChart,
  });
  const reportComposition: TestReportComposition = {
    async composeAndStore(input) {
      compositionCalls += 1;
      assert.deepEqual(input.activeLease, lease);
      assert.deepEqual(input.requiredQuestionIds, ['question-review']);
      assert.deepEqual(
        input.visualAssets.map(({ artifact, manifestArtifact }) => ({
          assetId: artifact.id,
          manifestArtifactId: manifestArtifact.id,
        })),
        [{ assetId: verifiedImage.artifact.id, manifestArtifactId: verifiedImage.manifestArtifact.id }],
      );
      assert.deepEqual(input.charts.map(({ spec: chartSpec, specHash, table, asset }) => ({
        spec: chartSpec,
        specHash,
        table,
        assetId: asset.artifact.id,
        manifestArtifactId: asset.manifestArtifact.id,
      })), [{
        spec,
        specHash: verifiedChartInput.specHash,
        table: verifiedChartInput.table,
        assetId: verifiedChart.artifact.id,
        manifestArtifactId: verifiedChart.manifestArtifact.id,
      }]);
      return productionComposition.composeAndStore(input);
    },
  };

  const engine = new ReportCompositionAwareLeaseExecutionEngine({
    repository,
    artifacts: store,
    tools: new ToolRouter().register(new CountingRealTavilyAdapter()),
    llm: new CountingRealLLM(),
    deliverables,
    reportReview,
    reportComposition,
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
  });
  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(compositionCalls, 1);
  const reportDocumentArtifact = await repository.findSealedArtifact({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    kind: 'report_document',
  });
  assert.ok(reportDocumentArtifact);
  assert.equal(reportDocumentArtifact.state, 'SEALED');
  assert.equal(reportDocumentArtifact.schemaVersion, 'report-document-v1');
  const storedDocument = await store.readVerifiedJson<ReportDocument>(reportDocumentArtifact.id);
  assert.ok(storedDocument.value.sections.flatMap(({ blocks }) => blocks).some(({ type }) => type === 'image'));
  assert.ok(storedDocument.value.sections.flatMap(({ blocks }) => blocks).some(({ type }) => type === 'chart'));

  const reportPackage = await new CurrentReportPackageReader({
    artifacts: store,
    repository,
    visualAssets,
  }).read({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
  });
  assert.equal(reportPackage?.presentationMode, 'multimodal');
  if (reportPackage?.presentationMode !== 'multimodal') assert.fail('expected multimodal package');
  assert.deepEqual(reportPackage.reportDocument, storedDocument.value);
  assert.deepEqual(reportPackage.visualAssetManifests, expectedVisualAssetManifests);
});

async function reportMaterialDiscoveryFixture(exportPolicy: 'allow' | 'mask' | 'block' = 'allow'): Promise<{
  repository: ControlPlaneRepository;
  lease: ControlExecutionLease;
  manifestArtifact: ControlArtifact;
  discover(): Promise<{ visualAssets: VerifiedVisualAsset[]; charts: unknown[] }>;
}> {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]!]);
  const store = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const visualAssets = new VisualAssetService({ artifacts: store });
  const asset = await visualAssets.ingest({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    source: {
      kind: 'user_upload',
      fileName: 'discovery.png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    },
    exportPolicy,
  });
  const dependencies = { artifacts: store, visualAssets, repository };
  const service = new ReportCompositionService(dependencies) as unknown as DiscoverableReportComposition;
  return {
    repository,
    lease,
    manifestArtifact: asset.manifestArtifact,
    discover: () => service.discoverAttemptMaterials({
      taskId: lease.taskId,
      planVersionId: lease.planVersionId,
      attemptId: lease.attemptId,
    }),
  };
}

test('production report material discovery rejects foreign, tampered, and unsealed visual Manifests', async () => {
  const foreign = await reportMaterialDiscoveryFixture();
  const foreignValue = JSON.parse(readFileSync(foreign.manifestArtifact.storageUri, 'utf8')) as Record<string, unknown>;
  const { manifestHash: _manifestHash, ...foreignDraft } = foreignValue;
  const reboundDraft = { ...foreignDraft, taskId: randomUUID() };
  const rebound = { ...reboundDraft, manifestHash: canonicalJsonHash(reboundDraft) };
  const reboundBytes = Buffer.from(JSON.stringify(rebound, null, 2));
  writeFileSync(foreign.manifestArtifact.storageUri, reboundBytes);
  const foreignConnection = await scopedDatabase.connect();
  try {
    await foreignConnection.query(
      `UPDATE control_artifacts SET content_sha256 = $2, byte_size = $3 WHERE id = $1`,
      [
        foreign.manifestArtifact.id,
        `sha256:${createHash('sha256').update(reboundBytes).digest('hex')}`,
        reboundBytes.byteLength,
      ],
    );
  } finally {
    foreignConnection.release();
  }
  await assert.rejects(foreign.discover(), /task|binding|foreign|match/i);

  const tampered = await reportMaterialDiscoveryFixture();
  writeFileSync(tampered.manifestArtifact.storageUri, '{}');
  await assert.rejects(tampered.discover(), /hash|integrity|tamper|manifest/i);

  const unsealed = await reportMaterialDiscoveryFixture();
  const unsealedConnection = await scopedDatabase.connect();
  try {
    await unsealedConnection.query(
      `UPDATE control_artifacts SET state = 'STAGING' WHERE id = $1`,
      [unsealed.manifestArtifact.id],
    );
  } finally {
    unsealedConnection.release();
  }
  await assert.rejects(unsealed.discover(), /sealed|state|manifest/i);
});

test('production report material discovery ignores an unrelated export-blocked screenshot', async () => {
  const blocked = await reportMaterialDiscoveryFixture('block');

  const discovered = await blocked.discover();

  assert.deepEqual(discovered.visualAssets, []);
  assert.deepEqual(discovered.charts, []);
});


const pausedReviewCases = [
  {
    name: 'deterministic report review block',
    verdict: 'block' as const,
    revisionRound: 0 as const,
    failureDimension: 'requirement_coverage' as const,
  },
  {
    name: 'semantic report review block',
    verdict: 'block' as const,
    revisionRound: 0 as const,
    failureDimension: 'risk_disclosure' as const,
  },
  {
    name: 'second report review revise verdict',
    verdict: 'revise' as const,
    revisionRound: 1 as const,
    failureDimension: 'recommendation_quality' as const,
  },
];

for (const reviewCase of pausedReviewCases) {
  test(`records ${reviewCase.name} as one deterministic non-retryable execution step`, async () => {
    const { repository, lease } = await claimedExecution(
      new Date(Date.now() + 60_000),
      [planSteps[0]!],
      { problem_graph: reviewProblemGraphFixture },
      reviewStructuredTaskFixture,
    );
    const reviewStore = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const review = new RecordingReportReviewFake(async (input) => {
      const dimensions = passingReviewDimensions().map((dimension) => dimension.id === reviewCase.failureDimension
        ? { ...dimension, passed: false, issues: [`${reviewCase.name} fixture issue`] }
        : dimension);
      const reviewArtifact = {
        version: 'report-review-v1' as const,
        taskId: input.task.id,
        planVersionId: input.plan.id,
        attemptId: input.attempt.id,
        deliverableArtifactId: input.deliverableArtifactId,
        verdict: reviewCase.verdict,
        dimensions,
        revisionRound: reviewCase.revisionRound,
      };
      const sealed = await reviewStore.writeJson({
        taskId: input.task.id,
        planVersionId: input.plan.id,
        attemptId: input.attempt.id,
        kind: 'report_review',
        relativePath: `reviews/review-r${reviewCase.revisionRound}.json`,
        value: reviewArtifact,
        schemaVersion: 'report-review-v1',
        activeLease: input.activeLease,
      });
      return { ...reviewArtifact, status: 'paused', artifactId: sealed.id };
    });

    const result = await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new CountingRealLLM(),
      new RecordingDeliverablesFake(),
      review,
    ).execute({ lease, expectedModel: 'pinned-model' });

    assert.equal(result.status, 'paused');
    assert.equal(result.failedStepNo, planSteps.slice(0, 1).length + 2);
    assert.equal(result.failure?.retryable, false);
    assert.deepEqual(result.failure?.allowedActions, ['abort']);
    const steps = await repository.listExecutionSteps(lease.attemptId);
    assert.equal(new Set(steps.map((step) => step.stepNo)).size, steps.length);
    const failedReviewSteps = steps.filter((step) => step.state === 'failed' && step.failure?.kind === 'report_review');
    assert.equal(failedReviewSteps.length, 1);
    assert.equal(failedReviewSteps[0]?.stepNo, 3);
    assert.equal(failedReviewSteps[0]?.actorType, 'reviewer');
    assert.equal(failedReviewSteps[0]?.failure?.retryable, false);
    assert.deepEqual(failedReviewSteps[0]?.failure?.allowedActions, ['abort']);
    assert.equal((await repository.getArtifact(result.reportReviewArtifactId ?? ''))?.state, 'SEALED');
  });
}

test('validates resolved Skill input before the Skill LLM side effect', async () => {
  const invalidSteps: CurrentPlanStep[] = [
    planSteps[0]!,
    {
      ...planSteps[1]!,
      input_bindings: [{
        target_pointer: '/business_domain',
        source_step_no: 1,
        source_pointer: '/results',
      }],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), invalidSteps);
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    llm,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failedStepNo, 2);
  assert.equal(result.failure?.kind, 'schema');
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 0);
  const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
  assert.equal(skillStep?.skillProvenance?.status, 'failed');
  assert.match(String(skillStep?.skillProvenance?.inputSchemaHash), /^sha256:/u);
  assert.equal(skillStep?.skillProvenance?.modelReceiptId, null);
});

test('persists failed Skill provenance and receipt when output schema validation fails', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    planSteps.slice(0, 2),
  );
  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new InvalidSkillOutputLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'schema');
  const calls = await repository.listModelCalls(lease.attemptId);
  assert.equal(calls.length, 1);
  const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
  assert.equal(skillStep?.skillProvenance?.status, 'failed');
  assert.equal(skillStep?.skillProvenance?.modelReceiptId, calls[0]?.id);
  assert.match(String(skillStep?.skillProvenance?.skillBodyHash), /^sha256:/u);
  assert.match(String(skillStep?.skillProvenance?.outputSchemaHash), /^sha256:/u);
  assert.equal(
    skillStep?.skillProvenance?.outputHash,
    canonicalJsonHash({ comparison_matrix: [] }),
  );
});

test('Skill provenance capture failure preserves the actor failure and pauses the attempt', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    planSteps.slice(0, 2),
  );
  const originalRoot = getConfigRoot();
  const missingRoot = mkdtempSync(join(tmpdir(), 'missing-skill-config-root-'));
  try {
    const result = await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new ConfigBreakingSkillLLM(() => setConfigRoot(missingRoot)),
    ).execute({ lease, expectedModel: 'pinned-model' });

    assert.equal(result.status, 'paused');
    assert.equal(result.failure?.kind, 'server');
    assert.equal(result.failure?.message, 'skill provider unavailable');
    assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
    const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
    assert.equal(skillStep?.skillProvenance?.status, 'failed');
    assert.match(String(skillStep?.skillProvenance?.captureFailure), /ENOENT|no such file/iu);
  } finally {
    setConfigRoot(originalRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test('pauses execution when current deliverable validation fails', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'one-public-source',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
  );
  const deliverables = new RecordingDeliverablesFake(async () => {
    throw new CurrentReportValidationError('deliverable evidence graph is invalid');
  });

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(deliverables.calls.length, 1);
  assert.equal(result.status, 'paused');
  assert.equal(result.failedStepNo, 2);
  assert.equal(result.failure?.kind, 'deliverable_validation');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  const failedStep = steps.find((step) => step.state === 'failed');
  assert.ok(failedStep);
  assert.equal(failedStep.stepNo, 2);
  assert.ok(failedStep.actorType === 'llm' || failedStep.actorType === 'system');
  assert.equal(failedStep.failure?.kind, 'deliverable_validation');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  const connection = await scopedDatabase.connect();
  try {
    const terminalArtifacts = await connection.query(
      `SELECT kind FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('execution_summary', 'deliverable')`,
      [lease.attemptId],
    );
    assert.deepEqual(terminalArtifacts.rows, []);
  } finally {
    connection.release();
  }
});

test('rejects completion when a required evidence minimum is not met', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'two-public-sources',
        acceptedClasses: ['public_source'],
        minimumCount: 2,
        required: true,
      }],
    } as Record<string, unknown>,
  );
  const adapter = new CountingRealTavilyAdapter();
  const engine = buildEngine(
    repository,
    new ToolRouter().register(adapter),
    new CountingRealLLM(),
  );

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutionAuthenticityError);
      assert.equal(error.details.kind, 'missing_required_evidence');
      assert.equal(error.details.requirementId, 'two-public-sources');
      assert.equal(error.details.required, 2);
      assert.equal(error.details.actual, 1);
      return true;
    },
  );
  assert.equal(adapter.calls, 1);
  assert.notEqual((await repository.getTaskDetail(lease.taskId))?.state, 'completed');
  assert.notEqual((await repository.listAttempts(lease.taskId))[0]?.state, 'completed');
  const connection = await scopedDatabase.connect();
  try {
    const deliverables = await connection.query(
      `SELECT count(*) AS count FROM control_artifacts WHERE attempt_id = $1 AND kind = 'deliverable'`,
      [lease.attemptId],
    );
    assert.equal(Number(deliverables.rows[0]?.count), 0);
  } finally {
    connection.release();
  }
});

test('completes when sealed real Tool evidence meets the required minimum', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'one-public-source',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
    } as Record<string, unknown>,
  );
  const adapter = new CountingRealTavilyAdapter();
  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(adapter.calls, 1);
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'completed');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'completed');
  const connection = await scopedDatabase.connect();
  try {
    const manifests = await connection.query(
      `SELECT storage_uri FROM control_artifacts
       WHERE attempt_id = $1 AND kind = 'evidence_manifest' AND state = 'SEALED'`,
      [lease.attemptId],
    );
    const storageUri = manifests.rows[0]?.storage_uri;
    if (typeof storageUri !== 'string') assert.fail('required evidence must come from a sealed manifest');
    const manifest: unknown = JSON.parse(readFileSync(storageUri, 'utf8'));
    assertUnknownRecord(manifest);
    assert.ok(Array.isArray(manifest.entries));
    assert.equal(manifest.entries.length, 1);
    const entry = manifest.entries[0];
    assertUnknownRecord(entry);
    assert.equal(entry.evidenceClass, 'public_source');
    assert.equal(entry.sourceUrl, 'https://source.test/article');
    const toolProof = entry.toolProof;
    assertUnknownRecord(toolProof);
    assert.equal(toolProof.executionMode, 'real');
  } finally {
    connection.release();
  }
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

test('keeps a failing core Tool paused with retry and abort actions', async () => {
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
});

test('continues after an optional Tool failure and completes with a sanitized gap', async () => {
  const optionalSteps = [
    planSteps[0],
    {
      ...planSteps[0],
      step_no: 2,
      step_name: '可选内部资料检索',
      actor_id: 'ai-spider-search',
    },
    planSteps[2],
    planSteps[3],
  ];
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    optionalSteps,
  );
  const coreAdapter = new CountingRealTavilyAdapter();
  const optionalAdapter = new FailingRealAdapter('internal_api');
  const llm = new CountingRealLLM();
  const deliverables = new RecordingDeliverablesFake();
  const result = await buildEngine(
    repository,
    new ToolRouter().register(coreAdapter).register(optionalAdapter),
    llm,
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' }) as DeliverableAwareExecutionResult;

  assert.equal(result.status, 'completed_with_gaps');
  assert.equal(result.gapCount, 1);
  assert.equal(result.deliverableArtifactId, 'deliverable-1');
  assert.equal(coreAdapter.calls, 1);
  assert.equal(optionalAdapter.calls, 1);
  assert.equal(llm.calls, 2);
  assert.equal(deliverables.calls.length, 1);
  const deliverableInput = deliverables.calls[0];
  if (!deliverableInput) assert.fail('current deliverable generation input must be recorded');
  assert.equal(deliverableInput.gaps.length, 1);
  const gap = deliverableInput.gaps[0];
  assert.ok(gap);
  assert.match(gap, /step\s*2|步骤\s*2/i);
  assert.match(gap, /ai-spider-search/);
  assert.match(gap, /dependency unavailable/);
  assert.doesNotMatch(gap, /ToolInvocationError|\bat\s+LeaseExecutionEngine/);

  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps.length, optionalSteps.length);
  assert.equal(steps[0]?.state, 'succeeded');
  assert.equal(steps[1]?.state, 'skipped');
  assert.equal(steps[1]?.failure?.toolTier, 'optional');
  assert.equal(steps[1]?.failure?.kind, 'network');
  assert.equal(steps[2]?.state, 'succeeded');
  assert.equal(steps[3]?.state, 'succeeded');
  assert.deepEqual(
    (await repository.listModelCalls(lease.attemptId)).map((call) => call.stage),
    ['llm', 'reviewer'],
  );
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'completed_with_gaps');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'completed');
});
test('does not skip an optional tool when lease is lost during artifact seal', async () => {
  const optionalSteps = [
    planSteps[0],
    {
      ...planSteps[0],
      step_no: 2,
      step_name: '可选内部资料检索',
      actor_id: 'ai-spider-search',
    },
    planSteps[2],
    planSteps[3],
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), optionalSteps);
  const originalSealArtifact = repository.sealArtifact.bind(repository);
  let sealCalls = 0;
  repository.sealArtifact = async (input) => {
    sealCalls += 1;
    if (sealCalls === 2) await expireLease(repository, lease);
    return originalSealArtifact(input);
  };
  const optionalAdapter = new SuccessfulInternalAdapter();
  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()).register(optionalAdapter),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(optionalAdapter.calls, 1);
  const steps = await repository.listExecutionSteps(lease.attemptId);
  const failedStep = steps.find((step) => step.state === 'failed');
  assert.ok(failedStep);
  assert.equal(failedStep.stepNo, 2);
  assert.equal(failedStep.failure?.kind, 'lease_lost');
  assert.equal(steps.some((step) => step.state === 'skipped'), false);
  assert.equal(steps.some((step) => step.stepNo > 2 && step.actorType !== 'system'), false);
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  assert.deepEqual(await repository.listModelCalls(lease.attemptId), []);
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
test('does not seal a step Artifact when the lease expires before artifact seal', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const originalSealArtifact = repository.sealArtifact.bind(repository);
  repository.sealArtifact = async (input) => {
    await expireLease(repository, lease);
    return originalSealArtifact(input);
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps[0]?.state, 'failed');
  assert.notEqual(steps[0]?.state, 'succeeded');
  const connection = await scopedDatabase.connect();
  try {
    const artifacts = await connection.query(
      `SELECT kind, state FROM control_artifacts WHERE attempt_id = $1`,
      [lease.attemptId],
    );
    assert.deepEqual(artifacts.rows, [{ kind: 'tool_output', state: 'FAILED' }]);
    assert.equal(artifacts.rows.some((artifact) => artifact.state === 'SEALED'), false);
  } finally {
    connection.release();
  }
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('redacts Skill, LLM, and Reviewer echoes before sealing or passing later step context', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), planSteps);
  const llm = new EchoingSensitiveRealLLM();
  const deliverables = new RecordingDeliverablesFake();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    llm,
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(deliverables.calls.length, 1);
  const connection = await scopedDatabase.connect();
  let serializedArtifacts = '';
  let sealedSkillOutput: unknown;
  try {
    const artifacts = await connection.query(
      `SELECT kind, storage_uri FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('skill_output', 'llm_output', 'review_output')
       ORDER BY kind`,
      [lease.attemptId],
    );
    assert.deepEqual(
      artifacts.rows.map((row) => String(row.kind)),
      ['llm_output', 'review_output', 'skill_output'],
    );
    serializedArtifacts = artifacts.rows
      .map((row) => readFileSync(String(row.storage_uri), 'utf8'))
      .join('\n');
    const skillArtifact = artifacts.rows.find((row) => row.kind === 'skill_output');
    if (!skillArtifact) assert.fail('sealed Skill output must exist');
    sealedSkillOutput = JSON.parse(readFileSync(String(skillArtifact.storage_uri), 'utf8')) as unknown;
  } finally {
    connection.release();
  }
  const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
  assert.equal(skillStep?.skillProvenance?.outputHash, canonicalJsonHash(sealedSkillOutput));

  const serializedLaterContext = JSON.stringify(llm.contexts);
  const serializedDeliverableInput = JSON.stringify(deliverables.calls[0]);
  const persistedAndForwarded = `${serializedArtifacts}\n${serializedLaterContext}\n${serializedDeliverableInput}`;
  for (const secret of Object.values(echoedSecrets)) {
    assert.doesNotMatch(persistedAndForwarded, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.doesNotMatch(persistedAndForwarded, /\bBearer\s+(?:skill|llm|reviewer)-token\b/iu);
  assert.doesNotMatch(persistedAndForwarded, /(?:skill|llm|reviewer)-owner@example\.test/iu);
  assert.doesNotMatch(persistedAndForwarded, /1380013800[123]/u);
  assert.doesNotMatch(persistedAndForwarded, /(?:skill|llm|reviewer)-key/u);
  assert.match(persistedAndForwarded, /\[REDACTED/u);
});

for (const blockedStage of ['skill', 'llm', 'reviewer'] as const) {
  test(`rejects blocked sensitive ${blockedStage} output before sealing it`, async () => {
    const blockedStepIndex = { skill: 1, llm: 2, reviewer: 3 }[blockedStage];
    const { repository, lease } = await claimedExecution(
      new Date(Date.now() + 60_000),
      planSteps.slice(0, blockedStepIndex + 1),
    );
    const result = await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new BlockedSensitiveStageLLM(blockedStage),
    ).execute({ lease, expectedModel: 'pinned-model' });

    assert.equal(result.status, 'paused');
    assert.equal(result.failure?.kind, 'safety');
    const blockedKind = {
      skill: 'skill_output',
      llm: 'llm_output',
      reviewer: 'review_output',
    }[blockedStage];
    const connection = await scopedDatabase.connect();
    try {
      const artifacts = await connection.query(
        `SELECT state FROM control_artifacts WHERE attempt_id = $1 AND kind = $2`,
        [lease.attemptId, blockedKind],
      );
      assert.equal(artifacts.rows.some((row) => row.state === 'SEALED'), false);
    } finally {
      connection.release();
    }
  });
}

test('invalidates terminal artifacts when the lease expires during deliverable generation', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const terminalStore = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const deliverables = new RecordingDeliverablesFake(async (input) => {
    const deliverable = minimalDeliverable(input);
    const artifact = await terminalStore.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'deliverable',
      relativePath: 'deliverables/final.json',
      schemaVersion: 'research-deliverable-v1',
      value: deliverable,
    });
    await expireLease(repository, lease);
    return { deliverable, deliverableArtifactId: artifact.id };
  });

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  const connection = await scopedDatabase.connect();
  try {
    const terminalArtifacts = await connection.query(
      `SELECT kind, state FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('evidence_manifest', 'deliverable')`,
      [lease.attemptId],
    );
    assert.equal(terminalArtifacts.rows.some((row) => row.state === 'SEALED'), false);
    assert.ok(terminalArtifacts.rows.every((row) => row.state === 'FAILED'));
  } finally {
    connection.release();
  }
});

test('terminal lease recovery invalidates sealed report document, review, manifest, and deliverable together', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
    { problem_graph: reviewProblemGraphFixture },
    reviewStructuredTaskFixture,
  );
  const terminalStore = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const deliverables = new RecordingDeliverablesFake(async (input) => {
    const deliverable = minimalDeliverable(input);
    const artifact = await terminalStore.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'deliverable',
      relativePath: 'deliverables/final-r1.json',
      schemaVersion: 'research-deliverable-v1',
      value: deliverable,
      activeLease: input.activeLease,
    });
    return { deliverable, deliverableArtifactId: artifact.id };
  });
  const reportReview = new RecordingReportReviewFake(async (input) => {
    const reviewArtifact = {
      version: 'report-review-v1' as const,
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      deliverableArtifactId: input.deliverableArtifactId,
      verdict: 'pass' as const,
      dimensions: passingReviewDimensions(),
      revisionRound: 1 as const,
    };
    const artifact = await terminalStore.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'report_review',
      relativePath: 'reviews/review-r1.json',
      schemaVersion: 'report-review-v1',
      value: reviewArtifact,
      activeLease: input.activeLease,
    });
    await terminalStore.writeJson({
      taskId: input.task.id,
      planVersionId: input.plan.id,
      attemptId: input.attempt.id,
      kind: 'report_document',
      relativePath: 'reports/report-document.json',
      schemaVersion: 'report-document-v1',
      value: {
        version: 'report-document-v1',
        title: 'Lease-fenced report',
        subtitle: 'Must be invalidated with its terminal inputs',
        executiveSummary: 'This sealed document cannot survive terminal CAS loss.',
        sections: [],
      },
      activeLease: input.activeLease,
    });
    const connection = await scopedDatabase.connect();
    try {
      await connection.query(
        `UPDATE control_execution_attempts
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [input.attempt.id],
      );
    } finally {
      connection.release();
    }
    return { ...reviewArtifact, status: 'completed', artifactId: artifact.id };
  });

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
    deliverables,
    reportReview,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  const connection = await scopedDatabase.connect();
  try {
    const terminalArtifacts = await connection.query(
      `SELECT kind, state FROM control_artifacts
       WHERE attempt_id = $1 AND kind IN ('evidence_manifest', 'deliverable', 'report_document', 'report_review')
       ORDER BY kind`,
      [lease.attemptId],
    );
    assert.deepEqual(
      terminalArtifacts.rows.map((row) => ({ kind: row.kind, state: row.state })),
      [
        { kind: 'deliverable', state: 'FAILED' },
        { kind: 'evidence_manifest', state: 'FAILED' },
        { kind: 'report_document', state: 'FAILED' },
        { kind: 'report_review', state: 'FAILED' },
      ],
    );
  } finally {
    connection.release();
  }
  assert.equal(await repository.findSealedArtifact({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    kind: 'report_review',
  }), null);
  assert.equal(await repository.findSealedArtifact({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    kind: 'report_document',
  }), null);
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
  assert.ok(Array.isArray(refs) && refs.some((ref) => {
    if (!ref || typeof ref !== 'object') return false;
    const source = ref as Record<string, unknown>;
    return typeof source.sourceUrl === 'string'
      && source.sourceUrl.startsWith('http')
      && Number.isInteger(source.originalIndex);
  }));
});

test('failed Skill provenance retains its persisted receipt when config capture then fails', async () => {
  const originalRoot = getConfigRoot();
  const missingRoot = mkdtempSync(join(tmpdir(), 'missing-skill-receipt-root-'));
  class ConfigBreakingAfterSkillResultLLM extends CountingRealLLM {
    override async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      const result = await super.generateStructured<T>(options);
      setConfigRoot(missingRoot);
      return result;
    }
  }

  try {
    const { repository, lease } = await claimedExecution(
      new Date(Date.now() + 60_000),
      planSteps.slice(0, 2),
    );
    const result = await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new ConfigBreakingAfterSkillResultLLM(),
    ).execute({ lease, expectedModel: 'pinned-model' });

    assert.equal(result.status, 'paused');
    assert.equal(result.failure?.kind, 'schema');
    const calls = await repository.listModelCalls(lease.attemptId);
    assert.equal(calls.length, 1);
    const receipt = calls[0]!;
    assert.equal(receipt.stage, 'skill');
    const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
    assert.equal(skillStep?.skillProvenance?.status, 'failed');
    assert.match(String(skillStep?.skillProvenance?.captureFailure), /ENOENT|no such file/iu);
    assert.equal(skillStep?.skillProvenance?.modelReceiptId, receipt.id);
    assert.equal(skillStep?.skillProvenance?.promptHash, receipt.promptHash);
    assert.equal(skillStep?.skillProvenance?.traceId, receipt.traceId);
  } finally {
    setConfigRoot(originalRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
