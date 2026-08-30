import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  projectResearchStrategyReportV2,
  researchStrategyProjectionUnitIds,
} from '../apps/orchestrator-runtime/src/report/research-strategy-report-projector.ts';
import { assertSemanticUnitProjectionCoverage } from '../apps/orchestrator-runtime/src/report/report-projection.ts';
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
  if (action?.type === 'answer') {
    assert.match(action.title, /Priority actions/u);
    assert.match(action.text, /strongest evidence/);
  }
  const semanticUnitIds = researchStrategyProjectionUnitIds(researchStrategyPayloadV2());
  assert.doesNotThrow(() => assertSemanticUnitProjectionCoverage(semanticUnitIds, document));
  for (const unitId of semanticUnitIds) {
    const count = document.sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
      block.type === 'answer' || block.type === 'projection-list' ? block.sourceNodeIds ?? [] : []
    ))).filter((candidate) => candidate === unitId).length;
    assert.equal(count, 1, `${unitId} must be projected exactly once`);
  }
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-document', document));
});

test('projects every mind-model edge as a distinct semantic source unit', () => {
  const payload = researchStrategyPayloadV2();
  payload.contentBlocks.push({
    id: 'content-block-003',
    kind: 'mind_model',
    title: 'Trust mind model',
    nodes: [{
      id: 'content-block-003-node-001',
      label: 'Evidence',
      description: 'Visible evidence.',
      support: {
        questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.8,
        status: 'supported', validationNeeded: '',
      },
    }, {
      id: 'content-block-003-node-002',
      label: 'Trust',
      description: 'Reduced uncertainty.',
      support: {
        questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.7,
        status: 'provisional', validationNeeded: 'Validate causality.',
      },
    }],
    edges: [{
      from: 'content-block-003-node-001',
      to: 'content-block-003-node-002',
      relationship: 'supports',
    }],
  });
  const blueprint = researchStrategyLayoutV1();
  blueprint.sections.push({
    title: 'Mind model', purpose: 'Explain the relationship.',
    prominence: 'supporting', blockRefs: ['content-block-003'],
  });

  const document = projectResearchStrategyReportV2({
    payload,
    blueprint,
    layoutMode: 'model',
    layoutWarnings: [],
    deliverableArtifactId: 'deliverable-1',
    payloadSchema,
    evidenceIndex: ['E1: public_source'],
    evidenceIds: ['E1'],
    findingGraph: researchStrategyFindingGraphV2(),
    coverage: researchStrategyCoverageV2(),
  });

  const required = researchStrategyProjectionUnitIds(payload);
  assert.ok(required.includes('content-block-003-edge-001'));
  assert.doesNotThrow(() => assertSemanticUnitProjectionCoverage(required, document));
});

test('projects limitations, open questions, and risk disclosures as exact semantic units', () => {
  const payload = researchStrategyPayloadV2();
  payload.limitations = ['Evidence is directional.'];
  payload.openQuestions = ['Will the effect persist?'];
  payload.riskDisclosures = [{
    id: 'risk-1',
    sourceType: 'answer_uncertainty',
    sourceId: 'Q1',
    statement: 'Will the effect persist?',
    disposition: 'open_question',
  }];
  const document = projectResearchStrategyReportV2({
    payload,
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
  const required = researchStrategyProjectionUnitIds(payload);
  assert.ok(required.includes('limitation-001'));
  assert.ok(required.includes('open-question-001'));
  assert.ok(required.includes('risk-1'));
  assert.doesNotThrow(() => assertSemanticUnitProjectionCoverage(required, document));
});

test('semantic-unit coverage rejects omitted and duplicate projected units', () => {
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
  const required = researchStrategyProjectionUnitIds(researchStrategyPayloadV2());
  const answer = document.sections[0]!.blocks[0]!;
  assert.equal(answer.type, 'answer');
  if (answer.type !== 'answer') return;
  answer.sourceNodeIds = [];
  assert.throws(() => assertSemanticUnitProjectionCoverage(required, document), /omits semantic units/u);
  answer.sourceNodeIds = ['Q1', 'Q1'];
  assert.throws(() => assertSemanticUnitProjectionCoverage(required, document), /duplicates semantic units/u);
  answer.sourceNodeIds = ['Q1', 'unexpected-unit'];
  assert.throws(() => assertSemanticUnitProjectionCoverage(required, document), /unexpected semantic units/u);
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
