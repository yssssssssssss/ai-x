import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentReportPackageResponse } from '../packages/api-contract/control-workflow.ts';
import type { ControlArtifact } from '../database/control-plane.ts';
import {
  EditorialMaterializationError,
} from '../apps/orchestrator-runtime/src/report/editorial-report-materializer.ts';
import {
  EditorialRendererError,
  renderEditorialReport,
} from '../apps/orchestrator-runtime/src/report/editorial-report-renderer.ts';
import { EditorialSourceError } from '../apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts';
import {
  EDITORIAL_MODEL_SYSTEM_PROMPT,
  EditorialPipelineError,
  EditorialReportPipeline,
  type EditorialPipelineLease,
  type EditorialPipelineStore,
} from '../apps/orchestrator-runtime/src/report/editorial-report-pipeline.ts';
import type {
  EditorialFailureDiagnosticInput,
  EditorialStorePublishInput,
  EditorialStoredGeneration,
} from '../apps/orchestrator-runtime/src/report/editorial-report-store.ts';
import {
  buildDeterministicEditorialBlueprint,
  canonicalJsonBytes,
  canonicalSha256,
  createEditorialMaterialUnitId,
  parseEditorialDiagnostic,
  parseEditorialReport,
  projectEditorialModelContext,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type EditorialModelPort,
  type EditorialStructuredModelClient,
  type FrozenEditorialSource,
  type Sha256,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { LLMInvocationError, hashPrompt, type LLMResult } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const HASH = `sha256:${'1'.repeat(64)}` as Sha256;

function materialUnit(input: {
  pointer: string;
  value: string;
  role: 'context' | 'claim' | 'risk';
  epistemicStatus?: 'fact' | 'unknown';
  evidenceIds?: string[];
  questionIds?: string[];
}): EditorialMaterialUnit {
  const id = createEditorialMaterialUnitId({ sourceArtifactId: 'deliverable-1', sourceArtifactContentSha256: HASH, sourceJsonPointer: input.pointer, role: input.role, value: input.value });
  const base = { id, value: input.value, metricEligible: false, sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: input.pointer }] as const, basisUnitIds: [], evidenceIds: input.evidenceIds ?? [], questionIds: input.questionIds ?? [], requiredInOutput: true, requiredInBody: true };
  if (input.role === 'claim') return { ...base, role: 'claim', epistemicStatus: input.epistemicStatus ?? 'fact' };
  if (input.role === 'risk') return { ...base, role: 'risk', epistemicStatus: 'unknown' };
  return { ...base, role: 'context' };
}

function fixture(): { source: FrozenEditorialSource; material: EditorialMaterial } {
  const method = materialUnit({ pointer: '/methodSummary', value: '基于封存材料', role: 'context' });
  const fact = materialUnit({ pointer: '/findingGraph/findings/0/statement', value: '已有事实', role: 'claim', evidenceIds: ['evidence-1'], questionIds: ['question-1'] });
  const risk = materialUnit({ pointer: '/risksAndOpenIssues/0', value: '仍需验证', role: 'risk' });
  const material: EditorialMaterial = {
    version: 'editorial-material-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    deliverableType: 'research_plan', presentationMode: 'current_text',
    sourceReportPackage: { artifactId: PACKAGE_ID, kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: HASH },
    sourceArtifacts: [
      { artifactId: PACKAGE_ID, kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: HASH },
      { artifactId: 'deliverable-1', kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated', contentSha256: HASH },
      { artifactId: 'evidence-artifact-1', kind: 'tool_output', schemaVersion: 'tool-output-v1', contentSha256: HASH },
    ],
    materializationWarningCodes: [],
    methodSummaryUnitId: method.id,
    units: [method, fact, risk], assets: [],
    evidence: [{ id: 'evidence-1', kind: 'tool_output', evidenceClass: 'dataset', artifactId: 'evidence-artifact-1', artifactContentSha256: HASH, jsonPointer: '/value', sensitivity: 'internal', redaction: 'none' }],
  };
  const packageArtifact: ControlArtifact & { state: 'SEALED'; contentSha256: Sha256 } = {
    id: PACKAGE_ID, taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID,
    kind: 'report_package', state: 'SEALED', storageUri: 'report-package.json', contentSha256: HASH,
    byteSize: 1, schemaVersion: 'report-package-v1', sensitivity: 'internal', redactionPolicyVersion: 'v1', failureReason: null,
  };
  const current = {
    presentationMode: 'current_text',
    deliverable: { version: 'research-deliverable-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID, deliverableType: 'research_plan', evidenceManifestArtifactId: 'manifest-1', methodSummary: 'x', findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] }, payload: {}, recommendations: [], coverage: { questionBindings: [], successCriterionBindings: [] }, risksAndOpenIssues: [], capabilityProvenance: [] },
    evidenceManifest: { version: 'evidence-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID, collectedAt: '2026-08-27T00:00:00.000Z', manifestHash: HASH, entries: [] },
    reportReview: { version: 'report-review-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID, deliverableArtifactId: 'deliverable-1', verdict: 'pass', dimensions: [], revisionRound: 0 },
  } as Exclude<CurrentReportPackageResponse, { presentationMode: 'legacy_text' }>;
  return {
    material,
    source: {
      binding: { taskId: TASK_ID, taskState: 'completed', taskStateVersion: 4, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID, reportPackageArtifactId: PACKAGE_ID, reportPackageContentSha256: HASH },
      reportPackage: { artifact: packageArtifact, value: { version: 'report-package-v1', taskId: TASK_ID, planVersionId: PLAN_ID, attemptId: ATTEMPT_ID, presentationMode: 'current_text', deliverableArtifactId: 'deliverable-1', evidenceManifestArtifactId: 'manifest-1', reportReviewArtifactId: 'review-1' } },
      current, sourceArtifacts: material.sourceArtifacts,
      sourcePolicyMetadata: [{ artifactId: PACKAGE_ID, contentSha256: HASH, sensitivity: 'internal', redactionPolicyVersion: 'v1' }],
      verifiedVisualAssets: [],
    },
  };
}

function materializeResult(material: EditorialMaterial) {
  const materialBytes = canonicalJsonBytes(material);
  const context = projectEditorialModelContext(material);
  return { material, materialBytes, materialHash: canonicalSha256(material), modelContext: context.context, modelContextBytes: Buffer.from(context.bytes), modelContextHash: context.hash, modelContextByteSize: context.byteSize, sourcePolicyMetadata: [{ artifactId: PACKAGE_ID, contentSha256: HASH, sensitivity: 'internal', redactionPolicyVersion: 'v1' }], warnings: [] };
}

const MODEL_LIMITS = {
  overallTimeoutMs: 90_000,
  maxHttpAttempts: 3,
  maxRetryAfterMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxOutputTokens: 8_000,
} as const;

function modelConfiguration(
  requestedModel = 'editorial-model',
  expectedActualModel = 'editorial-model-v1',
) {
  const body = {
    provider: 'gateway',
    endpointHost: 'llm-gw.jd.local',
    endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real' as const,
    eligibleAsReal: true,
    redirectMode: 'error' as const,
    routes: [{
      requestedModel,
      expectedActualModel,
      expectedActualModelExplicit: true as const,
    }],
    limits: MODEL_LIMITS,
  };
  return { ...body, gatewayConfigurationHash: canonicalSha256(body) };
}

function blueprintPlan(material: EditorialMaterial) {
  const fallback = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'a'.repeat(64)}`,
  });
  return {
    version: 'editorial-blueprint-plan-v1',
    locale: 'zh-CN',
    deck: {
      text: '依据可信的封存材料形成编辑化报告',
      mode: 'paraphrase',
      materialUnitIds: [material.methodSummaryUnitId],
    },
    sections: fallback.sections.filter(({ role }) => role !== 'audit'),
  };
}

class QueueEditorialClient implements EditorialStructuredModelClient {
  readonly calls: Array<{ schemaName: string; systemPrompt: string; context: object }> = [];
  private identityReads = 0;
  private readonly baseIdentity = {
    provider: 'gateway',
    endpointHost: 'llm-gw.jd.local',
    endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real' as const,
    eligibleAsReal: true,
    routes: [{
      requestedModel: 'editorial-model',
      expectedActualModel: 'editorial-model-v1',
      expectedActualModelExplicit: true,
    }],
  };

  constructor(
    private readonly responses: Array<unknown | Error>,
    private readonly mutateResult?: (
      result: LLMResult<unknown>,
      callIndex: number,
    ) => LLMResult<unknown> & Record<string, unknown>,
    private readonly identityForRead?: (
      identity: EditorialStructuredModelClient['configurationIdentity'],
      readCount: number,
    ) => EditorialStructuredModelClient['configurationIdentity'],
  ) {}

  get configurationIdentity(): EditorialStructuredModelClient['configurationIdentity'] {
    this.identityReads += 1;
    const identity = structuredClone(this.baseIdentity);
    return this.identityForRead?.(identity, this.identityReads) ?? identity;
  }

  async generateStructured<T>(options: {
    prompt: string;
    systemPrompt: string;
    schema: object;
    schemaName: 'editorial-report-blueprint' | 'editorial-report-fidelity';
    context: object;
    limits: typeof MODEL_LIMITS;
    redirectMode: 'error';
  }): Promise<Omit<LLMResult<T>, 'receiptId'>> {
    this.calls.push({
      schemaName: options.schemaName,
      systemPrompt: options.systemPrompt,
      context: structuredClone(options.context),
    });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    const result: LLMResult<T> = {
      data: structuredClone(response) as T,
      promptHash: hashPrompt(options.prompt, options.context, options.schemaName, options.systemPrompt),
      modelName: 'editorial-model-v1',
      modelVersion: 'editorial-model-v1',
      traceId: `trace-${this.calls.length}`,
      tokens: { prompt: 10, completion: 5, total: 15 },
      providerIdentity: {
        provider: 'gateway',
        endpointHost: 'llm-gw.jd.local',
        requestedModel: 'editorial-model',
        mode: 'real',
        eligibleAsReal: true,
      },
      expectedModel: 'editorial-model-v1',
    };
    return (this.mutateResult?.(result as LLMResult<unknown>, this.calls.length) ?? result) as Omit<LLMResult<T>, 'receiptId'>;
  }
}

function modelPort(
  responses: Array<unknown | Error>,
  mutateResult?: ConstructorParameters<typeof QueueEditorialClient>[1],
  identityForRead?: ConstructorParameters<typeof QueueEditorialClient>[2],
): { port: EditorialModelPort; client: QueueEditorialClient } {
  const client = new QueueEditorialClient(responses, mutateResult, identityForRead);
  return { port: { client, configuration: modelConfiguration() }, client };
}

class MemoryStore implements EditorialPipelineStore {
  stored: EditorialStoredGeneration | null = null;
  readonly failureDiagnostics: ReturnType<typeof parseEditorialDiagnostic>[] = [];
  readonly events: string[] = [];
  failureWriteError: Error | undefined;
  releaseError: Error | undefined;
  constructor(private readonly fence: () => Promise<void>) {}

  async readSlot(input: { slot: 'ready' | 'fallback' }): Promise<EditorialStoredGeneration | null> {
    this.events.push(`read:${input.slot}`);
    return this.stored?.slot === input.slot ? this.stored : null;
  }

  async acquire(): Promise<EditorialPipelineLease> {
    this.events.push('acquire');
    return {
      readSlot: async (slot) => {
        this.events.push(`lease-read:${slot}`);
        return this.stored?.slot === slot ? this.stored : null;
      },
      publish: async (input: EditorialStorePublishInput) => {
        this.events.push('publish');
        await input.assertStillCurrent();
        const manifest = parseEditorialReport(JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')));
        parseEditorialDiagnostic(JSON.parse(Buffer.from(input.diagnosticBytes).toString('utf8')));
        this.stored = {
          slot: input.slot, slotPath: '/tmp/fallback', reportPath: '/tmp/fallback/editorial-report.html', manifestPath: '/tmp/fallback/manifest.json', requestKey: manifest.requestKey, generationId: manifest.generationId, manifest,
          materialBytes: Buffer.from(input.materialBytes), blueprintBytes: Buffer.from(input.blueprintBytes), diagnosticBytes: Buffer.from(input.diagnosticBytes), htmlBytes: Buffer.from(input.htmlBytes), manifestBytes: Buffer.from(input.manifestBytes),
        };
        return this.stored;
      },
      release: async () => {
        this.events.push('release');
        if (this.releaseError) throw this.releaseError;
        return true;
      },
    };
  }

  async writeFailureDiagnostic(input: EditorialFailureDiagnosticInput): Promise<{ diagnosticPath: string }> {
    this.events.push('write-failure');
    await input.assertStillCurrent();
    if (this.failureWriteError) throw this.failureWriteError;
    assert.equal(input.taskId, TASK_ID);
    assert.deepEqual(input.expected, {
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      sourceReportPackage: {
        artifactId: PACKAGE_ID,
        kind: 'report_package',
        schemaVersion: 'report-package-v1',
        contentSha256: HASH,
      },
    });
    this.failureDiagnostics.push(parseEditorialDiagnostic(JSON.parse(Buffer.from(input.diagnosticBytes).toString('utf8'))));
    return { diagnosticPath: `/tmp/failures/${this.failureDiagnostics.length}/editorial-diagnostic.json` };
  }
}

test('Phase 1 publishes one deterministic degraded bundle with zero model calls and a publish fence', async () => {
  const { source, material } = fixture();
  const events: string[] = [];
  const verifier = {
    readCurrent: async () => { events.push('source'); return source; },
    assertStillCurrent: async () => { events.push('fence'); },
  };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const pipeline = new EditorialReportPipeline({ source: verifier, store, materialize: () => materializeResult(material), now: () => new Date('2026-08-27T08:00:00.000Z') });
  const result = await pipeline.generate({ taskId: TASK_ID });
  assert.equal(result.status, 'degraded');
  assert.equal(store.stored?.manifest.pipeline.gatewayConfiguration, null);
  assert.deepEqual(store.stored?.manifest.modelCalls, []);
  assert.equal(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')).modelEgress.reasonCode, 'EGRESS_MODEL_UNCONFIGURED');
  assert.deepEqual(events, ['source', 'fence']);
  assert.deepEqual(store.events, ['read:ready', 'acquire', 'lease-read:ready', 'lease-read:fallback', 'publish', 'release']);
});

test('Phase 1 publishes deterministic fallback for sensitivity and redaction-policy egress denials', async () => {
  for (const policy of [
    { sensitivity: 'confidential', redactionPolicyVersion: 'v1', reasonCode: 'EGRESS_SENSITIVITY_DENIED' },
    { sensitivity: 'internal', redactionPolicyVersion: 'v2', reasonCode: 'EGRESS_REDACTION_POLICY_DENIED' },
  ] as const) {
    const { source, material } = fixture();
    const verifier = {
      readCurrent: async () => source,
      assertStillCurrent: async () => undefined,
    };
    const store = new MemoryStore(verifier.assertStillCurrent);
    const materialization = materializeResult(material);
    materialization.sourcePolicyMetadata = materialization.sourcePolicyMetadata.map((entry) => ({
      ...entry,
      sensitivity: policy.sensitivity,
      redactionPolicyVersion: policy.redactionPolicyVersion,
    }));
    const pipeline = new EditorialReportPipeline({
      source: verifier,
      store,
      materialize: () => materialization,
    });

    const result = await pipeline.generate({ taskId: TASK_ID });

    assert.equal(result.status, 'degraded');
    const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
    assert.equal(diagnostic.status, 'degraded');
    assert.equal(diagnostic.modelEgress.reasonCode, policy.reasonCode);
    assert.ok(diagnostic.issues.some(({ code }) => code === policy.reasonCode));
    assert.deepEqual(store.stored?.manifest.modelCalls, []);
  }
});

test('writes a mode-none failure Diagnostic only after the source snapshot is frozen', async () => {
  const { source, material } = fixture();
  let fenceCalls = 0;
  const verifier = {
    readCurrent: async () => source,
    assertStillCurrent: async () => { fenceCalls += 1; },
  };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const pipeline = new EditorialReportPipeline({
    source: verifier,
    store,
    materialize: () => {
      throw new EditorialMaterializationError('EDITORIAL_PAYLOAD_INVALID', 'sensitive detail must not escape');
    },
  });

  await assert.rejects(
    pipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_PAYLOAD_INVALID'
      && error.diagnosticPath === '/tmp/failures/1/editorial-diagnostic.json',
  );
  assert.equal(fenceCalls, 1);
  assert.deepEqual(store.events, ['write-failure']);
  const diagnostic = store.failureDiagnostics[0]!;
  assert.equal(diagnostic.status, 'fail');
  assert.equal(diagnostic.mode, 'none');
  assert.equal('requestKey' in diagnostic, false);
  assert.equal(diagnostic.issues[0]?.code, 'EDITORIAL_PAYLOAD_INVALID');
  assert.equal(diagnostic.issues[0]?.message.includes('sensitive detail'), false);

  const configured = modelPort([]);
  const configuredStore = new MemoryStore(async () => undefined);
  await assert.rejects(
    new EditorialReportPipeline({
      source: { readCurrent: async () => source, assertStillCurrent: async () => undefined },
      store: configuredStore,
      modelPort: configured.port,
      materialize: () => {
        throw new EditorialMaterializationError('EDITORIAL_PAYLOAD_INVALID', 'private detail');
      },
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_PAYLOAD_INVALID',
  );
  assert.equal(configured.client.calls.length, 0);
  assert.equal(configuredStore.failureDiagnostics[0]?.mode, 'none');
  assert.equal(
    configuredStore.failureDiagnostics[0]?.gatewayConfigurationHash,
    modelConfiguration().gatewayConfigurationHash,
  );

  const sourceFailureStore = new MemoryStore(async () => undefined);
  const sourceFailurePipeline = new EditorialReportPipeline({
    source: {
      readCurrent: async () => { throw new EditorialSourceError('EDITORIAL_TASK_NOT_FOUND'); },
      assertStillCurrent: async () => undefined,
    },
    store: sourceFailureStore,
  });
  await assert.rejects(
    sourceFailurePipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'EDITORIAL_TASK_NOT_FOUND',
  );
  assert.deepEqual(sourceFailureStore.events, []);
  assert.deepEqual(sourceFailureStore.failureDiagnostics, []);
});

test('writes a prepared deterministic-fallback failure Diagnostic with request identity', async () => {
  const { source, material } = fixture();
  const verifier = {
    readCurrent: async () => source,
    assertStillCurrent: async () => undefined,
  };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const materialization = materializeResult(material);
  const pipeline = new EditorialReportPipeline({
    source: verifier,
    store,
    materialize: () => materialization,
    render: () => { throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'private renderer detail'); },
  });

  await assert.rejects(
    pipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'SOURCE_NOT_RENDERABLE'
      && error.diagnosticPath === '/tmp/failures/1/editorial-diagnostic.json',
  );
  const diagnostic = store.failureDiagnostics[0]!;
  assert.equal(diagnostic.status, 'fail');
  assert.equal(diagnostic.mode, 'deterministic_fallback');
  assert.match(diagnostic.requestKey, /^erq_[0-9a-f]{64}$/u);
  assert.equal(diagnostic.materialHash, materialization.materialHash);
  assert.equal(diagnostic.modelContextHash, materialization.modelContextHash);
  assert.equal(diagnostic.modelContextByteSize, materialization.modelContextByteSize);
  assert.equal(diagnostic.issues[0]?.message.includes('private renderer detail'), false);
  assert.deepEqual(store.events, [
    'read:ready', 'acquire', 'lease-read:ready', 'lease-read:fallback', 'release', 'write-failure',
  ]);
});

test('binding changes and failure-Diagnostic write errors never replace the original failure', async () => {
  const { source, material } = fixture();
  const changedStore = new MemoryStore(async () => {
    throw new EditorialSourceError('SOURCE_BINDING_CHANGED');
  });
  const changedPipeline = new EditorialReportPipeline({
    source: { readCurrent: async () => source, assertStillCurrent: async () => { throw new EditorialSourceError('SOURCE_BINDING_CHANGED'); } },
    store: changedStore,
    materialize: () => materializeResult(material),
  });
  await assert.rejects(
    changedPipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'SOURCE_BINDING_CHANGED'
      && error.diagnosticPath === undefined,
  );
  assert.equal(changedStore.events.includes('write-failure'), false);

  const failingStore = new MemoryStore(async () => undefined);
  failingStore.failureWriteError = new Error('filesystem detail must not replace the root cause');
  const failingPipeline = new EditorialReportPipeline({
    source: { readCurrent: async () => source, assertStillCurrent: async () => undefined },
    store: failingStore,
    materialize: () => { throw new EditorialMaterializationError('EDITORIAL_PAYLOAD_INVALID', 'root cause'); },
  });
  await assert.rejects(
    failingPipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_PAYLOAD_INVALID'
      && error.diagnosticPath === undefined,
  );
  assert.deepEqual(failingStore.failureDiagnostics, []);
});

test('lock-release failure cannot replace an earlier binding-change failure or create a Diagnostic', async () => {
  const { source, material } = fixture();
  const verifier = {
    readCurrent: async () => source,
    assertStillCurrent: async () => { throw new EditorialSourceError('SOURCE_BINDING_CHANGED'); },
  };
  const store = new MemoryStore(verifier.assertStillCurrent);
  store.releaseError = new Error('lock cleanup detail');
  const pipeline = new EditorialReportPipeline({
    source: verifier,
    store,
    materialize: () => materializeResult(material),
  });

  await assert.rejects(
    pipeline.generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'SOURCE_BINDING_CHANGED'
      && error.diagnosticPath === undefined,
  );
  assert.deepEqual(store.failureDiagnostics, []);
  assert.deepEqual(store.events, [
    'read:ready', 'acquire', 'lease-read:ready', 'lease-read:fallback', 'publish', 'release',
  ]);
});

test('cache return is fenced and does not acquire a request lock', async () => {
  const { source, material } = fixture();
  let fences = 0;
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => { fences += 1; } };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const pipeline = new EditorialReportPipeline({ source: verifier, store, materialize: () => materializeResult(material) });
  const first = await pipeline.generate({ taskId: TASK_ID });
  store.events.length = 0;
  const second = await pipeline.generate({ taskId: TASK_ID });
  assert.deepEqual(second, first);
  assert.deepEqual(store.events, ['read:ready', 'acquire', 'lease-read:ready', 'lease-read:fallback', 'release']);
  assert.equal(fences, 3);
});

test('Pipeline rejects a malformed non-null model port before any outbound call', () => {
  const { source } = fixture();
  const modelPort = { client: {}, configuration: {} } as unknown as EditorialModelPort;
  assert.throws(
    () => new EditorialReportPipeline({
      source: { readCurrent: async () => source, assertStillCurrent: async () => undefined },
      store: {} as EditorialPipelineStore,
      modelPort,
    }),
    /SCHEMA_INTEGRITY/u,
  );
});

test('Phase 2 rejects unsafe fallback HTML before any model call or publication', async () => {
  const { source, material } = fixture();
  const configured = modelPort([blueprintPlan(material)]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);

  await assert.rejects(
    new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: configured.port,
      materialize: () => materializeResult(material),
      render: (input) => {
        const rendered = renderEditorialReport(input);
        return {
          ...rendered,
          htmlBytes: Buffer.concat([rendered.htmlBytes, Buffer.from('<script>alert(1)</script>')]),
        };
      },
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_HTML_UNSAFE',
  );

  assert.equal(configured.client.calls.length, 0);
  assert.equal(store.stored, null);
  assert.equal(store.failureDiagnostics[0]?.checks.find(({ id }) => id === 'html_safety')?.status, 'failed');
});

test('Phase 2 publishes a ready report only after Planner and independent Fidelity pass', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const { port, client } = modelPort([
    plan,
    {
      version: 'editorial-fidelity-plan-v1',
      checks: [{
        copyPointer: '/deck',
        materialUnitIds: [material.methodSummaryUnitId],
        verdict: 'faithful',
      }],
    },
  ]);
  const events: string[] = [];
  const verifier = {
    readCurrent: async () => { events.push('source'); return source; },
    assertStillCurrent: async () => { events.push('fence'); },
  };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const pipeline = new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: port,
    materialize: () => materializeResult(material),
    now: () => new Date('2026-08-27T09:00:00.000Z'),
  });

  const result = await pipeline.generate({ taskId: TASK_ID });

  assert.equal(result.status, 'ready');
  assert.equal(store.stored?.slot, 'ready');
  assert.deepEqual(client.calls.map(({ schemaName }) => schemaName), [
    'editorial-report-blueprint',
    'editorial-report-fidelity',
  ]);
  assert.deepEqual(
    client.calls.map(({ systemPrompt }) => systemPrompt),
    [EDITORIAL_MODEL_SYSTEM_PROMPT, EDITORIAL_MODEL_SYSTEM_PROMPT],
  );
  assert.deepEqual(events, ['source', 'fence', 'fence', 'fence']);
  assert.equal(store.stored?.manifest.modelCalls.length, 2);
  const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
  assert.equal(diagnostic.status, 'pass');
  assert.equal(diagnostic.candidateAttempts.length, 1);
  assert.equal(diagnostic.candidateAttempts[0]?.outcome, 'accepted');
  assert.equal(diagnostic.candidateAttempts[0]?.fidelityReview?.verdict, 'pass');
});

test('Phase 2 gives one bounded repair attempt after a rejected Blueprint', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const { port, client } = modelPort([
    {},
    plan,
    {
      version: 'editorial-fidelity-plan-v1',
      checks: [{
        copyPointer: '/deck',
        materialUnitIds: [material.methodSummaryUnitId],
        verdict: 'narrower',
      }],
    },
  ]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'ready');
  assert.equal(client.calls.length, 3);
  assert.equal('repairHints' in client.calls[1]!.context, true);
  const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
  assert.deepEqual(diagnostic.candidateAttempts.map(({ outcome }) => outcome), ['rejected', 'accepted']);
  assert.deepEqual(diagnostic.rejectedResponseHashes, [diagnostic.candidateAttempts[0]!.plannerCall.responseHash]);
});

test('Phase 2 publishes the preflighted fallback when the Gateway call fails', async () => {
  const { source, material } = fixture();
  const invocationError = new LLMInvocationError('timeout', true, null, 'gateway request timed out');
  const { port, client } = modelPort([invocationError]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'degraded');
  assert.equal(client.calls.length, 1);
  assert.equal(store.stored?.slot, 'fallback');
  const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
  assert.equal(diagnostic.candidateAttempts[0]?.outcome, 'call_failed');
  assert.equal(diagnostic.candidateAttempts[0]?.plannerCall.status, 'failed');
  assert.deepEqual(diagnostic.candidateAttempts[0]?.issueCodes, ['LLM_TIMEOUT']);
});

test('Phase 2 logs this run when a failed LLM attempt reuses an immutable fallback', async () => {
  const { source, material } = fixture();
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  const firstModel = modelPort([
    new LLMInvocationError('timeout', true, null, 'first private failure'),
  ]);
  const first = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: firstModel.port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });
  const originalDiagnostic = Buffer.from(store.stored!.diagnosticBytes);

  const auditLines: string[] = [];
  const secondModel = modelPort([
    new LLMInvocationError('network', true, null, 'second private failure must not be logged'),
  ]);
  const second = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: secondModel.port,
    materialize: () => materializeResult(material),
    writeAuditLine: (line) => { auditLines.push(line); },
  }).generate({ taskId: TASK_ID });

  assert.equal(second.status, 'degraded');
  assert.equal(second.generationId, first.generationId);
  assert.equal(secondModel.client.calls.length, 1);
  assert.deepEqual(store.stored!.diagnosticBytes, originalDiagnostic);
  assert.equal(auditLines.length, 1);
  assert.doesNotMatch(auditLines[0]!, /private failure/u);
  const audit = JSON.parse(auditLines[0]!) as {
    event: string;
    generationId: string;
    issueCodes: string[];
    modelCalls: Array<{ status: string; failureCode?: string }>;
  };
  assert.equal(audit.event, 'fallback_reused_after_llm_failure');
  assert.equal(audit.generationId, first.generationId);
  assert.deepEqual(audit.issueCodes, ['LLM_NETWORK']);
  assert.deepEqual(audit.modelCalls.map(({ status, failureCode }) => ({ status, failureCode })), [
    { status: 'failed', failureCode: 'LLM_NETWORK' },
  ]);
});

test('Phase 2 re-fences fallback reuse after asynchronous audit before returning', async () => {
  const { source, material } = fixture();
  const stableVerifier = {
    readCurrent: async () => source,
    assertStillCurrent: async () => undefined,
  };
  const store = new MemoryStore(stableVerifier.assertStillCurrent);
  await new EditorialReportPipeline({
    source: stableVerifier,
    store,
    modelPort: modelPort([
      new LLMInvocationError('timeout', true, null, 'first failure'),
    ]).port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });
  const originalGenerationId = store.stored!.generationId;

  let sourceIsCurrent = true;
  let fenceCalls = 0;
  let auditCalls = 0;
  const verifier = {
    readCurrent: async () => source,
    assertStillCurrent: async () => {
      fenceCalls += 1;
      if (!sourceIsCurrent) throw new EditorialSourceError('SOURCE_BINDING_CHANGED');
    },
  };
  const configured = modelPort([
    new LLMInvocationError('network', true, null, 'second failure'),
  ]);

  await assert.rejects(
    new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: configured.port,
      materialize: () => materializeResult(material),
      writeAuditLine: async () => {
        auditCalls += 1;
        sourceIsCurrent = false;
      },
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'SOURCE_BINDING_CHANGED',
  );

  assert.equal(fenceCalls, 3);
  assert.equal(auditCalls, 1);
  assert.equal(configured.client.calls.length, 1);
  assert.equal(store.stored?.generationId, originalGenerationId);
  assert.equal(store.failureDiagnostics.length, 0);
});

test('Phase 2 treats a receiptId property as a hard wiring failure even when its value is undefined', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const { port, client } = modelPort(
    [plan],
    (result) => ({ ...result, receiptId: undefined }),
  );
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);

  await assert.rejects(
    new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: port,
      materialize: () => materializeResult(material),
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_RECEIPT_CLIENT_FORBIDDEN',
  );

  assert.equal(client.calls.length, 1);
  assert.equal(store.stored, null);
  assert.equal(store.failureDiagnostics.length, 1);
  const diagnostic = store.failureDiagnostics[0]!;
  assert.equal(diagnostic.status, 'fail');
  assert.equal(diagnostic.mode, 'llm');
  assert.equal(diagnostic.candidateAttempts.length, 1);
  assert.equal(diagnostic.candidateAttempts[0]?.outcome, 'call_failed');
  assert.equal(diagnostic.candidateAttempts[0]?.plannerCall.status, 'failed');
  assert.equal(
    diagnostic.checks.find(({ id }) => id === 'model_identity')?.status,
    'failed',
  );
  assert.equal(
    diagnostic.checks.find(({ id }) => id === 'composition_quality')?.status,
    'not_run',
  );
});

test('Phase 2 records invalid provider identity and actual-model drift before using fallback', async () => {
  const cases = [
    {
      expectedCode: 'MODEL_IDENTITY_INVALID',
      mutate: (result: LLMResult<unknown>) => ({
        ...result,
        expectedModel: 'untrusted-expected-model',
        modelName: 'untrusted-actual-model',
        providerIdentity: {
          provider: 'untrusted-provider',
          endpointHost: 'untrusted.invalid',
          requestedModel: 'untrusted-requested-model',
          mode: 'real' as const,
          eligibleAsReal: true,
        },
      }),
    },
    {
      expectedCode: 'MODEL_DRIFT',
      mutate: (result: LLMResult<unknown>) => ({ ...result, modelName: 'unexpected-actual-model' }),
    },
  ];
  for (const scenario of cases) {
    const { source, material } = fixture();
    const { port, client } = modelPort([blueprintPlan(material)], scenario.mutate);
    const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
    const store = new MemoryStore(verifier.assertStillCurrent);

    const result = await new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: port,
      materialize: () => materializeResult(material),
    }).generate({ taskId: TASK_ID });

    assert.equal(result.status, 'degraded');
    assert.equal(client.calls.length, 1);
    const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
    assert.deepEqual(diagnostic.candidateAttempts[0]?.issueCodes, [scenario.expectedCode]);
    const call = diagnostic.candidateAttempts[0]?.plannerCall;
    assert.equal(call?.status, 'failed');
    if (call?.status === 'failed') {
      for (const field of [
        'provider', 'endpointHost', 'requestedModel', 'expectedModel', 'actualModel', 'modelVersion', 'traceId',
      ] as const) {
        assert.equal(field in call, false, `${field} came from an untrusted failed response`);
      }
    }
  }
});

test('Phase 2 degrades safely when Gateway receipt metadata is out of bounds', async () => {
  const cases = [
    {
      mutate: (result: LLMResult<unknown>) => ({ ...result, traceId: 'x'.repeat(257) }),
      unsafeTraceId: 'x'.repeat(257),
    },
    {
      mutate: (result: LLMResult<unknown>) => ({
        ...result,
        tokens: { prompt: 10, completion: 5, total: 14 },
      }),
      unsafeTraceId: undefined,
    },
  ];
  for (const scenario of cases) {
    const { source, material } = fixture();
    const { port, client } = modelPort([blueprintPlan(material)], scenario.mutate);
    const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
    const store = new MemoryStore(verifier.assertStillCurrent);

    const result = await new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: port,
      materialize: () => materializeResult(material),
    }).generate({ taskId: TASK_ID });

    assert.equal(result.status, 'degraded');
    assert.equal(client.calls.length, 1);
    const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
    assert.deepEqual(diagnostic.candidateAttempts[0]?.issueCodes, ['MODEL_METADATA_INVALID']);
    assert.equal(diagnostic.checks.find(({ id }) => id === 'model_identity')?.status, 'failed');
    const call = diagnostic.candidateAttempts[0]?.plannerCall;
    assert.equal(call?.status, 'failed');
    if (call?.status === 'failed' && scenario.unsafeTraceId !== undefined) {
      assert.equal(call.traceId, undefined);
    }
  }
});

test('Phase 2 fences binding and client configuration immediately before every model call', async () => {
  const bindingCase = fixture();
  const bindingModel = modelPort([
    blueprintPlan(bindingCase.material),
    {
      version: 'editorial-fidelity-plan-v1',
      checks: [{
        copyPointer: '/deck',
        materialUnitIds: [bindingCase.material.methodSummaryUnitId],
        verdict: 'faithful',
      }],
    },
  ]);
  let bindingFences = 0;
  const bindingVerifier = {
    readCurrent: async () => bindingCase.source,
    assertStillCurrent: async () => {
      bindingFences += 1;
      if (bindingFences === 2) throw new EditorialSourceError('SOURCE_BINDING_CHANGED');
    },
  };
  const bindingStore = new MemoryStore(bindingVerifier.assertStillCurrent);

  await assert.rejects(
    new EditorialReportPipeline({
      source: bindingVerifier,
      store: bindingStore,
      modelPort: bindingModel.port,
      materialize: () => materializeResult(bindingCase.material),
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError && error.code === 'SOURCE_BINDING_CHANGED',
  );
  assert.equal(bindingFences, 2);
  assert.equal(bindingModel.client.calls.length, 1);
  assert.equal(bindingStore.stored, null);

  const portCase = fixture();
  const portModel = modelPort(
    [blueprintPlan(portCase.material)],
    undefined,
    (identity, readCount) => readCount === 1
      ? identity
      : { ...identity, endpointUrl: 'http://llm-gw.jd.local/changed/chat/completions' },
  );
  const portVerifier = { readCurrent: async () => portCase.source, assertStillCurrent: async () => undefined };
  const portStore = new MemoryStore(portVerifier.assertStillCurrent);

  await assert.rejects(
    new EditorialReportPipeline({
      source: portVerifier,
      store: portStore,
      modelPort: portModel.port,
      materialize: () => materializeResult(portCase.material),
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_MODEL_PORT_MISMATCH',
  );
  assert.equal(portModel.client.calls.length, 1);
  assert.equal(portStore.stored, null);
  assert.equal(portStore.failureDiagnostics.length, 1);
  assert.equal(portStore.failureDiagnostics[0]?.mode, 'llm');
  assert.equal(portStore.failureDiagnostics[0]?.candidateAttempts.length, 1);
  assert.equal(portStore.failureDiagnostics[0]?.candidateAttempts[0]?.plannerCall.status, 'succeeded');

  const synchronousCase = fixture();
  let mutablePort: Extract<EditorialModelPort, { client: object }>;
  const synchronousModel = modelPort(
    [blueprintPlan(synchronousCase.material)],
    undefined,
    (identity) => {
      mutablePort.configuration = modelConfiguration('replacement-model', 'replacement-model-v1');
      return {
        ...identity,
        routes: [{
          requestedModel: 'replacement-model',
          expectedActualModel: 'replacement-model-v1',
          expectedActualModelExplicit: true,
        }],
      };
    },
  );
  mutablePort = synchronousModel.port as Extract<EditorialModelPort, { client: object }>;
  const synchronousVerifier = {
    readCurrent: async () => synchronousCase.source,
    assertStillCurrent: async () => undefined,
  };
  const synchronousStore = new MemoryStore(synchronousVerifier.assertStillCurrent);

  await assert.rejects(
    new EditorialReportPipeline({
      source: synchronousVerifier,
      store: synchronousStore,
      modelPort: mutablePort,
      materialize: () => materializeResult(synchronousCase.material),
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'EDITORIAL_MODEL_PORT_MISMATCH',
  );
  assert.equal(synchronousModel.client.calls.length, 0);
  assert.equal(synchronousStore.stored, null);
  assert.equal(synchronousStore.failureDiagnostics[0]?.gatewayConfigurationHash, modelConfiguration().gatewayConfigurationHash);
});

test('Phase 2 egress denial publishes fallback without calling the configured model', async () => {
  const { source, material } = fixture();
  const configured = modelPort([blueprintPlan(material)]);
  const materialization = materializeResult(material);
  materialization.sourcePolicyMetadata = materialization.sourcePolicyMetadata.map((entry) => ({
    ...entry,
    sensitivity: 'confidential',
  }));
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);

  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: configured.port,
    materialize: () => materialization,
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'degraded');
  assert.equal(configured.client.calls.length, 0);
  assert.equal(store.stored?.manifest.pipeline.modelEgress.reasonCode, 'EGRESS_SENSITIVITY_DENIED');
  assert.deepEqual(store.stored?.manifest.modelCalls, []);
});

test('Phase 2 performs only one repair after two rejected Planner candidates then publishes fallback', async () => {
  const { source, material } = fixture();
  const configured = modelPort([{}, {}]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);

  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: configured.port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(configured.client.calls.map(({ schemaName }) => schemaName), [
    'editorial-report-blueprint',
    'editorial-report-blueprint',
  ]);
  const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
  assert.deepEqual(diagnostic.candidateAttempts.map(({ outcome }) => outcome), ['rejected', 'rejected']);
});

test('Phase 2 never exceeds two Planner and two Fidelity calls', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const blockedReview = {
    version: 'editorial-fidelity-plan-v1',
    checks: [{
      copyPointer: '/deck',
      materialUnitIds: [material.methodSummaryUnitId],
      verdict: 'unsupported',
    }],
  };
  const configured = modelPort([plan, blockedReview, plan, blockedReview, plan]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);

  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: configured.port,
    materialize: () => materializeResult(material),
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(configured.client.calls.map(({ schemaName }) => schemaName), [
    'editorial-report-blueprint',
    'editorial-report-fidelity',
    'editorial-report-blueprint',
    'editorial-report-fidelity',
  ]);
});

test('Phase 2 never masks a hard candidate renderer failure with the preflighted fallback', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const configured = modelPort([
    plan,
    {
      version: 'editorial-fidelity-plan-v1',
      checks: [{
        copyPointer: '/deck',
        materialUnitIds: [material.methodSummaryUnitId],
        verdict: 'faithful',
      }],
    },
  ]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  let renderCalls = 0;

  await assert.rejects(
    new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: configured.port,
      materialize: () => materializeResult(material),
      render: (input) => {
        renderCalls += 1;
        const rendered = renderEditorialReport(input);
        if (renderCalls === 1) return rendered;
        return {
          ...rendered,
          htmlBytes: Buffer.concat([rendered.htmlBytes, Buffer.from('<script>alert(1)</script>')]),
        };
      },
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError && error.code === 'EDITORIAL_HTML_UNSAFE',
  );

  assert.equal(renderCalls, 2);
  assert.equal(store.stored, null);
  assert.equal(store.failureDiagnostics.length, 1);
  assert.equal(store.failureDiagnostics[0]?.mode, 'llm');
  assert.equal(store.failureDiagnostics[0]?.candidateAttempts.length, 1);
  assert.equal(store.failureDiagnostics[0]?.candidateAttempts[0]?.plannerCall.status, 'succeeded');
  assert.equal(store.failureDiagnostics[0]?.candidateAttempts[0]?.fidelityCall?.status, 'succeeded');
});

test('Phase 2 rejects an oversized candidate and publishes the preflighted fallback', async () => {
  const { source, material } = fixture();
  const plan = blueprintPlan(material);
  const review = {
    version: 'editorial-fidelity-plan-v1',
    checks: [{
      copyPointer: '/deck',
      materialUnitIds: [material.methodSummaryUnitId],
      verdict: 'faithful',
    }],
  };
  const configured = modelPort([plan, review, plan, review]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  let renderCalls = 0;

  const result = await new EditorialReportPipeline({
    source: verifier,
    store,
    modelPort: configured.port,
    materialize: () => materializeResult(material),
    render: (input) => {
      renderCalls += 1;
      const rendered = renderEditorialReport(input);
      return renderCalls === 1
        ? rendered
        : { ...rendered, htmlBytes: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20) };
    },
  }).generate({ taskId: TASK_ID });

  assert.equal(result.status, 'degraded');
  assert.equal(renderCalls, 3);
  assert.equal(configured.client.calls.length, 4);
  const diagnostic = parseEditorialDiagnostic(JSON.parse(store.stored!.diagnosticBytes.toString('utf8')));
  assert.deepEqual(diagnostic.candidateAttempts.map(({ issueCodes }) => issueCodes), [
    ['SOURCE_NOT_RENDERABLE'],
    ['SOURCE_NOT_RENDERABLE'],
  ]);
});

test('Phase 2 hard-fails when the Renderer forges its composition trace', async () => {
  const { source, material } = fixture();
  const configured = modelPort([
    blueprintPlan(material),
    {
      version: 'editorial-fidelity-plan-v1',
      checks: [{
        copyPointer: '/deck',
        materialUnitIds: [material.methodSummaryUnitId],
        verdict: 'faithful',
      }],
    },
  ]);
  const verifier = { readCurrent: async () => source, assertStillCurrent: async () => undefined };
  const store = new MemoryStore(verifier.assertStillCurrent);
  let renderCalls = 0;

  await assert.rejects(
    new EditorialReportPipeline({
      source: verifier,
      store,
      modelPort: configured.port,
      materialize: () => materializeResult(material),
      render: (input) => {
        renderCalls += 1;
        const rendered = renderEditorialReport(input);
        if (renderCalls === 1) return rendered;
        return {
          ...rendered,
          trace: { ...rendered.trace, eligibleCompositionKinds: ['flow'] },
        };
      },
    }).generate({ taskId: TASK_ID }),
    (error: unknown) => error instanceof EditorialPipelineError
      && error.code === 'COMPOSITION_QUALITY',
  );

  assert.equal(renderCalls, 2);
  assert.equal(store.stored, null);
  assert.equal(store.failureDiagnostics[0]?.candidateAttempts.length, 1);
});
