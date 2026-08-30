import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ControlArtifact, ControlExecutionLease } from '../database/control-plane.ts';
import type { ReportPackageV2 } from '../packages/api-contract/report-package.ts';
import { REPORT_PACKAGE_V2_VERSION } from '../packages/api-contract/report-package.ts';
import {
  ReportPackageV3ArtifactService,
} from '../apps/orchestrator-runtime/src/report/report-package-v3-artifact.ts';
import {
  bindEditorialShowcaseEvidenceManifest,
  compileEditorialShowcase,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
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
  contentSha256?: string;
  mediaType?: string;
  storageUri?: string;
}): ControlArtifact {
  return {
    id: input.id,
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    kind: input.kind,
    state: 'SEALED',
    storageUri: input.storageUri ?? `/safe/${input.id}`,
    contentSha256: input.contentSha256 ?? SHA,
    byteSize: 100,
    schemaVersion: input.schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
  };
}

function canonicalValue(): ReportPackageV2 {
  return {
    version: REPORT_PACKAGE_V2_VERSION,
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    reportPublicationId: 'report-publication-v1:abc',
    presentationMode: 'multimodal',
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-1',
    reportReviewArtifactId: 'review-1',
    sourceReportDocumentArtifactId: 'document-1',
    sourceReportDocumentContentSha256: SHA,
    layout: { mode: 'model', blueprintArtifactId: 'blueprint-1' },
    assetSnapshot: { assets: [], charts: [] },
    standaloneHtml: {
      status: 'ready', artifactId: 'canonical-html-1', rendererVersion: 'standalone-html-v2',
    },
    notices: [],
  };
}

test('Report Package v3 seals a preferred Showcase while retaining the verified canonical v2 package', async () => {
  const evidenceManifest = showcaseEvidenceManifestFixture();
  const spec = bindEditorialShowcaseEvidenceManifest(compileEditorialShowcase(
    showcaseMaterialFixture(),
    showcaseIntentFixture(),
    'model',
  ).spec, {
    artifactId: 'evidence-1',
    contentSha256: SHA,
    manifestHash: evidenceManifest.manifestHash,
  });
  const canonicalArtifact = artifact({
    id: 'package-v2-1',
    kind: 'report_package',
    schemaVersion: 'report-package-v2',
    contentSha256: `sha256:${'b'.repeat(64)}`,
    storageUri: '/safe/reports/report-package.json',
  });
  const specArtifact = artifact({
    id: 'showcase-spec-1', kind: 'report_editorial_showcase_spec', schemaVersion: spec.version,
  });
  const htmlArtifact = artifact({
    id: 'showcase-html-1', kind: 'editorial_showcase_html', schemaVersion: 'editorial-showcase-html-v1',
    mediaType: 'text/html; charset=utf-8',
  });
  let packageValue: unknown;
  const service = new ReportPackageV3ArtifactService({
    artifacts: {
      async writeJson(input) {
        packageValue = input.value;
        return artifact({
          id: 'package-v3-1', kind: 'report_package', schemaVersion: 'report-package-v3',
          storageUri: '/safe/reports/report-package-v3.json',
        });
      },
      async readVerifiedBoundJson<T>(id: string): Promise<{ artifact: ControlArtifact; value: T }> {
        if (id === 'package-v3-1') return { artifact: artifact({ id, kind: 'report_package', schemaVersion: 'report-package-v3', storageUri: '/safe/reports/report-package-v3.json' }), value: packageValue as T };
        if (id === 'deliverable-1') return { artifact: artifact({ id, kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated' }), value: { taskId: lease.taskId, planVersionId: lease.planVersionId, attemptId: lease.attemptId } as T };
        if (id === 'evidence-1') return { artifact: artifact({ id, kind: 'evidence_manifest', schemaVersion: 'evidence-v1' }), value: evidenceManifest as T };
        if (id === specArtifact.id) return { artifact: specArtifact, value: spec as T };
        throw new Error(`unexpected JSON ${id}`);
      },
      async readVerifiedBoundText(id) {
        assert.equal(id, htmlArtifact.id);
        return {
          artifact: htmlArtifact,
          content: `<!doctype html><meta name="showcase-profile" content="editorial-showcase-v1"><meta name="showcase-outline-signature" content="${spec.showcaseOutlineSignature}"><meta name="showcase-renderer-version" content="editorial-showcase-html-v1"><meta name="showcase-spec-sha256" content="${SHA}"><meta name="source-deliverable-sha256" content="${SHA}"><meta name="source-evidence-manifest-id" content="evidence-1"><meta name="source-evidence-manifest-sha256" content="${SHA}"><meta name="source-evidence-manifest-hash" content="${evidenceManifest.manifestHash}">`,
        };
      },
    },
    canonicalPackages: {
      async verify() { return { artifact: canonicalArtifact, value: canonicalValue() }; },
    },
  });

  const result = await service.seal({
    activeLease: lease,
    canonicalPackageArtifactId: canonicalArtifact.id,
    canonicalPackageContentSha256: canonicalArtifact.contentSha256!,
    reportPublicationId: canonicalValue().reportPublicationId,
    preferredHtml: 'showcase',
    showcase: {
      status: 'ready',
      specArtifactId: specArtifact.id,
      htmlArtifactId: htmlArtifact.id,
      rendererVersion: 'editorial-showcase-html-v1',
      profileId: 'editorial-showcase-v1',
      generationMode: 'model',
      showcaseOutlineSignature: spec.showcaseOutlineSignature,
    },
  });

  assert.equal(result.schemaVersion, 'report-package-v3');
  assert.equal((packageValue as { preferredHtml: string }).preferredHtml, 'showcase');

  spec.binding.evidenceManifestHash = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(
    service.verify({
      artifactId: result.id,
      taskId: lease.taskId,
      planVersionId: lease.planVersionId,
      attemptId: lease.attemptId,
    }),
    /Showcase Spec identity is invalid/u,
  );
});
