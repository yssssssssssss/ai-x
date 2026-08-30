import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeResearchStrategyDocument } from '../apps/orchestrator-runtime/src/report/dynamic-report-composer.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { assertReportProjectionIntegrity } from '../apps/orchestrator-runtime/src/report/report-projection.ts';
import { strategyPayload } from './research-strategy-contract.test.ts';

const payloadSchema = JSON.parse(readFileSync('schemas/deliverables/research-strategy-report.schema.json', 'utf8')) as object;

test('dynamic strategy report is answer-first, materializes requested artifacts, and has no empty sections', () => {
  const payload = strategyPayload();
  const document = composeResearchStrategyDocument({
    payload,
    deliverableArtifactId: 'deliverable-1',
    payloadSchema,
    evidenceIndex: ['E1: public_source'],
    evidenceIds: ['E1'],
    findingGraph: {
      findings: [{ id: 'F1', kind: 'fact', statement: 'Proof improves confidence.', evidenceIds: ['E1'] }],
      analyses: [{ id: 'AN1', statement: 'Proof should lead the hierarchy.', findingIds: ['F1'] }],
      subQuestionSummaries: [{ id: 'S1', summary: 'Put fit proof first.', findingIds: ['F1'], analysisIds: ['AN1'] }],
      overallConclusions: [{ id: 'C1', statement: 'Change the PDP hierarchy.', summaryIds: ['S1'] }],
    },
    coverage: {
      questionBindings: [{ questionId: 'Q1', summaryIds: ['S1'] }],
      successCriterionBindings: [],
    },
    envelopeRisksAndOpenIssues: [],
  });
  assert.equal(document.version, 'report-document-v2');
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-document', document));
  assert.equal(document.sections[0]?.id, 'executive-answers');
  assert.ok(document.sections.some(({ id }) => id === 'strategy-map'));
  assert.ok(document.sections.some(({ id }) => id === 'mind-model'));
  assert.ok(document.sections.flatMap(({ blocks }) => blocks).some((block) => block.type === 'answer' && block.kind === 'priority_matrix'));
  assert.equal(document.sections.some(({ id }) => id === 'remaining-deliverable-content'), false);
  assert.ok(document.sections.every(({ blocks }) => blocks.length > 0));
  const directAnswer = document.sections[0]?.blocks[0];
  assert.ok(directAnswer?.type === 'answer');
  assert.equal(directAnswer.answerStatus, 'supported');
  assert.deepEqual(directAnswer.findingIds, ['F1']);
  assert.deepEqual(directAnswer.summaryIds, ['S1']);
  const action = document.sections.flatMap(({ blocks }) => blocks).find(({ id }) => id === 'action-A1');
  assert.ok(action?.type === 'answer');
  assert.equal(action.confidence, payload.prioritizedActions[0]!.confidence);
  const risk = document.sections.flatMap(({ blocks }) => blocks).find(({ id }) => id === 'risk-disclosure-index');
  assert.ok(risk?.type === 'answer');
  assert.equal(risk.confidence, undefined);
});

test('dynamic strategy report rejects an envelope risk omitted from canonical risk disclosures', () => {
  const payload = strategyPayload();
  assert.throws(() => composeResearchStrategyDocument({
    payload,
    deliverableArtifactId: 'deliverable-1',
    payloadSchema,
    evidenceIndex: ['E1: public_source'],
    evidenceIds: ['E1'],
    findingGraph: {
      findings: [{ id: 'F1', kind: 'fact', statement: 'Proof improves confidence.', evidenceIds: ['E1'] }],
      analyses: [{ id: 'AN1', statement: 'Proof should lead the hierarchy.', findingIds: ['F1'] }],
      subQuestionSummaries: [{ id: 'S1', summary: 'Put fit proof first.', findingIds: ['F1'], analysisIds: ['AN1'] }],
      overallConclusions: [{ id: 'C1', statement: 'Change the PDP hierarchy.', summaryIds: ['S1'] }],
    },
    coverage: { questionBindings: [{ questionId: 'Q1', summaryIds: ['S1'] }], successCriterionBindings: [] },
    envelopeRisksAndOpenIssues: ['Reviewer condition missing'],
  }), /omits envelope risk/u);
});
