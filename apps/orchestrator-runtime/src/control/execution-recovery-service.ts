export interface RecoveryExecution {
  taskId: string;
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
  listArtifacts(): Promise<RecoveryArtifact[]>;
  quarantineArtifact(input: { artifactId: string; quarantineUri: string }): Promise<void>;
  failArtifact(input: { artifactId: string; reason: string }): Promise<void>;
  invalidateArtifact(input: { artifactId: string; reason: string }): Promise<void>;
}

const TERMINAL_ARTIFACT_KINDS = new Set([
  'evidence_manifest',
  'deliverable',
  'report_review',
  'report_document',
]);

function asTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return time;
}

export class ExecutionRecoveryService {
  constructor(private readonly dependencies: { store: ExecutionRecoveryStore }) {}

  async recover(now: Date): Promise<void> {
    const nowMs = asTime(now);
    if (!Number.isFinite(nowMs)) throw new Error('recovery timestamp is invalid');

    const executions = await this.dependencies.store.listExecutions();
    for (const execution of executions) {
      if (
        execution.taskState === 'executing'
        && execution.attemptState === 'active'
        && asTime(execution.leaseExpiresAt) <= nowMs
      ) {
        await this.dependencies.store.pauseExecution({
          taskId: execution.taskId,
          attemptId: execution.attemptId,
          reason: 'worker_lost',
        });
      }
    }

    const artifacts = await this.dependencies.store.listArtifacts();
    for (const artifact of artifacts) {
      if (artifact.state === 'STAGING') {
        const quarantineUri = `${artifact.storageUri}.${artifact.id}.orphan`;
        await this.dependencies.store.quarantineArtifact({
          artifactId: artifact.id,
          quarantineUri,
        });
        await this.dependencies.store.failArtifact({
          artifactId: artifact.id,
          reason: `orphaned staging artifact moved to ${quarantineUri}`,
        });
        continue;
      }

      if (artifact.state === 'SEALED' && TERMINAL_ARTIFACT_KINDS.has(artifact.kind)) {
        await this.dependencies.store.invalidateArtifact({
          artifactId: artifact.id,
          reason: 'terminal artifact invalidated during execution recovery',
        });
      }
    }
  }
}
