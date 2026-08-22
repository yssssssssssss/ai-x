import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchPlanPayload } from '../packages/api-contract/research-deliverable.ts';
import {
  RESEARCH_PLAN_REQUIRED_POINTERS,
  assertProjectionCoverage,
  projectResearchPlan,
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

test('research plan projection covers all twelve required payload fields without empty sections', () => {
  const result = projectResearchPlan({ payload: payload(), deliverableArtifactId: 'deliverable-1' });
  assert.deepEqual(result.coverage.coveredPointers, [...RESEARCH_PLAN_REQUIRED_POINTERS]);
  assert.deepEqual(result.coverage.omittedPointers, []);
  assert.ok(result.sections.every(({ blocks }) => blocks.length > 0));
  assert.match(JSON.stringify(result.sections), /week 1/u);
  assert.match(JSON.stringify(result.sections), /source traceability/u);
});

test('full projection rejects a missing required pointer while summary requires an omission reason', () => {
  assert.throws(() => assertProjectionCoverage(RESEARCH_PLAN_REQUIRED_POINTERS, {
    sourceDeliverableArtifactId: 'deliverable-1',
    projectionMode: 'full',
    coveredPointers: RESEARCH_PLAN_REQUIRED_POINTERS.slice(1),
    omittedPointers: [],
  }), /does not cover required payload pointer \/title/u);

  assert.doesNotThrow(() => assertProjectionCoverage(RESEARCH_PLAN_REQUIRED_POINTERS, {
    sourceDeliverableArtifactId: 'deliverable-1',
    projectionMode: 'summary',
    coveredPointers: RESEARCH_PLAN_REQUIRED_POINTERS.slice(1),
    omittedPointers: [{ pointer: '/title', reason: 'title is represented by the package name' }],
  }));
});
