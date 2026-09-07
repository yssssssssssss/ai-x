import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileEditorialShowcase,
} from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

test('deterministically compiles reviewed Material into a complete Showcase Spec', () => {
  const fixture = showcaseFixture();
  const first = compileEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    intent: null,
  });
  const second = compileEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    intent: null,
  });

  assert.equal(first.spec.version, 'universal-editorial-presentation-spec-v1');
  assert.equal(first.spec.profileId, 'universal-editorial-showcase-v1');
  assert.equal(first.spec.generationMode, 'deterministic_showcase');
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.spec, second.spec);

  const components = first.spec.sections.flatMap(({ components }) => components);
  const kinds = components.map(({ kind }) => kind);
  for (const kind of [
    'editorial-hero',
    'evidence-boundary',
    'answer-chain',
    'metric-cards',
    'stage-flow',
    'record-table',
    'deliverable-map',
    'dimension-table',
    'method-board',
    'record-grid',
    'validation-list',
    'risk-register',
    'analysis-appendix',
    'source-register',
  ]) assert.ok(kinds.includes(kind as never), kind);

  const bodyUnitIds = fixture.material.units.filter(({ requiredInBody }) => requiredInBody).map(({ id }) => id);
  const promotedSupportingUnitIds = [
    fixture.ids.phaseOneDuration,
    fixture.ids.phaseOneOutput,
    fixture.ids.phaseTwoDuration,
    fixture.ids.phaseTwoOutput,
    fixture.ids.dimensionName,
    fixture.ids.dimensionPurpose,
    fixture.ids.dimensionField,
    fixture.ids.methodOne,
    fixture.ids.methodTwo,
  ];
  const auditUnitIds = fixture.material.units
    .filter(({ id, requiredInOutput, requiredInBody }) => (
      requiredInOutput && !requiredInBody && !promotedSupportingUnitIds.includes(id)
    ))
    .map(({ id }) => id);
  const ownedMainIds = components
    .filter(({ kind }) => kind !== 'analysis-appendix')
    .flatMap(({ ownedUnitIds }) => ownedUnitIds);
  const appendix = components.find(({ kind }) => kind === 'analysis-appendix');

  assert.equal(new Set(ownedMainIds).size, ownedMainIds.length);
  assert.deepEqual([...ownedMainIds].sort(), [...bodyUnitIds, ...promotedSupportingUnitIds].sort());
  assert.deepEqual(appendix?.ownedUnitIds, auditUnitIds);
  assert.deepEqual(first.spec.requiredBodyUnitIds, bodyUnitIds);
  assert.deepEqual(first.spec.requiredAuditUnitIds, auditUnitIds);
  assert.deepEqual(first.spec.promotedSupportingUnitIds, promotedSupportingUnitIds);

  const evidenceBoundary = components.find(({ kind }) => kind === 'evidence-boundary');
  assert.deepEqual(evidenceBoundary?.ownedUnitIds, []);
  assert.ok(evidenceBoundary?.sourceUnitIds.includes(fixture.ids.fact));
  assert.ok(evidenceBoundary?.sourceUnitIds.includes(fixture.ids.risk));

  const answerChain = components.find(({ kind }) => kind === 'answer-chain');
  assert.equal(answerChain?.kind, 'answer-chain');
  if (answerChain?.kind === 'answer-chain') {
    assert.equal(answerChain.content.question.unitId, fixture.ids.questionOne);
    assert.ok(answerChain.content.supporting.some(({ unitId }) => unitId === fixture.ids.fact));
    assert.ok(answerChain.content.actions.some(({ unitId }) => unitId === fixture.ids.action));
  }

  const scopeTable = components.find(({ kind }) => kind === 'record-table');
  assert.deepEqual(scopeTable?.ownedUnitIds, [fixture.ids.scopeMarket, fixture.ids.scopeSubject]);
  const deliverableMap = components.find(({ kind }) => kind === 'deliverable-map');
  assert.deepEqual(deliverableMap?.ownedUnitIds, [fixture.ids.deliverableOne, fixture.ids.deliverableTwo]);
  const dimensionTable = components.find(({ kind }) => kind === 'dimension-table');
  assert.deepEqual(dimensionTable?.ownedUnitIds, [fixture.ids.dimensionName, fixture.ids.dimensionPurpose, fixture.ids.dimensionField]);
  const methodBoard = components.find(({ kind }) => kind === 'method-board');
  assert.deepEqual(methodBoard?.ownedUnitIds, [fixture.ids.methodOne, fixture.ids.methodTwo]);

  const stageFlow = components.find(({ kind }) => kind === 'stage-flow');
  assert.deepEqual(stageFlow?.ownedUnitIds, [
    fixture.ids.phaseOne,
    fixture.ids.phaseOneAction,
    fixture.ids.phaseOneDuration,
    fixture.ids.phaseOneOutput,
    fixture.ids.phaseTwo,
    fixture.ids.phaseTwoAction,
    fixture.ids.phaseTwoDuration,
    fixture.ids.phaseTwoOutput,
  ]);
  assert.match(first.hash, /^sha256:[a-f0-9]{64}$/u);
});

test('compiles a valid model Intent by reordering exact deterministic components without losing content', () => {
  const fixture = showcaseFixture();
  const intent = {
    version: 'universal-editorial-showcase-intent-v1' as const,
    profileId: 'universal-editorial-showcase-v1' as const,
    sections: [{
      id: 'overview', role: 'decision' as const,
      title: '核心判断',
      componentIds: ['showcase-hero'],
    }, {
      id: 'execution-first', role: 'execution' as const,
      title: '执行计划',
      componentIds: ['showcase-stage-flow'],
    }],
  };

  const result = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent });
  assert.equal(result.spec.generationMode, 'model_intent');
  assert.equal(result.spec.sections[0]?.id, 'overview');
  assert.equal(result.spec.sections[0]?.title, '核心判断');
  assert.equal(result.spec.sections[0]?.components[0]?.id, 'showcase-hero');
  assert.equal(result.spec.sections[1]?.id, 'execution-first');
  const allOwned = result.spec.sections.flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  assert.equal(new Set(allOwned).size, allOwned.length);
  assert.equal(allOwned.length, fixture.material.units.filter(({ requiredInOutput }) => requiredInOutput).length);
});
