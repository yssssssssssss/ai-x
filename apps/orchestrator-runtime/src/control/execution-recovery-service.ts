import {
  ARTIFACT_QUARANTINE_PENDING_MARKER,
  type ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type { ControlArtifactStore } from './artifact-store.ts';

export interface RecoveryExecution {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  taskState: string;
  attemptState: string;
  leaseExpiresAt: Date;
  failureKind?: string;
}

export interface RecoveryArtifact {
  id: string;
  kind: string;
  state: string;
  storageUri: string;
  quarantinedUri?: string;
  failureReason?: string;
}

export interface ExecutionRecoveryStore {
  recoverVisualPublications(): Promise<number>;
  listExecutions(): Promise<RecoveryExecution[]>;
  pauseExecution(input: { taskId: string; attemptId: string; reason: string }): Promise<void>;
  listArtifactsForAttempt(input: { taskId: string; planVersionId: string; attemptId: string }): Promise<RecoveryArtifact[]>;
  listSucceededStepArtifactIds(attemptId: string): Promise<string[]>;
  quarantineArtifact(input: { artifactId: string }): Promise<void>;
  invalidateArtifact(input: { artifactId: string; reason: string }): Promise<void>;
}

const TERMINAL_ARTIFACT_KINDS = new Set([
  'evidence_manifest',
  'deliverable',
  'report_review',
  'report_document',
  'report_package',
]);
const STEP_OUTPUT_ARTIFACT_KINDS = new Set(['tool_output', 'skill_output', 'llm_output', 'review_output']);
const VISUAL_COMPOSITE_ARTIFACT_KINDS = new Set([
  'visual_asset',
  'visual_asset_manifest',
  'image_annotation',
  'chart_spec',
  'chart_data',
]);

function asTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function recoveryError(message: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${message}: ${detail}`, { cause });
}

export class ExecutionRecoveryService {
  constructor(private readonly dependencies: { store: ExecutionRecoveryStore }) {}

  async recover(now: Date): Promise<void> {
    const nowMs = asTime(now);
    if (!Number.isFinite(nowMs)) throw new Error('recovery timestamp is invalid');
    const errors: Error[] = [];
    try {
      await this.dependencies.store.recoverVisualPublications();
    } catch (error) {
      errors.push(recoveryError('visual publication recovery failed', error));
    }
    const interrupted: RecoveryExecution[] = [];
    let executions: RecoveryExecution[] = [];
    try {
      executions = await this.dependencies.store.listExecutions();
    } catch (error) {
      errors.push(recoveryError('execution recovery scan failed', error));
    }
    for (const execution of executions) {
      if (
        ['paused', 'cancelled'].includes(execution.attemptState)
        && (execution.failureKind === 'worker_loss' || execution.failureKind === 'artifact_invalidation')
      ) {
        interrupted.push(execution);
        continue;
      }
      if (
        !['executing', 'reviewing', 'composing_report'].includes(execution.taskState)
        || execution.attemptState !== 'active'
        || asTime(execution.leaseExpiresAt) > nowMs
      ) continue;
      try {
        await this.dependencies.store.pauseExecution({
          taskId: execution.taskId,
          attemptId: execution.attemptId,
          reason: 'worker_lost',
        });
      } catch (error) {
        errors.push(recoveryError(`execution ${execution.attemptId} pause failed`, error));
        continue;
      }
      interrupted.push(execution);
    }
    for (const execution of interrupted) {
      let succeededStepArtifactIds: ReadonlySet<string> | undefined;
      try {
        succeededStepArtifactIds = new Set(
          await this.dependencies.store.listSucceededStepArtifactIds(execution.attemptId),
        );
      } catch (error) {
        errors.push(recoveryError(`execution ${execution.attemptId} step Artifact reference scan failed`, error));
      }
      let artifacts: RecoveryArtifact[];
      try {
        artifacts = await this.dependencies.store.listArtifactsForAttempt(execution);
      } catch (error) {
        errors.push(recoveryError(`execution ${execution.attemptId} Artifact scan failed`, error));
        continue;
      }
      for (const artifact of artifacts) {
        try {
          if (
            artifact.state === 'STAGING'
            || (
              artifact.state === 'FAILED'
              && artifact.failureReason?.includes(ARTIFACT_QUARANTINE_PENDING_MARKER)
            )
          ) {
            await this.dependencies.store.quarantineArtifact({ artifactId: artifact.id });
          } else if (artifact.state === 'SEALED' && TERMINAL_ARTIFACT_KINDS.has(artifact.kind)) {
            await this.dependencies.store.invalidateArtifact({ artifactId: artifact.id, reason: 'terminal artifact invalidated during execution recovery' });
          } else if (
            artifact.state === 'SEALED'
            && VISUAL_COMPOSITE_ARTIFACT_KINDS.has(artifact.kind)
          ) {
            await this.dependencies.store.invalidateArtifact({
              artifactId: artifact.id,
              reason: 'visual composite Artifact invalidated during execution recovery',
            });
          } else if (
            artifact.state === 'SEALED'
            && STEP_OUTPUT_ARTIFACT_KINDS.has(artifact.kind)
            && succeededStepArtifactIds !== undefined
            && !succeededStepArtifactIds.has(artifact.id)
          ) {
            await this.dependencies.store.invalidateArtifact({
              artifactId: artifact.id,
              reason: 'unpublished step Artifact invalidated during execution recovery',
            });
          }
        } catch (error) {
          errors.push(recoveryError(`Artifact ${artifact.id} recovery failed`, error));
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `execution recovery completed with ${errors.length} error(s): ${errors.map(({ message }) => message).join('; ')}`,
      );
    }
  }
}

export class ControlPlaneExecutionRecoveryStore implements ExecutionRecoveryStore {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly artifacts: Pick<ControlArtifactStore, 'quarantineStagingArtifact'>,
  ) {}
  recoverVisualPublications(): Promise<number> { return this.repository.recoverVisualPublications(); }
  listExecutions(): Promise<RecoveryExecution[]> { return this.repository.listRecoverableExecutions(); }
  async pauseExecution(input: { taskId: string; attemptId: string; reason: string }): Promise<void> {
    await this.repository.expireExecutionLease({ taskId: input.taskId, attemptId: input.attemptId });
  }
  async listArtifactsForAttempt(input: { taskId: string; planVersionId: string; attemptId: string }): Promise<RecoveryArtifact[]> {
    return (await this.repository.listArtifactsForAttempt(input))
      .map((artifact) => ({ ...artifact, failureReason: artifact.failureReason ?? undefined }));
  }
  async listSucceededStepArtifactIds(attemptId: string): Promise<string[]> {
    return (await this.repository.listExecutionSteps(attemptId))
      .filter((step) => step.state === 'succeeded' && step.outputArtifactId !== null)
      .map((step) => step.outputArtifactId!);
  }
  async quarantineArtifact(input: { artifactId: string }): Promise<void> {
    await this.artifacts.quarantineStagingArtifact(input.artifactId);
  }
  invalidateArtifact(input: { artifactId: string; reason: string }): Promise<void> {
    return this.repository.invalidateArtifactPublication(input.artifactId, input.reason);
  }
}

export class ExecutionRecoveryController {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly service: ExecutionRecoveryService,
    private readonly intervalMs = 30_000,
    private readonly now = () => new Date(),
    private readonly onError: (error: unknown) => void = (error) => console.error('execution recovery failed:', error),
  ) {}
  private runCycle(): void {
    if (this.running !== undefined) return;
    this.running = this.service.recover(this.now())
      .catch((error) => { this.onError(error); })
      .finally(() => { this.running = undefined; });
  }
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.runCycle();
    this.timer = setInterval(() => this.runCycle(), this.intervalMs);
    await this.running;
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    this.running = undefined;
  }
}
