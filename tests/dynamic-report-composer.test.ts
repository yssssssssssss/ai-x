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
  const document = composeResearchStrategyDocument({ payload, deliverableArtifactId: 'deliverable-1', payloadSchema, evidenceIndex: ['E1: public_source'], evidenceIds: ['E1'] });
  assert.equal(document.version, 'report-document-v2');
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-document', document));
  assert.equal(document.sections[0]?.id, 'executive-answers');
  assert.ok(document.sections.some(({ id }) => id === 'strategy-map'));
  assert.ok(document.sections.some(({ id }) => id === 'mind-model'));
  assert.ok(document.sections.flatMap(({ blocks }) => blocks).some((block) => block.type === 'answer' && block.kind === 'priority_matrix'));
  assert.equal(document.sections.some(({ id }) => id === 'remaining-deliverable-content'), false);
  assert.ok(document.sections.every(({ blocks }) => blocks.length > 0));
  assert.doesNotThrow(() => assertReportProjectionIntegrity({ document, deliverableArtifactId: 'deliverable-1', payload, requiredPointers: Object.keys(payload).map((key) => `/${key}`) }));
});
