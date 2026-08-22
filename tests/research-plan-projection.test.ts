import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchPlanPayload } from '../packages/api-contract/research-deliverable.ts';
import type { ReportDocument } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import {
  assertProjectionCoverage,
  assertReportProjectionIntegrity,
  projectResearchPlan,
  researchPlanRequiredPointers,
} from '../apps/orchestrator-runtime/src/report/report-projection.ts';

function payload(): ResearchPlanPayload {
  return {
    title: 'Research plan',
    researchGoal: 'Answer the decision question',
    scope: { market: 'global', subjects: ['cat', 'dog'], timeWindow: 'five weeks' },
    competitorSampling: {
      strategy: 'stratified', targetCount: 6,
      inclusionCriteria: ['public evidence'], exclusionCriteria: ['no evidence'],
    },
    researchQuestions: ['Q1'],
    comparisonDimensions: [{ id: 'd1', name: 'Trust', purpose: 'compare trust', collectionFields: ['proof'] }],
    sourcePlan: [{ evidenceClass: 'knowledge', sourceTypes: ['standard'], purpose: 'method basis' }],
    executionPlan: [{ phase: 'week 1', activities: ['desk research'], duration: '1 week', outputs: ['matrix'] }],
    collectionTemplate: [{ field: 'proof', description: 'source proof', evidenceRequired: true }],
    analysisMethods: ['thematic analysis'],
    deliverables: ['strategy map'],
    qualityChecks: ['source traceability'],
  };
}

function projectedDocument(): { document: ReportDocument; payload: ResearchPlanPayload } {
  const source = payload();
  const projection = projectResearchPlan({
    payload: source,
    deliverableArtifactId: 'deliverable-1',
    requiredPointers: researchPlanRequiredPointers(),
  });
  return {
    payload: source,
    document: {
      version: 'report-document-v2',
      title: 'Research plan',
      subtitle: 'Validated projection',
      executiveSummary: 'Complete plan.',
      sections: projection.sections,
      ...projection.coverage,
    },
  };
}

test('research plan projection derives and covers all required payload fields without empty sections', () => {
  const requiredPointers = researchPlanRequiredPointers();
  const result = projectResearchPlan({
    payload: payload(),
    deliverableArtifactId: 'deliverable-1',
    requiredPointers,
  });
  assert.deepEqual(result.coverage.coveredPointers, requiredPointers);
  assert.deepEqual(result.coverage.omittedPointers, []);
  assert.ok(result.sections.every(({ blocks }) => blocks.length > 0));
  assert.ok(result.sections.flatMap(({ blocks }) => blocks).every(({ type }) => type === 'projection-list'));
  assert.match(JSON.stringify(result.sections), /week 1/u);
  assert.match(JSON.stringify(result.sections), /source traceability/u);
});

test('full projection rejects a missing required pointer while summary requires an omission reason', () => {
  const requiredPointers = researchPlanRequiredPointers();
  assert.throws(() => assertProjectionCoverage(requiredPointers, {
    sourceDeliverableArtifactId: 'deliverable-1',
    projectionMode: 'full',
    coveredPointers: requiredPointers.slice(1),
    omittedPointers: [],
  }), /does not cover required payload pointer \/title/u);

  assert.doesNotThrow(() => assertProjectionCoverage(requiredPointers, {
    sourceDeliverableArtifactId: 'deliverable-1',
    projectionMode: 'summary',
    coveredPointers: requiredPointers.slice(1),
    omittedPointers: [{ pointer: '/title', reason: 'title is represented by the package name' }],
  }));
});

test('v2 projection integrity rejects source identity, block provenance, and payload pointer tampering', () => {
  const { document, payload: source } = projectedDocument();
  assert.doesNotThrow(() => assertReportProjectionIntegrity({
    document,
    deliverableArtifactId: 'deliverable-1',
    payload: source,
  }));
  assert.throws(() => assertReportProjectionIntegrity({
    document: { ...document, sourceDeliverableArtifactId: 'other-deliverable' },
    deliverableArtifactId: 'deliverable-1',
    payload: source,
  }), /identity mismatch/u);
  assert.throws(() => assertReportProjectionIntegrity({
    document: { ...document, coveredPointers: document.coveredPointers?.slice(1) },
    deliverableArtifactId: 'deliverable-1',
    payload: source,
  }), /do not match projection block provenance/u);
  const tampered = structuredClone(document);
  const projectionBlock = tampered.sections.flatMap(({ blocks }) => blocks)
    .find((block) => block.type === 'projection-list');
  if (!projectionBlock || projectionBlock.type !== 'projection-list') throw new Error('fixture projection block missing');
  projectionBlock.sourcePointers[0] = '/notPresent';
  tampered.coveredPointers![0] = '/notPresent';
  assert.throws(() => assertReportProjectionIntegrity({
    document: tampered,
    deliverableArtifactId: 'deliverable-1',
    payload: source,
  }), /pointer does not exist/u);
});
