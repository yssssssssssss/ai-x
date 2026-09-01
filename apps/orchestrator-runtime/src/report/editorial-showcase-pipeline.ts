import type { EditorialShowcaseManifestV1 } from '../../../../packages/api-contract/editorial-showcase.ts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  hashBytes,
  type EditorialSourceVerifier,
  type Sha256,
} from './editorial-report-contract.ts';
import {
  materializeEditorialReport,
  type EditorialMaterializationResult,
} from './editorial-report-materializer.ts';
import { buildEditorialHtmlSourcePacket } from './editorial-html-source-packet.ts';
import { loadEditorialPresentationBrief } from './editorial-presentation-brief.ts';
import { compileEditorialShowcase } from './editorial-showcase-compiler.ts';
import { loadEditorialShowcaseProfile } from './editorial-showcase-profile.ts';
import type { EditorialShowcasePlanningResult } from './editorial-showcase-planner.ts';
import { EDITORIAL_SHOWCASE_INTENT_PROMPT_VERSION } from './editorial-showcase-planner.ts';
import { renderEditorialShowcase } from './editorial-showcase-renderer.ts';
import type {
  EditorialShowcaseStore,
  EditorialShowcaseStoredPublication,
} from './editorial-showcase-store.ts';
import { validateEditorialShowcase } from './editorial-showcase-validator.ts';

export const EDITORIAL_SHOWCASE_PIPELINE_VERSION = 'universal-editorial-showcase-pipeline-v2' as const;

export class EditorialShowcasePipelineError extends Error {
  readonly name = 'EditorialShowcasePipelineError';
  constructor(
    readonly code: 'SHOWCASE_DISABLED' | 'SHOWCASE_GENERATION_FAILED',
    options?: { cause?: unknown },
  ) {
    super(code, options);
  }
}

export interface EditorialShowcaseGenerationResult {
  status: 'ready';
  generationMode: 'model_intent' | 'deterministic_showcase';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  publicationId: string;
  reportPath: string;
  manifestPath: string;
}

export interface EditorialShowcasePlannerPort {
  plan(input: {
    sourcePacket: ReturnType<typeof buildEditorialHtmlSourcePacket>['packet'];
    deterministicSpec: ReturnType<typeof compileEditorialShowcase>['spec'];
  }): Promise<EditorialShowcasePlanningResult>;
}

export interface EditorialShowcaseLockLease { release(): Promise<boolean>; }
export interface EditorialShowcaseLockStore {
  acquire(input: { taskId: string; attemptId: string; requestKey: string }): Promise<EditorialShowcaseLockLease>;
}

export interface EditorialShowcasePipelineDependencies {
  source: EditorialSourceVerifier;
  materialize?: typeof materializeEditorialReport;
  planner: EditorialShowcasePlannerPort;
  store: Pick<EditorialShowcaseStore, 'read' | 'publish'>;
  lockStore: EditorialShowcaseLockStore;
  modelAllowed?: (materialization: EditorialMaterializationResult) => boolean;
  now?: () => Date;
}

function requestKey(input: {
  sourceReportPackageId: string;
  sourceReportPackageHash: Sha256;
  materialHash: Sha256;
  sourcePacketHash: Sha256;
  profileHash: Sha256;
}): string {
  return `esq_${canonicalSha256({
    version: EDITORIAL_SHOWCASE_PIPELINE_VERSION,
    intentPromptVersion: EDITORIAL_SHOWCASE_INTENT_PROMPT_VERSION,
    ...input,
  }).slice('sha256:'.length)}`;
}

function publicationId(input: {
  requestKey: string;
  intentHash: Sha256;
  specHash: Sha256;
  htmlHash: Sha256;
}): string {
  return `esh_${canonicalSha256(input).slice('sha256:'.length)}`;
}

function fromStored(stored: EditorialShowcaseStoredPublication): EditorialShowcaseGenerationResult {
  return {
    status: 'ready',
    generationMode: stored.manifest.generationMode,
    taskId: stored.manifest.taskId,
    planVersionId: stored.manifest.planVersionId,
    attemptId: stored.manifest.attemptId,
    requestKey: stored.manifest.requestKey,
    publicationId: stored.manifest.publicationId,
    reportPath: stored.reportPath,
    manifestPath: stored.manifestPath,
  };
}

export class EditorialShowcasePipeline {
  private readonly materialize: typeof materializeEditorialReport;
  private readonly now: () => Date;

  constructor(private readonly dependencies: EditorialShowcasePipelineDependencies) {
    this.materialize = dependencies.materialize ?? materializeEditorialReport;
    this.now = dependencies.now ?? (() => new Date());
  }

  async generate(input: { taskId: string }): Promise<EditorialShowcaseGenerationResult> {
    const source = await this.dependencies.source.readCurrent(input.taskId);
    const materialization = this.materialize(source);
    const presentation = loadEditorialPresentationBrief();
    const sourcePacket = buildEditorialHtmlSourcePacket({
      material: materialization.material,
      presentationBrief: presentation.brief,
    });
    const profile = loadEditorialShowcaseProfile();
    const deterministic = compileEditorialShowcase({
      material: materialization.material,
      sourcePacket: sourcePacket.packet,
      intent: null,
    });
    const key = requestKey({
      sourceReportPackageId: source.binding.reportPackageArtifactId,
      sourceReportPackageHash: source.binding.reportPackageContentSha256,
      materialHash: materialization.materialHash,
      sourcePacketHash: sourcePacket.hash,
      profileHash: profile.hash,
    });
    const coordinates = { taskId: source.binding.taskId, attemptId: source.binding.attemptId, requestKey: key };
    const expected = {
      planVersionId: source.binding.planVersionId,
      sourceReportPackageId: source.binding.reportPackageArtifactId,
      sourceReportPackageHash: source.binding.reportPackageContentSha256,
    };
    const cached = await this.dependencies.store.read({ ...coordinates, expected });
    if (cached) {
      await this.dependencies.source.assertStillCurrent(source.binding);
      return fromStored(cached);
    }
    const lease = await this.dependencies.lockStore.acquire(coordinates);
    try {
      const winner = await this.dependencies.store.read({ ...coordinates, expected });
      if (winner) {
        await this.dependencies.source.assertStillCurrent(source.binding);
        return fromStored(winner);
      }
      await this.dependencies.source.assertStillCurrent(source.binding);
      const planning: EditorialShowcasePlanningResult = this.dependencies.modelAllowed?.(materialization) === false
        ? {
            mode: 'deterministic_showcase', intent: null, intentHash: null,
            reasonCode: 'SHOWCASE_MODEL_UNAVAILABLE',
          }
        : await this.dependencies.planner.plan({
            sourcePacket: sourcePacket.packet,
            deterministicSpec: deterministic.spec,
          });
      await this.dependencies.source.assertStillCurrent(source.binding);
      const intent = planning.mode === 'model_intent' ? planning.intent : null;
      const compiled = compileEditorialShowcase({
        material: materialization.material,
        sourcePacket: sourcePacket.packet,
        intent,
      });
      const rendered = renderEditorialShowcase({ spec: compiled.spec });
      const validation = validateEditorialShowcase({
        material: materialization.material,
        sourcePacket: sourcePacket.packet,
        spec: compiled.spec,
        intent,
        renderResult: rendered,
      });
      const intentBytes = canonicalJsonBytes(intent);
      const validationBytes = canonicalJsonBytes(validation);
      const intentHash = hashBytes(intentBytes);
      const id = publicationId({
        requestKey: key,
        intentHash,
        specHash: compiled.hash,
        htmlHash: rendered.htmlHash,
      });
      const manifest: EditorialShowcaseManifestV1 = {
        version: 'universal-editorial-showcase-publication-v1',
        authority: 'derived',
        status: 'ready',
        generationMode: compiled.spec.generationMode,
        taskId: source.binding.taskId,
        planVersionId: source.binding.planVersionId,
        attemptId: source.binding.attemptId,
        requestKey: key,
        publicationId: id,
        profileId: 'universal-editorial-showcase-v1',
        sourceReportPackage: materialization.material.sourceReportPackage,
        materialHash: materialization.materialHash,
        sourcePacketHash: sourcePacket.hash,
        intentHash,
        specHash: compiled.hash,
        profileHash: profile.hash,
        htmlHash: rendered.htmlHash,
        renderManifestHash: rendered.renderManifestHash,
        validationHash: hashBytes(validationBytes),
        ...(planning.modelCall === undefined ? {} : { modelCall: planning.modelCall }),
        generatedAt: this.now().toISOString(),
      };
      const stored = await this.dependencies.store.publish({
        ...coordinates,
        materialBytes: materialization.materialBytes,
        sourcePacketBytes: sourcePacket.bytes,
        intentBytes,
        specBytes: compiled.bytes,
        renderManifestBytes: rendered.renderManifestBytes,
        validationBytes,
        htmlBytes: rendered.htmlBytes,
        manifestBytes: canonicalJsonBytes(manifest),
        assertStillCurrent: () => this.dependencies.source.assertStillCurrent(source.binding),
      });
      return fromStored(stored);
    } catch (error) {
      throw new EditorialShowcasePipelineError('SHOWCASE_GENERATION_FAILED', { cause: error });
    } finally {
      await lease.release();
    }
  }
}
