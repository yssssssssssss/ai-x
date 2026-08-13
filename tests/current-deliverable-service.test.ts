import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { test } from 'node:test';
import type {
  CurrentExecutionPlan,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../packages/api-contract/research-deliverable.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
  type FindingGraph,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { ArtifactWriteInput } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
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
  plan: {
    id: string;
    plan: Pick<CurrentExecutionPlan, 'deliverable_type'>;
  };
  attempt: { id: string };
  researchGoal: string;
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
  outputs: unknown[];
  gaps: string[];
  expectedModel: string;
}

interface DeliverableGenerateResult {
  deliverable: DeliverableEnvelope;
  deliverableArtifactId: string;
}

interface CurrentDeliverableServiceLike {
  generate(input: DeliverableGenerateInput): Promise<DeliverableGenerateResult>;
}

interface SealedArtifactResult {
  id: string;
  state: 'SEALED';
}

interface ArtifactWriterLike {
  writeJson(input: ArtifactWriteInput): Promise<SealedArtifactResult>;
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

const taskId = 'task-current-1';
const planVersionId = 'plan-version-current-1';
const attemptId = 'attempt-current-1';
const evidenceManifestArtifactId = 'artifact-evidence-manifest-1';
const evidenceArtifactId = 'artifact-tool-output-1';
const deliverableArtifactId = 'artifact-deliverable-1';
const evidenceArtifactContentSha256 = `sha256:${'1'.repeat(64)}`;
const evidenceManifestContentSha256 = `sha256:${'2'.repeat(64)}`;
const resolvedEvidenceValue = { title: 'current source', url: 'https://example.test/products/current' };
const evidenceArtifactOutput = { results: [resolvedEvidenceValue] };
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

  constructor(private readonly draft: unknown) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.structuredCalls.push(options);
    return {
      data: this.draft as T,
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

function sealedEvidence(): {
  evidenceManifest: SealedEvidenceManifest;
  evidenceResolver: EvidenceArtifactResolver;
} {
  const evidence = new EvidenceService();
  const evidenceResolver: EvidenceArtifactResolver = {
    resolveArtifact: (candidateId) => candidateId === evidenceArtifactId
      ? {
          artifact: {
            id: evidenceArtifactId,
            contentSha256: evidenceArtifactContentSha256,
          },
          value: {
            output: evidenceArtifactOutput,
            redactedOutputHash,
            raw: resolverWrapperRawFixture,
          },
        }
      : null,
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
    evidenceManifest: evidence.evidenceManifest,
    evidenceResolver: evidence.evidenceResolver,
    outputs: [{ actorId: 'tavily', output: { summary: '公开来源采集完成' } }],
    gaps: [],
    expectedModel: 'pinned-model',
    ...overrides,
  };
}

async function createHarness(draft: unknown = validDeliverableDraft()): Promise<{
  service: CurrentDeliverableServiceLike;
  validator: RecordingSchemaValidator;
  llm: StaticDeliverableLLM;
  writes: ArtifactWriteInput[];
}> {
  const { CurrentDeliverableService } = await loadCurrentDeliverableModule();
  const writes: ArtifactWriteInput[] = [];
  const artifacts: ArtifactWriterLike = {
    async writeJson(input) {
      writes.push(input);
      return { id: deliverableArtifactId, state: 'SEALED' };
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
    verifiedEvidence?: Array<{ evidenceId: string; sourceUrl?: string; value: unknown }>;
  };
  assert.deepEqual(modelContext.verifiedEvidence, [{
    evidenceId: 'E1',
    sourceUrl,
    value: resolvedEvidenceValue,
  }]);
  const verifiedEvidenceText = JSON.stringify(modelContext.verifiedEvidence);
  const fullModelContextText = JSON.stringify(modelContext);
  assert.equal(verifiedEvidenceText.includes('output'), false);
  assert.equal(verifiedEvidenceText.includes('redactedOutputHash'), false);
  assert.equal(verifiedEvidenceText.includes(resolverWrapperRawFixture), false);
  assert.equal(fullModelContextText.includes('redactedOutputHash'), false);
  assert.equal(fullModelContextText.includes(resolverWrapperRawFixture), false);
  assert.equal(validator.schemaCalls.length, 1);
  assert.equal(validator.schemaCalls[0]?.label, 'research-plan-deliverable-content');

  assert.equal(result.deliverable.version, 'research-deliverable-v1');
  assert.equal(result.deliverable.taskId, taskId);
  assert.equal(result.deliverable.planVersionId, planVersionId);
  assert.equal(result.deliverable.attemptId, attemptId);
  assert.equal(result.deliverable.deliverableType, 'research_plan');
  assert.equal(result.deliverable.evidenceManifestArtifactId, evidenceManifestArtifactId);
  assert.doesNotThrow(() => validator.validateFileOrThrow(
    researchPlanSchemaPath,
    result.deliverable.payload,
  ));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.relativePath, 'deliverables/final.json');
  assert.equal(writes[0]?.kind, 'deliverable');
  assert.deepEqual(writes[0]?.value, result.deliverable);
  assert.equal(result.deliverableArtifactId, deliverableArtifactId);
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
  test(`rejects ${invalid.name} with typed schema validation before writing`, async () => {
    const { service, validator, writes } = await createHarness(invalid.draft());

    await assert.rejects(
      () => service.generate(generateInput()),
      (error: unknown) => error instanceof SchemaValidationError,
    );

    assert.equal(validator.schemaCalls.length, 1);
    assert.equal(validator.schemaCalls[0]?.label, 'research-plan-deliverable-content');
    assert.equal(writes.length, 0);
  });
}
