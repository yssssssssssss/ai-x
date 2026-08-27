import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  buildDeterministicEditorialBlueprint,
  buildEditorialFidelityReview,
  buildPhase1PublishedDiagnostic,
  buildPhase2PublishedDiagnostic,
  canonicalJsonBytes,
  createEditorialGenerationId,
  createEditorialMaterialUnitId,
  createEditorialRequestKey,
  evaluateEditorialModelEgress,
  enumerateEditorialParaphrases,
  hashBytes,
  NO_EDITORIAL_MODEL_PORT,
  projectEditorialModelContext,
  type EditorialBlueprint,
  type EditorialDiagnostic,
  type EditorialGatewayConfiguration,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type EditorialModelPort,
  type EditorialReport,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  EditorialReportStore,
  EditorialStoreError,
  type EditorialStorePublishInput,
} from '../apps/orchestrator-runtime/src/report/editorial-report-store.ts';
import {
  renderEditorialReport,
  type EditorialRenderableVisualAsset,
} from '../apps/orchestrator-runtime/src/report/editorial-report-renderer.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const PACKAGE_HASH = `sha256:${'c'.repeat(64)}` as const;
const DELIVERABLE_HASH = `sha256:${'d'.repeat(64)}` as const;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const FAILURE_EXPECTED = {
  planVersionId: PLAN_ID,
  attemptId: ATTEMPT_ID,
  sourceReportPackage: {
    artifactId: PACKAGE_ID,
    kind: 'report_package',
    schemaVersion: 'report-package-v1',
    contentSha256: PACKAGE_HASH,
  },
} as const;

function fixtureMaterial(): EditorialMaterial {
  const sourceReportPackage = {
    artifactId: PACKAGE_ID,
    kind: 'report_package',
    schemaVersion: 'report-package-v1',
    contentSha256: PACKAGE_HASH,
  };
  const sourceArtifact = {
    artifactId: 'deliverable-1',
    kind: 'deliverable',
    schemaVersion: 'research-deliverable-v1-review-gated',
    contentSha256: DELIVERABLE_HASH,
  };
  const unit = (
    pointer: string,
    value: string,
    role: 'context' | 'risk',
  ): EditorialMaterialUnit => {
    const base = {
      id: createEditorialMaterialUnitId({
        sourceArtifactId: sourceArtifact.artifactId,
        sourceArtifactContentSha256: sourceArtifact.contentSha256,
        sourceJsonPointer: pointer,
        role,
        value,
      }),
      value,
      metricEligible: false,
      sourceRefs: [{ artifactId: sourceArtifact.artifactId, jsonPointer: pointer }] as const,
      basisUnitIds: [],
      evidenceIds: [],
      questionIds: role === 'risk' ? ['question-1'] : [],
      requiredInOutput: true,
      requiredInBody: true,
    };
    if (role === 'risk') return { ...base, role, epistemicStatus: 'unknown' };
    return { ...base, role };
  };
  const method = unit('/methodSummary', '基于已封存材料', 'context');
  const risk = unit('/risksAndOpenIssues/0', '仍需验证', 'risk');
  return {
    version: 'editorial-material-v1',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    deliverableType: 'research_plan',
    presentationMode: 'current_text',
    sourceReportPackage,
    sourceArtifacts: [sourceReportPackage, sourceArtifact],
    materializationWarningCodes: [],
    methodSummaryUnitId: method.id,
    units: [method, risk],
    assets: [],
    evidence: [],
  };
}

const BASE_MATERIAL = fixtureMaterial();
const BASE_MODEL_CONTEXT = projectEditorialModelContext(BASE_MATERIAL);
const BASE_MODEL_EGRESS = evaluateEditorialModelEgress({
  sourcePolicyMetadata: BASE_MATERIAL.sourceArtifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    contentSha256: artifact.contentSha256,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  })),
  modelPort: NO_EDITORIAL_MODEL_PORT,
});
const REQUEST_KEY = createEditorialRequestKey({
  sourceReportPackageId: PACKAGE_ID,
  sourceReportPackageHash: PACKAGE_HASH,
  materialHash: hashBytes(canonicalJsonBytes(BASE_MATERIAL)),
  modelContextHash: BASE_MODEL_CONTEXT.hash,
  modelEgress: BASE_MODEL_EGRESS,
  gatewayConfiguration: null,
});

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'editorial-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function bundle(
  slot: 'fallback' = 'fallback',
  overrides: Partial<EditorialStorePublishInput> = {},
  variant: {
    generationId?: string;
    material?: EditorialMaterial;
    exportedAssets?: EditorialReport['exportedAssets'];
    assetBytes?: Readonly<Record<string, Buffer>>;
    generatedAt?: string;
  } = {},
): EditorialStorePublishInput {
  const material = structuredClone(variant.material ?? BASE_MATERIAL);
  const sourceReportPackage = material.sourceReportPackage;
  const modelContext = projectEditorialModelContext(material);
  const materialBytes = canonicalJsonBytes(material);
  const materialHash = hashBytes(materialBytes);
  const modelEgress = evaluateEditorialModelEgress({
    sourcePolicyMetadata: material.sourceArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      contentSha256: artifact.contentSha256,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    })),
    modelPort: NO_EDITORIAL_MODEL_PORT,
  });
  const requestKey = createEditorialRequestKey({
    sourceReportPackageId: sourceReportPackage.artifactId,
    sourceReportPackageHash: sourceReportPackage.contentSha256,
    materialHash,
    modelContextHash: modelContext.hash,
    modelEgress,
    gatewayConfiguration: null,
  });
  const blueprint = buildDeterministicEditorialBlueprint({ material, requestKey });
  const sourceById = new Map(material.sourceArtifacts.map((source) => [source.artifactId, source]));
  const verifiedVisualAssets: EditorialRenderableVisualAsset[] = material.assets.map((asset) => {
    const bytes = variant.assetBytes?.[asset.assetId];
    const source = sourceById.get(asset.assetId);
    assert.ok(bytes, `missing fixture bytes for ${asset.assetId}`);
    assert.ok(source, `missing fixture source for ${asset.assetId}`);
    return {
      artifact: { id: asset.assetId },
      manifestArtifact: { id: asset.manifestArtifactId },
      bytes,
      manifest: { contentSha256: source.contentSha256 },
    };
  });
  const rendered = renderEditorialReport({ material, blueprint, verifiedVisualAssets });
  const blueprintBytes = canonicalJsonBytes(blueprint);
  const blueprintHash = hashBytes(blueprintBytes);
  const exportedAssets = variant.exportedAssets ?? rendered.exportedAssets;
  const generationId = variant.generationId ?? createEditorialGenerationId({
    requestKey,
    mode: 'deterministic_fallback',
    materialHash,
    publishedBlueprintHash: blueprintHash,
    exportedAssetHashes: exportedAssets,
  });
  const htmlBytes = rendered.htmlBytes;
  const htmlHash = hashBytes(htmlBytes);
  const diagnostic = buildPhase1PublishedDiagnostic({
    material,
    requestKey,
    materialHash,
    modelEgress,
    modelContextHash: modelContext.hash,
    modelContextByteSize: modelContext.byteSize,
    generationId,
    publishedBlueprintHash: blueprintHash,
    htmlHash,
    rendererWarningCodes: rendered.warnings.map(({ code }) => code),
  });
  const diagnosticBytes = canonicalJsonBytes(diagnostic);
  const derived = (
    relativePath: string,
    bytes: Buffer,
    mediaType: 'application/json' | 'text/html',
  ) => ({ relativePath, contentSha256: hashBytes(bytes), byteSize: bytes.byteLength, mediaType });
  const manifest: EditorialReport = {
    version: 'editorial-report-v1',
    authority: 'derived',
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    requestKey,
    generationId,
    status: 'degraded',
    sourceReportPackage,
    pipeline: {
      materialVersion: 'editorial-material-v1',
      modelContextVersion: 'editorial-model-context-v1',
      modelContextHash: modelContext.hash,
      blueprintPlanVersion: 'editorial-blueprint-plan-v1',
      blueprintVersion: 'editorial-blueprint-v1',
      promptVersion: 'editorial-blueprint-prompt-v2',
      fidelityPromptVersion: 'editorial-fidelity-prompt-v2',
      fallbackVersion: 'editorial-fallback-v1',
      rendererVersion: 'editorial-html-v1',
      storeVersion: 'editorial-store-v1',
      modelEgress,
      gatewayConfiguration: null,
    },
    modelCalls: [],
    exportedAssets,
    files: {
      material: derived('editorial-material.json', materialBytes, 'application/json'),
      blueprint: derived('editorial-blueprint.json', blueprintBytes, 'application/json'),
      diagnostic: derived('editorial-diagnostic.json', diagnosticBytes, 'application/json'),
      html: {
        ...derived('editorial-report.html', htmlBytes, 'text/html'),
        mediaType: 'text/html',
        selfContained: true,
        printProfile: 'a4-portrait-v1',
      },
    },
    generatedAt: variant.generatedAt ?? '2026-08-27T06:00:00.000Z',
  };
  return {
    slot,
    materialBytes,
    blueprintBytes,
    diagnosticBytes,
    htmlBytes,
    manifestBytes: canonicalJsonBytes(manifest),
    assertStillCurrent: async () => {},
    ...overrides,
  };
}

function configuredFailureBundle(): EditorialStorePublishInput {
  const configurationBody = {
    provider: 'gateway',
    endpointHost: 'llm-gw.jd.local',
    endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real' as const,
    eligibleAsReal: true,
    redirectMode: 'error' as const,
    routes: [{
      requestedModel: 'route-a',
      expectedActualModel: 'actual-a',
      expectedActualModelExplicit: true as const,
    }],
    limits: {
      overallTimeoutMs: 90_000 as const,
      maxHttpAttempts: 3 as const,
      maxRetryAfterMs: 5_000 as const,
      maxResponseBytes: 1_048_576 as const,
      maxOutputTokens: 8_000 as const,
    },
  };
  const configuration: EditorialGatewayConfiguration = {
    ...configurationBody,
    gatewayConfigurationHash: hashBytes(canonicalJsonBytes(configurationBody)),
  };
  const modelPort: EditorialModelPort = {
    client: {
      configurationIdentity: {
        provider: configuration.provider,
        endpointHost: configuration.endpointHost,
        endpointUrl: configuration.endpointUrl,
        mode: configuration.mode,
        eligibleAsReal: configuration.eligibleAsReal,
        routes: configuration.routes,
      },
      async generateStructured<T>(): Promise<never> {
        throw new Error('not called');
      },
    },
    configuration,
  };

  return rewriteBundle(bundle(), (draft) => {
    const materialBytes = canonicalJsonBytes(draft.material);
    const materialHash = hashBytes(materialBytes);
    const modelContext = projectEditorialModelContext(draft.material);
    const modelEgress = evaluateEditorialModelEgress({
      sourcePolicyMetadata: draft.material.sourceArtifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        contentSha256: artifact.contentSha256,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
      })),
      modelPort,
    });
    const requestKey = createEditorialRequestKey({
      sourceReportPackageId: draft.material.sourceReportPackage.artifactId,
      sourceReportPackageHash: draft.material.sourceReportPackage.contentSha256,
      materialHash,
      modelContextHash: modelContext.hash,
      modelEgress,
      gatewayConfiguration: configuration,
    });
    draft.blueprint = buildDeterministicEditorialBlueprint({ material: draft.material, requestKey });
    const rendered = renderEditorialReport({
      material: draft.material,
      blueprint: draft.blueprint,
      verifiedVisualAssets: [],
    });
    draft.htmlBytes = rendered.htmlBytes;
    const blueprintHash = hashBytes(canonicalJsonBytes(draft.blueprint));
    const generationId = createEditorialGenerationId({
      requestKey,
      mode: 'deterministic_fallback',
      materialHash,
      publishedBlueprintHash: blueprintHash,
      exportedAssetHashes: rendered.exportedAssets,
    });
    const plannerCall = {
      stage: 'editorial_blueprint' as const,
      ordinal: 1 as const,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      promptVersion: 'editorial-blueprint-prompt-v2',
      promptHash: `sha256:${'1'.repeat(16)}` as const,
      status: 'failed' as const,
      failureCode: 'LLM_SERVER',
    };
    const candidateAttempts = [{
      ordinal: 1 as const,
      plannerCall,
      outcome: 'call_failed' as const,
      issueCodes: ['LLM_SERVER'],
    }];
    draft.diagnostic = buildPhase2PublishedDiagnostic({
      material: draft.material,
      requestKey,
      materialHash,
      modelEgress,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      generationId,
      publishedBlueprintHash: blueprintHash,
      htmlHash: hashBytes(draft.htmlBytes),
      status: 'degraded',
      candidateAttempts,
      rendererWarningCodes: rendered.warnings.map(({ code }) => code),
      degradedReasonCodes: ['LLM_SERVER'],
    });
    draft.manifest = {
      ...draft.manifest,
      requestKey,
      generationId,
      pipeline: {
        ...draft.manifest.pipeline,
        modelContextHash: modelContext.hash,
        modelEgress,
        gatewayConfiguration: configuration,
      },
      modelCalls: [plannerCall],
      exportedAssets: rendered.exportedAssets,
    };
  });
}

function blueprintPlanHash(blueprint: EditorialBlueprint): `sha256:${string}` {
  return hashBytes(canonicalJsonBytes({
    version: 'editorial-blueprint-plan-v1',
    locale: blueprint.locale,
    ...(blueprint.title === undefined ? {} : { title: blueprint.title }),
    deck: blueprint.deck,
    sections: blueprint.sections.slice(0, -1),
  }));
}

function configuredReadyBundle(): EditorialStorePublishInput {
  const rewritten = rewriteBundle(configuredFailureBundle(), (draft) => {
    const configuration = draft.manifest.pipeline.gatewayConfiguration;
    assert.ok(configuration);
    const modelContext = projectEditorialModelContext(draft.material);
    const materialHash = hashBytes(canonicalJsonBytes(draft.material));
    const blueprintHash = hashBytes(canonicalJsonBytes(draft.blueprint));
    const rendered = renderEditorialReport({
      material: draft.material,
      blueprint: draft.blueprint,
      verifiedVisualAssets: [],
    });
    draft.htmlBytes = rendered.htmlBytes;
    const generationId = createEditorialGenerationId({
      requestKey: draft.manifest.requestKey,
      mode: 'llm',
      materialHash,
      publishedBlueprintHash: blueprintHash,
      exportedAssetHashes: rendered.exportedAssets,
    });
    const route = configuration.routes[0]!;
    const plannerCall = {
      stage: 'editorial_blueprint' as const,
      ordinal: 1 as const,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      promptVersion: 'editorial-blueprint-prompt-v2',
      promptHash: `sha256:${'1'.repeat(16)}` as const,
      status: 'succeeded' as const,
      provider: configuration.provider,
      endpointHost: configuration.endpointHost,
      requestedModel: route.requestedModel,
      expectedModel: route.expectedActualModel,
      actualModel: route.expectedActualModel,
      modelVersion: route.expectedActualModel,
      traceId: 'trace-ready-1',
      responseHash: blueprintPlanHash(draft.blueprint),
    };
    const candidateAttempts = [{
      ordinal: 1 as const,
      blueprintHash,
      plannerCall,
      outcome: 'accepted' as const,
      issueCodes: [],
    }];
    draft.diagnostic = buildPhase2PublishedDiagnostic({
      material: draft.material,
      requestKey: draft.manifest.requestKey,
      materialHash,
      modelEgress: draft.manifest.pipeline.modelEgress,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      generationId,
      publishedBlueprintHash: blueprintHash,
      htmlHash: hashBytes(draft.htmlBytes),
      status: 'ready',
      candidateAttempts,
      rendererWarningCodes: rendered.warnings.map(({ code }) => code),
    });
    draft.manifest = {
      ...draft.manifest,
      generationId,
      status: 'ready',
      modelCalls: [plannerCall],
      exportedAssets: rendered.exportedAssets,
    };
  });
  return { ...rewritten, slot: 'ready' };
}

function configuredParaphraseReadyBundle(): EditorialStorePublishInput {
  return rewriteBundle(configuredReadyBundle(), (draft) => {
    const configuration = draft.manifest.pipeline.gatewayConfiguration;
    assert.ok(configuration);
    const decisionCover = draft.blueprint.sections
      .flatMap(({ blocks }) => blocks)
      .find(({ kind }) => kind === 'decision-cover');
    assert.ok(decisionCover?.kind === 'decision-cover');
    decisionCover.summary = { ...decisionCover.summary, mode: 'paraphrase' };
    const materialHash = hashBytes(canonicalJsonBytes(draft.material));
    const blueprintHash = hashBytes(canonicalJsonBytes(draft.blueprint));
    const paraphrases = enumerateEditorialParaphrases(draft.blueprint);
    assert.equal(paraphrases.length, 1);
    const fidelityReview = buildEditorialFidelityReview({
      plan: {
        version: 'editorial-fidelity-plan-v1',
        checks: paraphrases.map(({ copyPointer, materialUnitIds }) => ({
          copyPointer,
          materialUnitIds,
          verdict: 'faithful' as const,
        })),
      },
      materialHash,
      blueprint: draft.blueprint,
    });
    const modelContext = projectEditorialModelContext(draft.material);
    const route = configuration.routes[0]!;
    const plannerCall = draft.diagnostic.candidateAttempts[0]!.plannerCall;
    assert.equal(plannerCall.status, 'succeeded');
    plannerCall.responseHash = blueprintPlanHash(draft.blueprint);
    const fidelityPlan = {
      version: 'editorial-fidelity-plan-v1' as const,
      checks: fidelityReview.checks,
    };
    const fidelityCall = {
      stage: 'editorial_fidelity_review' as const,
      ordinal: 1 as const,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      promptVersion: 'editorial-fidelity-prompt-v2',
      promptHash: `sha256:${'3'.repeat(16)}` as const,
      status: 'succeeded' as const,
      provider: configuration.provider,
      endpointHost: configuration.endpointHost,
      requestedModel: route.requestedModel,
      expectedModel: route.expectedActualModel,
      actualModel: route.expectedActualModel,
      modelVersion: route.expectedActualModel,
      traceId: 'trace-fidelity-1',
      responseHash: hashBytes(canonicalJsonBytes(fidelityPlan)),
      inputBlueprintHash: blueprintHash,
    };
    const candidateAttempts = [{
      ordinal: 1 as const,
      blueprintHash,
      plannerCall,
      fidelityCall,
      fidelityReviewHash: hashBytes(canonicalJsonBytes(fidelityReview)),
      fidelityReview,
      outcome: 'accepted' as const,
      issueCodes: [],
    }];
    const rendered = renderEditorialReport({
      material: draft.material,
      blueprint: draft.blueprint,
      verifiedVisualAssets: [],
    });
    draft.htmlBytes = rendered.htmlBytes;
    const generationId = createEditorialGenerationId({
      requestKey: draft.manifest.requestKey,
      mode: 'llm',
      materialHash,
      publishedBlueprintHash: blueprintHash,
      exportedAssetHashes: rendered.exportedAssets,
    });
    draft.diagnostic = buildPhase2PublishedDiagnostic({
      material: draft.material,
      requestKey: draft.manifest.requestKey,
      materialHash,
      modelEgress: draft.manifest.pipeline.modelEgress,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      generationId,
      publishedBlueprintHash: blueprintHash,
      htmlHash: hashBytes(draft.htmlBytes),
      status: 'ready',
      candidateAttempts,
      rendererWarningCodes: rendered.warnings.map(({ code }) => code),
    });
    const { inputBlueprintHash: _inputBlueprintHash, ...manifestFidelityCall } = fidelityCall;
    draft.manifest = {
      ...draft.manifest,
      generationId,
      modelCalls: [plannerCall, manifestFidelityCall],
      exportedAssets: rendered.exportedAssets,
    };
  });
}

interface BundleDraft {
  material: EditorialMaterial;
  blueprint: EditorialBlueprint;
  diagnostic: Extract<EditorialDiagnostic, { status: 'pass' | 'degraded' }>;
  manifest: EditorialReport;
  htmlBytes: Buffer;
}

function rewriteBundle(
  input: EditorialStorePublishInput,
  mutate: (draft: BundleDraft) => void,
): EditorialStorePublishInput {
  const draft: BundleDraft = {
    material: JSON.parse(Buffer.from(input.materialBytes).toString('utf8')) as EditorialMaterial,
    blueprint: JSON.parse(Buffer.from(input.blueprintBytes).toString('utf8')) as EditorialBlueprint,
    diagnostic: JSON.parse(Buffer.from(input.diagnosticBytes).toString('utf8')) as BundleDraft['diagnostic'],
    manifest: JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as EditorialReport,
    htmlBytes: Buffer.from(input.htmlBytes),
  };
  mutate(draft);
  const materialBytes = canonicalJsonBytes(draft.material);
  const blueprintBytes = canonicalJsonBytes(draft.blueprint);
  const diagnosticBytes = canonicalJsonBytes(draft.diagnostic);
  const fileRef = (
    relativePath: string,
    bytes: Buffer,
    mediaType: 'application/json' | 'text/html',
  ) => ({ relativePath, contentSha256: hashBytes(bytes), byteSize: bytes.byteLength, mediaType });
  draft.manifest.files = {
    material: fileRef('editorial-material.json', materialBytes, 'application/json'),
    blueprint: fileRef('editorial-blueprint.json', blueprintBytes, 'application/json'),
    diagnostic: fileRef('editorial-diagnostic.json', diagnosticBytes, 'application/json'),
    html: {
      ...fileRef('editorial-report.html', draft.htmlBytes, 'text/html'),
      mediaType: 'text/html',
      selfContained: true,
      printProfile: 'a4-portrait-v1',
    },
  };
  return {
    ...input,
    materialBytes,
    blueprintBytes,
    diagnosticBytes,
    htmlBytes: draft.htmlBytes,
    manifestBytes: canonicalJsonBytes(draft.manifest),
  };
}

function bundleCoordinates(input: EditorialStorePublishInput): {
  taskId: string;
  attemptId: string;
  requestKey: string;
} {
  const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as EditorialReport;
  return { taskId: manifest.taskId, attemptId: manifest.attemptId, requestKey: manifest.requestKey };
}

async function assertInstalledBundleRejected(
  root: string,
  reports: EditorialReportStore,
  input: EditorialStorePublishInput,
): Promise<void> {
  await installBundle(root, input);
  await assert.rejects(
    reports.readSlot({ ...bundleCoordinates(input), slot: input.slot }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );
}

function visualMaterial(
  manifestVersion: 'visual-asset-manifest-v1' | 'visual-asset-manifest-v2' = 'visual-asset-manifest-v1',
): { material: EditorialMaterial; sourceAssetId: string; imageBytes: Buffer } {
  const material = fixtureMaterial();
  const sourceAssetId = 'visual-source-1';
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imageHash = hashBytes(imageBytes);
  const imageSource = {
    artifactId: sourceAssetId,
    kind: 'visual_asset',
    schemaVersion: 'visual-asset-v1',
    contentSha256: imageHash,
  };
  const visualManifestSource = {
    artifactId: 'visual-manifest-1',
    kind: 'visual_asset_manifest',
    schemaVersion: manifestVersion,
    contentSha256: `sha256:${'e'.repeat(64)}` as const,
  };
  const makeUnit = (pointer: string, value: string): EditorialMaterialUnit => ({
    id: createEditorialMaterialUnitId({
      sourceArtifactId: sourceAssetId,
      sourceArtifactContentSha256: imageHash,
      sourceJsonPointer: pointer,
      role: 'context',
      value,
    }),
    value,
    metricEligible: false,
    sourceRefs: [{ artifactId: sourceAssetId, jsonPointer: pointer }],
    basisUnitIds: [],
    evidenceIds: [],
    questionIds: [],
    requiredInOutput: true,
    requiredInBody: false,
    role: 'context',
  });
  const caption = makeUnit('/caption', '验证图片');
  const alt = makeUnit('/alt', '验证图片替代文本');
  material.presentationMode = 'multimodal';
  material.sourceArtifacts.push(imageSource, visualManifestSource);
  material.units.push(caption, alt);
  material.assets.push({
    id: 'editorial-asset-internal-1',
    assetId: sourceAssetId,
    manifestArtifactId: visualManifestSource.artifactId,
    visualRole: 'standalone',
    mediaType: 'image/png',
    byteSize: imageBytes.byteLength,
    width: 1,
    height: 1,
    exportPolicy: 'allow',
    captionUnitId: caption.id,
    altTextUnitId: alt.id,
    evidenceIds: [],
    sourceRefs: [{ artifactId: sourceAssetId, jsonPointer: '/' }],
  });
  return { material, sourceAssetId, imageBytes };
}

function failureDiagnosticBytes(taskId = TASK_ID): Buffer {
  const diagnostic = JSON.parse(Buffer.from(bundle().diagnosticBytes).toString('utf8')) as Record<string, unknown>;
  diagnostic.taskId = taskId;
  diagnostic.status = 'fail';
  diagnostic.mode = 'none';
  for (const key of [
    'requestKey', 'materialHash', 'modelEgress', 'modelContextHash', 'modelContextByteSize',
    'generationId', 'publishedBlueprintHash', 'htmlHash',
  ]) {
    delete diagnostic[key];
  }
  diagnostic.checks = (diagnostic.checks as Array<Record<string, unknown>>).map((check) => ({
    ...check,
    status: check.id === 'source_integrity' ? 'passed' : 'not_run',
    issues: [],
  }));
  diagnostic.issues = [{
    code: 'SOURCE_NOT_RENDERABLE',
    severity: 'error',
    message: 'Editorial report generation failed after source freeze.',
  }];
  return canonicalJsonBytes(diagnostic);
}

function store(root: string, input: {
  now?: Date;
  pid?: number;
  alive?: (pid: number) => boolean;
  hooks?: ConstructorParameters<typeof EditorialReportStore>[0]['hooks'];
} = {}): EditorialReportStore {
  return new EditorialReportStore({
    root,
    hostname: 'editorial-test-host',
    pid: input.pid ?? 1001,
    now: () => input.now ?? new Date('2026-08-27T06:00:00.000Z'),
    isPidAlive: input.alive ?? (() => true),
    hooks: input.hooks,
  });
}

async function installBundle(root: string, input: EditorialStorePublishInput): Promise<string> {
  const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as EditorialReport;
  const slotPath = join(
    root,
    'tasks',
    manifest.taskId,
    'attempts',
    manifest.attemptId,
    'requests',
    manifest.requestKey,
    input.slot,
  );
  await mkdir(slotPath, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of [
    ['editorial-material.json', input.materialBytes],
    ['editorial-blueprint.json', input.blueprintBytes],
    ['editorial-diagnostic.json', input.diagnosticBytes],
    ['editorial-report.html', input.htmlBytes],
    ['manifest.json', input.manifestBytes],
  ] as const) {
    await writeFile(join(slotPath, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  return slotPath;
}

test('publishes manifest-last into an immutable owner-only slot and verifies every byte', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  let fenceCalls = 0;

  const published = await lease.publish(bundle('fallback', {
    assertStillCurrent: async () => { fenceCalls += 1; },
  }));

  assert.equal(fenceCalls, 1);
  assert.equal(published.manifest.status, 'degraded');
  assert.equal(published.reportPath, join(published.slotPath, 'editorial-report.html'));
  assert.deepEqual((await reports.readSlot({
    taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback',
  }))?.manifest, published.manifest);
  assert.equal((await lstat(published.slotPath)).mode & 0o777, 0o700);
  for (const name of await readdir(published.slotPath)) {
    assert.equal((await lstat(join(published.slotPath, name))).mode & 0o777, 0o600);
  }
  assert.equal(await lease.release(), true);
});

test('persists and rereads a configured model-call failure as a verified degraded bundle', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const input = configuredFailureBundle();
  const coordinates = bundleCoordinates(input);
  const lease = await reports.acquire(coordinates);

  const published = await lease.publish(input);
  const reread = await reports.readSlot({ ...coordinates, slot: 'fallback' });

  assert.equal(published.manifest.status, 'degraded');
  assert.equal(published.manifest.pipeline.modelEgress.decision, 'allow');
  assert.equal(published.manifest.modelCalls[0]?.status, 'failed');
  assert.deepEqual(reread?.manifest, published.manifest);
  assert.equal(await lease.release(), true);
});

test('rejects a mutated file and a symlink instead of trusting manifest presence', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const published = await lease.publish(bundle());
  await lease.release();
  await writeFile(published.reportPath, 'tampered');
  await assert.rejects(
    reports.readSlot({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback' }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );

  await rm(published.reportPath);
  await symlink('/etc/passwd', published.reportPath);
  await assert.rejects(
    reports.readSlot({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback' }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );
});

test('rejects a canonical and hash-consistent slot that violates a JSON contract', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const invalid = rewriteBundle(bundle(), (draft) => {
    (draft.material as unknown as Record<string, unknown>).unexpected = true;
  });
  await installBundle(root, invalid);

  await assert.rejects(
    reports.readSlot({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback' }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );
  await lease.release();
});

test('rejects a synchronized forged model-context hash and request key at publish', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const forgedContextHash = `sha256:${'1'.repeat(64)}` as const;
  const forged = rewriteBundle(bundle(), (draft) => {
    const materialHash = hashBytes(canonicalJsonBytes(draft.material));
    const requestKey = createEditorialRequestKey({
      sourceReportPackageId: draft.material.sourceReportPackage.artifactId,
      sourceReportPackageHash: draft.material.sourceReportPackage.contentSha256,
      materialHash,
      modelContextHash: forgedContextHash,
      modelEgress: draft.manifest.pipeline.modelEgress,
      gatewayConfiguration: draft.manifest.pipeline.gatewayConfiguration,
    });
    draft.blueprint.requestKey = requestKey;
    draft.diagnostic.requestKey = requestKey;
    draft.diagnostic.modelContextHash = forgedContextHash;
    draft.manifest.requestKey = requestKey;
    draft.manifest.pipeline.modelContextHash = forgedContextHash;
    const blueprintHash = hashBytes(canonicalJsonBytes(draft.blueprint));
    const generationId = createEditorialGenerationId({
      requestKey,
      mode: 'deterministic_fallback',
      materialHash,
      publishedBlueprintHash: blueprintHash,
      exportedAssetHashes: draft.manifest.exportedAssets,
    });
    draft.diagnostic.publishedBlueprintHash = blueprintHash;
    draft.diagnostic.generationId = generationId;
    draft.manifest.generationId = generationId;
  });
  const coordinates = bundleCoordinates(forged);
  const lease = await reports.acquire(coordinates);

  await assert.rejects(
    lease.publish(forged),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );
  await lease.release();
});

test('rejects synchronized generation, model-egress, and unsafe-HTML tampering on cache reads', async (t) => {
  const root = await temporaryRoot(t);
  const cases: Array<{ name: string; input: EditorialStorePublishInput }> = [
    {
      name: 'generation id',
      input: bundle('fallback', {}, { generationId: `er_${'7'.repeat(64)}` }),
    },
    {
      name: 'model egress',
      input: rewriteBundle(bundle(), (draft) => {
        draft.diagnostic.modelEgress = {
          ...draft.diagnostic.modelEgress,
          evaluated: {
            ...draft.diagnostic.modelEgress.evaluated,
            sourcePolicySetHash: `sha256:${'8'.repeat(64)}`,
          },
        };
      }),
    },
    {
      name: 'unsafe HTML',
      input: rewriteBundle(bundle(), (draft) => {
        draft.htmlBytes = Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>@page{size:A4 portrait}@media print{}</style></head><body><script>alert(1)</script></body></html>`);
        draft.diagnostic.htmlHash = hashBytes(draft.htmlBytes);
      }),
    },
  ];
  for (const [index, item] of cases.entries()) {
    const caseRoot = join(root, String(index));
    const reports = store(caseRoot);
    await assertInstalledBundleRejected(caseRoot, reports, item.input);
  }
});

test('rejects synchronized fallback Blueprint and safe HTML forgery', async (t) => {
  const root = await temporaryRoot(t);
  const forgedBlueprint = rewriteBundle(bundle(), (draft) => {
    draft.blueprint.sections[0]!.title = {
      text: String(draft.material.units[0]!.value),
      mode: 'verbatim',
      materialUnitIds: [draft.material.units[0]!.id],
    };
    draft.htmlBytes = renderEditorialReport({
      material: draft.material,
      blueprint: draft.blueprint,
      verifiedVisualAssets: [],
    }).htmlBytes;
    const blueprintHash = hashBytes(canonicalJsonBytes(draft.blueprint));
    const generationId = createEditorialGenerationId({
      requestKey: draft.manifest.requestKey,
      mode: 'deterministic_fallback',
      materialHash: hashBytes(canonicalJsonBytes(draft.material)),
      publishedBlueprintHash: blueprintHash,
      exportedAssetHashes: draft.manifest.exportedAssets,
    });
    draft.diagnostic.publishedBlueprintHash = blueprintHash;
    draft.diagnostic.htmlHash = hashBytes(draft.htmlBytes);
    draft.diagnostic.generationId = generationId;
    draft.manifest.generationId = generationId;
  });
  await assertInstalledBundleRejected(join(root, 'blueprint'), store(join(root, 'blueprint')), forgedBlueprint);

  const forgedHtml = rewriteBundle(bundle(), (draft) => {
    draft.htmlBytes = Buffer.from(
      draft.htmlBytes.toString('utf8').replace('本报告为已封存结果的派生呈现', '本报告已经人工确认'),
      'utf8',
    );
    draft.diagnostic.htmlHash = hashBytes(draft.htmlBytes);
  });
  await assertInstalledBundleRejected(join(root, 'html'), store(join(root, 'html')), forgedHtml);
});

test('rejects a synchronized Diagnostic and manifest file-hash rewrite', async (t) => {
  const root = await temporaryRoot(t);
  const original = bundle();
  const forged = rewriteBundle(original, (draft) => {
    draft.diagnostic.issues[0]!.message = 'The audit message was rewritten after publication.';
  });
  const originalManifest = JSON.parse(Buffer.from(original.manifestBytes).toString('utf8')) as EditorialReport;
  const forgedManifest = JSON.parse(Buffer.from(forged.manifestBytes).toString('utf8')) as EditorialReport;

  assert.equal(forgedManifest.requestKey, originalManifest.requestKey);
  assert.equal(forgedManifest.generationId, originalManifest.generationId);
  assert.notEqual(
    forgedManifest.files.diagnostic.contentSha256,
    originalManifest.files.diagnostic.contentSha256,
  );
  await assertInstalledBundleRejected(root, store(root), forged);
});

test('rebuilds a ready Diagnostic and rejects a synchronized warning rewrite', async (t) => {
  const root = await temporaryRoot(t);
  const validRoot = join(root, 'valid');
  const valid = configuredReadyBundle();
  const validReports = store(validRoot);
  const lease = await validReports.acquire(bundleCoordinates(valid));
  const published = await lease.publish(valid);
  assert.equal(published.manifest.status, 'ready');
  await lease.release();
  assert.equal((await validReports.readSlot({
    ...bundleCoordinates(valid),
    slot: 'ready',
  }))?.manifest.status, 'ready');

  const forged = rewriteBundle(valid, (draft) => {
    draft.diagnostic.issues.push({
      code: 'FORGED_READY_WARNING',
      severity: 'warning',
      message: 'This schema-valid warning was added after publication.',
    });
  });
  const forgedRoot = join(root, 'forged');
  await assertInstalledBundleRejected(forgedRoot, store(forgedRoot), forged);
});

test('rejects a ready paraphrase whose Fidelity evidence was synchronously removed', async (t) => {
  const root = await temporaryRoot(t);
  const valid = configuredParaphraseReadyBundle();
  const validRoot = join(root, 'valid');
  const validReports = store(validRoot);
  const lease = await validReports.acquire(bundleCoordinates(valid));
  assert.equal((await lease.publish(valid)).manifest.status, 'ready');
  await lease.release();

  const forged = rewriteBundle(valid, (draft) => {
    const configuration = draft.manifest.pipeline.gatewayConfiguration;
    assert.ok(configuration);
    const accepted = draft.diagnostic.candidateAttempts.find(({ outcome }) => outcome === 'accepted');
    assert.ok(accepted);
    const mutableAttempt = accepted as unknown as Record<string, unknown>;
    delete mutableAttempt.fidelityCall;
    delete mutableAttempt.fidelityReviewHash;
    delete mutableAttempt.fidelityReview;
    const materialHash = hashBytes(canonicalJsonBytes(draft.material));
    const modelContext = projectEditorialModelContext(draft.material);
    const rendered = renderEditorialReport({
      material: draft.material,
      blueprint: draft.blueprint,
      verifiedVisualAssets: [],
    });
    draft.diagnostic = buildPhase2PublishedDiagnostic({
      material: draft.material,
      requestKey: draft.manifest.requestKey,
      materialHash,
      modelEgress: draft.manifest.pipeline.modelEgress,
      gatewayConfigurationHash: configuration.gatewayConfigurationHash,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      generationId: draft.manifest.generationId,
      publishedBlueprintHash: hashBytes(canonicalJsonBytes(draft.blueprint)),
      htmlHash: hashBytes(draft.htmlBytes),
      status: 'ready',
      candidateAttempts: draft.diagnostic.candidateAttempts,
      rendererWarningCodes: rendered.warnings.map(({ code }) => code),
    });
    draft.manifest.modelCalls = draft.manifest.modelCalls.filter(
      ({ stage }) => stage === 'editorial_blueprint',
    );
  });
  const forgedRoot = join(root, 'forged');
  await assertInstalledBundleRejected(forgedRoot, store(forgedRoot), forged);
});

test('rejects ready response hashes that do not bind their persisted Planner and Fidelity plans', async (t) => {
  const root = await temporaryRoot(t);
  const valid = configuredParaphraseReadyBundle();
  for (const [index, stage] of ['editorial_blueprint', 'editorial_fidelity_review'].entries()) {
    const forged = rewriteBundle(valid, (draft) => {
      const accepted = draft.diagnostic.candidateAttempts.find(({ outcome }) => outcome === 'accepted');
      assert.ok(accepted);
      const call = stage === 'editorial_blueprint'
        ? accepted.plannerCall
        : accepted.fidelityCall;
      assert.ok(call?.status === 'succeeded');
      call.responseHash = `sha256:${String(index + 7).repeat(64)}`;
      const manifestCall = draft.manifest.modelCalls.find((candidate) => candidate.stage === stage);
      assert.ok(manifestCall?.status === 'succeeded');
      manifestCall.responseHash = call.responseHash;
    });
    const forgedRoot = join(root, String(index));
    await assertInstalledBundleRejected(forgedRoot, store(forgedRoot), forged);
  }
});

test('uses source Asset IDs, not internal Material Asset IDs, for export closure', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const { material, sourceAssetId, imageBytes } = visualMaterial();
  const sourceHash = hashBytes(imageBytes);
  const valid = bundle('fallback', {}, {
    material,
    exportedAssets: [{ assetId: sourceAssetId, contentSha256: sourceHash }],
    assetBytes: { [sourceAssetId]: imageBytes },
  });
  const coordinates = bundleCoordinates(valid);
  const lease = await reports.acquire(coordinates);
  const published = await lease.publish(valid);
  assert.deepEqual(published.manifest.exportedAssets, [{ assetId: sourceAssetId, contentSha256: sourceHash }]);
  await lease.release();

  const invalidRoot = join(root, 'invalid');
  const invalid = bundle('fallback', {}, {
    material,
    exportedAssets: [{ assetId: 'editorial-asset-internal-1', contentSha256: sourceHash }],
    assetBytes: { [sourceAssetId]: imageBytes },
  });
  await assertInstalledBundleRejected(invalidRoot, store(invalidRoot), invalid);

  const confusedRoot = join(root, 'confused');
  const confusedMaterial = structuredClone(material);
  const source = confusedMaterial.sourceArtifacts.find(({ artifactId }) => artifactId === sourceAssetId)!;
  source.kind = 'deliverable';
  source.schemaVersion = 'research-deliverable-v1-review-gated';
  const confused = bundle('fallback', {}, {
    material: confusedMaterial,
    exportedAssets: [{ assetId: sourceAssetId, contentSha256: sourceHash }],
    assetBytes: { [sourceAssetId]: imageBytes },
  });
  await assertInstalledBundleRejected(confusedRoot, store(confusedRoot), confused);
});

test('accepts frozen V2 visual Asset Manifests in publish and cache verification', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const { material, sourceAssetId, imageBytes } = visualMaterial('visual-asset-manifest-v2');
  const input = bundle('fallback', {}, {
    material,
    exportedAssets: [{ assetId: sourceAssetId, contentSha256: hashBytes(imageBytes) }],
    assetBytes: { [sourceAssetId]: imageBytes },
  });
  const coordinates = bundleCoordinates(input);
  const lease = await reports.acquire(coordinates);

  const published = await lease.publish(input);
  const cached = await reports.readSlot({ ...coordinates, slot: 'fallback' });

  assert.equal(published.generationId, cached?.generationId);
  assert.deepEqual(cached?.manifest.exportedAssets, [{
    assetId: sourceAssetId,
    contentSha256: hashBytes(imageBytes),
  }]);
  await lease.release();
});

test('writes a fenced failure Diagnostic once with owner-only permissions', async (t) => {
  const root = await temporaryRoot(t);
  let fenceCalls = 0;
  const diagnosticBytes = failureDiagnosticBytes();
  const written = await store(root).writeFailureDiagnostic({
    taskId: TASK_ID,
    expected: FAILURE_EXPECTED,
    diagnosticBytes,
    assertStillCurrent: async () => { fenceCalls += 1; },
  });

  assert.equal(fenceCalls, 1);
  assert.match(
    written.diagnosticPath,
    new RegExp(`/tasks/${TASK_ID}/failures/[0-9a-f]{32}/editorial-diagnostic\\.json$`, 'u'),
  );
  assert.deepEqual(await readFile(written.diagnosticPath), diagnosticBytes);
  assert.equal((await lstat(written.diagnosticPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(written.diagnosticPath, '..'))).mode & 0o777, 0o700);
});

test('failure Diagnostic checks the current binding after staging and leaves no visible result on drift', async (t) => {
  const root = await temporaryRoot(t);
  const diagnosticBytes = failureDiagnosticBytes();
  const failuresPath = join(root, 'tasks', TASK_ID, 'failures');
  let bindingChanged = false;
  let fenceCalls = 0;
  const reports = new EditorialReportStore({
    root,
    hostname: 'editorial-test-host',
    pid: 1001,
    now: () => new Date('2026-08-27T06:00:00.000Z'),
    isPidAlive: () => true,
    randomBytes: (size) => {
      bindingChanged = true;
      return Buffer.alloc(size, 0xcd);
    },
  });

  await assert.rejects(
    reports.writeFailureDiagnostic({
      taskId: TASK_ID,
      expected: FAILURE_EXPECTED,
      diagnosticBytes,
      assertStillCurrent: async () => {
        fenceCalls += 1;
        const entries = await readdir(failuresPath);
        assert.equal(entries.length, 1);
        assert.doesNotMatch(entries[0]!, /^[0-9a-f]{32}$/u, 'a final failure directory must not exist before the fence');
        assert.deepEqual(await readFile(join(failuresPath, entries[0]!, 'editorial-diagnostic.json')), diagnosticBytes);
        if (bindingChanged) throw new Error('source changed before failure publish');
      },
    }),
    /source changed before failure publish/u,
  );

  assert.equal(fenceCalls, 1);
  assert.deepEqual(await readdir(failuresPath), []);
});

test('failure Diagnostic revalidates staged bytes after the binding fence', async (t) => {
  const root = await temporaryRoot(t);
  const failuresPath = join(root, 'tasks', TASK_ID, 'failures');
  const reports = store(root);

  await assert.rejects(
    reports.writeFailureDiagnostic({
      taskId: TASK_ID,
      expected: FAILURE_EXPECTED,
      diagnosticBytes: failureDiagnosticBytes(),
      assertStillCurrent: async () => {
        const [staging] = await readdir(failuresPath);
        assert.ok(staging?.startsWith('.staging-'));
        await writeFile(join(failuresPath, staging, 'editorial-diagnostic.json'), 'tampered', { mode: 0o600 });
      },
    }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_STORE_WRITE_FAILED',
  );

  assert.deepEqual(await readdir(failuresPath), []);
});

test('failure Diagnostic rejects invalid content, a stale fence, and overwrite attempts', async (t) => {
  const root = await temporaryRoot(t);
  const fixedRandom = (size: number): Buffer => Buffer.alloc(size, 0xab);
  const reports = new EditorialReportStore({
    root,
    hostname: 'editorial-test-host',
    pid: 1001,
    now: () => new Date('2026-08-27T06:00:00.000Z'),
    isPidAlive: () => true,
    randomBytes: fixedRandom,
  });
  await assert.rejects(
    reports.writeFailureDiagnostic({
      taskId: TASK_ID,
      expected: FAILURE_EXPECTED,
      diagnosticBytes: bundle().diagnosticBytes,
      assertStillCurrent: async () => {},
    }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
  );
  await assert.rejects(
    reports.writeFailureDiagnostic({
      taskId: TASK_ID,
      expected: FAILURE_EXPECTED,
      diagnosticBytes: failureDiagnosticBytes(),
      assertStillCurrent: async () => { throw new Error('source changed'); },
    }),
    /source changed/u,
  );
  const first = await reports.writeFailureDiagnostic({
    taskId: TASK_ID,
    expected: FAILURE_EXPECTED,
    diagnosticBytes: failureDiagnosticBytes(),
    assertStillCurrent: async () => {},
  });
  const original = await readFile(first.diagnosticPath);
  await assert.rejects(
    reports.writeFailureDiagnostic({
      taskId: TASK_ID,
      expected: FAILURE_EXPECTED,
      diagnosticBytes: failureDiagnosticBytes(),
      assertStillCurrent: async () => {},
    }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_STORE_WRITE_FAILED',
  );
  assert.deepEqual(await readFile(first.diagnosticPath), original);
});

test('failure Diagnostic rejects every stale frozen-binding field before its fence', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const cases: Array<{ name: string; mutate(diagnostic: Record<string, unknown>): void }> = [
    { name: 'task', mutate: (diagnostic) => { diagnostic.taskId = '88888888-8888-4888-8888-888888888888'; } },
    { name: 'plan', mutate: (diagnostic) => { diagnostic.planVersionId = '55555555-5555-4555-8555-555555555555'; } },
    { name: 'attempt', mutate: (diagnostic) => { diagnostic.attemptId = '66666666-6666-4666-8666-666666666666'; } },
    {
      name: 'package id',
      mutate: (diagnostic) => {
        (diagnostic.sourceReportPackage as Record<string, unknown>).artifactId = '77777777-7777-4777-8777-777777777777';
      },
    },
    {
      name: 'package hash',
      mutate: (diagnostic) => {
        (diagnostic.sourceReportPackage as Record<string, unknown>).contentSha256 = `sha256:${'7'.repeat(64)}`;
      },
    },
    {
      name: 'package kind',
      mutate: (diagnostic) => {
        (diagnostic.sourceReportPackage as Record<string, unknown>).kind = 'deliverable';
      },
    },
    {
      name: 'package schema',
      mutate: (diagnostic) => {
        (diagnostic.sourceReportPackage as Record<string, unknown>).schemaVersion = 'report-package-v2';
      },
    },
  ];
  let fenceCalls = 0;

  for (const item of cases) {
    const diagnostic = JSON.parse(failureDiagnosticBytes().toString('utf8')) as Record<string, unknown>;
    item.mutate(diagnostic);
    await assert.rejects(
      reports.writeFailureDiagnostic({
        taskId: TASK_ID,
        expected: FAILURE_EXPECTED,
        diagnosticBytes: canonicalJsonBytes(diagnostic),
        assertStillCurrent: async () => { fenceCalls += 1; },
      }),
      (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_SIDECAR_CORRUPT',
      item.name,
    );
  }

  assert.equal(fenceCalls, 0);
});

test('a live lock is immediately busy and never waits or inspects result slots', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const owner = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const started = Date.now();
  await assert.rejects(
    reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
  );
  assert.ok(Date.now() - started < 500);
  await owner.release();
});

test('lease release does not derive coordinates by splitting the absolute root path', async (t) => {
  const parent = await temporaryRoot(t);
  const root = join(parent, 'tasks', 'nested-editorial-root');
  const reports = store(root);
  const coordinates = { taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY };
  const lease = await reports.acquire(coordinates);

  assert.equal(await lease.release(), true);
  const replacement = await reports.acquire(coordinates);
  assert.equal(await replacement.release(), true);
});

test('strictly-stale lock is reaped once and an old owner cannot delete its replacement', async (t) => {
  const root = await temporaryRoot(t);
  const old = store(root, { now: new Date('2026-08-27T05:00:00.000Z'), pid: 1001 });
  const oldLease = await old.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const replacementStore = store(root, {
    now: new Date('2026-08-27T05:15:00.001Z'),
    pid: 2002,
    alive: () => false,
  });
  const replacement = await replacementStore.acquire({
    taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY,
  });
  assert.equal(await oldLease.release(), false, 'old token/inode must not unlink the replacement lock');
  await assert.rejects(
    replacementStore.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
  );
  assert.equal(await replacement.release(), true);
});

test('lock at exactly fifteen minutes is not stale', async (t) => {
  const root = await temporaryRoot(t);
  const old = store(root, { now: new Date('2026-08-27T05:00:00.000Z'), pid: 1001 });
  const lease = await old.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const contender = store(root, {
    now: new Date('2026-08-27T05:15:00.000Z'), pid: 2002, alive: () => false,
  });
  await assert.rejects(
    contender.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
  );
  await lease.release();
});

test('a normal owner winning after reap makes the reclaimer busy without touching the new lock', async (t) => {
  const root = await temporaryRoot(t);
  const old = store(root, { now: new Date('2026-08-27T05:00:00.000Z'), pid: 1001 });
  await old.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  let releaseHook!: () => void;
  const atHook = new Promise<void>((resolve) => { releaseHook = resolve; });
  let hookReached!: () => void;
  const reached = new Promise<void>((resolve) => { hookReached = resolve; });
  const reclaimer = store(root, {
    now: new Date('2026-08-27T05:15:00.001Z'), pid: 2002, alive: () => false,
    hooks: { afterReapRename: async () => { hookReached(); await atHook; } },
  });
  const reclaim = reclaimer.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  await reached;
  const winnerStore = store(root, { now: new Date('2026-08-27T05:15:00.002Z'), pid: 3003 });
  const winner = await winnerStore.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  releaseHook();
  await assert.rejects(
    reclaim,
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
  );
  await assert.rejects(
    winnerStore.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
  );
  await winner.release();
});

test('publish fence failure and manifest-write failure leave no discoverable slot', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  await assert.rejects(
    lease.publish(bundle('fallback', { assertStillCurrent: async () => { throw new Error('changed'); } })),
    /changed/,
  );
  assert.equal(await reports.readSlot({
    taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback',
  }), null);
  await lease.release();

  const failing = store(root, { hooks: { beforeManifestWrite: async () => { throw new Error('disk failed'); } } });
  const next = await failing.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  await assert.rejects(next.publish(bundle()), /disk failed/);
  assert.equal(await failing.readSlot({
    taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY, slot: 'fallback',
  }), null);
  await next.release();
});

test('publish rechecks the current binding after the final asynchronous hook', async (t) => {
  const root = await temporaryRoot(t);
  let bindingChanged = false;
  const reports = store(root, {
    hooks: {
      beforePublishRename: async () => { bindingChanged = true; },
    },
  });
  const input = bundle('fallback', {
    assertStillCurrent: async () => {
      if (bindingChanged) throw new Error('source changed in rename window');
    },
  });
  const coordinates = bundleCoordinates(input);
  const lease = await reports.acquire(coordinates);

  await assert.rejects(lease.publish(input), /source changed in rename window/u);
  assert.equal(await reports.readSlot({ ...coordinates, slot: 'fallback' }), null);
  await lease.release();
});

test('publish keeps the request lock owned while the final binding fence is in flight', async (t) => {
  const root = await temporaryRoot(t);
  const owner = store(root, { now: new Date('2026-08-27T05:00:00.000Z'), pid: 1001 });
  const lease = await owner.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const reclaimer = store(root, {
    now: new Date('2026-08-27T05:15:00.001Z'),
    pid: 2002,
    alive: () => false,
  });
  let fenceCalls = 0;

  const published = await lease.publish(bundle('fallback', {
    assertStillCurrent: async () => {
      fenceCalls += 1;
      await assert.rejects(
        reclaimer.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
        (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_REQUEST_BUSY',
      );
    },
  }));

  assert.equal(fenceCalls, 1);
  assert.equal(published.slot, 'fallback');
  assert.equal(await lease.release(), true);
});

test('a release blocked by the publish guard remains retryable', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const coordinates = { taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY };
  const lease = await reports.acquire(coordinates);
  let releaseDuringFence: boolean | undefined;

  const published = await lease.publish(bundle('fallback', {
    assertStillCurrent: async () => {
      releaseDuringFence = await lease.release();
    },
  }));

  assert.equal(releaseDuringFence, false);
  assert.equal(published.slot, 'fallback');
  assert.equal(await lease.release(), true);
  const replacement = await reports.acquire(coordinates);
  assert.equal(await replacement.release(), true);
});

test('publish revalidates every staged byte after the binding fence', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const coordinates = { taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY };
  const stagingRoot = join(root, 'tasks', TASK_ID, 'attempts', ATTEMPT_ID, '.staging');
  const lease = await reports.acquire(coordinates);

  await assert.rejects(
    lease.publish(bundle('fallback', {
      assertStillCurrent: async () => {
        const [staging] = await readdir(stagingRoot);
        assert.ok(staging);
        await writeFile(join(stagingRoot, staging, 'editorial-diagnostic.json'), 'tampered', { mode: 0o600 });
      },
    })),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_STORE_PUBLISH_FAILED',
  );

  assert.equal(await reports.readSlot({ ...coordinates, slot: 'fallback' }), null);
  assert.deepEqual(await readdir(stagingRoot), []);
  assert.equal(await lease.release(), true);
});

test('an existing valid immutable slot wins without being overwritten', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  const firstLease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const first = await firstLease.publish(bundle());
  await firstLease.release();
  const firstManifestBytes = await readFile(first.manifestPath);
  const secondLease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  const second = await secondLease.publish(bundle('fallback', {
    manifestBytes: Buffer.from(firstManifestBytes),
  }));
  assert.equal(second.generationId, first.generationId);
  assert.deepEqual(await readFile(first.manifestPath), firstManifestBytes);
  await secondLease.release();
});

test('a valid winner appearing in the rename window is never overwritten', async (t) => {
  const root = await temporaryRoot(t);
  const winner = bundle('fallback', {}, { generatedAt: '2026-08-27T06:01:00.000Z' });
  const winnerGenerationId = JSON.parse(Buffer.from(winner.manifestBytes).toString('utf8')).generationId as string;
  let hookCalls = 0;
  const reports = store(root, {
    hooks: {
      beforePublishRename: async () => {
        hookCalls += 1;
        await installBundle(root, winner);
      },
    },
  });
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });

  const published = await lease.publish(bundle());

  assert.equal(hookCalls, 1);
  assert.equal(published.generationId, winnerGenerationId);
  assert.equal(published.manifest.generatedAt, '2026-08-27T06:01:00.000Z');
  assert.deepEqual(published.htmlBytes, Buffer.from(winner.htmlBytes));
  assert.equal((await readdir(join(root, 'tasks', TASK_ID, 'attempts', ATTEMPT_ID, '.staging'))).length, 0);
  await lease.release();
});

test('acquisition cleans only same-request staging and reaped entries older than 24 hours', async (t) => {
  const root = await temporaryRoot(t);
  const attemptRoot = join(root, 'tasks', TASK_ID, 'attempts', ATTEMPT_ID);
  const oldStaging = join(attemptRoot, '.staging', `${REQUEST_KEY}-old`);
  const otherStaging = join(attemptRoot, '.staging', `erq_${'9'.repeat(64)}-old`);
  const oldReaped = join(attemptRoot, 'locks', '.reaped', `${REQUEST_KEY}-old.lock`);
  await mkdir(oldStaging, { recursive: true, mode: 0o700 });
  await mkdir(otherStaging, { recursive: true, mode: 0o700 });
  await mkdir(join(attemptRoot, 'locks', '.reaped'), { recursive: true, mode: 0o700 });
  await writeFile(oldReaped, 'old', { mode: 0o600 });
  const oldTime = new Date('2026-08-26T05:59:59.000Z');
  await utimes(oldStaging, oldTime, oldTime);
  await utimes(otherStaging, oldTime, oldTime);
  await utimes(oldReaped, oldTime, oldTime);
  const reports = store(root);
  const lease = await reports.acquire({ taskId: TASK_ID, attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY });
  await assert.rejects(lstat(oldStaging), { code: 'ENOENT' });
  await assert.rejects(lstat(oldReaped), { code: 'ENOENT' });
  assert.equal((await lstat(otherStaging)).isDirectory(), true);
  await lease.release();
});

test('rejects caller-controlled path components before filesystem access', async (t) => {
  const root = await temporaryRoot(t);
  const reports = store(root);
  await assert.rejects(
    reports.acquire({ taskId: '../escape', attemptId: ATTEMPT_ID, requestKey: REQUEST_KEY }),
    (error: unknown) => error instanceof EditorialStoreError && error.code === 'EDITORIAL_STORE_PATH_INVALID',
  );
  await mkdir(root, { recursive: true });
  await chmod(root, 0o700);
  assert.deepEqual(await readdir(root), []);
});
