import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { VisualInputGateStore } from '../apps/orchestrator-runtime/src/control/visual-input-gate-store.ts';
import {
  ExecutionAuthenticityError,
  LeaseExecutionEngine,
  type LeaseExecutionResult,
} from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import type {
  ChartSpec,
  CurrentPlanStep,
  EvidenceRequirement,
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
import { ImageAnnotationService } from '../apps/orchestrator-runtime/src/report/image-annotation-service.ts';
import { VisualInputMaterializer } from '../apps/orchestrator-runtime/src/report/visual-input-materializer.ts';
import {
  chartTableAlternative,
  renderAndSealChartSvg,
  type ChartTableAlternative,
} from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';
import { chartSpecHash } from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';
import { CurrentReportPackageReader } from '../apps/orchestrator-runtime/src/report/current-report-package-reader.ts';
import { ReportPackageArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-artifact.ts';
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
import {
  getConfigRoot,
  hashFile,
  loadEvidencePolicy,
  setConfigRoot,
  type ToolManifest,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
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
      screenshotComparisons: [],
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

class CapturingRestAdapter implements ToolAdapter {
  readonly adapterType = 'rest_json' as const;
  readonly implementationId = 'test-rest-json-real-v1';
  readonly executionMode = 'real' as const;
  calls = 0;
  readonly inputs: object[] = [];

  constructor(private readonly output: object = { status: 'available' }) {}

  endpointHost(): string {
    return 'design-tool.test';
  }

  async invoke(options: { input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    this.inputs.push(structuredClone(options.input));
    return {
      output: structuredClone(this.output),
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

class TransientThenInvalidSchemaAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'test-transient-then-schema-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'api.tavily.test';
  }

  async invoke(options: { toolId: string; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    const attemptReceipt = {
      declaredAdapterType: options.manifest.adapter_type,
      resolvedAdapterType: this.adapterType,
      implementationId: this.implementationId,
      executionMode: this.executionMode,
      endpointHost: this.endpointHost(),
      status: this.calls === 1 ? 'failed' as const : 'ok' as const,
      latencyMs: this.calls,
    };
    if (this.calls === 1) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'network',
        retryable: true,
        providerStatus: null,
        sanitizedMessage: 'transient dependency outage',
        receipt: attemptReceipt,
      });
    }
    return { output: { results: 'invalid' }, latencyMs: this.calls, receipt: attemptReceipt };
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

function digitalHumanSkillOutput(payload: Record<string, unknown> = {
  comparison_matrix: [{ competitor: 'A', dimension: '体验', assessment: 'ok', source: 'tool_result' }],
  differentiation_opportunities: ['verified'],
  sources: ['https://source.test/article'],
}): Record<string, unknown> {
  return {
    version: 'skill-output-v2',
    status: 'succeeded',
    summary: '基于已提供材料完成竞品分析。',
    findings: [{ id: 'finding-1', statement: '竞品体验存在可验证差异。', confidence: 0.8 }],
    assumptions: [],
    limitations: [],
    recommendations: ['继续用公开来源复核关键差异。'],
    payload,
  };
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
      ? digitalHumanSkillOutput()
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

class ReverseCompletionLLM extends CountingRealLLM {
  override async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    const result = await super.generateText(options);
    if (options.receipt.stepNo === 2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return result;
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
      data: digitalHumanSkillOutput({
        comparison_matrix: [{
          competitor: 'A',
          dimension: '体验',
          assessment: echoedSecrets.skill,
          source: 'tool_result',
        }],
        differentiation_opportunities: [echoedSecrets.skill],
        sources: ['https://source.test/article'],
      }) as T,
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
      data: digitalHumanSkillOutput({
        comparison_matrix: [{
          competitor: 'A',
          dimension: '体验',
          assessment: 'confidential internal-only roadmap',
          source: 'tool_result',
        }],
        differentiation_opportunities: ['verified'],
        sources: ['https://source.test/article'],
      }) as T,
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
    expected_outputs: [{ pointer: '/payload/comparison_matrix', description: 'comparison' }],
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
  pendingInputs: unknown[] = [],
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
    pendingInputs,
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
  skillLoader: SkillLoader = new SkillLoader(),
): LeaseExecutionEngine {
  return new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools,
    llm,
    deliverables,
    ...(reportReview ? { reportReview } : {}),
    skillLoader,
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

async function ageLeasePastExpiry(lease: ControlExecutionLease): Promise<void> {
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
}

async function expireLease(
  repository: ControlPlaneRepository,
  lease: ControlExecutionLease,
): Promise<void> {
  await ageLeasePastExpiry(lease);
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

test('rejects legacy pending inputs without an explicit kind before Tool or LLM side effects', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    planSteps,
    {},
    { research_goal: 'compare digital human products' },
    [{
      role: 'query',
      label: 'query',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
    }],
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = buildEngine(repository, new ToolRouter().register(adapter), llm);

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    /pending input contract is invalid: item 1 is malformed/u,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
});

test('rejects a legacy raw visual gate before materialization or Tool side effects', async () => {
  const visualSteps = structuredClone(planSteps);
  visualSteps[0]!.input.designImage = null;
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    visualSteps,
    {},
    { research_goal: 'compare digital human products' },
    [{
      kind: 'visual',
      role: 'designImage',
      label: 'designImage',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'designImage', multiple: false }],
    }],
  );
  const plan = await repository.getPlanVersionDetail(lease.planVersionId);
  assert.ok(plan);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const legacyConnection = await scopedDatabase.connect();
  try {
    await legacyConnection.query(
      `INSERT INTO control_gate_records
       (task_id, plan_version_id, plan_hash, gate_type, gate_key, required_authority,
        decision, value_json, actor_user_id, actor_role, policy_version, idempotency_key)
       VALUES ($1, $2, $3, 'input', 'designImage', 'owner', 'provided', $4, $5, 'owner',
               'legacy-test-only', $6)`,
      [
        lease.taskId,
        lease.planVersionId,
        plan.planHash,
        JSON.stringify({ dataUrl: `data:image/png;base64,${png.toString('base64')}` }),
        ownerId,
        `legacy-visual-${randomUUID()}`,
      ],
    );
  } finally {
    legacyConnection.release();
  }
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  let materializeCalls = 0;
  const engine = new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools: new ToolRouter().register(adapter),
    llm,
    deliverables: new RecordingDeliverablesFake(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    visualInputMaterializer: {
      async materialize() { materializeCalls += 1; },
    },
  });

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    /unsealed dataUrl/u,
  );
  assert.equal(materializeCalls, 0);
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
});

test('uses the same verified visual bytes for materialization and Tool dataUrl hydration', async () => {
  const steps: CurrentPlanStep[] = [
    {
      step_no: 1,
      step_name: 'design analysis',
      actor_type: 'tool',
      actor_id: 'aesthetic-quant-lab',
      question_ids: ['question-1'],
      depends_on: [],
      input: { designImage: null },
      input_bindings: [],
      expected_outputs: [{ pointer: '/status', description: 'design status' }],
      acceptance_criteria: ['analyzes the supplied image'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    { ...structuredClone(planSteps[0]!), step_no: 2 },
    {
      ...structuredClone(planSteps[1]!),
      step_no: 3,
      depends_on: [2],
      input_bindings: [{
        target_pointer: '/business_domain',
        source_step_no: 2,
        source_pointer: '/results/0/title',
      }],
    },
    { ...structuredClone(planSteps[2]!), step_no: 4, depends_on: [3] },
    { ...structuredClone(planSteps[3]!), step_no: 5, depends_on: [4] },
  ];
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    steps,
    {},
    { research_goal: 'compare digital human products' },
    [{
      kind: 'visual',
      role: 'designImage',
      label: 'designImage',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'aesthetic-quant-lab', field: 'designImage', multiple: false }],
    }],
  );
  const plan = await repository.getPlanVersionDetail(lease.planVersionId);
  assert.ok(plan);
  const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const visualInputGates = new VisualInputGateStore(artifacts);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const published = await visualInputGates.publish({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    gateKey: 'designImage',
    multiple: false,
    requiredVisual: true,
    value: { dataUrl: `data:image/png;base64,${png.toString('base64')}` },
  });
  await repository.recordGate({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    planHash: plan.planHash,
    gateType: 'input',
    gateKey: 'designImage',
    requiredAuthority: 'owner',
    decision: 'provided',
    evidenceRef: published.evidenceRef,
    actorUserId: ownerId,
    actorRole: 'owner',
    idempotencyKey: `sealed-visual-${randomUUID()}`,
  });
  const tavily = new CountingRealTavilyAdapter();
  const designTool = new CapturingRestAdapter();
  const llm = new CountingRealLLM();
  let materialized: Buffer | undefined;
  let annotationPurpose: 'input_provenance' | 'design_audit' | undefined;
  const engine = new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts,
    tools: new ToolRouter().register(tavily).register(designTool),
    llm,
    deliverables: new RecordingDeliverablesFake(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    visualInputGates,
    visualInputMaterializer: {
      async materialize(input) {
        materialized = Buffer.from(input.visuals[0]!.images[0]!.bytes);
        annotationPurpose = input.annotationPurpose;
      },
    },
  });

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.deepEqual(materialized, png);
  assert.equal(annotationPurpose, 'input_provenance');
  assert.equal(designTool.calls, 1);
  const designInput = designTool.inputs[0] as { designImage?: { dataUrl?: string } };
  const dataUrl = designInput.designImage?.dataUrl;
  assert.equal(typeof dataUrl, 'string');
  assert.deepEqual(Buffer.from(dataUrl!.split(',')[1]!, 'base64'), png);
});

test('defers design annotation until verified attention findings are available', async () => {
  const attentionStep: CurrentPlanStep = {
    step_no: 2,
    step_name: 'attention analysis',
    actor_type: 'tool',
    actor_id: 'attention-analysis-lab',
    question_ids: ['question-1'],
    depends_on: [1],
    input: { image: {} },
    input_bindings: [],
    expected_outputs: [{ pointer: '/hotspots', description: 'verified attention hotspots' }],
    acceptance_criteria: ['returns finding-bound normalized hotspots'],
    requires_approval: false,
    fallback_actor_ids: [],
  };
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!, attentionStep],
    {
      deliverable_type: 'design_audit_report',
      evidence_requirements: [{
        id: 'design-audit-report',
        acceptedClasses: ['screenshot', 'user_input', 'public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
  );
  const materializedOriginal = {
    gateKey: 'designImage',
    imageIndex: 1,
    original: { assetId: 'design-original', manifestArtifactId: 'design-original-manifest' },
  };
  let annotationPurpose: 'input_provenance' | undefined;
  let annotatedFindings: Array<{
    findingId: string;
    label: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  const designTool = new CapturingRestAdapter({
    status: 'available',
    hotspots: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.85, reason: 'Primary CTA dominates' }],
  });
  const engine = new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools: new ToolRouter().register(new CountingRealTavilyAdapter()).register(designTool),
    llm: new CountingRealLLM(),
    deliverables: new RecordingDeliverablesFake(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    visualInputMaterializer: {
      async materialize(input) {
        annotationPurpose = input.annotationPurpose;
        return [materializedOriginal];
      },
      async annotateDesignFindings(input) {
        assert.deepEqual(input.original, materializedOriginal);
        annotatedFindings = structuredClone(input.findings);
      },
    },
  });

  const result = await engine.execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(annotationPurpose, undefined);
  assert.equal(designTool.calls, 1);
  assert.deepEqual(annotatedFindings, [{
    findingId: 'design-attention-2-1',
    label: 'Primary CTA dominates',
    severity: 'high',
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
  }]);
});

test('production design audit fails closed before actors without exactly one original', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
    {
      deliverable_type: 'design_audit_report',
      evidence_requirements: [{
        id: 'design-audit-report',
        acceptedClasses: ['screenshot', 'user_input', 'public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
  );
  const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const visualAssets = new VisualAssetService({ artifacts });
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const engine = new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts,
    tools: new ToolRouter().register(adapter),
    llm,
    deliverables: new RecordingDeliverablesFake(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    visualInputMaterializer: new VisualInputMaterializer({
      visualAssets,
      imageAnnotations: new ImageAnnotationService({ assets: visualAssets, artifacts }),
    }),
  });

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    /exactly one materialized original and a finding-bound annotation producer/u,
  );

  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.stepName, 'execution preflight');
  assert.equal(step?.state, 'failed');
  assert.match(
    String(step?.failure?.message),
    /exactly one materialized original and a finding-bound annotation producer/u,
  );
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
});

test('records lease loss when visual materialization outlives the active lease', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  let materializeCalls = 0;
  const engine = new DeliverableAwareLeaseExecutionEngine({
    repository,
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    tools: new ToolRouter().register(adapter),
    llm,
    deliverables: new RecordingDeliverablesFake(),
    skillLoader: new SkillLoader(),
    validator: new SchemaValidator(),
    heartbeatMs: 60_000,
    visualInputMaterializer: {
      async materialize() {
        materializeCalls += 1;
        await ageLeasePastExpiry(lease);
      },
    },
  });

  await assert.rejects(
    () => engine.execute({ lease, expectedModel: 'pinned-model' }),
    ControlPlaneConflictError,
  );

  assert.equal(materializeCalls, 1);
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.stepName, 'execution preflight');
  assert.equal(step?.actorId, 'preflight');
  assert.equal(step?.state, 'failed');
  assert.equal(step?.failure?.kind, 'lease_lost');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
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
test('legacy task_type-only execution uses the persisted research_plan deliverable contract', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      deliverable_type: 'research_plan',
      evidence_requirements: [{
        id: 'public-market-evidence',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
    {
      task_type: 'competitive_research',
      research_goal: 'compare digital human products',
    },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();
  const deliverables = new RecordingDeliverablesFake();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    llm,
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(adapter.calls, 1);
  assert.equal(deliverables.calls.length, 1);
  assert.equal(deliverables.calls[0]?.plan.plan.deliverable_type, 'research_plan');
  assert.deepEqual(deliverables.calls[0]?.finalizedRequirement, {
    task_type: 'competitive_research',
    research_goal: 'compare digital human products',
  });
  assert.equal(result.evidenceManifestArtifactId !== undefined, true);
  assert.equal(result.deliverableArtifactId, 'deliverable-1');
});

test('engine preflight preserves a schema-valid empty Tool input without injecting query', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const adapter: ToolAdapter = {
    adapterType: 'rest_json',
    implementationId: 'qualified-real-rest-json',
    executionMode: 'real',
    endpointHost: () => 'aesthetic.fixture.test',
    async invoke() { throw new Error('not used during preflight'); },
  };
  const engine = buildEngine(
    repository,
    new ToolRouter().register(adapter),
    new CountingRealLLM(),
  ) as unknown as {
    preflight(plan: {
      taskId: string;
      evidence_requirements: EvidenceRequirement[];
      steps: CurrentPlanStep[];
    }, researchGoal: string): Promise<Error | null>;
  };
  const error = await engine.preflight({
    taskId: 'task-empty-tool-input',
    evidence_requirements: [],
    steps: [{
      ...planSteps[0]!,
      actor_id: 'aesthetic-quant-lab',
      step_name: 'empty aesthetic input',
      input: {},
    }],
  }, 'must not be injected as query');

  assert.equal(error, null);
});

test('research-task-v2 without expected_deliverables remains rejected during engine preflight', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    { deliverable_type: 'research_plan' },
    {
      version: 'research-task-v2',
      task_type: 'competitive_research',
      research_goal: 'compare digital human products',
    },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  await assert.rejects(
    () => buildEngine(repository, new ToolRouter().register(adapter), llm)
      .execute({ lease, expectedModel: 'pinned-model' }),
    /expected_deliverables are malformed/,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(llm.calls, 0);
  await assertNoExecutionArtifacts(lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('research-task-v2 without task_type remains rejected during engine preflight', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    { deliverable_type: 'research_plan' },
    {
      version: 'research-task-v2',
      research_goal: 'compare digital human products',
      expected_deliverables: ['research_plan'],
    },
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  await assert.rejects(
    () => buildEngine(repository, new ToolRouter().register(adapter), llm)
      .execute({ lease, expectedModel: 'pinned-model' }),
    /task_type is malformed/,
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
        source_pointer: '/payload/comparison_matrix',
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

test('settles every parallel wave step before pausing after an input binding failure', async () => {
  const invalidParallelSteps: CurrentPlanStep[] = [
    {
      ...planSteps[0]!,
      expected_outputs: [{ pointer: '/missing', description: 'declared but absent runtime output' }],
    },
    ...[2, 3].map((stepNo): CurrentPlanStep => ({
      step_no: stepNo,
      step_name: `并行分析 ${stepNo}`,
      actor_type: 'llm',
      actor_id: `parallel-summary-${stepNo}`,
      question_ids: ['question-1'],
      depends_on: [1],
      input: { source: null },
      input_bindings: [{
        target_pointer: '/source',
        source_step_no: 1,
        source_pointer: '/missing',
      }],
      expected_outputs: [{ pointer: '/text', description: 'summary' }],
      acceptance_criteria: ['summarizes evidence'],
      requires_approval: false,
      fallback_actor_ids: [],
    })),
  ];
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    invalidParallelSteps,
  );
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  await assert.rejects(
    () => buildEngine(
      repository,
      new ToolRouter().register(adapter),
      llm,
    ).execute({ lease, expectedModel: 'pinned-model' }),
    ExecutionAuthenticityError,
  );
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 0);
  const branchSteps = (await repository.listExecutionSteps(lease.attemptId))
    .filter((step) => step.stepNo === 2 || step.stepNo === 3)
    .sort((left, right) => left.stepNo - right.stepNo);
  assert.deepEqual(branchSteps.map((step) => step.state), ['failed', 'failed']);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('prioritizes parallel Artifact invalidation failure as the attempt pause reason', async () => {
  const steps: CurrentPlanStep[] = [
    {
      ...planSteps[2]!,
      step_no: 1,
      step_name: 'lower ordinary failure',
      depends_on: [],
    },
    {
      ...planSteps[0]!,
      step_no: 2,
      step_name: 'higher Artifact cleanup failure',
      depends_on: [],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), steps);
  const llm = new CountingRealLLM();
  const originalGenerateText = llm.generateText.bind(llm);
  llm.generateText = async (options) => {
    if (options.receipt.stepNo === 1) {
      throw new LLMInvocationError('server', false, 503, 'lower parallel step failed');
    }
    return originalGenerateText(options);
  };
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  const originalInvalidateArtifact = repository.invalidateArtifactPublication.bind(repository);
  let succeededWriteAttempts = 0;
  let cleanupAttempts = 0;
  let unpublishedArtifactId: string | undefined;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo === 2 && candidate.state === 'succeeded') {
      succeededWriteAttempts += 1;
      unpublishedArtifactId = candidate.outputArtifactId;
      throw new Error('injected succeeded-step persistence failure');
    }
    await originalRecordExecutionStep(candidate);
  };
  repository.invalidateArtifactPublication = async (artifactId, reason) => {
    if (artifactId === unpublishedArtifactId) {
      cleanupAttempts += 1;
      throw new Error('injected Artifact invalidation failure');
    }
    await originalInvalidateArtifact(artifactId, reason);
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    llm,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failedStepNo, 1);
  assert.equal(result.failure?.kind, 'server');
  assert.equal(succeededWriteAttempts, 2);
  assert.equal(cleanupAttempts, 1);
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.attemptState, 'paused');
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
});

test('settles and pauses a parallel wave when a pre-run lease refresh rejects', async () => {
  const parallelSteps: CurrentPlanStep[] = [planSteps[0]!, ...[2, 3].map((stepNo): CurrentPlanStep => ({
    step_no: stepNo,
    step_name: `并行摘要 ${stepNo}`,
    actor_type: 'llm',
    actor_id: `parallel-summary-${stepNo}`,
    question_ids: ['question-1'],
    depends_on: [1],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/text', description: 'summary' }],
    acceptance_criteria: ['summarizes evidence'],
    requires_approval: false,
    fallback_actor_ids: [],
  }))];
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    parallelSteps,
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let rejectNextPreRunRefresh = false;
  repository.recordExecutionStep = async (candidate) => {
    await originalRecordExecutionStep(candidate);
    if (candidate.stepNo === 1 && candidate.state === 'succeeded') {
      rejectNextPreRunRefresh = true;
    }
  };
  const originalRequireActiveLease = repository.requireActiveLease.bind(repository);
  repository.requireActiveLease = async (candidate) => {
    if (rejectNextPreRunRefresh) {
      rejectNextPreRunRefresh = false;
      throw new ControlPlaneConflictError('injected pre-run lease refresh rejection');
    }
    return originalRequireActiveLease(candidate);
  };
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    llm,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 1);
  assert.deepEqual(
    (await repository.listExecutionSteps(lease.attemptId)).map(({ stepNo, state }) => ({ stepNo, state })),
    [
      { stepNo: 1, state: 'succeeded' },
      { stepNo: 2, state: 'failed' },
      { stepNo: 3, state: 'succeeded' },
    ],
  );
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('inserts a failed step when the lease expires before the pre-run running row', async () => {
  const steps: CurrentPlanStep[] = [
    planSteps[0]!,
    { ...planSteps[2]!, step_no: 2, depends_on: [1] },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), steps);
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  const regularStepTwoStates: string[] = [];
  let expired = false;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo === 2) regularStepTwoStates.push(candidate.state);
    await originalRecordExecutionStep(candidate);
    if (candidate.stepNo === 1 && candidate.state === 'succeeded' && !expired) {
      expired = true;
      await ageLeasePastExpiry(lease);
    }
  };
  const adapter = new CountingRealTavilyAdapter();
  const llm = new CountingRealLLM();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    llm,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(adapter.calls, 1);
  assert.equal(llm.calls, 0);
  assert.deepEqual(regularStepTwoStates, ['failed']);
  const executionSteps = await repository.listExecutionSteps(lease.attemptId);
  assert.deepEqual(
    executionSteps.map(({ stepNo, state }) => ({ stepNo, state })),
    [
      { stepNo: 1, state: 'succeeded' },
      { stepNo: 2, state: 'failed' },
    ],
  );
  assert.equal(executionSteps[1]?.actorId, planSteps[2]!.actor_id);
  assert.equal(executionSteps[1]?.failure?.kind, 'lease_lost');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
});

test('fails closed without publishing optional Tool output when succeeded-step persistence fails', async () => {
  const steps: CurrentPlanStep[] = [
    planSteps[0]!,
    {
      ...planSteps[0]!,
      step_no: 2,
      step_name: '可选内部资料检索',
      actor_id: 'ai-spider-search',
      depends_on: [1],
    },
    {
      ...planSteps[2]!,
      step_no: 3,
      depends_on: [2],
      input: { source: null },
      input_bindings: [{
        target_pointer: '/source',
        source_step_no: 2,
        source_pointer: '/results',
      }],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), steps);
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo === 2 && candidate.state === 'succeeded') {
      throw new Error('injected succeeded-step persistence failure');
    }
    await originalRecordExecutionStep(candidate);
  };
  const llm = new CountingRealLLM();

  const result = await buildEngine(
    repository,
    new ToolRouter()
      .register(new CountingRealTavilyAdapter())
      .register(new SuccessfulInternalAdapter()),
    llm,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(llm.calls, 0);
  const executionSteps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(executionSteps.find(({ stepNo }) => stepNo === 2)?.state, 'failed');
  assert.equal(executionSteps.some(({ stepNo }) => stepNo === 3), false);
  const optionalArtifact = (await repository.listArtifactsForAttempt(lease))
    .find(({ storageUri }) => storageUri.includes('/steps/2-tool_output.json'));
  assert.equal(optionalArtifact?.state, 'FAILED');
});

test('defers Artifact invalidation when succeeded-step writes and readback all fail', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  const originalListExecutionSteps = repository.listExecutionSteps.bind(repository);
  let succeededWriteAttempts = 0;
  let readbackFailures = 0;
  let artifactId: string | undefined;
  let artifactStateBeforeFailedWrite: string | undefined;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo === 1 && candidate.state === 'succeeded') {
      succeededWriteAttempts += 1;
      artifactId = candidate.outputArtifactId;
      throw new Error('injected succeeded-step persistence failure');
    }
    if (candidate.stepNo === 1 && candidate.state === 'failed' && artifactId) {
      artifactStateBeforeFailedWrite = (await repository.getArtifact(artifactId))?.state;
    }
    await originalRecordExecutionStep(candidate);
  };
  repository.listExecutionSteps = async (attemptId) => {
    if (
      attemptId === lease.attemptId
      && succeededWriteAttempts === 2
      && readbackFailures === 0
    ) {
      readbackFailures += 1;
      throw new Error('injected succeeded-step readback failure');
    }
    return originalListExecutionSteps(attemptId);
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(succeededWriteAttempts, 2);
  assert.equal(readbackFailures, 1);
  assert.equal(artifactStateBeforeFailedWrite, 'SEALED');
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'failed');
  assert.ok(artifactId);
  assert.equal((await repository.getArtifact(artifactId))?.state, 'FAILED');
});

test('rejects a mutated succeeded readback without invalidating its referenced Artifact', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let succeededWriteAttempts = 0;
  let artifactId: string | undefined;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo !== 1 || candidate.state !== 'succeeded') {
      await originalRecordExecutionStep(candidate);
      return;
    }
    succeededWriteAttempts += 1;
    artifactId = candidate.outputArtifactId;
    if (succeededWriteAttempts === 1) {
      await originalRecordExecutionStep(candidate);
      const connection = await scopedDatabase.connect();
      try {
        await connection.query(
          `UPDATE control_execution_steps
           SET actor_id = 'tampered-actor', tool_provenance = $3, latency_ms = 999
           WHERE attempt_id = $1 AND step_no = $2`,
          [
            candidate.attemptId,
            candidate.stepNo,
            JSON.stringify({ ...candidate.toolProvenance, configHash: 'sha256:tampered' }),
          ],
        );
      } finally {
        connection.release();
      }
    }
    throw new Error('injected succeeded-step response failure');
  };

  let executionError: unknown;
  try {
    await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new CountingRealLLM(),
    ).execute({ lease, expectedModel: 'pinned-model' });
  } catch (error) {
    executionError = error;
  }

  assert.ok(executionError instanceof ControlPlaneConflictError);
  assert.equal(succeededWriteAttempts, 2);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'succeeded');
  assert.equal(step?.actorId, 'tampered-actor');
  assert.equal(step?.latencyMs, 999);
  assert.equal(step?.toolProvenance?.configHash, 'sha256:tampered');
  assert.equal(step?.outputArtifactId, artifactId);
  assert.ok(artifactId);
  assert.equal((await repository.getArtifact(artifactId))?.state, 'SEALED');
});

test('keeps a succeeded step and Artifact when the commit response is lost', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let lostResponse = false;
  repository.recordExecutionStep = async (candidate) => {
    await originalRecordExecutionStep(candidate);
    if (candidate.stepNo === 1 && candidate.state === 'succeeded' && !lostResponse) {
      lostResponse = true;
      throw new Error('simulated commit response loss');
    }
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'succeeded');
  assert.ok(step?.outputArtifactId);
  assert.equal((await repository.getArtifact(step.outputArtifactId))?.state, 'SEALED');
});

test('accepts an ambiguous succeeded readback using persisted JSON semantics', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let succeededWriteAttempts = 0;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo !== 1 || candidate.state !== 'succeeded') {
      await originalRecordExecutionStep(candidate);
      return;
    }
    succeededWriteAttempts += 1;
    candidate.toolProvenance = {
      ...candidate.toolProvenance,
      transientReceipt: undefined,
    };
    if (succeededWriteAttempts === 1) await originalRecordExecutionStep(candidate);
    throw new Error('simulated ambiguous succeeded response');
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  assert.equal(succeededWriteAttempts, 2);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'succeeded');
  assert.equal(Object.hasOwn(step?.toolProvenance ?? {}, 'transientReceipt'), false);
  assert.ok(step?.outputArtifactId);
  assert.equal((await repository.getArtifact(step.outputArtifactId))?.state, 'SEALED');
});

test('keeps a committed succeeded Artifact when the retry loses the real lease', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let succeededWriteAttempts = 0;
  let retryLostLease = false;
  let artifactId: string | undefined;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo !== 1 || candidate.state !== 'succeeded') {
      await originalRecordExecutionStep(candidate);
      return;
    }
    succeededWriteAttempts += 1;
    artifactId = candidate.outputArtifactId;
    if (succeededWriteAttempts === 1) {
      await originalRecordExecutionStep(candidate);
      await ageLeasePastExpiry(lease);
      throw new Error('simulated committed response loss');
    }
    try {
      await originalRecordExecutionStep(candidate);
    } catch (error) {
      retryLostLease = error instanceof ControlPlaneConflictError;
      throw error;
    }
  };

  let executionError: unknown;
  try {
    await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new CountingRealLLM(),
    ).execute({ lease, expectedModel: 'pinned-model' });
  } catch (error) {
    executionError = error;
  }

  if (executionError !== undefined) assert.ok(executionError instanceof ControlPlaneConflictError);
  assert.equal(succeededWriteAttempts, 2);
  assert.equal(retryLostLease, true);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'succeeded');
  assert.equal(step?.outputArtifactId, artifactId);
  assert.ok(artifactId);
  assert.equal((await repository.getArtifact(artifactId))?.state, 'SEALED');
});

test('records lease loss when an uncommitted succeeded retry meets a real expiry', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const originalRecordExecutionStep = repository.recordExecutionStep.bind(repository);
  let succeededWriteAttempts = 0;
  let artifactId: string | undefined;
  repository.recordExecutionStep = async (candidate) => {
    if (candidate.stepNo !== 1 || candidate.state !== 'succeeded') {
      await originalRecordExecutionStep(candidate);
      return;
    }
    succeededWriteAttempts += 1;
    artifactId = candidate.outputArtifactId;
    if (succeededWriteAttempts === 1) {
      await ageLeasePastExpiry(lease);
      throw new Error('simulated uncommitted response failure');
    }
    await originalRecordExecutionStep(candidate);
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(succeededWriteAttempts, 2);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.state, 'failed');
  assert.equal(step?.failure?.kind, 'lease_lost');
  assert.ok(artifactId);
  assert.equal((await repository.getArtifact(artifactId))?.state, 'FAILED');
});

test('inserts a failed step when the lease expires during checkpoint reseal before a running row', async () => {
  const first = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
  );
  const firstResult = await buildEngine(
    first.repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease: first.lease, expectedModel: 'pinned-model' });
  assert.equal(firstResult.status, 'completed');

  const completedTask = await first.repository.getTaskDetail(first.lease.taskId);
  assert.ok(completedTask);
  const readyTask = await first.repository.transitionTask({
    taskId: first.lease.taskId,
    expectedVersion: completedTask.stateVersion,
    from: 'completed',
    to: 'ready',
  });
  const retryToken = randomUUID();
  const retryOwner = 'checkpoint-retry-worker';
  const retryClaim = await first.repository.claimExecution({
    taskId: first.lease.taskId,
    planVersionId: first.lease.planVersionId,
    expectedVersion: readyTask.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: retryOwner,
    leaseTokenHash: leaseHash(retryToken),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    retryOf: first.lease.attemptId,
  });
  const retryLease: ControlExecutionLease = {
    taskId: first.lease.taskId,
    planVersionId: first.lease.planVersionId,
    attemptId: retryClaim.attemptId,
    leaseOwner: retryOwner,
    leaseToken: retryToken,
    retryOf: first.lease.attemptId,
  };
  const originalSealArtifact = first.repository.sealArtifact.bind(first.repository);
  const originalRecordExecutionStep = first.repository.recordExecutionStep.bind(first.repository);
  const regularRetryStates: string[] = [];
  let expiredDuringReseal = false;
  first.repository.recordExecutionStep = async (candidate) => {
    if (candidate.attemptId === retryLease.attemptId && candidate.stepNo === 1) {
      regularRetryStates.push(candidate.state);
    }
    await originalRecordExecutionStep(candidate);
  };
  first.repository.sealArtifact = async (candidate) => {
    if (candidate.attemptId === retryLease.attemptId && !expiredDuringReseal) {
      expiredDuringReseal = true;
      await ageLeasePastExpiry(retryLease);
    }
    return originalSealArtifact(candidate);
  };

  const result = await buildEngine(
    first.repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease: retryLease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(expiredDuringReseal, true);
  assert.deepEqual(regularRetryStates, ['failed']);
  const [failedStep] = await first.repository.listExecutionSteps(retryLease.attemptId);
  assert.equal(failedStep?.state, 'failed');
  assert.equal(failedStep?.actorId, planSteps[0]!.actor_id);
  assert.equal(failedStep?.failure?.kind, 'lease_lost');
  const retryArtifacts = await first.repository.listArtifactsForAttempt(retryLease);
  assert.deepEqual(retryArtifacts.map(({ kind, state }) => ({ kind, state })), [
    { kind: 'tool_output', state: 'FAILED' },
  ]);
  assert.equal((await first.repository.getTaskDetail(retryLease.taskId))?.state, 'paused');
  assert.equal(
    (await first.repository.listAttempts(retryLease.taskId))
      .find(({ id }) => id === retryLease.attemptId)?.state,
    'paused',
  );
});

test('orders parallel outputs by step number regardless of completion timing', async () => {
  const steps: CurrentPlanStep[] = [
    planSteps[0]!,
    ...[2, 3].map((stepNo): CurrentPlanStep => ({
      ...planSteps[2]!,
      step_no: stepNo,
      step_name: `并行摘要 ${stepNo}`,
      depends_on: [1],
    })),
    {
      ...planSteps[2]!,
      step_no: 4,
      step_name: '合并摘要',
      depends_on: [2, 3],
    },
  ];
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), steps);
  const llm = new ReverseCompletionLLM();
  const deliverables = new RecordingDeliverablesFake();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    llm,
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  const mergedContext = llm.contexts.find((context) => {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
    const priorOutputs = (context as Record<string, unknown>).prior_outputs;
    return Array.isArray(priorOutputs) && priorOutputs.length === 2;
  });
  assertUnknownRecord(mergedContext);
  assert.deepEqual(
    (mergedContext.prior_outputs as Array<{ stepNo: number }>).map(({ stepNo }) => stepNo),
    [2, 3],
  );
  assert.deepEqual(
    (deliverables.calls[0]?.outputs as Array<{ stepNo: number }> | undefined)?.map(({ stepNo }) => stepNo),
    [1, 2, 3, 4],
  );
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
    const skillArtifactId = steps[1]?.skillProvenance?.outputArtifactId;
    assert.equal(typeof skillArtifactId, 'string');
    for (const entry of evidence.entries) {
      assertUnknownRecord(entry);
      assert.equal(entry.kind, 'tool_output');
      assert.notEqual(entry.artifactId, skillArtifactId);
    }
    const evidenceEntry = evidence.entries[0];
    assertUnknownRecord(evidenceEntry);
    const toolProvenance = steps[0]?.toolProvenance ?? {};
    assert.equal(toolProvenance.toolTier, 'core');
    assert.ok(Array.isArray(toolProvenance.attemptReceipts));
    assert.equal(toolProvenance.attemptReceipts.length, 1);
    assert.equal(toolProvenance.attemptReceipts[0]?.status, 'succeeded');
    const toolProof = evidenceEntry.toolProof;
    assertUnknownRecord(toolProof);
    assert.equal(evidenceEntry.toolTier, 'core');
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
    assert.equal(schemaVersions.skill_output, 'skill-output-v2');
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
  assert.match(String(skillProvenance.payloadSchemaHash), /^sha256:/u);
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
  const annotation = await new ImageAnnotationService({ assets: visualAssets, artifacts: store }).annotate({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    original: {
      assetId: verifiedImage.artifact.id,
      manifestArtifactId: verifiedImage.manifestArtifact.id,
    },
    findingIds: ['F1'],
    annotations: [{
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      findingId: 'F1',
      label: 'Verified production wiring',
      severity: 'low',
    }],
    exportPolicy: 'allow',
  });
  const verifiedAnnotation = await visualAssets.readVerified({
    assetId: annotation.derived.assetArtifact.id,
    manifestArtifactId: annotation.derived.manifestArtifact.id,
  });
  assert.deepEqual(verifiedAnnotation.manifest.derivedFrom, {
    assetId: verifiedImage.artifact.id,
    manifestArtifactId: verifiedImage.manifestArtifact.id,
    contentSha256: verifiedImage.manifest.contentSha256,
    manifestHash: verifiedImage.manifest.manifestHash,
  });
  assert.deepEqual(verifiedAnnotation.manifest.derivation, {
    kind: 'annotation',
    overlayArtifactId: annotation.overlayArtifact.id,
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
    const payload = value.payload as {
      competitorSamples: Array<{ evidenceIds: string[] }>;
      dimensionMatrix: Array<{ values: Array<{ evidenceIds: string[] }> }>;
      differences: Array<{ evidenceIds: string[] }>;
      screenshotComparisons: Array<{
        id: string;
        dimension: string;
        sampleIds: string[];
        assetIds: string[];
        caption: string;
      }>;
    };
    payload.screenshotComparisons = [{
      id: 'screenshot-production-wiring',
      dimension: 'verified visual comparison',
      sampleIds: ['sample-a'],
      assetIds: [verifiedImage.artifact.id, verifiedAnnotation.artifact.id],
      caption: 'Verified source image and derived annotation comparison',
    }];
    const evidenceId = input.evidenceManifest.value.entries[0]?.id;
    assert.ok(evidenceId);
    payload.competitorSamples[0]!.evidenceIds = [evidenceId];
    payload.dimensionMatrix[0]!.values[0]!.evidenceIds = [evidenceId];
    payload.differences[0]!.evidenceIds = [evidenceId];
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
    structuredClone(verifiedAnnotation.manifest),
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
  }, {
    assetId: verifiedAnnotation.artifact.id,
    manifestArtifactId: verifiedAnnotation.manifestArtifact.id,
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
        [
          { assetId: verifiedImage.artifact.id, manifestArtifactId: verifiedImage.manifestArtifact.id },
          { assetId: verifiedAnnotation.artifact.id, manifestArtifactId: verifiedAnnotation.manifestArtifact.id },
        ],
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

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(compositionCalls, 1);
  const reportDocumentArtifact = await repository.findSealedArtifact({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    kind: 'report_document',
  });
  assert.ok(reportDocumentArtifact);
  assert.equal(reportDocumentArtifact.state, 'SEALED');
  assert.equal(reportDocumentArtifact.schemaVersion, 'report-document-v1');
  assert.ok(result.reportPackageArtifactId);
  const sealedReportPackage = await new ReportPackageArtifactService(store).verify({
    artifactId: result.reportPackageArtifactId,
    attemptId: lease.attemptId,
  });
  assert.equal(sealedReportPackage.value.deliverableArtifactId, result.deliverableArtifactId);
  assert.equal(sealedReportPackage.value.evidenceManifestArtifactId, result.evidenceManifestArtifactId);
  assert.equal(sealedReportPackage.value.reportReviewArtifactId, result.reportReviewArtifactId);
  assert.equal(sealedReportPackage.value.reportDocumentArtifactId, reportDocumentArtifact.id);
  const storedDocument = await store.readVerifiedJson<ReportDocument>(reportDocumentArtifact.id);
  const documentBlocks = storedDocument.value.sections.flatMap(({ blocks }) => blocks);
  const imageComparison = documentBlocks.find((block) => (
    block.type === 'image-comparison'
    && block.beforeAssetRef.assetId === verifiedImage.artifact.id
    && block.afterAssetRef.assetId === verifiedAnnotation.artifact.id
  ));
  assert.ok(imageComparison?.type === 'image-comparison');
  assert.ok(documentBlocks.some(({ type }) => type === 'chart'));
  const standaloneImageIds = documentBlocks.flatMap((block) => (
    block.type === 'image' ? [block.assetRef.assetId] : []
  ));
  assert.equal(standaloneImageIds.includes(verifiedImage.artifact.id), false);
  assert.equal(standaloneImageIds.includes(verifiedAnnotation.artifact.id), false);

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
  assert.match(String(skillStep?.skillProvenance?.payloadSchemaHash), /^sha256:/u);
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
    const calls = await repository.listModelCalls(lease.attemptId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.status, 'failed');
    const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
    assert.equal(skillStep?.skillProvenance?.status, 'failed');
    assert.equal(skillStep?.skillProvenance?.modelReceiptId, calls[0]?.id);
    assert.equal(skillStep?.skillProvenance?.promptHash, calls[0]?.promptHash);
    assert.equal(skillStep?.skillProvenance?.traceId, calls[0]?.traceId);
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
    {
      deliverable_type: 'research_plan',
      evidence_requirements: [{
        id: 'research-plan',
        acceptedClasses: ['user_input', 'knowledge', 'public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
    {
      task_type: 'user_research_planning',
      research_goal: 'compare digital human products',
      expected_deliverables: ['research_plan'],
      success_criteria: [{ id: 'research-plan', statement: 'plan is evidence backed' }],
    },
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
  assert.equal(optionalAdapter.calls, 2);
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
      depends_on: [1],
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
test('persists only Tool attempt receipts when the final lease fence loses the lease', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const originalRequireActiveLease = repository.requireActiveLease.bind(repository);
  let requireCalls = 0;
  repository.requireActiveLease = async (candidate) => {
    requireCalls += 1;
    if (requireCalls === 6) await expireLease(repository, lease);
    return originalRequireActiveLease(candidate);
  };

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'lease_lost');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  const failedStep = steps.find((step) => step.state === 'failed');
  assert.ok(failedStep);
  assert.equal(failedStep.failure?.kind, 'lease_lost');
  const failure = failedStep.failure;
  assertUnknownRecord(failure);
  assertUnknownRecord(failure.retry);
  assert.ok(Array.isArray(failure.toolAttemptReceipts));
  assert.equal(failure.toolAttemptReceipts.length, 1);
  assert.ok(Array.isArray(failure.retry.attemptReceipts));
  assert.equal(failure.retry.attemptReceipts.length, 1);
  assert.equal(failure.actorResult, undefined);
  assert.doesNotMatch(JSON.stringify(failure), /actorResult|digital human competitors|verified public source|secret-value|secret-token|promptHash|Authorization/u);
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
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]],
    {
      deliverable_type: 'research_plan',
      evidence_requirements: [{
        id: 'research-plan',
        acceptedClasses: ['user_input', 'knowledge', 'public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
    {
      task_type: 'user_research_planning',
      research_goal: 'capture a research plan',
      expected_deliverables: ['research_plan'],
      success_criteria: [{ id: 'research-plan', statement: 'plan is evidence backed' }],
    },
  );
  const originalRoot = getConfigRoot();
  const missingRoot = mkdtempSync(join(tmpdir(), 'missing-config-root-'));

  const adapter = new ConfigBreakingAdapter(() => setConfigRoot(missingRoot));
  const stableSkillLoader = new SkillLoader();
  const tavilyTool = stableSkillLoader.getTool('tavily-web-search');
  assert.ok(tavilyTool);
  const cachedSkillLoader = {
    getTool(id: string) {
      return id === 'tavily-web-search' ? tavilyTool : stableSkillLoader.getTool(id);
    },
    getSkill(id: string) {
      return stableSkillLoader.getSkill(id);
    },
  } as SkillLoader;
  try {
    const result = await buildEngine(
      repository,
      new ToolRouter().register(adapter),
      new CountingRealLLM(),
      undefined,
      undefined,
      cachedSkillLoader,
    ).execute({ lease, expectedModel: 'pinned-model' });
    assert.equal(result.status, 'paused');
    assert.equal(result.failure?.kind, 'network');
    assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  } finally {
    setConfigRoot(originalRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
test('preserves all Tool attempt receipts when a transient failure is followed by schema-invalid output', async () => {
  const { repository, lease } = await claimedExecution(new Date(Date.now() + 60_000), [planSteps[0]]);
  const adapter = new TransientThenInvalidSchemaAdapter();
  const result = await buildEngine(
    repository,
    new ToolRouter().register(adapter),
    new CountingRealLLM(),
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'paused');
  assert.equal(result.failure?.kind, 'schema');
  assert.equal(adapter.calls, 2);
  const step = (await repository.listExecutionSteps(lease.attemptId))[0];
  assert.ok(step);
  assertUnknownRecord(step.failure);
  assertUnknownRecord(step.failure.retry);
  const terminalReceipts = step.failure.retry.attemptReceipts;
  assert.ok(Array.isArray(terminalReceipts));
  assert.equal(terminalReceipts.length, 2);
  assert.equal(terminalReceipts[0]?.status, 'failed');
  assert.equal(terminalReceipts[0]?.failure?.kind, 'network');
  assert.equal(terminalReceipts[1]?.status, 'succeeded');
  assertUnknownRecord(step.toolProvenance);
  const provenanceReceipts = step.toolProvenance.attemptReceipts;
  assert.ok(Array.isArray(provenanceReceipts));
  assert.equal(provenanceReceipts.length, 2);
  assert.equal(provenanceReceipts[0]?.status, 'failed');
  assert.equal(provenanceReceipts[0]?.failure?.kind, 'network');
  assert.equal(provenanceReceipts[1]?.status, 'succeeded');
  const attemptIds = provenanceReceipts.map((entry) => entry.attemptId);
  assert.equal(attemptIds.every((attemptId) => typeof attemptId === 'string' && attemptId.length > 0), true);
  assert.equal(new Set(attemptIds).size, attemptIds.length);
  const providerReceipts = provenanceReceipts.map((entry) => entry.receipt);
  assert.equal(providerReceipts.every((receipt) => typeof receipt?.attemptId === 'string' && receipt.attemptId.length > 0), true);
  assert.equal(new Set(providerReceipts.map((receipt) => receipt?.attemptId)).size, providerReceipts.length);
  assert.equal(providerReceipts.every((receipt) => receipt?.retryOf === undefined), true);
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

test('Skill provenance retains the contract hashes captured before the provider call', async () => {
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
    const skill = new SkillLoader().getSkill(planSteps[1]!.actor_id);
    assert.ok(skill?.input_schema);
    assert.ok(skill.output_schema);
    assert.ok(skill.payload_schema);
    const expectedSchemaHashes = {
      input: hashFile(skill.input_schema),
      output: hashFile(skill.output_schema),
      payload: hashFile(skill.payload_schema),
    };
    const { repository, lease } = await claimedExecution(
      new Date(Date.now() + 60_000),
      planSteps.slice(0, 2),
    );
    const result = await buildEngine(
      repository,
      new ToolRouter().register(new CountingRealTavilyAdapter()),
      new ConfigBreakingAfterSkillResultLLM(),
    ).execute({ lease, expectedModel: 'pinned-model' });

    assert.equal(result.status, 'completed');
    const calls = await repository.listModelCalls(lease.attemptId);
    assert.equal(calls.length, 1);
    const receipt = calls[0]!;
    assert.equal(receipt.stage, 'skill');
    const skillStep = (await repository.listExecutionSteps(lease.attemptId))[1];
    assert.equal(skillStep?.skillProvenance?.status, 'succeeded');
    assert.equal(skillStep?.skillProvenance?.inputSchemaHash, expectedSchemaHashes.input);
    assert.equal(skillStep?.skillProvenance?.outputSchemaHash, expectedSchemaHashes.output);
    assert.equal(skillStep?.skillProvenance?.payloadSchemaHash, expectedSchemaHashes.payload);
    assert.equal(skillStep?.skillProvenance?.modelReceiptId, receipt.id);
    assert.equal(skillStep?.skillProvenance?.promptHash, receipt.promptHash);
    assert.equal(skillStep?.skillProvenance?.traceId, receipt.traceId);
  } finally {
    setConfigRoot(originalRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test('one production Tool collector Manifest can satisfy every configured required Evidence Policy', async () => {
  const { repository, lease } = await claimedExecution(
    new Date(Date.now() + 60_000),
    [planSteps[0]!],
    {
      deliverable_type: 'competitive_analysis_report',
      evidence_requirements: [{
        id: 'collector-proof',
        acceptedClasses: ['public_source'],
        minimumCount: 1,
        required: true,
      }],
    },
    {
      version: 'research-task-v2',
      task_type: 'competitive_research',
      research_goal: 'Compare verified competitors',
      expected_deliverables: ['competitive_analysis_report'],
      success_criteria: [{ id: 'fixture-criterion', statement: 'comparison is evidence backed' }],
    },
  );
  const deliverables = new RecordingDeliverablesFake();

  const result = await buildEngine(
    repository,
    new ToolRouter().register(new CountingRealTavilyAdapter()),
    new CountingRealLLM(),
    deliverables,
  ).execute({ lease, expectedModel: 'pinned-model' });

  assert.equal(result.status, 'completed');
  const evidenceInput = deliverables.calls[0]?.evidenceManifest;
  assert.ok(evidenceInput);
  assert.equal(evidenceInput.artifact.state, 'SEALED');
  assert.equal(evidenceInput.value.taskId, lease.taskId);
  assert.equal(evidenceInput.value.planVersionId, lease.planVersionId);
  assert.equal(evidenceInput.value.attemptId, lease.attemptId);
  const manifestArtifact = await repository.getArtifact(evidenceInput.artifact.id);
  assert.equal(manifestArtifact?.state, 'SEALED');
  assert.equal(manifestArtifact?.taskId, lease.taskId);
  assert.equal(manifestArtifact?.planVersionId, lease.planVersionId);
  assert.equal(manifestArtifact?.attemptId, lease.attemptId);

  for (const policy of loadEvidencePolicy().policies) {
    const requiredRequirements = policy.requirements.filter(({ required }) => required);
    assert.ok(requiredRequirements.length > 0, `${policy.task_type}/${policy.deliverable_type} must require Evidence`);
    for (const requirement of requiredRequirements) {
      const actual = evidenceInput.value.entries.filter((entry) => (
        entry.toolTier === 'core' && requirement.accepted_classes.includes(entry.evidenceClass)
      )).length;
      assert.ok(
        actual >= requirement.minimum_count,
        `${policy.task_type}/${policy.deliverable_type}/${requirement.id} must be achievable by collector output`,
      );
    }
  }
});
