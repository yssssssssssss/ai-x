import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { afterEach, test } from 'node:test';
import type {
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  ResearchStrategyContentDraftV2,
  ResearchStrategyContentPatchV1,
  ResearchStrategyReportPayloadV2,
} from '../packages/api-contract/research-deliverable.ts';
import { REPORT_REVIEW_V2_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';
import { ArtifactNotSealedError, type ControlArtifact } from '../database/control-plane.ts';
import { ControlArtifactStore, type ArtifactWriteInput } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
  type FindingGraph,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { MaterializeInput, SynthesisMaterial } from '../apps/orchestrator-runtime/src/report/synthesis-materializer.ts';
import type { ReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import {
  ResearchStrategyDeliverableValidationError,
  type CurrentDeliverableGenerateInput,
} from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

type DeliverableEnvelope = ResearchDeliverableEnvelope<ResearchPlanPayload>;

type DeliverableDraft = Pick<
  DeliverableEnvelope,
  | 'methodSummary'
  | 'findingGraph'
  | 'payload'
  | 'recommendations'
  | 'capabilityProvenance'
> & {
  coverage: {
    questionBindings: Array<{ questionId: string; summaryIds: string[] }>;
    successCriterionBindings: Array<{
      successCriterionId: string;
      conclusionIds: string[];
      recommendationIds: string[];
    }>;
  };
  risksAndOpenIssues?: string[];
};

interface SealedEvidenceManifest {
  artifact: {
    id: string;
    contentSha256: string;
    state: 'SEALED';
  };
  value: EvidenceManifest;
}

interface DeliverableGenerateInput {
  task: { id: string };
  plan: CurrentDeliverableGenerateInput['plan'];
  attempt: { id: string };
  researchGoal: string;
  finalizedRequirement?: unknown;
  problemGraph?: unknown;
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
  outputs: unknown[];
  gaps: string[];
  gapRefs?: ReadonlyArray<{ key: string; stepNo: number }>;
  expectedModel: string;
}

interface DeliverableGenerateResult {
  deliverable: DeliverableEnvelope;
  deliverableArtifactId: string;
}

interface DeliverableRevisionInput extends DeliverableGenerateInput {
  review: ReportReviewArtifact;
  reviewArtifactId: string;
  currentDeliverable?: ResearchDeliverableEnvelope<unknown>;
}

interface CurrentDeliverableServiceLike {
  generate(input: DeliverableGenerateInput): Promise<DeliverableGenerateResult>;
  revise(input: DeliverableRevisionInput): Promise<DeliverableGenerateResult>;
}

interface ArtifactWriterLike {
  writeJson(input: ArtifactWriteInput): Promise<{ id: string }>;
}

interface RuntimeSchemaValidator {
  validateFileOrThrow(path: string, value: unknown): void;
  validateSchemaOrThrow(schema: object, value: unknown, label: string): void;
}

type CurrentDeliverableServiceConstructor = new (dependencies: {
  llm: LLMClient;
  validator: RuntimeSchemaValidator;
  evidence: EvidenceService;
  artifacts: ArtifactWriterLike;
  materializer?: { materialize(input: MaterializeInput): Promise<SynthesisMaterial[]> };
}) => CurrentDeliverableServiceLike;

interface CurrentDeliverableModule {
  CurrentDeliverableService: CurrentDeliverableServiceConstructor;
}

const deliverableModulePath: string =
  '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
const deliverableModuleFile = new URL(deliverableModulePath, import.meta.url);

async function loadCurrentDeliverableModule(): Promise<CurrentDeliverableModule> {
  assert.equal(
    existsSync(deliverableModuleFile),
    true,
    'CurrentDeliverableService module must exist',
  );
  // Test-boundary exception: keep the planned, currently absent module path non-literal
  // so the explicit existence assertion remains the RED instead of a type-check error.
  const moduleExports = await import(deliverableModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.CurrentDeliverableService, 'function');
  return moduleExports as unknown as CurrentDeliverableModule;
}
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const taskId = 'task-current-1';
const planVersionId = 'plan-version-current-1';
const attemptId = 'attempt-current-1';
const evidenceManifestArtifactId = 'artifact-evidence-manifest-1';
const evidenceArtifactId = 'artifact-tool-output-1';
const weightArtifactId = 'artifact-scoring-weight-1';
const deliverableArtifactId = 'artifact-deliverable-1';
const evidenceArtifactContentSha256 = `sha256:${'1'.repeat(64)}`;
const weightArtifactContentSha256 = `sha256:${'3'.repeat(64)}`;
const evidenceManifestContentSha256 = `sha256:${'2'.repeat(64)}`;
const resolvedEvidenceValue = { title: 'current source', url: 'https://example.test/products/current' };
const evidenceArtifactOutput = { results: [resolvedEvidenceValue] };
const weightArtifactValue = { weights: [{ percentage: 25 }] };
const redactedOutputHash = `sha256:${createHash('sha256').update(JSON.stringify(evidenceArtifactOutput)).digest('hex')}`;
const sourceUrl = resolvedEvidenceValue.url;
const resolverWrapperRawFixture = 'RAW_RESOLVER_WRAPPER_MUST_NOT_REACH_LLM';
const researchPlanSchemaPath = join(
  process.cwd(),
  'schemas/deliverables/research-plan.schema.json',
);

function validResearchPlanPayload(): ResearchPlanPayload {
  return {
    title: '宠物辅食竞品研究计划',
    researchGoal: '识别宠物辅食市场的主要竞品及其产品、价格与渠道差异',
    scope: {
      market: '中国大陆宠物辅食市场',
      subjects: ['犬用辅食', '猫用辅食'],
      timeWindow: '最近十二个月',
    },
    competitorSampling: {
      strategy: '按市场影响力与产品覆盖度分层抽样',
      targetCount: 6,
      inclusionCriteria: ['公开渠道可获取产品与品牌信息'],
      exclusionCriteria: ['已停止销售且无可核验公开资料'],
    },
    researchQuestions: ['主要竞品如何定位目标宠物与消费场景？'],
    comparisonDimensions: [{
      id: 'product-positioning',
      name: '产品定位',
      purpose: '比较各竞品的目标用户、宠物类型与核心卖点',
      collectionFields: ['目标宠物', '消费场景', '核心卖点'],
    }],
    sourcePlan: [{
      evidenceClass: 'public_source',
      sourceTypes: ['品牌官网', '电商商品页'],
      purpose: '核验产品信息、价格与品牌定位',
    }],
    executionPlan: [{
      phase: '竞品信息采集',
      activities: ['检索并记录入样品牌的公开资料'],
      duration: '2 个工作日',
      outputs: ['竞品信息采集表'],
    }],
    collectionTemplate: [{
      field: '核心卖点',
      description: '品牌对产品价值的公开表述',
      evidenceRequired: true,
    }],
    analysisMethods: ['横向维度对比'],
    deliverables: ['竞品研究报告'],
    qualityChecks: ['每项事实均关联可追溯公开来源'],
  };
}

function validFindingGraph(): FindingGraph {
  return {
    findings: [{
      id: 'F1',
      kind: 'fact',
      evidenceIds: ['E1'],
      statement: '公开产品页支持该竞品定位事实',
    }],
    analyses: [{
      id: 'A1',
      findingIds: ['F1'],
      statement: '基于公开事实进行横向分析',
    }],
    subQuestionSummaries: [{
      id: 'S1',
      findingIds: ['F1'],
      analysisIds: ['A1'],
      summary: '公开资料支持产品定位比较',
    }],
    overallConclusions: [{
      id: 'C1',
      summaryIds: ['S1'],
      statement: '产品定位应作为核心比较维度',
    }],
  };
}

function validDeliverableDraft(): DeliverableDraft {
  return {
    methodSummary: '检索公开产品页并按预设维度归纳证据',
    findingGraph: validFindingGraph(),
    payload: validResearchPlanPayload(),
    recommendations: [{
      id: 'R1',
      summaryIds: ['S1'],
      statement: '按产品定位维度继续采集可追溯公开信息',
    }],
    coverage: {
      questionBindings: [{ questionId: 'q1', summaryIds: ['S1'] }],
      successCriterionBindings: [{
        successCriterionId: 'criterion1',
        conclusionIds: ['C1'],
        recommendationIds: ['R1'],
      }],
    },
    risksAndOpenIssues: ['公开页面内容可能随时间变化'],
    capabilityProvenance: [{ id: 'pinned-model', type: 'llm' }],
  };
}

class StaticDeliverableLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'fixture',
    endpointHost: 'fixture.test',
    requestedModel: 'pinned-model',
    mode: 'mock',
    eligibleAsReal: false,
  };
  readonly structuredCalls: StructuredLLMCallOptions[] = [];
  private callIndex = 0;

  constructor(private readonly draft: unknown | unknown[]) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.structuredCalls.push(options);
    const drafts = Array.isArray(this.draft) ? this.draft : [this.draft];
    const data = drafts[Math.min(this.callIndex, drafts.length - 1)];
    this.callIndex += 1;
    return {
      data: data as T,
      promptHash: 'sha256:deliverable-prompt',
      modelName: 'pinned-model',
      modelVersion: 'fixture-v1',
      traceId: 'trace_deliverable_fixture',
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('CurrentDeliverableService must use structured generation');
  }
}

interface SchemaValidationCall {
  schema: object;
  value: unknown;
  label: string;
}

class RecordingSchemaValidator implements RuntimeSchemaValidator {
  readonly schemaCalls: SchemaValidationCall[] = [];
  private readonly delegate = new SchemaValidator();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  validateFileOrThrow(path: string, value: unknown): void {
    this.delegate.validateFileOrThrow(path, value);
  }

  validateSchemaOrThrow(schema: object, value: unknown, label: string): void {
    this.schemaCalls.push({ schema, value, label });
    const validate = this.ajv.compile(schema);
    if (validate(value)) return;
    throw new SchemaValidationError(
      label,
      (validate.errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'invalid'}`),
    );
  }
}
class MemoryArtifactRegistry {
  readonly artifacts = new Map<string, ControlArtifact>();

  async createStagingArtifact(input: {
    taskId: string;
    planVersionId?: string;
    attemptId?: string;
    kind: string;
    storageUri: string;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
  }): Promise<ControlArtifact> {
    const artifact: ControlArtifact = {
      id: randomUUID(),
      taskId: input.taskId,
      planVersionId: input.planVersionId ?? null,
      attemptId: input.attemptId ?? null,
      kind: input.kind,
      state: 'STAGING',
      storageUri: input.storageUri,
      contentSha256: null,
      byteSize: null,
      schemaVersion: input.schemaVersion,
      sensitivity: input.sensitivity,
      redactionPolicyVersion: input.redactionPolicyVersion,
      failureReason: null,
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  }): Promise<ControlArtifact> {
    const current = this.artifacts.get(input.artifactId);
    if (!current) throw new Error('missing staging artifact');
    const sealed: ControlArtifact = {
      ...current,
      state: 'SEALED',
      contentSha256: input.contentSha256,
      byteSize: input.byteSize,
    };
    this.artifacts.set(sealed.id, sealed);
    return sealed;
  }

  async failArtifact(artifactId: string, failureReason: string): Promise<void> {
    const current = this.artifacts.get(artifactId);
    if (!current) throw new Error('missing staging artifact');
    this.artifacts.set(artifactId, { ...current, state: 'FAILED', failureReason });
  }

  async invalidateArtifactPublication(artifactId: string, failureReason: string): Promise<void> {
    await this.failArtifact(artifactId, failureReason);
  }

  async quarantineStagingArtifact(): Promise<ControlArtifact | null> {
    return null;
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listArtifactsByStorageUri(storageUri: string): Promise<ControlArtifact[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.storageUri === storageUri);
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.state === 'STAGING');
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return artifact;
  }

  async requireSealedArtifactBinding(artifactId: string): Promise<ControlArtifact> {
    return this.requireSealedArtifact(artifactId);
  }
}

function sealedEvidence(): {
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
} {
  const evidence = new EvidenceService();
  const evidenceResolver: EvidenceArtifactResolver = {
    resolveArtifact: (candidateId) => {
      if (candidateId === evidenceArtifactId) return {
          artifact: {
            id: evidenceArtifactId,
            contentSha256: evidenceArtifactContentSha256,
          },
          value: {
            output: evidenceArtifactOutput,
            redactedOutputHash,
            raw: resolverWrapperRawFixture,
          },
        };
      if (candidateId === weightArtifactId) return {
        artifact: {
          id: weightArtifactId,
          contentSha256: weightArtifactContentSha256,
        },
        value: weightArtifactValue,
      };
      return null;
    },
  };
  const value = evidence.createManifest({
    taskId,
    planVersionId,
    attemptId,
    collectedAt: '2026-08-11T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      artifactId: evidenceArtifactId,
      artifactContentSha256: evidenceArtifactContentSha256,
      jsonPointer: '/output/results/0',
      sourceUrl,
      stepNo: 1,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash,
      },
      sensitivity: 'public',
      redaction: 'masked',
    }, {
      id: 'W-1',
      kind: 'user_constraint',
      evidenceClass: 'user_input',
      artifactId: weightArtifactId,
      artifactContentSha256: weightArtifactContentSha256,
      jsonPointer: '/weights/0/percentage',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, evidenceResolver);

  return {
    evidenceManifest: {
      artifact: {
        id: evidenceManifestArtifactId,
        contentSha256: evidenceManifestContentSha256,
        state: 'SEALED',
      },
      value,
    },
    evidenceResolver,
  };
}

function generateInput(overrides: Partial<DeliverableGenerateInput> = {}): DeliverableGenerateInput {
  const evidence = sealedEvidence();
  return {
    task: { id: taskId },
    plan: {
      id: planVersionId,
      plan: { deliverable_type: 'research_plan' },
    },
    attempt: { id: attemptId },
    researchGoal: '形成可信的宠物辅食竞品研究计划',
    finalizedRequirement: {
      version: 'research-task-v2',
      task_type: 'user_research_planning',
      expected_deliverables: ['research_plan'],
      success_criteria: [{ id: 'criterion1', statement: '结论可追溯' }],
    },
    problemGraph: {
      version: 'problem-graph-v1',
      questions: [{ id: 'q1', priority: 'required' }],
    },
    evidenceManifest: evidence.evidenceManifest,
    evidenceResolver: evidence.evidenceResolver,
    outputs: [{ actorId: 'tavily', output: { summary: '公开来源采集完成' } }],
    gaps: [],
    expectedModel: 'pinned-model',
    ...overrides,
  };
}

async function createHarness(
  draft: unknown = validDeliverableDraft(),
  materializer?: { materialize(input: MaterializeInput): Promise<SynthesisMaterial[]> },
  artifactWriter?: ArtifactWriterLike,
): Promise<{
  service: CurrentDeliverableServiceLike;
  validator: RecordingSchemaValidator;
  llm: StaticDeliverableLLM;
  writes: ArtifactWriteInput[];
}> {
  const { CurrentDeliverableService } = await loadCurrentDeliverableModule();
  const writes: ArtifactWriteInput[] = [];
  const artifacts: ArtifactWriterLike = artifactWriter ?? {
    async writeJson(input) {
      writes.push(input);
      return { id: deliverableArtifactId };
    },
  };
  const validator = new RecordingSchemaValidator();
  const llm = new StaticDeliverableLLM(draft);
  return {
    service: new CurrentDeliverableService({
      llm,
      validator,
      evidence: new EvidenceService(),
      artifacts,
      materializer,
    }),
    validator,
    llm,
    writes,
  };
}

test('generates and seals a machine-owned research plan deliverable envelope', async () => {
  const { service, validator, llm, writes } = await createHarness();

  const result = await service.generate(generateInput());

  const modelContext = llm.structuredCalls[0]?.context as {
    finalizedRequirement?: unknown;
    problemGraph?: unknown;
    coverageRequirements?: {
      requiredQuestionIds: string[];
      successCriterionIds: string[];
    };
    verifiedEvidence?: Array<{
      evidenceId: string;
      evidenceClass: string;
      sourceUrl?: string;
      value: unknown;
    }>;
  };
  assert.deepEqual(modelContext.verifiedEvidence, [{
    evidenceId: 'E1',
    evidenceClass: 'public_source',
    sourceUrl,
    value: resolvedEvidenceValue,
  }, {
    evidenceId: 'W-1',
    evidenceClass: 'user_input',
    value: 25,
  }]);
  const verifiedEvidenceText = JSON.stringify(modelContext.verifiedEvidence);
  const fullModelContextText = JSON.stringify(modelContext);
  assert.equal(verifiedEvidenceText.includes('output'), false);
  assert.equal(verifiedEvidenceText.includes('redactedOutputHash'), false);
  assert.equal(verifiedEvidenceText.includes(resolverWrapperRawFixture), false);
  assert.equal(fullModelContextText.includes('redactedOutputHash'), false);
  assert.equal(fullModelContextText.includes(resolverWrapperRawFixture), false);
  assert.deepEqual(modelContext.finalizedRequirement, generateInput().finalizedRequirement);
  assert.deepEqual(modelContext.problemGraph, generateInput().problemGraph);
  assert.deepEqual(modelContext.coverageRequirements, {
    requiredQuestionIds: ['q1'],
    successCriterionIds: ['criterion1'],
  });
  assert.match(llm.structuredCalls[0]?.prompt ?? '', /coverage|binding/i);
  assert.match(
    llm.structuredCalls[0]?.prompt ?? '',
    /evidenceIds.*verifiedEvidence.*Visual Asset/is,
  );
  assert.match(
    llm.structuredCalls[0]?.prompt ?? '',
    /findingGraph.*fact.*public_source.*screenshot.*dataset.*user_input.*cannot/is,
  );
  assert.equal(validator.schemaCalls.length, 1);
  assert.equal(validator.schemaCalls[0]?.label, 'research-plan-deliverable-content');

  assert.equal(result.deliverable.version, 'research-deliverable-v1');
  assert.equal(result.deliverable.taskId, taskId);
  assert.equal(result.deliverable.planVersionId, planVersionId);
  assert.equal(result.deliverable.attemptId, attemptId);
  assert.equal(result.deliverable.deliverableType, 'research_plan');
  assert.equal(result.deliverable.evidenceManifestArtifactId, evidenceManifestArtifactId);
  assert.deepEqual(result.deliverable.coverage, validDeliverableDraft().coverage);
  assert.doesNotThrow(() => validator.validateFileOrThrow(
    researchPlanSchemaPath,
    result.deliverable.payload,
  ));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.relativePath, 'deliverables/final-r0.json');
  assert.equal(writes[0]?.kind, 'deliverable');
  assert.equal(writes[0]?.schemaVersion, 'research-deliverable-v1-review-gated');
  assert.deepEqual(writes[0]?.value, result.deliverable);
  assert.equal(result.deliverableArtifactId, deliverableArtifactId);
});

test('retries deliverable generation once with schema validation feedback', async () => {
  const invalidShape = { title: 'wrong top-level shape' };
  const invalidEvidence = validDeliverableDraft();
  invalidEvidence.findingGraph.subQuestionSummaries[0]!.findingIds = [];
  invalidEvidence.findingGraph.subQuestionSummaries[0]!.analysisIds = [];
  const valid = validDeliverableDraft();
  const { service, llm } = await createHarness([invalidShape, invalidEvidence, valid]);

  const result = await service.generate(generateInput());

  assert.ok(result.deliverableArtifactId);
  assert.equal(llm.structuredCalls.length, 3);
  assert.match(
    JSON.stringify(llm.structuredCalls[1]?.context),
    /validationFeedback.*complete deliverable draft.*methodSummary.*findingGraph.*payload/,
  );
  assert.match(JSON.stringify(llm.structuredCalls[2]?.context), /validationFeedback.*no roots/);
});

test('retries strict deliverable generation when required coverage bindings are incomplete', async () => {
  const incomplete = validDeliverableDraft();
  const complete = structuredClone(incomplete);
  complete.coverage.questionBindings.push({ questionId: 'q2', summaryIds: ['S1'] });
  complete.coverage.successCriterionBindings.push({
    successCriterionId: 'criterion2',
    conclusionIds: ['C1'],
    recommendationIds: ['R1'],
  });
  const { service, llm } = await createHarness([incomplete, complete]);

  const result = await service.generate(generateInput({
    finalizedRequirement: {
      version: 'research-task-v2',
      task_type: 'user_research_planning',
      expected_deliverables: ['research_plan'],
      success_criteria: [
        { id: 'criterion1', statement: '结论可追溯' },
        { id: 'criterion2', statement: '建议覆盖完整' },
      ],
    },
    problemGraph: {
      version: 'problem-graph-v1',
      questions: [
        { id: 'q1', priority: 'required' },
        { id: 'q2', priority: 'required' },
      ],
    },
  }));

  assert.equal(llm.structuredCalls.length, 2);
  assert.match(
    JSON.stringify(llm.structuredCalls[1]?.context),
    /validationFeedback.*missing required question q2.*missing success criterion criterion2/,
  );
  assert.deepEqual(result.deliverable.coverage, complete.coverage);
});

test('drops undeclared payload root fields before strict validation and sealing', async () => {
  const draft = validDeliverableDraft();
  Object.assign(draft.payload, { unexpectedPayloadField: 'must not be sealed' });
  const { service } = await createHarness(draft);

  const result = await service.generate(generateInput());

  assert.equal('unexpectedPayloadField' in result.deliverable.payload, false);
});

test('unwraps a nested object only when it contains every required deliverable draft field', async () => {
  const wrapped = { result: { content: validDeliverableDraft() }, explanation: 'model wrapper' };
  const { service } = await createHarness(wrapped);

  const result = await service.generate(generateInput());

  assert.equal(result.deliverable.methodSummary, validDeliverableDraft().methodSummary);
});

for (const wrapped of [
  { label: 'an array', value: { result: [{ content: validDeliverableDraft() }] } },
  { label: 'a JSON string', value: { result: JSON.stringify(validDeliverableDraft()) } },
]) {
  test(`unwraps a deliverable draft nested in ${wrapped.label}`, async () => {
    const { service } = await createHarness(wrapped.value);

    const result = await service.generate(generateInput());

    assert.equal(result.deliverable.methodSummary, validDeliverableDraft().methodSummary);
  });
}

test('retries competitive synthesis when the canonical case universe or matrix scores are lost', async () => {
  const valid = {
    ...validDeliverableDraft(),
    payload: {
      competitorSamples: [
        { id: 'C01', name: 'Case one', rationale: 'Primary case', evidenceIds: ['E1'] },
        { id: 'C02', name: 'Case two', rationale: 'Secondary case', evidenceIds: ['E1'] },
      ],
      dimensionMatrix: [{
        dimension: '定位清晰度',
        weight: 1,
        values: [
          { sampleId: 'C01', value: '清晰', score: 4, evidenceIds: ['E1'] },
          { sampleId: 'C02', value: '清晰', score: 5, evidenceIds: ['E1'] },
        ],
      }],
      differences: [{ id: 'D1', dimension: '定位清晰度', statement: 'Case two is clearer', evidenceIds: ['E1'] }],
      impacts: [{ differenceId: 'D1', audience: '设计团队', statement: 'Provides a clearer reference' }],
      actionRecommendations: [{ id: 'R2', differenceIds: ['D1'], priority: 'P1', statement: 'Validate the clearer pattern' }],
      visualEvidence: [],
      screenshotComparisons: [],
    },
  };
  const invalid = structuredClone(valid) as typeof valid;
  invalid.payload.competitorSamples[0]!.id = 'S01';
  invalid.payload.dimensionMatrix[0]!.values[0] = {
    sampleId: 'S01',
    value: '清晰',
    score: 4,
    evidenceIds: ['E1'],
  };
  delete (invalid.payload.dimensionMatrix[0]!.values[0] as unknown as Record<string, unknown>).score;
  const materializer = {
    async materialize(_input: MaterializeInput): Promise<SynthesisMaterial[]> {
      return [{
        stepNo: 7,
        actorType: 'skill',
        actorId: 'competitive-web-research',
        questionIds: ['q1'],
        artifactId: 'artifact-step-7',
        artifactContentSha256: 'sha256:step-seven',
        value: {
          payload: {
            case_universe: [{ case_id: 'C01' }, { case_id: 'C02' }],
            scoring_system: { weights_ordered: [{ dimension: '定位清晰度', weight: 1 }] },
          },
        },
        semanticRole: 'analysis',
      }];
    },
  };
  const { service, llm } = await createHarness(
    [invalid, valid],
    materializer,
  );
  const result = await service.generate(generateInput({
    plan: {
      id: planVersionId,
      plan: {
        deliverable_type: 'competitive_analysis_report',
        capability_decisions: {
          eligible: [{ optional_tool_decisions: [{
            tool_id: 'playwright-page-capture',
            status: 'unavailable',
            reason_code: 'optional_tool_real_adapter_unavailable',
          }] }],
        },
        steps: [],
      },
    },
    finalizedRequirement: {
      version: 'research-task-v2',
      task_type: 'competitive_research',
      expected_deliverables: ['competitive_analysis_report'],
      success_criteria: [{ id: 'criterion1', statement: '矩阵完整' }],
    },
    problemGraph: { version: 'problem-graph-v1', questions: [{ id: 'q1', priority: 'required' }] },
    gaps: ['optional browser capture is unavailable'],
    gapRefs: [{
      key: 'capability:playwright-page-capture:optional_tool_real_adapter_unavailable',
      stepNo: 0,
    }],
  }));

  assert.equal(llm.structuredCalls.length, 2);
  assert.match(
    JSON.stringify(llm.structuredCalls[1]?.context),
    /canonical.*C01.*C02|matrix.*score/isu,
  );
  assert.deepEqual(
    (result.deliverable.payload as unknown as { competitorSamples: Array<{ id: string }> }).competitorSamples
      .map(({ id }) => id),
    ['C01', 'C02'],
  );
});

test('legacy task_type-only generation falls back to the persisted plan deliverable id', async () => {
  const { service, llm, writes } = await createHarness();

  const result = await service.generate(generateInput({
    plan: {
      id: planVersionId,
      plan: { deliverable_type: 'research_plan' },
    },
    finalizedRequirement: {
      task_type: 'competitive_research',
      success_criteria: [{ id: 'criterion1', statement: '结论可追溯' }],
    },
  }));

  assert.equal(result.deliverable.deliverableType, 'research_plan');
  assert.equal(llm.structuredCalls.length, 1);
  const context = llm.structuredCalls[0]?.context as {
    deliverableContract?: { id?: string };
  };
  assert.equal(context.deliverableContract?.id, 'research_plan');
  assert.equal(writes.length, 1);
});

test('research-task-v2 without expected_deliverables remains rejected by deliverable selection', async () => {
  const { service, llm, writes } = await createHarness();

  await assert.rejects(
    () => service.generate(generateInput({
      finalizedRequirement: {
        version: 'research-task-v2',
        task_type: 'competitive_research',
      },
    })),
    /expected_deliverables are required/,
  );
  assert.equal(llm.structuredCalls.length, 0);
  assert.equal(writes.length, 0);
});

test('research-task-v2 without task_type remains rejected by deliverable selection', async () => {
  const { service, llm, writes } = await createHarness();

  await assert.rejects(
    () => service.generate(generateInput({
      finalizedRequirement: {
        version: 'research-task-v2',
        expected_deliverables: ['research_plan'],
      },
    })),
    /task_type is required/,
  );
  assert.equal(llm.structuredCalls.length, 0);
  assert.equal(writes.length, 0);
});
test('writes round 0 and revised round 1 deliverables to distinct immutable paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'current-deliverable-rounds-'));
  tempDirs.push(root);
  const registry = new MemoryArtifactRegistry();
  const store = new ControlArtifactStore({ root, registry });
  const { service } = await createHarness(validDeliverableDraft(), undefined, store);

  const round0 = await service.generate(generateInput());
  const round0Artifact = await registry.requireSealedArtifact(round0.deliverableArtifactId);
  const round0Value = (await store.readVerifiedJson<DeliverableEnvelope>(round0.deliverableArtifactId)).value;

  const round1 = await service.revise({
    ...generateInput(),
    review: {
      version: 'report-review-v1',
      taskId,
      planVersionId,
      attemptId,
      deliverableArtifactId: round0.deliverableArtifactId,
      verdict: 'revise',
      dimensions: [
        { id: 'requirement_coverage', passed: true, issues: [] },
        { id: 'question_coverage', passed: true, issues: [] },
        { id: 'evidence_coverage', passed: true, issues: [] },
        { id: 'reasoning_quality', passed: false, issues: ['strengthen reasoning'] },
        { id: 'recommendation_quality', passed: true, issues: [] },
        { id: 'visual_quality', passed: true, issues: [] },
        { id: 'risk_disclosure', passed: true, issues: [] },
      ],
      revisionRound: 0,
    },
    reviewArtifactId: 'review-r0',
  });
  const round1Artifact = await registry.requireSealedArtifact(round1.deliverableArtifactId);
  assert.match(round0Artifact.storageUri, /deliverables\/final-r0\.json$/u);
  assert.notEqual(round1.deliverableArtifactId, round0.deliverableArtifactId);
  assert.notEqual(round1Artifact.storageUri, round0Artifact.storageUri);
  assert.match(round1Artifact.storageUri, /deliverables\/final-r1\.json$/u);
  assert.deepEqual(
    (await store.readVerifiedJson<DeliverableEnvelope>(round0.deliverableArtifactId)).value,
    round0Value,
  );

  await assert.rejects(() => store.writeJson({
    taskId,
    planVersionId,
    attemptId,
    kind: 'deliverable',
    relativePath: 'deliverables/final-r0.json',
    schemaVersion: 'research-deliverable-v1-review-gated',
    value: { overwritten: true },
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST');
  assert.deepEqual(
    (await store.readVerifiedJson<DeliverableEnvelope>(round0.deliverableArtifactId)).value,
    round0Value,
  );
});
test('changes synthesis content when verified Skill or Reviewer material changes', async () => {
  const material = (text: string): SynthesisMaterial[] => [{
    stepNo: 2,
    actorType: 'skill',
    actorId: 'analyst',
    questionIds: ['q1'],
    artifactId: 'artifact-skill',
    artifactContentSha256: `sha256:${text}`,
    value: { analysis: text },
    semanticRole: 'analysis',
  }, {
    stepNo: 3,
    actorType: 'reviewer',
    actorId: 'review',
    questionIds: ['q1'],
    artifactId: 'artifact-reviewer',
    artifactContentSha256: `sha256:review-${text}`,
    value: { review: text },
    semanticRole: 'review',
  }];
  const firstHarness = await createHarness(validDeliverableDraft(), {
    async materialize(_input) { return material('first'); },
  });
  await firstHarness.service.generate(generateInput());
  const firstContext = JSON.stringify(firstHarness.llm.structuredCalls[0]?.context);
  const secondHarness = await createHarness(validDeliverableDraft(), {
    async materialize(_input) { return material('second'); },
  });
  await secondHarness.service.generate(generateInput());
  const secondContext = JSON.stringify(secondHarness.llm.structuredCalls[0]?.context);
  assert.notEqual(createHash('sha256').update(firstContext).digest('hex'), createHash('sha256').update(secondContext).digest('hex'));
  assert.equal(firstContext.includes('sealedOutputs'), false);
  assert.match(firstContext, /first/);
  assert.match(secondContext, /second/);
});

test('appends machine-observed gaps when the LLM omits risksAndOpenIssues', async () => {
  const draft = validDeliverableDraft();
  delete draft.risksAndOpenIssues;
  const { service } = await createHarness(draft);

  const result = await service.generate(generateInput({
    gaps: ['可选渠道价格信息未完成交叉验证'],
  }));

  assert.deepEqual(
    result.deliverable.risksAndOpenIssues,
    ['可选渠道价格信息未完成交叉验证'],
  );
});

test('rejects a recommendation without a summary root before writing an artifact', async () => {
  const draft = validDeliverableDraft();
  draft.recommendations = [{ id: 'R1', summaryIds: [], statement: '无根建议' }];
  const { service, writes } = await createHarness(draft);

  await assert.rejects(() => service.generate(generateInput()));

  assert.equal(writes.length, 0);
});

const INVALID_DELIVERABLE_COVERAGE_CASES: Array<{
  name: string;
  mutate(draft: DeliverableDraft): void;
}> = [{
  name: 'missing coverage',
  mutate: (draft) => { Reflect.deleteProperty(draft, 'coverage'); },
}, {
  name: 'an empty question target list',
  mutate: (draft) => { draft.coverage.questionBindings[0]!.summaryIds = []; },
}, {
  name: 'an extra question binding property',
  mutate: (draft) => {
    Object.assign(draft.coverage.questionBindings[0]!, { unexpected: true });
  },
}, {
  name: 'a duplicate question binding',
  mutate: (draft) => { draft.coverage.questionBindings.push({ ...draft.coverage.questionBindings[0]! }); },
}, {
  name: 'a dangling conclusion reference',
  mutate: (draft) => {
    draft.coverage.successCriterionBindings[0]!.conclusionIds = ['missing-conclusion'];
  },
}];

for (const invalid of INVALID_DELIVERABLE_COVERAGE_CASES) {
  test(`rejects deliverable content with ${invalid.name} before writing an artifact`, async () => {
    const draft = validDeliverableDraft();
    invalid.mutate(draft);
    const { service, writes } = await createHarness(draft);
    await assert.rejects(() => service.generate(generateInput()));
    assert.equal(writes.length, 0);
  });
}

test('rejects evidence that does not match its sealed artifact before writing an artifact', async () => {
  const { service, writes } = await createHarness();
  const input = generateInput();
  input.evidenceResolver = {
    resolveArtifact: (candidateId) => candidateId === evidenceArtifactId
      ? {
          artifact: {
            id: evidenceArtifactId,
            contentSha256: `sha256:${'f'.repeat(64)}`,
          },
          value: {
            output: { results: [{ title: 'current source', url: sourceUrl }] },
            redactedOutputHash,
          },
        }
      : null,
  };

  await assert.rejects(() => service.generate(input));

  assert.equal(writes.length, 0);
});

test('rejects a research plan with targetCount=0 before writing an artifact', async () => {
  const draft = validDeliverableDraft();
  draft.payload.competitorSampling.targetCount = 0;
  const { service, writes } = await createHarness(draft);

  await assert.rejects(() => service.generate(generateInput()));

  assert.equal(writes.length, 0);
});

test('does not persist full prompts or raw sensitive output fields', async () => {
  const fullPromptFixture = 'FULL_PROMPT_FIXTURE_MUST_NOT_BE_PERSISTED';
  const rawSensitiveFixture = 'RAW_SENSITIVE_FIXTURE_MUST_NOT_BE_PERSISTED';
  const { service, llm, writes } = await createHarness();

  await service.generate(generateInput({
    outputs: [{
      actorId: 'tavily',
      fullPrompt: fullPromptFixture,
      output: {
        summary: '仅允许持久化归纳后的证据内容',
        rawSensitiveField: rawSensitiveFixture,
      },
    }],
  }));

  const persistedValue = JSON.stringify(writes[0]?.value);
  assert.equal(persistedValue.includes(fullPromptFixture), false);
  assert.equal(persistedValue.includes(rawSensitiveFixture), false);
  const modelContext = JSON.stringify(llm.structuredCalls[0]?.context);
  assert.equal(modelContext.includes(fullPromptFixture), false);
  assert.equal(modelContext.includes(rawSensitiveFixture), false);
});

test('redacts sensitive research goals and gaps before model transmission and sealing', async () => {
  const sensitiveEmail = 'owner@example.test';
  const sensitivePhone = '13800138000';
  const credentialGaps = [{
    marker: '下游认证失败',
    scheme: 'Bearer',
    secret: 'gap-secret',
    text: '下游认证失败 Authorization: Bearer gap-secret',
  }, {
    marker: 'downstream bearer credential',
    scheme: 'Bearer',
    secret: 'topsecret',
    text: 'downstream bearer credential Bearer topsecret',
  }, {
    marker: 'downstream basic credential',
    scheme: 'Basic',
    secret: 'basic-secret',
    text: 'downstream basic credential Authorization: Basic basic-secret',
  }, {
    marker: 'downstream digest credential',
    scheme: 'Digest',
    secret: 'digest-secret',
    text: 'downstream digest credential Authorization: Digest digest-secret',
  }, {
    marker: 'downstream negotiate credential',
    scheme: 'Negotiate',
    secret: 'negotiate-secret',
    text: 'downstream negotiate credential Authorization: Negotiate negotiate-secret',
  }, {
    marker: 'downstream aws credential',
    scheme: 'AWS4-HMAC-SHA256',
    secret: 'aws-secret',
    text: 'downstream aws credential Authorization: AWS4-HMAC-SHA256 aws-secret',
  }];
  const benignGap = 'perform basic competitor research; digest market trends; negotiate scope';
  const rawGoal = `为 ${sensitiveEmail} 和 ${sensitivePhone} 形成可信竞品研究计划`;
  const { service, llm, writes } = await createHarness();

  const result = await service.generate(generateInput({
    researchGoal: rawGoal,
    gaps: [...credentialGaps.map((gap) => gap.text), benignGap],
  }));

  const modelContext = JSON.stringify(llm.structuredCalls[0]?.context);
  const sealedDeliverable = JSON.stringify(result.deliverable);
  const persistedValue = JSON.stringify(writes[0]?.value);
  const protectedLiterals = [
    sensitiveEmail,
    sensitivePhone,
    ...credentialGaps.flatMap((gap) => [gap.text, gap.scheme, gap.secret]),
  ];
  for (const sensitiveLiteral of protectedLiterals) {
    assert.equal(modelContext.includes(sensitiveLiteral), false);
    assert.equal(sealedDeliverable.includes(sensitiveLiteral), false);
    assert.equal(persistedValue.includes(sensitiveLiteral), false);
  }
  assert.match(modelContext, /\[REDACTED_EMAIL\]/);
  assert.match(modelContext, /\[REDACTED_PHONE\]/);
  for (const gap of credentialGaps) {
    const sanitizedGap = result.deliverable.risksAndOpenIssues.find(
      (risk) => risk.includes(gap.marker),
    );
    assert.ok(sanitizedGap, `missing sanitized gap for ${gap.text}`);
    assert.match(sanitizedGap, /\[REDACTED\]/);
    assert.equal(modelContext.includes(sanitizedGap), true);
  }
  assert.equal(modelContext.includes(benignGap), true);
  assert.equal(result.deliverable.risksAndOpenIssues.includes(benignGap), true);
  assert.equal(persistedValue.includes(benignGap), true);
});

test('derives deduplicated capability provenance only from sealed execution outputs', async () => {
  const draft = validDeliverableDraft();
  draft.capabilityProvenance = [
    { id: 'forged-tool', type: 'tool' },
    { id: 'forged-skill', type: 'skill' },
  ];
  const { service } = await createHarness(draft);

  const result = await service.generate(generateInput({
    outputs: [{
      actorId: 'tavily',
      kind: 'tool_output',
      artifact: { id: 'artifact-tool-1', contentSha256: `sha256:${'4'.repeat(64)}`, state: 'SEALED' },
    }, {
      actorId: 'market-analysis',
      kind: 'skill_output',
      artifact: { id: 'artifact-skill-1', contentSha256: `sha256:${'5'.repeat(64)}`, state: 'SEALED' },
    }, {
      actorId: 'tavily',
      kind: 'tool_output',
      artifact: { id: 'artifact-tool-duplicate', contentSha256: `sha256:${'6'.repeat(64)}`, state: 'SEALED' },
    }, {
      actorId: 'unsealed-tool',
      kind: 'tool_output',
      artifact: { id: 'artifact-unsealed', contentSha256: `sha256:${'7'.repeat(64)}`, state: 'STAGED' },
    }],
  }));

  assert.deepEqual(result.deliverable.capabilityProvenance, [
    { id: 'tavily', type: 'tool' },
    { id: 'market-analysis', type: 'skill' },
  ]);
});

const invalidDraftCases: Array<{ name: string; draft: () => unknown }> = [{
  name: 'an empty methodSummary',
  draft: () => ({ ...validDeliverableDraft(), methodSummary: '' }),
}, {
  name: 'empty findings',
  draft: () => {
    const valid = validDeliverableDraft();
    return { ...valid, findingGraph: { ...valid.findingGraph, findings: [] } };
  },
}, {
  name: 'empty analyses',
  draft: () => {
    const valid = validDeliverableDraft();
    return { ...valid, findingGraph: { ...valid.findingGraph, analyses: [] } };
  },
}, {
  name: 'empty sub-question summaries',
  draft: () => {
    const valid = validDeliverableDraft();
    return { ...valid, findingGraph: { ...valid.findingGraph, subQuestionSummaries: [] } };
  },
}, {
  name: 'empty overall conclusions',
  draft: () => {
    const valid = validDeliverableDraft();
    return { ...valid, findingGraph: { ...valid.findingGraph, overallConclusions: [] } };
  },
}, {
  name: 'empty recommendations',
  draft: () => ({ ...validDeliverableDraft(), recommendations: [] }),
}, {
  name: 'a non-array risksAndOpenIssues',
  draft: () => ({ ...validDeliverableDraft(), risksAndOpenIssues: 'not-an-array' }),
}, {
  name: 'an unexpected top-level property',
  draft: () => ({ ...validDeliverableDraft(), unexpectedProperty: true }),
}, {
  name: 'a malformed finding graph child',
  draft: () => {
    const valid = validDeliverableDraft();
    return {
      ...valid,
      findingGraph: {
        ...valid.findingGraph,
        findings: [{
          id: 'F1',
          kind: 'fact',
          evidenceIds: 'E1',
          statement: 'evidenceIds must be an array',
        }],
      },
    };
  },
}];

for (const invalid of invalidDraftCases) {
  test(`rejects ${invalid.name} with typed schema validation after bounded retries without writing`, async () => {
    const { service, validator, llm, writes } = await createHarness(invalid.draft());

    await assert.rejects(
      () => service.generate(generateInput()),
      (error: unknown) => error instanceof SchemaValidationError,
    );

    assert.equal(llm.structuredCalls.length, 3);
    assert.deepEqual(
      validator.schemaCalls.map((call) => call.label),
      Array.from({ length: 3 }, () => 'research-plan-deliverable-content'),
    );
    assert.equal(writes.length, 0);
  });
}

function openStrategyDraft(): ResearchStrategyContentDraftV2 {
  const support = {
    questionIds: ['q1'], evidenceIds: ['E1'], confidence: 0.8,
    status: 'supported' as const, validationNeeded: '',
  };
  return {
    schemaVersion: 'research-strategy-content-draft-v2',
    title: 'Open answer',
    decisionContext: 'Choose the next action.',
    executiveAnswer: 'Lead with verified evidence.',
    methodSummary: 'Synthesized the verified evidence.',
    directAnswers: [{
      questionId: 'q1', question: 'What should change?', answer: 'Lead with verified evidence.',
      answerStatus: 'supported', evidenceIds: ['E1'], confidence: 0.8,
      businessImplication: 'Reduce uncertainty.', recommendedAction: 'Ship the evidence card.', validationNeeded: '',
    }],
    evidenceFindings: [{
      key: 'fact', statement: 'The public source supports the decision.', support: structuredClone(support),
    }],
    contentBlocks: [{
      key: 'narrative', kind: 'narrative', title: 'Why this works',
      content: 'The evidence supports the proposed direction.', support: structuredClone(support),
    }],
    limitations: [],
    openQuestions: [],
  };
}

function structuralEvidencePatch(evidenceIds: string[] = ['E1']): ResearchStrategyContentPatchV1 {
  return {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'q1',
      answerStatus: evidenceIds.length > 0 ? 'supported' : 'provisional',
      evidenceIds,
      confidence: evidenceIds.length > 0 ? 0.8 : 0.6,
      validationNeeded: evidenceIds.length > 0 ? '' : 'Validate the answer.',
    }],
  };
}

function semanticRevisionPatch(): ResearchStrategyContentPatchV1 {
  return {
    version: 'research-strategy-content-patch-v1',
    mode: 'semantic_revision',
    operations: [{
      op: 'replace_semantic_text',
      reviewIssueId: 'reasoning_quality:1',
      reason: 'Weaken the exact answer named by the sealed Review issue.',
      target: { entity: 'direct_answer', key: 'q1', field: 'answer' },
      value: 'Lead with carefully qualified, verifiable trust signals.',
    }],
  };
}

function noOpStructuralPatch(): ResearchStrategyContentPatchV1 {
  return {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{ op: 'append_limitation', value: 'The invalid binding remains unresolved.' }],
  };
}

function compoundedStructuralPatch(): ResearchStrategyContentPatchV1 {
  const provisionalSupport = {
    questionIds: ['q1_系统'],
    evidenceIds: [],
    confidence: 0.6,
    status: 'provisional' as const,
    validationNeeded: 'Validate against the verified source.',
  };
  return {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_direct_answer_binding',
      questionId: 'q1',
      answerStatus: 'provisional',
      evidenceIds: [],
      confidence: 0.6,
      validationNeeded: 'Validate the answer.',
    }, {
      op: 'replace_support',
      target: { entity: 'evidence_finding', key: 'fact' },
      support: provisionalSupport,
    }, {
      op: 'replace_support',
      target: { entity: 'content_block', key: 'narrative' },
      support: provisionalSupport,
    }],
  };
}

function openStrategyMaterials(content: ResearchStrategyContentDraftV2): SynthesisMaterial[] {
  return [{
    stepNo: 8,
    actorType: 'skill',
    actorId: 'research-strategy-synthesis',
    questionIds: ['q1'],
    artifactId: 'skill-output-1',
    artifactContentSha256: `sha256:${'8'.repeat(64)}`,
    semanticRole: 'analysis',
    value: {
      version: 'skill-output-v2', status: 'succeeded', summary: 'Complete',
      findings: [], assumptions: [], limitations: [], recommendations: [], payload: content,
    },
  }, {
    stepNo: 9,
    actorType: 'reviewer',
    actorId: 'reviewer.research-lead',
    questionIds: ['q1'],
    artifactId: 'review-output-1',
    artifactContentSha256: `sha256:${'a'.repeat(64)}`,
    semanticRole: 'review',
    value: { version: 'reviewer-step-output-v1', review: 'Pass.', verdict: 'pass', conditions: [] },
  }];
}

function openStrategyInput(): Partial<DeliverableGenerateInput> {
  return {
    plan: { id: planVersionId, plan: { deliverable_type: 'research_strategy_report' } },
    finalizedRequirement: {
      version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer',
      business_domain: 'test', research_goal: 'answer q1', target_audience: ['team'], scope: ['test'], constraints: [],
      success_criteria: [{ id: 'criterion1', statement: 'Answer q1' }],
      expected_deliverables: ['research_strategy_report'], requested_artifacts: ['executive_answers', 'research_report'],
      assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'public', pii_detected: false,
    },
    problemGraph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'q1', statement: 'What should change?', rationale: 'Decision', priority: 'required',
        success_criterion_ids: ['criterion1'], evidence_requirements: [], acceptance_criteria: ['Direct answer'], depends_on: [],
      }],
    },
    outputs: [{
      stepNo: 8, actorType: 'skill', actorId: 'research-strategy-synthesis', kind: 'skill_output', state: 'succeeded',
      taskId, planVersionId, attemptId,
      artifact: { id: 'skill-output-1', contentSha256: `sha256:${'8'.repeat(64)}`, state: 'SEALED' },
    }],
  };
}

test('assembles a research strategy deliverable from the reviewed Skill output without another full-report LLM call', async () => {
  const content = openStrategyDraft();
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(content); } };
  const { service, llm } = await createHarness(validDeliverableDraft(), materializer);
  const result = await service.generate(generateInput(openStrategyInput()));

  assert.equal(llm.structuredCalls.length, 0);
  assert.equal((result.deliverable.payload as { schemaVersion?: string }).schemaVersion, 'research-strategy-content-v2');
  assert.deepEqual(result.deliverable.coverage.questionBindings, [{ questionId: 'q1', summaryIds: ['summary-q1'] }]);
});

test('revises an open strategy report through one bounded Content Draft repair', async () => {
  const content = openStrategyDraft();
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(content); } };
  const { service, llm, writes } = await createHarness(semanticRevisionPatch(), materializer);
  const strategyInput = generateInput(openStrategyInput());
  const initial = await service.generate(strategyInput);
  const revised = await service.revise({
    ...strategyInput,
    currentDeliverable: initial.deliverable,
    review: {
      version: 'report-review-v2', taskId, planVersionId, attemptId,
      deliverableArtifactId: initial.deliverableArtifactId,
      verdict: 'revise',
      dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => id === 'reasoning_quality'
        ? {
            id,
            passed: false,
            issues: ['Weaken one unsupported claim.'],
            targetNodeIds: ['q1'],
            revisionIssues: [{
              id: 'reasoning_quality:1',
              message: 'Weaken one unsupported claim.',
              targetNodeIds: ['q1'],
            }],
          }
        : { id, passed: true, issues: [] }),
      revisionRound: 0,
    },
    reviewArtifactId: 'review-r0',
  });

  assert.equal(llm.structuredCalls.length, 1);
  assert.equal(llm.structuredCalls[0]?.receipt.stage, 'deliverable_repair');
  const revisionContext = llm.structuredCalls[0]?.context as {
    authorizingReviewArtifactId?: string;
    reviewIssues?: Array<{ id: string; targetNodeIds: string[] }>;
  };
  assert.equal(revisionContext.authorizingReviewArtifactId, 'review-r0');
  assert.deepEqual(revisionContext.reviewIssues, [{
    id: 'reasoning_quality:1',
    dimensionId: 'reasoning_quality',
    issue: 'Weaken one unsupported claim.',
    targetNodeIds: ['q1'],
  }]);
  assert.equal(revised.deliverableArtifactId, deliverableArtifactId);
  assert.deepEqual(writes.map(({ relativePath }) => relativePath), [
    'diagnostics/content-fidelity-r0.json',
    'deliverables/final-r0.json',
    'diagnostics/content-fidelity-r1.json',
    'deliverables/final-r1.json',
  ]);
  const revisionFidelity = writes[2]?.value as { repairOperations?: string[]; removedUnitKeys?: string[] };
  assert.match(revisionFidelity.repairOperations?.[0] ?? '', /reasoning_quality:1/u);
  assert.match(revisionFidelity.repairOperations?.[0] ?? '', /direct_answer/u);
  assert.deepEqual(revisionFidelity.removedUnitKeys, []);
});

test('deterministically restores empty provisional Evidence bindings before invoking repair', async () => {
  const content = openStrategyDraft();
  content.directAnswers[0]!.answerStatus = 'provisional';
  content.directAnswers[0]!.evidenceIds = [];
  content.directAnswers[0]!.validationNeeded = 'Validate the answer.';
  content.evidenceFindings[0]!.support.status = 'provisional';
  content.evidenceFindings[0]!.support.evidenceIds = [];
  content.evidenceFindings[0]!.support.validationNeeded = 'Validate the finding.';
  const narrative = content.contentBlocks[0]!;
  assert.equal(narrative.kind, 'narrative');
  if (narrative.kind === 'narrative') {
    narrative.support.status = 'provisional';
    narrative.support.evidenceIds = [];
    narrative.support.validationNeeded = 'Validate the narrative.';
  }
  const bindingSource: SynthesisMaterial = {
    stepNo: 3,
    actorType: 'llm',
    actorId: 'llm.openai.gpt-4o',
    questionIds: ['q1'],
    artifactId: 'evidence-inventory-1',
    artifactContentSha256: `sha256:${'b'.repeat(64)}`,
    semanticRole: 'inference',
    value: { text: '## q1\nVerified source: E1.' },
  };
  const materializer = {
    async materialize(): Promise<SynthesisMaterial[]> {
      return [bindingSource, ...openStrategyMaterials(content)];
    },
  };
  const { service, llm, writes } = await createHarness(openStrategyDraft(), materializer);

  const result = await service.generate(generateInput(openStrategyInput()));

  assert.equal(llm.structuredCalls.length, 0);
  assert.deepEqual(
    (result.deliverable.payload as unknown as ResearchStrategyReportPayloadV2).directAnswers[0]?.evidenceIds,
    ['E1'],
  );
  assert.equal(writes[0]?.kind, 'content_fidelity_diagnostic');
  assert.equal(writes[1]?.kind, 'deliverable');
  assert.equal((writes[0]?.value as { mode?: string }).mode, 'none');
  assert.equal((writes[0]?.value as { removedUnitKeys?: string[] }).removedUnitKeys?.length, 0);
});

test('requires the fidelity diagnostic before sealing a Canonical Deliverable', async () => {
  const content = openStrategyDraft();
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(content); } };
  const writes: ArtifactWriteInput[] = [];
  const artifactWriter: ArtifactWriterLike = {
    async writeJson(input) {
      writes.push(input);
      if (input.kind === 'content_fidelity_diagnostic') throw new Error('fidelity store unavailable');
      return { id: deliverableArtifactId };
    },
  };
  const { service } = await createHarness(validDeliverableDraft(), materializer, artifactWriter);

  await assert.rejects(
    () => service.generate(generateInput(openStrategyInput())),
    /fidelity store unavailable/u,
  );
  assert.deepEqual(writes.map(({ kind }) => kind), ['content_fidelity_diagnostic']);
});

test('persists fidelity diagnostics and preview when the initial Draft inventory is invalid', async () => {
  const invalid = openStrategyDraft();
  invalid.contentBlocks.push(structuredClone(invalid.contentBlocks[0]!));
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, writes } = await createHarness(structuralEvidencePatch(), materializer);

  await assert.rejects(
    () => service.generate(generateInput(openStrategyInput())),
    (error: unknown) => error instanceof ResearchStrategyDeliverableValidationError
      && /duplicate content unit/u.test(error.message)
      && error.draftPreview.contentBlocks.length === 2,
  );
  assert.deepEqual(writes.map(({ kind }) => kind), [
    'deliverable_validation_diagnostic',
    'content_fidelity_diagnostic',
  ]);
});

test('validates the production Patch response before applying operations', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const oversizedPatch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: Array.from({ length: 65 }, (_, index) => ({
      op: 'append_limitation' as const,
      value: `Limitation ${index + 1}`,
    })),
  };
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, validator, llm } = await createHarness(oversizedPatch, materializer);

  await assert.rejects(
    () => service.generate(generateInput(openStrategyInput())),
    /must NOT have more than 64 items|must have fewer than 65 items/iu,
  );
  assert.equal(llm.structuredCalls.length, 1);
  assert.ok(validator.schemaCalls.some(({ label }) => label === 'research-strategy-content-patch-v1'));
});

test('malformed structural Patch responses keep diagnostics and reviewed preview intact', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const malformedPatch = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
  };
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, writes } = await createHarness(malformedPatch, materializer);

  await assert.rejects(
    () => service.generate(generateInput(openStrategyInput())),
    (error: unknown) => error instanceof ResearchStrategyDeliverableValidationError
      && /required property 'operations'/u.test(error.message)
      && error.draftPreview.directAnswers.length === 1,
  );
  assert.deepEqual(writes.map(({ kind }) => kind), [
    'deliverable_validation_diagnostic',
    'deliverable_validation_diagnostic',
    'content_fidelity_diagnostic',
  ]);
  assert.deepEqual(
    (writes[2]?.value as { repairOperations?: string[] }).repairOperations,
    ['invalid_patch:operations_missing'],
  );
});

test('malformed semantic Patch responses keep diagnostics and reviewed preview intact', async () => {
  const content = openStrategyDraft();
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(content); } };
  const malformedPatch = {
    version: 'research-strategy-content-patch-v1',
    mode: 'semantic_revision',
    operations: 'invalid',
  };
  const { service, writes } = await createHarness(malformedPatch, materializer);
  const strategyInput = generateInput(openStrategyInput());
  const initial = await service.generate(strategyInput);

  await assert.rejects(
    () => service.revise({
      ...strategyInput,
      currentDeliverable: initial.deliverable,
      review: {
        version: 'report-review-v2', taskId, planVersionId, attemptId,
        deliverableArtifactId: initial.deliverableArtifactId,
        verdict: 'revise',
        dimensions: REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => id === 'reasoning_quality'
          ? {
              id, passed: false, issues: ['Weaken one unsupported claim.'],
              revisionIssues: [{
                id: 'reasoning_quality:1', message: 'Weaken one unsupported claim.', targetNodeIds: ['q1'],
              }],
            }
          : { id, passed: true, issues: [] }),
        revisionRound: 0,
      },
      reviewArtifactId: 'review-r0',
    }),
    (error: unknown) => error instanceof ResearchStrategyDeliverableValidationError
      && /operations must be array/u.test(error.message)
      && error.draftPreview.contentBlocks.length === 1,
  );
  assert.deepEqual(writes.slice(-2).map(({ kind }) => kind), [
    'deliverable_validation_diagnostic',
    'content_fidelity_diagnostic',
  ]);
});

test('repairs one invalid reviewed Content Draft without returning to full Deliverable synthesis', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, llm, writes } = await createHarness(structuralEvidencePatch(), materializer);

  const result = await service.generate(generateInput(openStrategyInput()));

  assert.equal(llm.structuredCalls.length, 1);
  assert.equal(llm.structuredCalls[0]?.receipt.stage, 'deliverable_repair');
  assert.equal((result.deliverable.payload as { schemaVersion?: string }).schemaVersion, 'research-strategy-content-v2');
  assert.deepEqual(writes.map(({ kind, relativePath }) => ({ kind, relativePath })), [{
    kind: 'deliverable_validation_diagnostic',
    relativePath: 'diagnostics/deliverable-validation-r0.json',
  }, {
    kind: 'content_fidelity_diagnostic',
    relativePath: 'diagnostics/content-fidelity-r0.json',
  }, {
    kind: 'deliverable',
    relativePath: 'deliverables/final-r0.json',
  }]);
  assert.equal((writes[0]?.value as { fallbackApplied?: boolean }).fallbackApplied, true);
  const fidelity = writes[1]?.value as {
    sourceUnitCount?: number;
    candidateUnitCount?: number;
    removedUnitKeys?: string[];
    repairOperations?: string[];
  };
  assert.equal(fidelity.sourceUnitCount, fidelity.candidateUnitCount);
  assert.deepEqual(fidelity.removedUnitKeys, []);
  assert.match(fidelity.repairOperations?.[0] ?? '', /replace_direct_answer_binding:q1/u);
});

test('normalizes missing Evidence and a safe Question alias introduced by bounded Content Draft repair', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const bindingSource: SynthesisMaterial = {
    stepNo: 3,
    actorType: 'llm',
    actorId: 'llm.openai.gpt-4o',
    questionIds: ['q1'],
    artifactId: 'evidence-inventory-1',
    artifactContentSha256: `sha256:${'b'.repeat(64)}`,
    semanticRole: 'inference',
    value: { text: '## q1\nVerified source: E1.' },
  };
  const materializer = {
    async materialize(): Promise<SynthesisMaterial[]> {
      return [bindingSource, ...openStrategyMaterials(invalid)];
    },
  };
  const { service, llm, writes } = await createHarness(compoundedStructuralPatch(), materializer);

  const result = await service.generate(generateInput(openStrategyInput()));

  assert.equal(llm.structuredCalls.length, 1);
  const repairContext = llm.structuredCalls[0]?.context as {
    evidenceBindingSources?: Array<{ stepNo: number; questionIds: string[]; value: unknown }>;
  };
  assert.deepEqual(repairContext.evidenceBindingSources, [{
    stepNo: 3,
    questionIds: ['q1'],
    value: { text: '## q1\nVerified source: E1.' },
  }]);
  const block = (result.deliverable.payload as unknown as ResearchStrategyReportPayloadV2).contentBlocks[0]!;
  assert.equal(block.kind, 'narrative');
  if (block.kind === 'narrative') {
    assert.deepEqual(block.support.questionIds, ['q1']);
    assert.deepEqual(block.support.evidenceIds, ['E1']);
    assert.equal(block.support.status, 'provisional');
  }
  assert.deepEqual(
    (result.deliverable.payload as unknown as ResearchStrategyReportPayloadV2).directAnswers[0]?.evidenceIds,
    ['E1'],
  );
  assert.deepEqual(
    writes.map(({ kind }) => kind),
    ['deliverable_validation_diagnostic', 'content_fidelity_diagnostic', 'deliverable'],
  );
});

test('rejects a semantic rewrite operation in structural repair mode', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const forbiddenPatch: ResearchStrategyContentPatchV1 = {
    version: 'research-strategy-content-patch-v1',
    mode: 'structural_repair',
    operations: [{
      op: 'replace_semantic_text',
      reviewIssueId: 'reasoning_quality:1',
      reason: 'This operation is intentionally forbidden in structural mode.',
      target: { entity: 'direct_answer', key: 'q1', field: 'answer' },
      value: 'A compressed replacement answer.',
    }],
  };
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, llm, writes } = await createHarness(forbiddenPatch, materializer);

  await assert.rejects(
    () => service.generate(generateInput(openStrategyInput())),
    (error: unknown) => {
      assert.ok(error instanceof ResearchStrategyDeliverableValidationError);
      assert.equal(error.draftPreview.canonical, false);
      assert.equal(error.draftPreview.exportAllowed, false);
      assert.equal(error.draftPreview.directAnswers.length, 1);
      assert.equal(error.draftPreview.contentBlocks.length, 1);
      return /structural repair cannot replace semantic text/iu.test(error.message);
    },
  );

  assert.equal(llm.structuredCalls.length, 1);
  assert.deepEqual(writes.map(({ relativePath }) => relativePath), [
    'diagnostics/deliverable-validation-r0.json',
    'diagnostics/deliverable-validation-r1.json',
    'diagnostics/content-fidelity-r1.json',
  ]);
});

test('persists a sanitized diagnostic when reviewed Skill assembly and its bounded repair fail', async () => {
  const invalid = openStrategyDraft();
  invalid.directAnswers[0]!.evidenceIds = ['unknown-evidence'];
  const materializer = { async materialize(): Promise<SynthesisMaterial[]> { return openStrategyMaterials(invalid); } };
  const { service, llm, writes } = await createHarness(noOpStructuralPatch(), materializer);
  await assert.rejects(() => service.generate(generateInput(openStrategyInput())), /unknown Evidence/);

  assert.equal(llm.structuredCalls.length, 1);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(({ relativePath }) => relativePath), [
    'diagnostics/deliverable-validation-r0.json',
    'diagnostics/deliverable-validation-r1.json',
    'diagnostics/content-fidelity-r1.json',
  ]);
  assert.deepEqual(
    writes.map(({ kind }) => kind),
    ['deliverable_validation_diagnostic', 'deliverable_validation_diagnostic', 'content_fidelity_diagnostic'],
  );
  assert.equal((writes[0]?.value as { fallbackApplied?: boolean }).fallbackApplied, true);
  assert.equal((writes[1]?.value as { fallbackApplied?: boolean }).fallbackApplied, false);
  assert.equal(writes[0]?.schemaVersion, 'deliverable-validation-diagnostic-v1');
  assert.equal(writes[1]?.schemaVersion, 'deliverable-validation-diagnostic-v1');
  assert.equal(writes[2]?.schemaVersion, 'content-fidelity-diagnostic-v1');
  assert.doesNotMatch(JSON.stringify(writes.map(({ value }) => value)), /api[_-]?key|authorization|bearer/iu);
});
