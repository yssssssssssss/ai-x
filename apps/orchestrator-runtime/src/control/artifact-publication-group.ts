import type { ControlArtifactStore } from './artifact-store.ts';

type ArtifactInvalidator = Pick<ControlArtifactStore, 'invalidateArtifactPublication'>;
type PublicationState = 'open' | 'committed' | 'compensated' | 'compensation_failed';

export class ArtifactInvalidationError extends Error {
  constructor(
    readonly failedArtifactIds: string[],
    readonly invalidationReason: string,
    readonly failures: unknown[] = [],
  ) {
    super(`Artifact invalidation failed for: ${failedArtifactIds.join(', ')}`);
    this.name = 'ArtifactInvalidationError';
  }
}

export function mergeArtifactInvalidationErrors(
  error: ArtifactInvalidationError,
  compensationError: ArtifactInvalidationError,
): ArtifactInvalidationError {
  if (error === compensationError) return error;
  return new ArtifactInvalidationError(
    [...new Set([...error.failedArtifactIds, ...compensationError.failedArtifactIds])],
    compensationError.invalidationReason,
    [...new Set([...error.failures, ...compensationError.failures])],
  );
}

export class ArtifactPublicationGroup {
  private readonly tracked = new Set<string>();
  private state: PublicationState = 'open';
  private compensationFailure: ArtifactInvalidationError | undefined;

  constructor(private readonly artifacts: ArtifactInvalidator) {}

  get artifactIds(): string[] {
    return [...this.tracked];
  }

  track(artifactId: string): this {
    if (this.state !== 'open') {
      throw new Error(`Artifact publication group is already ${this.state}`);
    }
    if (!artifactId.trim()) throw new Error('Artifact publication group requires an Artifact id');
    this.tracked.add(artifactId);
    return this;
  }

  commit(): void {
    if (this.state !== 'open') {
      throw new Error(`Artifact publication group is already ${this.state}`);
    }
    this.state = 'committed';
  }

  async compensate(reason: string): Promise<void> {
    if (this.state === 'committed') {
      throw new Error('Artifact publication group is already committed');
    }
    if (this.state === 'compensated') return;
    if (this.state === 'compensation_failed') {
      throw this.compensationFailure;
    }
    const artifactIds = this.artifactIds;
    const outcomes = await Promise.allSettled(artifactIds.map((artifactId) => (
      this.artifacts.invalidateArtifactPublication(artifactId, reason)
    )));
    const failedArtifactIds: string[] = [];
    const failures: unknown[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      failedArtifactIds.push(artifactIds[index]!);
      failures.push(outcome.reason);
    });
    if (failedArtifactIds.length > 0) {
      this.state = 'compensation_failed';
      this.compensationFailure = new ArtifactInvalidationError(failedArtifactIds, reason, failures);
      throw this.compensationFailure;
    }
    this.state = 'compensated';
  }
}
