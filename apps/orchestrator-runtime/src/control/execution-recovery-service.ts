import type { ControlPlaneRepository } from '../../../../database/control-plane.ts';

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
  listExecutions(): Promise<RecoveryExecution[]>;
  pauseExecution(input: { taskId: string; attemptId: string; reason: string }): Promise<void>;
  listArtifactsForAttempt(input: { taskId: string; planVersionId: string; attemptId: string }): Promise<RecoveryArtifact[]>;
  quarantineArtifact(input: { artifactId: string; quarantineUri: string }): Promise<void>;
  failArtifact(input: { artifactId: string; reason: string }): Promise<void>;
  invalidateArtifact(input: { artifactId: string; reason: string }): Promise<void>;
}

const TERMINAL_ARTIFACT_KINDS = new Set(['evidence_manifest', 'deliverable', 'report_review', 'report_document']);

function asTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export class ExecutionRecoveryService {
  constructor(private readonly dependencies: { store: ExecutionRecoveryStore }) {}

  async recover(now: Date): Promise<void> {
    const nowMs = asTime(now);
    if (!Number.isFinite(nowMs)) throw new Error('recovery timestamp is invalid');
    const paused: RecoveryExecution[] = [];
    for (const execution of await this.dependencies.store.listExecutions()) {
      if (execution.taskState !== 'executing' || execution.attemptState !== 'active' || asTime(execution.leaseExpiresAt) > nowMs) continue;
      await this.dependencies.store.pauseExecution({ taskId: execution.taskId, attemptId: execution.attemptId, reason: 'worker_lost' });
      paused.push(execution);
    }
    for (const execution of paused) {
      const artifacts = await this.dependencies.store.listArtifactsForAttempt(execution);
      for (const artifact of artifacts) {
        if (artifact.state === 'STAGING') {
          const quarantineUri = `${artifact.storageUri}.${artifact.id}.orphan`;
          await this.dependencies.store.quarantineArtifact({ artifactId: artifact.id, quarantineUri });
          await this.dependencies.store.failArtifact({ artifactId: artifact.id, reason: `orphaned staging artifact moved to ${quarantineUri}` });
        } else if (artifact.state === 'SEALED' && TERMINAL_ARTIFACT_KINDS.has(artifact.kind)) {
          await this.dependencies.store.invalidateArtifact({ artifactId: artifact.id, reason: 'terminal artifact invalidated during execution recovery' });
        }
      }
    }
  }
}

export class ControlPlaneExecutionRecoveryStore implements ExecutionRecoveryStore {
  constructor(private readonly repository: ControlPlaneRepository) {}
  listExecutions(): Promise<RecoveryExecution[]> { return this.repository.listRecoverableExecutions(); }
  async pauseExecution(input: { taskId: string; attemptId: string; reason: string }): Promise<void> {
    await this.repository.expireExecutionLease({ taskId: input.taskId, attemptId: input.attemptId });
  }
  async listArtifactsForAttempt(input: { taskId: string; planVersionId: string; attemptId: string }): Promise<RecoveryArtifact[]> {
    return (await this.repository.listArtifactsForAttempt({ ...input, kinds: ['evidence_manifest', 'deliverable', 'report_review', 'report_document'] })).map((artifact) => ({ ...artifact, failureReason: artifact.failureReason ?? undefined }));
  }
  quarantineArtifact(input: { artifactId: string; quarantineUri: string }): Promise<void> {
    return this.repository.quarantineArtifact(input);
  }
  failArtifact(input: { artifactId: string; reason: string }): Promise<void> {
    return this.repository.failArtifact(input.artifactId, input.reason);
  }
  invalidateArtifact(input: { artifactId: string; reason: string }): Promise<void> {
    return this.repository.invalidateArtifactPublication(input.artifactId, input.reason);
  }
}

export class ExecutionRecoveryController {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly service: ExecutionRecoveryService, private readonly intervalMs = 30_000, private readonly now = () => new Date()) {}
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.service.recover(this.now());
    this.timer = setInterval(() => {
      if (this.running !== undefined) return;
      this.running = this.service.recover(this.now()).finally(() => { this.running = undefined; });
    }, this.intervalMs);
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    this.running = undefined;
  }
}
