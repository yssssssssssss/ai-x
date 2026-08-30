import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseReportPackageV3,
  REPORT_PACKAGE_V3_VERSION,
} from '../packages/api-contract/report-package.ts';

const SHA = `sha256:${'a'.repeat(64)}`;

function readyPackage() {
  return {
    version: REPORT_PACKAGE_V3_VERSION,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    reportPublicationId: 'report-publication-v1:abc',
    canonicalPackageArtifactId: 'package-v2-1',
    canonicalPackageContentSha256: SHA,
    preferredHtml: 'showcase',
    showcase: {
      status: 'ready',
      specArtifactId: 'showcase-spec-1',
      htmlArtifactId: 'showcase-html-1',
      rendererVersion: 'editorial-showcase-html-v1',
      profileId: 'editorial-showcase-v1',
      generationMode: 'model',
      showcaseOutlineSignature: SHA,
    },
  };
}

test('Report Package v3 preserves canonical v2 root and a ready Showcase variant', () => {
  assert.deepEqual(parseReportPackageV3(readyPackage()), readyPackage());
});

test('Report Package v3 requires canonical preference when Showcase is unavailable', () => {
  assert.throws(
    () => parseReportPackageV3({
      ...readyPackage(),
      showcase: { status: 'unavailable', reasonCode: 'showcase_provider_failure' },
    }),
    /preferredHtml/u,
  );
  assert.equal(parseReportPackageV3({
    ...readyPackage(),
    preferredHtml: 'canonical',
    showcase: { status: 'unavailable', reasonCode: 'showcase_provider_failure' },
  }).showcase.status, 'unavailable');
});

test('Report Package v3 rejects unknown fields and invalid Showcase identities', () => {
  assert.throws(() => parseReportPackageV3({ ...readyPackage(), extra: true }), /extra/u);
  assert.throws(() => parseReportPackageV3({
    ...readyPackage(),
    showcase: { ...readyPackage().showcase, profileId: 'case-specific-template' },
  }), /profileId/u);
});
