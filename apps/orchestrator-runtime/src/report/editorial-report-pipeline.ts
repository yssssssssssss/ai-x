import {
  EDITORIAL_BLUEPRINT_PLAN_VERSION,
  EDITORIAL_BLUEPRINT_PROMPT_VERSION,
  EDITORIAL_BLUEPRINT_VERSION,
  EDITORIAL_CHECK_IDS,
  EDITORIAL_DIAGNOSTIC_VERSION,
  EDITORIAL_FALLBACK_VERSION,
  EDITORIAL_FIDELITY_PROMPT_VERSION,
  EDITORIAL_MATERIAL_VERSION,
  EDITORIAL_MAX_DIAGNOSTIC_BYTES,
  EDITORIAL_MAX_JSON_BYTES,
  EDITORIAL_MAX_MANIFEST_BYTES,
  EDITORIAL_MODEL_CONTEXT_VERSION,
  EDITORIAL_RENDERER_VERSION,
  EDITORIAL_REPORT_VERSION,
  EDITORIAL_STORE_VERSION,
  NO_EDITORIAL_MODEL_PORT,
  EditorialContractError,
  buildDeterministicEditorialBlueprint,
  buildPhase1PublishedDiagnostic,
  canonicalJsonBytes,
  createEditorialGenerationId,
  createEditorialRequestKey,
  evaluateEditorialModelEgress,
  hashBytes,
  parseEditorialDiagnostic,
  parseEditorialReport,
  validateEditorialBlueprint,
  validateEditorialRenderTrace,
  type EditorialCheckId,
  type EditorialDiagnostic,
  type EditorialDiagnosticCheck,
  type EditorialDiagnosticIssue,
  type EditorialMaterial,
  type EditorialModelEgressDecision,
  type EditorialModelPort,
  type EditorialReport,
  type EditorialSourceBinding,
  type EditorialSourceVerifier,
  type Sha256,
} from './editorial-report-contract.ts';
import {
  EditorialMaterializationError,
  materializeEditorialReport,
  type EditorialMaterializationResult,
} from './editorial-report-materializer.ts';
import {
  EditorialRendererError,
  renderEditorialReport,
  type EditorialRenderResult,
} from './editorial-report-renderer.ts';
import {
  EditorialStoreError,
  type EditorialFailureDiagnosticInput,
  type EditorialFailureDiagnostic,
  type EditorialReportSlot,
  type EditorialStorePublishInput,
  type EditorialStoredGeneration,
  type EditorialStoreExpectedSource,
} from './editorial-report-store.ts';
import { EditorialSourceError } from './editorial-report-source-reader.ts';

export interface EditorialReportGenerationResult {
  status: 'ready' | 'degraded';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  generationId: string;
  reportPath: string;
  manifestPath: string;
}

export interface EditorialReportPipelineDependencies {
  source: EditorialSourceVerifier;
  store: EditorialPipelineStore;
  modelPort?: EditorialModelPort;
  now?: () => Date;
  materialize?: typeof materializeEditorialReport;
  render?: typeof renderEditorialReport;
}

export interface EditorialPipelineLease {
  readSlot(slot: EditorialReportSlot, expected?: EditorialStoreExpectedSource): Promise<EditorialStoredGeneration | null>;
  publish(input: EditorialStorePublishInput): Promise<EditorialStoredGeneration>;
  release(): Promise<boolean>;
}

export interface EditorialPipelineStore {
  readSlot(input: {
    taskId: string;
    attemptId: string;
    requestKey: string;
    slot: EditorialReportSlot;
    expected?: EditorialStoreExpectedSource;
  }): Promise<EditorialStoredGeneration | null>;
  acquire(input: { taskId: string; attemptId: string; requestKey: string }): Promise<EditorialPipelineLease>;
  writeFailureDiagnostic(input: EditorialFailureDiagnosticInput): Promise<EditorialFailureDiagnostic>;
}

export class EditorialPipelineError extends Error {
  readonly name = 'EditorialPipelineError';

  constructor(
    readonly code: string,
    options?: { cause?: unknown; diagnosticPath?: string },
  ) {
    super(code, options);
    this.diagnosticPath = options?.diagnosticPath;
  }

  readonly diagnosticPath?: string;
}

function check(
  id: EditorialCheckId,
  status: EditorialDiagnosticCheck['status'],
  issues: EditorialDiagnosticIssue[] = [],
): EditorialDiagnosticCheck {
  return {
    id,
    status,
    method: id === 'content_fidelity' ? 'llm' : 'deterministic',
    issues,
  };
}

function failureCode(error: unknown): string {
  if (
    error instanceof EditorialPipelineError
    || error instanceof EditorialSourceError
    || error instanceof EditorialContractError
    || error instanceof EditorialMaterializationError
    || error instanceof EditorialRendererError
    || error instanceof EditorialStoreError
  ) {
    return /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'EDITORIAL_REPORT_FAILED';
  }
  return 'EDITORIAL_REPORT_FAILED';
}

function failureCheckId(error: unknown): EditorialCheckId {
  if (error instanceof EditorialContractError && error.checkId) return error.checkId;
  if (error instanceof EditorialRendererError) {
    return error.code === 'EDITORIAL_HTML_UNSAFE' ? 'html_safety' : 'composition_quality';
  }
  if (error instanceof EditorialMaterializationError) {
    if (/RELATION|EVIDENCE|SENSITIVE|SOURCE_INTEGRITY/u.test(error.code)) return 'reference_integrity';
    if (/LIMIT|PAYLOAD|IDENTIFIER/u.test(error.code)) return 'schema_integrity';
  }
  if (error instanceof EditorialStoreError) return 'schema_integrity';
  return 'composition_quality';
}

function failureChecks(input: {
  failedCheckId: EditorialCheckId;
  failureIssue: EditorialDiagnosticIssue;
  modelEgress?: EditorialModelEgressDecision;
}): EditorialDiagnosticCheck[] {
  return EDITORIAL_CHECK_IDS.map((id) => {
    if (id === input.failedCheckId) return check(id, 'failed', [input.failureIssue]);
    if (id === 'source_integrity') return check(id, 'passed');
    if (id === 'model_egress' && input.modelEgress !== undefined) return check(id, 'passed');
    return check(id, 'not_run');
  });
}

function sourceReportPackageRef(source: Awaited<ReturnType<EditorialSourceVerifier['readCurrent']>>): EditorialMaterial['sourceReportPackage'] {
  return {
    artifactId: source.binding.reportPackageArtifactId,
    kind: source.reportPackage.artifact.kind,
    schemaVersion: source.reportPackage.artifact.schemaVersion,
    contentSha256: source.binding.reportPackageContentSha256,
  };
}

interface PreparedFailureContext {
  materialization: EditorialMaterializationResult;
  modelEgress: EditorialModelEgressDecision;
  requestKey: string;
}

function buildFailureDiagnostic(input: {
  source: Awaited<ReturnType<EditorialSourceVerifier['readCurrent']>>;
  error: unknown;
  prepared?: PreparedFailureContext;
}): EditorialDiagnostic {
  const code = failureCode(input.error);
  const failureIssue: EditorialDiagnosticIssue = {
    code,
    severity: 'error',
    message: 'Editorial report generation failed after the source snapshot was frozen.',
  };
  const base = {
    version: EDITORIAL_DIAGNOSTIC_VERSION,
    taskId: input.source.binding.taskId,
    planVersionId: input.source.binding.planVersionId,
    attemptId: input.source.binding.attemptId,
    sourceReportPackage: sourceReportPackageRef(input.source),
    gatewayConfigurationHash: null,
    candidateAttempts: [],
    rejectedResponseHashes: [],
    checks: failureChecks({
      failedCheckId: failureCheckId(input.error),
      failureIssue,
      ...(input.prepared === undefined ? {} : { modelEgress: input.prepared.modelEgress }),
    }),
    issues: [failureIssue],
  };
  return parseEditorialDiagnostic(input.prepared === undefined
    ? { ...base, status: 'fail', mode: 'none' }
    : {
        ...base,
        status: 'fail',
        mode: 'deterministic_fallback',
        requestKey: input.prepared.requestKey,
        materialHash: input.prepared.materialization.materialHash,
        modelEgress: input.prepared.modelEgress,
        modelContextHash: input.prepared.materialization.modelContextHash,
        modelContextByteSize: input.prepared.materialization.modelContextByteSize,
      });
}

function fileRef(
  relativePath: string,
  bytes: Uint8Array,
  mediaType: 'application/json' | 'text/html',
): { relativePath: string; contentSha256: Sha256; byteSize: number; mediaType: 'application/json' | 'text/html' } {
  return { relativePath, contentSha256: hashBytes(bytes), byteSize: bytes.byteLength, mediaType };
}

function expectedSource(
  source: Awaited<ReturnType<EditorialSourceVerifier['readCurrent']>>,
): EditorialStoreExpectedSource {
  return {
    planVersionId: source.binding.planVersionId,
    sourceReportPackage: {
      artifactId: source.binding.reportPackageArtifactId,
      contentSha256: source.binding.reportPackageContentSha256,
    },
    sensitivity: source.reportPackage.artifact.sensitivity,
    redactionPolicyVersion: source.reportPackage.artifact.redactionPolicyVersion,
  };
}

function resultFromStored(source: EditorialSourceBinding, stored: EditorialStoredGeneration): EditorialReportGenerationResult {
  return {
    status: stored.manifest.status,
    taskId: source.taskId,
    planVersionId: source.planVersionId,
    attemptId: source.attemptId,
    requestKey: stored.requestKey,
    generationId: stored.generationId,
    reportPath: stored.reportPath,
    manifestPath: stored.manifestPath,
  };
}

function assertPhase1Port(modelPort: EditorialModelPort): void {
  if (modelPort.client !== null || modelPort.configuration !== null) {
    throw new EditorialPipelineError('EDITORIAL_PHASE1_MODEL_FORBIDDEN');
  }
}

function assertBundleLimits(input: {
  materialization: EditorialMaterializationResult;
  blueprintBytes: Uint8Array;
  render: EditorialRenderResult;
}): void {
  if (
    input.materialization.materialBytes.byteLength > EDITORIAL_MAX_JSON_BYTES
    || input.blueprintBytes.byteLength > EDITORIAL_MAX_JSON_BYTES
    || input.render.htmlBytes.byteLength > EDITORIAL_MAX_JSON_BYTES
  ) {
    throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE');
  }
}

export class EditorialReportPipeline {
  private readonly modelPort: EditorialModelPort;
  private readonly now: () => Date;
  private readonly materialize: typeof materializeEditorialReport;
  private readonly render: typeof renderEditorialReport;

  constructor(private readonly dependencies: EditorialReportPipelineDependencies) {
    this.modelPort = dependencies.modelPort ?? NO_EDITORIAL_MODEL_PORT;
    this.now = dependencies.now ?? (() => new Date());
    this.materialize = dependencies.materialize ?? materializeEditorialReport;
    this.render = dependencies.render ?? renderEditorialReport;
    assertPhase1Port(this.modelPort);
  }

  private async failureWithDiagnostic(
    source: Awaited<ReturnType<EditorialSourceVerifier['readCurrent']>>,
    error: unknown,
    prepared?: PreparedFailureContext,
  ): Promise<EditorialPipelineError> {
    const code = failureCode(error);
    if (code === 'SOURCE_BINDING_CHANGED') {
      return error instanceof EditorialPipelineError
        ? error
        : new EditorialPipelineError(code, { cause: error });
    }
    let diagnosticPath: string | undefined;
    try {
      const diagnosticBytes = canonicalJsonBytes(buildFailureDiagnostic({ source, error, prepared }));
      if (diagnosticBytes.byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
        throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE');
      }
      const stored = await this.dependencies.store.writeFailureDiagnostic({
        taskId: source.binding.taskId,
        expected: {
          planVersionId: source.binding.planVersionId,
          attemptId: source.binding.attemptId,
          sourceReportPackage: sourceReportPackageRef(source),
        },
        diagnosticBytes,
        assertStillCurrent: () => this.dependencies.source.assertStillCurrent(source.binding),
      });
      diagnosticPath = stored.diagnosticPath;
    } catch {
      // Failure diagnostics are best-effort and must never replace the generation failure.
    }
    return new EditorialPipelineError(code, {
      cause: error,
      ...(diagnosticPath === undefined ? {} : { diagnosticPath }),
    });
  }

  async generate(input: { taskId: string }): Promise<EditorialReportGenerationResult> {
    const source = await this.dependencies.source.readCurrent(input.taskId);
    let prepared: PreparedFailureContext | undefined;
    try {
      const materialization = this.materialize(source);
      const modelEgress = evaluateEditorialModelEgress({
        sourcePolicyMetadata: materialization.sourcePolicyMetadata,
        modelPort: this.modelPort,
      });
      if (modelEgress.decision !== 'deny') {
        throw new EditorialPipelineError('EDITORIAL_PHASE1_MODEL_FORBIDDEN');
      }
      const requestKey = createEditorialRequestKey({
        sourceReportPackageId: source.binding.reportPackageArtifactId,
        sourceReportPackageHash: source.binding.reportPackageContentSha256,
        materialHash: materialization.materialHash,
        modelContextHash: materialization.modelContextHash,
        modelEgress,
        gatewayConfiguration: null,
      });
      prepared = { materialization, modelEgress, requestKey };
      const coordinates = {
        taskId: source.binding.taskId,
        attemptId: source.binding.attemptId,
        requestKey,
      };
      const expected = expectedSource(source);

      const ready = await this.dependencies.store.readSlot({ ...coordinates, slot: 'ready', expected });
      if (ready) {
        await this.dependencies.source.assertStillCurrent(source.binding);
        return resultFromStored(source.binding, ready);
      }

      const lease = await this.dependencies.store.acquire(coordinates);
      let generationError: unknown;
      try {
        const winner = await lease.readSlot('ready', expected);
        if (winner) {
          await this.dependencies.source.assertStillCurrent(source.binding);
          return resultFromStored(source.binding, winner);
        }
        const existingFallback = await lease.readSlot('fallback', expected);
        if (existingFallback) {
          await this.dependencies.source.assertStillCurrent(source.binding);
          return resultFromStored(source.binding, existingFallback);
        }

        const blueprint = buildDeterministicEditorialBlueprint({
          material: materialization.material,
          requestKey,
        });
        validateEditorialBlueprint({
          blueprint,
          material: materialization.material,
          mode: 'deterministic_fallback',
        });
        const blueprintBytes = canonicalJsonBytes(blueprint);
        const blueprintHash = hashBytes(blueprintBytes);
        const rendered = this.render({
          material: materialization.material,
          blueprint,
          verifiedVisualAssets: source.verifiedVisualAssets,
        });
        validateEditorialRenderTrace({
          blueprint,
          material: materialization.material,
          trace: rendered.trace,
          exportedAssets: rendered.exportedAssets,
        });
        assertBundleLimits({ materialization, blueprintBytes, render: rendered });
        const htmlHash = hashBytes(rendered.htmlBytes);
        const generationId = createEditorialGenerationId({
          requestKey,
          mode: 'deterministic_fallback',
          materialHash: materialization.materialHash,
          publishedBlueprintHash: blueprintHash,
          exportedAssetHashes: rendered.exportedAssets,
        });
        const diagnostic = buildPhase1PublishedDiagnostic({
          material: materialization.material,
          requestKey,
          materialHash: materialization.materialHash,
          modelEgress,
          modelContextHash: materialization.modelContextHash,
          modelContextByteSize: materialization.modelContextByteSize,
          generationId,
          publishedBlueprintHash: blueprintHash,
          htmlHash,
          rendererWarningCodes: rendered.warnings.map(({ code }) => code),
        });
        const diagnosticBytes = canonicalJsonBytes(diagnostic);
        if (diagnosticBytes.byteLength > EDITORIAL_MAX_DIAGNOSTIC_BYTES) {
          throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE');
        }
        const manifest = parseEditorialReport({
          version: EDITORIAL_REPORT_VERSION,
          authority: 'derived',
          taskId: source.binding.taskId,
          planVersionId: source.binding.planVersionId,
          attemptId: source.binding.attemptId,
          sensitivity: source.reportPackage.artifact.sensitivity,
          redactionPolicyVersion: source.reportPackage.artifact.redactionPolicyVersion,
          requestKey,
          generationId,
          status: 'degraded',
          sourceReportPackage: materialization.material.sourceReportPackage,
          pipeline: {
            materialVersion: EDITORIAL_MATERIAL_VERSION,
            modelContextVersion: EDITORIAL_MODEL_CONTEXT_VERSION,
            modelContextHash: materialization.modelContextHash,
            blueprintPlanVersion: EDITORIAL_BLUEPRINT_PLAN_VERSION,
            blueprintVersion: EDITORIAL_BLUEPRINT_VERSION,
            promptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
            fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
            fallbackVersion: EDITORIAL_FALLBACK_VERSION,
            rendererVersion: EDITORIAL_RENDERER_VERSION,
            storeVersion: EDITORIAL_STORE_VERSION,
            modelEgress,
            gatewayConfiguration: null,
          },
          modelCalls: [],
          exportedAssets: rendered.exportedAssets,
          files: {
            material: fileRef('editorial-material.json', materialization.materialBytes, 'application/json'),
            blueprint: fileRef('editorial-blueprint.json', blueprintBytes, 'application/json'),
            diagnostic: fileRef('editorial-diagnostic.json', diagnosticBytes, 'application/json'),
            html: {
              ...fileRef('editorial-report.html', rendered.htmlBytes, 'text/html'),
              selfContained: true,
              printProfile: 'a4-portrait-v1',
            },
          },
          generatedAt: this.now().toISOString(),
        }) as EditorialReport;
        const manifestBytes = canonicalJsonBytes(manifest);
        if (manifestBytes.byteLength > EDITORIAL_MAX_MANIFEST_BYTES) {
          throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE');
        }
        const stored = await lease.publish({
          slot: 'fallback',
          materialBytes: materialization.materialBytes,
          blueprintBytes,
          diagnosticBytes,
          htmlBytes: rendered.htmlBytes,
          manifestBytes,
          assertStillCurrent: () => this.dependencies.source.assertStillCurrent(source.binding),
        });
        return resultFromStored(source.binding, stored);
      } catch (error) {
        generationError = error;
        throw error;
      } finally {
        try {
          await lease.release();
        } catch (releaseError) {
          if (generationError === undefined) throw releaseError;
        }
      }
    } catch (error) {
      throw await this.failureWithDiagnostic(source, error, prepared);
    }
  }
}
