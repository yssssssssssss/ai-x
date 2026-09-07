import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentReportPackageResponse } from '../packages/api-contract/control-workflow.ts';
import type { ControlArtifact } from '../database/control-plane.ts';
import {
  EditorialMaterializationError,
} from '../apps/orchestrator-runtime/src/report/editorial-report-materializer.ts';
import {
  EditorialRendererError,
} from '../apps/orchestrator-runtime/src/report/editorial-report-renderer.ts';
import { EditorialSourceError } from '../apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts';
import {
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
  canonicalJsonBytes,
  canonicalSha256,
  createEditorialMaterialUnitId,
  parseEditorialDiagnostic,
  parseEditorialReport,
  projectEditorialModelContext,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type EditorialModelPort,
  type FrozenEditorialSource,
  type Sha256,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';

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
  assert.equal(fences, 2);
});

test('Phase 1 rejects a non-null model port instead of silently making an outbound call', () => {
  const { source } = fixture();
  const modelPort = { client: {}, configuration: {} } as unknown as EditorialModelPort;
  assert.throws(() => new EditorialReportPipeline({ source: { readCurrent: async () => source, assertStillCurrent: async () => undefined }, store: {} as EditorialPipelineStore, modelPort }), (error: unknown) => error instanceof EditorialPipelineError && error.code === 'EDITORIAL_PHASE1_MODEL_FORBIDDEN');
});
