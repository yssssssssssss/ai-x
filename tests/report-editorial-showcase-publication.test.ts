import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ControlArtifact, ControlExecutionLease } from '../database/control-plane.ts';
import {
  EditorialShowcasePublicationService,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-publication.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import {
  showcaseEvidenceManifestFixture,
  showcaseIntentFixture,
  showcaseMaterialFixture,
} from './fixtures/report-editorial/showcase-fixtures.ts';

const SHA = `sha256:${'a'.repeat(64)}`;
const lease: ControlExecutionLease = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  leaseOwner: 'worker-1',
  leaseToken: 'token-1',
};

function artifact(input: {
  id: string;
  kind: string;
  schemaVersion: string;
  mediaType?: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    kind: input.kind,
    state: 'SEALED',
    storageUri: `/safe/${input.id}`,
    contentSha256: SHA,
    byteSize: 100,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
  };
}

const evidenceManifestArtifact = (): ControlArtifact => artifact({
  id: 'evidence-manifest-1',
  kind: 'evidence_manifest',
  schemaVersion: 'evidence-v1',
});

test('publication validates and seals the Showcase spec and offline HTML with one binding', async () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  const writes: Array<Record<string, unknown>> = [];
  const tracked: string[] = [];
  const publication = new EditorialShowcasePublicationService({
    artifacts: {
      async writeJson(input) {
        writes.push(input as unknown as Record<string, unknown>);
        return artifact({
          id: 'showcase-spec-1',
          kind: 'report_editorial_showcase_spec',
          schemaVersion: 'editorial-presentation-spec-v1',
        });
      },
      async writeText(input) {
        writes.push(input as unknown as Record<string, unknown>);
        return artifact({
          id: 'showcase-html-1',
          kind: 'editorial_showcase_html',
          schemaVersion: 'editorial-showcase-html-v1',
          mediaType: 'text/html; charset=utf-8',
        });
      },
      async invalidateArtifactPublication() {},
    },
  });

  const result = await publication.publish({
    activeLease: lease,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
    evidenceManifestArtifact: evidenceManifestArtifact(),
    spec,
    onArtifactSealed: (sealed) => tracked.push(sealed.id),
  });

  assert.deepEqual(tracked, ['showcase-spec-1', 'showcase-html-1']);
  assert.equal(writes[0]?.relativePath, 'reports/editorial-showcase-spec.json');
  assert.equal(writes[1]?.relativePath, 'reports/editorial-showcase.html');
  assert.equal(result.showcase.status, 'ready');
  if (result.showcase.status !== 'ready') assert.fail('showcase should be ready');
  assert.equal(result.showcase.specArtifactId, 'showcase-spec-1');
  assert.equal(result.showcase.htmlArtifactId, 'showcase-html-1');
  assert.equal(result.showcase.profileId, 'editorial-showcase-v1');
  assert.equal(result.showcase.generationMode, 'model');
  assert.deepEqual(
    (writes[0]?.value as { binding: Record<string, unknown> }).binding,
    {
      ...material.binding,
      evidenceManifestArtifactId: 'evidence-manifest-1',
      evidenceManifestContentSha256: SHA,
      evidenceManifestHash: showcaseEvidenceManifestFixture().manifestHash,
    },
  );
  assert.match(String(writes[1]?.content), /data-showcase-profile="editorial-showcase-v1"/u);
  assert.match(String(writes[1]?.content), /name="showcase-spec-sha256" content="sha256:[a-f0-9]{64}"/u);
  assert.match(String(writes[1]?.content), /name="source-evidence-manifest-id" content="evidence-manifest-1"/u);
  assert.match(String(writes[1]?.content), /name="source-evidence-manifest-sha256" content="sha256:[a-f0-9]{64}"/u);
});

test('publication compensates a partial Showcase and returns unavailable when the HTML write fails', async () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  const invalidated: string[] = [];
  const publication = new EditorialShowcasePublicationService({
    artifacts: {
      async writeJson() {
        return artifact({
          id: 'showcase-spec-partial',
          kind: 'report_editorial_showcase_spec',
          schemaVersion: 'editorial-presentation-spec-v1',
        });
      },
      async writeText() { throw new Error('disk unavailable'); },
      async invalidateArtifactPublication(id) { invalidated.push(id); },
    },
  });

  const result = await publication.publish({
    activeLease: lease,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
    evidenceManifestArtifact: evidenceManifestArtifact(),
    spec,
  });

  assert.deepEqual(result, {
    showcase: { status: 'unavailable', reasonCode: 'showcase_renderer_failure' },
  });
  assert.deepEqual(invalidated, ['showcase-spec-partial']);
});

test('publication invalidates a malformed sealed Artifact returned by the store', async () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  const invalidated: string[] = [];
  const publication = new EditorialShowcasePublicationService({
    artifacts: {
      async writeJson() {
        return artifact({
          id: 'malformed-showcase-spec',
          kind: 'wrong_kind',
          schemaVersion: 'editorial-presentation-spec-v1',
        });
      },
      async writeText() { throw new Error('must not write HTML'); },
      async invalidateArtifactPublication(id) { invalidated.push(id); },
    },
  });

  const result = await publication.publish({
    activeLease: lease,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
    evidenceManifestArtifact: evidenceManifestArtifact(),
    spec,
  });

  assert.deepEqual(result, {
    showcase: { status: 'unavailable', reasonCode: 'showcase_renderer_failure' },
  });
  assert.deepEqual(invalidated, ['malformed-showcase-spec']);
});

test('publication rejects a mismatched Evidence binding before writing any Artifact', async () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  let writes = 0;
  const publication = new EditorialShowcasePublicationService({
    artifacts: {
      async writeJson() { writes += 1; return artifact({ id: 'unexpected', kind: 'x', schemaVersion: 'x' }); },
      async writeText() { writes += 1; return artifact({ id: 'unexpected', kind: 'x', schemaVersion: 'x' }); },
      async invalidateArtifactPublication() {},
    },
  });
  const evidenceManifest = { ...showcaseEvidenceManifestFixture(), attemptId: 'other-attempt' };

  await assert.rejects(
    publication.publish({
      activeLease: lease,
      material,
      evidenceManifest,
      evidenceManifestArtifact: evidenceManifestArtifact(),
      spec,
    }),
    /Evidence Manifest binding does not match/u,
  );
  await assert.rejects(
    publication.publish({
      activeLease: lease,
      material,
      evidenceManifest: showcaseEvidenceManifestFixture(),
      evidenceManifestArtifact: { ...evidenceManifestArtifact(), attemptId: 'other-attempt' },
      spec,
    }),
    /Evidence Manifest Artifact binding is invalid/u,
  );
  assert.equal(writes, 0);
});
