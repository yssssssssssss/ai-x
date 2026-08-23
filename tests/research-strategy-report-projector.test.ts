import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { projectResearchStrategyReportV2 } from '../apps/orchestrator-runtime/src/report/research-strategy-report-projector.ts';
import {
  researchStrategyCoverageV2,
  researchStrategyFindingGraphV2,
  researchStrategyLayoutV1,
  researchStrategyPayloadV2,
} from './fixtures/research-strategy-v2.ts';

const payloadSchema = JSON.parse(readFileSync(
  'schemas/deliverables/research-strategy-report-v2.schema.json',
  'utf8',
)) as object;

test('projects model-directed section order without changing canonical content', () => {
  const document = projectResearchStrategyReportV2({
    payload: researchStrategyPayloadV2(),
    blueprint: researchStrategyLayoutV1(),
    layoutMode: 'model',
    layoutWarnings: [],
    deliverableArtifactId: 'deliverable-1',
    payloadSchema,
    evidenceIndex: ['E1: public_source'],
    evidenceIds: ['E1'],
    findingGraph: researchStrategyFindingGraphV2(),
    coverage: researchStrategyCoverageV2(),
  });

  assert.deepEqual(document.sections.map(({ title }) => title), [
    '直接答案 / Executive Answers',
    'Act first',
    'Why it works',
    '证据与置信度 / Evidence and Confidence',
    '局限与待解决问题 / Limitations and Open Questions',
    '证据附录 / Evidence Appendix',
  ]);
  assert.equal(document.layoutMode, 'model');
  assert.deepEqual(document.layoutWarnings, []);
  const action = document.sections[1]?.blocks[0];
  assert.equal(action?.type, 'answer');
  if (action?.type === 'answer') assert.match(action.text, /strongest evidence/);
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-document', document));
});

test('projector rejects a blueprint that omits canonical content', () => {
  const blueprint = researchStrategyLayoutV1();
  blueprint.sections = blueprint.sections.slice(0, 1);
  assert.throws(() => projectResearchStrategyReportV2({
    payload: researchStrategyPayloadV2(),
    blueprint,
    layoutMode: 'model',
    layoutWarnings: [],
    deliverableArtifactId: 'deliverable-1',
    payloadSchema,
    evidenceIndex: ['E1: public_source'],
    evidenceIds: ['E1'],
    findingGraph: researchStrategyFindingGraphV2(),
    coverage: researchStrategyCoverageV2(),
  }), /every Canonical Content Block exactly once/);
});
