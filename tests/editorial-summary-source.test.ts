import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEditorialMaterialUnitId,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { buildEditorialSummarySource } from '../apps/orchestrator-runtime/src/report/editorial-summary-source.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

test('builds a lossless semantic source without a presentation template', () => {
  const { material } = showcaseFixture();
  const { source } = buildEditorialSummarySource({
    material,
    reportReview: {
      version: 'report-review-v1',
      verdict: 'pass',
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      reviewedArtifactId: 'deliverable-1',
      reviewedArtifactContentSha256: `sha256:${'8'.repeat(64)}`,
      reviewerModel: 'review-model',
      reviewerModelVersion: 'review-model-v1',
      traceId: 'trace-review',
      dimensions: [],
      revisionRound: 0,
    },
  });

  assert.equal(source.version, 'editorial-summary-source-v1');
  assert.equal(source.binding.taskId, material.taskId);
  assert.equal(source.report.deliverableType, material.deliverableType);
  assert.deepEqual(source.report.requiredQuestionIds, ['Q1']);
  assert.equal(source.sourceUnitCount, material.units.length);
  assert.deepEqual(
    new Set(source.atoms.flatMap(({ sourceUnitIds }) => sourceUnitIds)),
    new Set(material.units.map(({ id }) => id)),
  );
  assert.equal(source.review.verdict, 'pass');

  const encoded = JSON.stringify(source);
  assert.doesNotMatch(encoded, /presentationBrief|visualizationCandidates|profileId|componentKind/u);
});

test('accepts every active Deliverable without changing the Summary source contract', () => {
  const deliverableTypes = [
    'research_plan',
    'research_strategy_report',
    'competitive_analysis_report',
    'voc_diagnosis_report',
    'design_audit_report',
    'accessibility_audit_report',
  ] as const;
  for (const deliverableType of deliverableTypes) {
    const { material } = showcaseFixture();
    const { source } = buildEditorialSummarySource({
      material: { ...material, deliverableType },
      reportReview: { verdict: 'pass' },
    });
    assert.equal(source.report.deliverableType, deliverableType);
    assert.equal(source.version, 'editorial-summary-source-v1');
  }
});

test('deduplicates exact repeated text while retaining every source Unit binding', () => {
  const { material } = showcaseFixture();
  const first = material.units.find(({ questionIds }) => questionIds.includes('Q1'))!;
  const duplicateSourceRef = { ...first.sourceRefs[0], jsonPointer: '/duplicate' };
  const duplicate = {
    ...first,
    id: createEditorialMaterialUnitId({
      sourceArtifactId: duplicateSourceRef.artifactId,
      sourceArtifactContentSha256: material.sourceArtifacts.find(({ artifactId }) => (
        artifactId === duplicateSourceRef.artifactId
      ))!.contentSha256,
      sourceJsonPointer: duplicateSourceRef.jsonPointer,
      role: first.role,
      value: first.value,
    }),
    sourceRefs: [duplicateSourceRef] as const,
  };
  const { source } = buildEditorialSummarySource({
    material: { ...material, units: [...material.units, duplicate] },
    reportReview: { verdict: 'pass' },
  });

  const atom = source.atoms.find(({ sourceUnitIds }) => sourceUnitIds.includes(first.id));
  assert.ok(atom);
  assert.ok(atom.sourceUnitIds.includes(duplicate.id));
  assert.equal(source.sourceUnitCount, material.units.length + 1);
});
