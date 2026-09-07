import type { EditorialSummaryManifestV1 } from '../../../../packages/api-contract/editorial-summary.ts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  type EditorialSourceVerifier,
  type Sha256,
} from './editorial-report-contract.ts';
import {
  materializeEditorialReport,
  type EditorialMaterializationResult,
} from './editorial-report-materializer.ts';
import {
  EDITORIAL_SUMMARY_FIDELITY_PROMPT_VERSION,
  EDITORIAL_SUMMARY_HTML_PROMPT_VERSION,
  EDITORIAL_SUMMARY_PLAN_PROMPT_VERSION,
  EDITORIAL_SUMMARY_REPAIR_PROMPT_VERSION,
  type EditorialSummaryGeneration,
} from './editorial-summary-generator.ts';
import { buildEditorialSummarySource } from './editorial-summary-source.ts';
import {
  EditorialSummaryStoreError,
  type EditorialSummaryStore,
  type EditorialSummaryStoredPublication,
} from './editorial-summary-store.ts';

export const EDITORIAL_SUMMARY_PIPELINE_VERSION = 'editorial-summary-pipeline-v1' as const;

export class EditorialSummaryPipelineError extends Error {
  readonly name = 'EditorialSummaryPipelineError';
  constructor(
    readonly code: 'SUMMARY_MODEL_UNAVAILABLE' | 'SUMMARY_GENERATION_FAILED',
    options?: { cause?: unknown },
  ) { super(code, options); }
}

export interface EditorialSummaryGenerationResult {
  status: 'ready';
  generationMode: 'llm_html';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  publicationId: string;
  reportPath: string;
  manifestPath: string;
}

export interface EditorialSummaryGeneratorPort {
  generate(input: {
    source: ReturnType<typeof buildEditorialSummarySource>['source'];
    beforeModelCall?: () => Promise<void>;
  }): Promise<EditorialSummaryGeneration>;
}

export interface EditorialSummaryLockLease { release(): Promise<boolean>; }
export interface EditorialSummaryLockStore {
  acquire(input: { taskId: string; attemptId: string; requestKey: string }): Promise<EditorialSummaryLockLease>;
}

export interface EditorialSummaryPipelineDependencies {
  source: EditorialSourceVerifier;
  materialize?: typeof materializeEditorialReport;
  generator: EditorialSummaryGeneratorPort;
  store: Pick<EditorialSummaryStore, 'read' | 'publish'>;
  lockStore: EditorialSummaryLockStore;
  generationIdentity: Sha256;
  modelAllowed?: (materialization: EditorialMaterializationResult) => boolean;
  now?: () => Date;
}

export function editorialSummaryRequestKey(input: {
  sourceHash: Sha256;
  generationIdentity: Sha256;
}): string {
  return `esrq_${canonicalSha256({
    pipelineVersion: EDITORIAL_SUMMARY_PIPELINE_VERSION,
    planPromptVersion: EDITORIAL_SUMMARY_PLAN_PROMPT_VERSION,
    htmlPromptVersion: EDITORIAL_SUMMARY_HTML_PROMPT_VERSION,
    fidelityPromptVersion: EDITORIAL_SUMMARY_FIDELITY_PROMPT_VERSION,
    repairPromptVersion: EDITORIAL_SUMMARY_REPAIR_PROMPT_VERSION,
    ...input,
  }).slice('sha256:'.length)}`;
}

function publicationId(input: {
  requestKey: string;
  planHash: Sha256;
  htmlHash: Sha256;
  validationHash: Sha256;
  fidelityHash: Sha256;
}): string {
  return `esrp_${canonicalSha256(input).slice('sha256:'.length)}`;
}

function fromStored(stored: EditorialSummaryStoredPublication): EditorialSummaryGenerationResult {
  return {
    status: 'ready',
    generationMode: 'llm_html',
    taskId: stored.manifest.taskId,
    planVersionId: stored.manifest.planVersionId,
    attemptId: stored.manifest.attemptId,
    requestKey: stored.manifest.requestKey,
    publicationId: stored.manifest.publicationId,
    reportPath: stored.reportPath,
    manifestPath: stored.manifestPath,
  };
}

export class EditorialSummaryPipeline {
  private readonly materialize: typeof materializeEditorialReport;
  private readonly now: () => Date;

  constructor(private readonly dependencies: EditorialSummaryPipelineDependencies) {
    this.materialize = dependencies.materialize ?? materializeEditorialReport;
    this.now = dependencies.now ?? (() => new Date());
  }

  async generate(input: { taskId: string }): Promise<EditorialSummaryGenerationResult> {
    try {
      const frozen = await this.dependencies.source.readCurrent(input.taskId);
      const materialization = this.materialize(frozen);
      const summarySource = buildEditorialSummarySource({
        material: materialization.material,
        reportReview: frozen.current.reportReview,
        ...(frozen.taskContext === undefined ? {} : { taskContext: frozen.taskContext }),
      });
      const key = editorialSummaryRequestKey({
        sourceHash: summarySource.hash,
        generationIdentity: this.dependencies.generationIdentity,
      });
      const coordinates = {
        taskId: frozen.binding.taskId,
        attemptId: frozen.binding.attemptId,
        requestKey: key,
      };
      const expected = {
        planVersionId: frozen.binding.planVersionId,
        sourceReportPackageId: frozen.binding.reportPackageArtifactId,
        sourceReportPackageHash: frozen.binding.reportPackageContentSha256,
        sourceHash: summarySource.hash,
      };
      const cached = await this.dependencies.store.read({ ...coordinates, expected });
      if (cached) {
        await this.dependencies.source.assertStillCurrent(frozen.binding);
        return fromStored(cached);
      }
      if (this.dependencies.modelAllowed?.(materialization) === false) {
        throw new EditorialSummaryPipelineError('SUMMARY_MODEL_UNAVAILABLE');
      }

      const lease = await this.dependencies.lockStore.acquire(coordinates);
      try {
        const winner = await this.dependencies.store.read({ ...coordinates, expected });
        if (winner) {
          await this.dependencies.source.assertStillCurrent(frozen.binding);
          return fromStored(winner);
        }
        await this.dependencies.source.assertStillCurrent(frozen.binding);
        const generated = await this.dependencies.generator.generate({
          source: summarySource.source,
          beforeModelCall: () => this.dependencies.source.assertStillCurrent(frozen.binding),
        });
        await this.dependencies.source.assertStillCurrent(frozen.binding);
        const validationHash = canonicalSha256(generated.validation);
        const fidelityHash = canonicalSha256(generated.fidelity);
        const id = publicationId({
          requestKey: key,
          planHash: generated.planHash,
          htmlHash: generated.htmlHash,
          validationHash,
          fidelityHash,
        });
        const manifest: EditorialSummaryManifestV1 = {
          version: 'editorial-summary-publication-v1',
          authority: 'derived',
          status: 'ready',
          generationMode: 'llm_html',
          taskId: frozen.binding.taskId,
          planVersionId: frozen.binding.planVersionId,
          attemptId: frozen.binding.attemptId,
          requestKey: key,
          publicationId: id,
          sourceReportPackage: materialization.material.sourceReportPackage,
          sourceHash: summarySource.hash,
          planHash: generated.planHash,
          htmlHash: generated.htmlHash,
          validationHash,
          fidelityHash,
          modelCalls: generated.modelCalls,
          generatedAt: this.now().toISOString(),
        };
        const stored = await this.dependencies.store.publish({
          ...coordinates,
          sourceBytes: summarySource.bytes,
          planBytes: generated.planBytes,
          htmlBytes: generated.htmlBytes,
          validationBytes: generated.validationBytes,
          fidelityBytes: generated.fidelityBytes,
          manifestBytes: canonicalJsonBytes(manifest),
          assertStillCurrent: () => this.dependencies.source.assertStillCurrent(frozen.binding),
        });
        return fromStored(stored);
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof EditorialSummaryPipelineError || error instanceof EditorialSummaryStoreError) throw error;
      throw new EditorialSummaryPipelineError('SUMMARY_GENERATION_FAILED', { cause: error });
    }
  }
}
