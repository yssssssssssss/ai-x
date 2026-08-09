import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { ControlArtifact, ControlPlaneRepository } from '../../../../database/control-plane.ts';

export class ArtifactIntegrityError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} checksum does not match its sealed record`);
    this.name = 'ArtifactIntegrityError';
  }
}

export interface ArtifactWriteInput {
  taskId: string;
  planVersionId: string;
  attemptId?: string;
  kind: string;
  relativePath: string;
  value: unknown;
  schemaVersion?: string;
  sensitivity?: string;
  redactionPolicyVersion?: string;
}

export class ControlArtifactStore {
  constructor(
    private readonly options: {
      root: string;
      registry: Pick<
        ControlPlaneRepository,
        'createStagingArtifact' | 'sealArtifact' | 'failArtifact' | 'getArtifact' | 'listStagingArtifacts' | 'requireSealedArtifact'
      >;
    },
  ) {}

  private directoryFor(input: Pick<ArtifactWriteInput, 'taskId' | 'planVersionId' | 'attemptId'>): string {
    if (input.attemptId) {
      return join(this.options.root, 'tasks', input.taskId, 'attempts', input.attemptId);
    }
    return join(this.options.root, 'tasks', input.taskId, 'plans', input.planVersionId);
  }

  private resolveArtifactPath(directory: string, relativePath: string): string {
    if (isAbsolute(relativePath) || normalize(relativePath).startsWith('..')) {
      throw new Error(`artifact path must stay under its versioned directory: ${relativePath}`);
    }
    const target = resolve(directory, relativePath);
    if (relative(directory, target).startsWith('..')) {
      throw new Error(`artifact path must stay under its versioned directory: ${relativePath}`);
    }
    return target;
  }

  async writeJson(input: ArtifactWriteInput): Promise<ControlArtifact> {
    const directory = this.directoryFor(input);
    const storageUri = this.resolveArtifactPath(directory, input.relativePath);
    const artifact = await this.options.registry.createStagingArtifact({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: input.kind,
      storageUri,
      schemaVersion: input.schemaVersion ?? 'v1',
      sensitivity: input.sensitivity ?? 'internal',
      redactionPolicyVersion: input.redactionPolicyVersion ?? 'v1',
    });
    const temporaryUri = `${storageUri}.${artifact.id}.tmp`;

    try {
      mkdirSync(dirname(storageUri), { recursive: true });
      const content = JSON.stringify(input.value, null, 2);
      writeFileSync(temporaryUri, content);
      const descriptor = openSync(temporaryUri, 'r');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      linkSync(temporaryUri, storageUri);
      unlinkSync(temporaryUri);
      const bytes = readFileSync(storageUri);
      const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      return await this.options.registry.sealArtifact({
        artifactId: artifact.id,
        contentSha256,
        byteSize: bytes.byteLength,
      });
    } catch (error) {
      if (existsSync(temporaryUri)) rmSync(temporaryUri, { force: true });
      await this.options.registry.failArtifact(artifact.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async reconcileStaging(): Promise<void> {
    for (const artifact of await this.options.registry.listStagingArtifacts()) {
      if (!existsSync(artifact.storageUri)) {
        await this.options.registry.failArtifact(artifact.id, 'staging artifact file is missing');
        continue;
      }
      const quarantineUri = `${artifact.storageUri}.${artifact.id}.orphan`;
      renameSync(artifact.storageUri, quarantineUri);
      await this.options.registry.failArtifact(artifact.id, `orphaned staging artifact moved to ${quarantineUri}`);
    }
  }

  async verifySealed(artifactId: string): Promise<ControlArtifact> {
    const artifact = await this.options.registry.requireSealedArtifact(artifactId);
    const bytes = readFileSync(artifact.storageUri);
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== artifact.contentSha256) {
      throw new ArtifactIntegrityError(artifactId);
    }
    return artifact;
  }
}
