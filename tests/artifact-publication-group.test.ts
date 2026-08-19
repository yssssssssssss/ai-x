import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArtifactInvalidationError,
  ArtifactPublicationGroup,
} from '../apps/orchestrator-runtime/src/control/artifact-publication-group.ts';

test('tracks Artifact ids once and compensates every publication in order', async () => {
  const invalidations: Array<{ artifactId: string; reason: string }> = [];
  const group = new ArtifactPublicationGroup({
    async invalidateArtifactPublication(artifactId, reason) {
      invalidations.push({ artifactId, reason });
    },
  });

  group.track('tool-1').track('asset-1').track('tool-1').track('manifest-1');
  await group.compensate('publication failed');
  await group.compensate('publication failed again');

  assert.deepEqual(group.artifactIds, ['tool-1', 'asset-1', 'manifest-1']);
  assert.deepEqual(invalidations, [
    { artifactId: 'tool-1', reason: 'publication failed' },
    { artifactId: 'asset-1', reason: 'publication failed' },
    { artifactId: 'manifest-1', reason: 'publication failed' },
  ]);
});

test('attempts every invalidation and reports each failed Artifact id', async () => {
  const attempted: string[] = [];
  const group = new ArtifactPublicationGroup({
    async invalidateArtifactPublication(artifactId) {
      attempted.push(artifactId);
      if (artifactId !== 'asset-1') throw new Error(`cannot invalidate ${artifactId}`);
    },
  });
  group.track('tool-1').track('asset-1').track('manifest-1');

  await assert.rejects(
    () => group.compensate('publication failed'),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactInvalidationError);
      assert.deepEqual(error.failedArtifactIds, ['tool-1', 'manifest-1']);
      return true;
    },
  );
  assert.deepEqual(attempted, ['tool-1', 'asset-1', 'manifest-1']);
});

test('rethrows the same compensation failure without repeating invalidations', async () => {
  const attempts: string[] = [];
  const group = new ArtifactPublicationGroup({
    invalidateArtifactPublication: async (artifactId: string) => {
      attempts.push(artifactId);
      throw new Error(`cannot invalidate ${artifactId}`);
    },
  } as never).track('artifact-a');

  let first: unknown;
  await assert.rejects(
    async () => {
      try {
        await group.compensate('failed publication');
      } catch (error) {
        first = error;
        throw error;
      }
    },
    ArtifactInvalidationError,
  );
  await assert.rejects(
    () => group.compensate('ignored retry reason'),
    (error: unknown) => error === first,
  );
  assert.deepEqual(attempts, ['artifact-a']);
});

test('committed publication groups cannot be compensated or extended', async () => {
  let invalidations = 0;
  const group = new ArtifactPublicationGroup({
    async invalidateArtifactPublication() { invalidations += 1; },
  });
  group.track('tool-1');
  group.commit();

  assert.throws(() => group.track('asset-1'), /committed/u);
  await assert.rejects(() => group.compensate('late cancellation'), /committed/u);
  assert.equal(invalidations, 0);
});
