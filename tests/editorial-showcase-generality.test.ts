import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createEditorialMaterialUnitId,
  type EditorialMaterial,
  type EditorialMaterialUnit,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { buildEditorialHtmlSourcePacket } from '../apps/orchestrator-runtime/src/report/editorial-html-source-packet.ts';
import { loadEditorialPresentationBrief } from '../apps/orchestrator-runtime/src/report/editorial-presentation-brief.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { projectEditorialShowcaseSource } from '../apps/orchestrator-runtime/src/report/editorial-showcase-source-adapter.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

function rethemeMaterial(source: EditorialMaterial): EditorialMaterial {
  const replacements = new Map<string, { id: string; value: string | number | boolean }>();
  source.units.forEach((unit, index) => {
    const value = typeof unit.value === 'string' ? `通用业务研究内容 ${index + 1}` : unit.value;
    replacements.set(unit.id, {
      value,
      id: createEditorialMaterialUnitId({
        sourceArtifactId: unit.sourceRefs[0].artifactId,
        sourceArtifactContentSha256: source.sourceArtifacts.find(({ artifactId }) => artifactId === unit.sourceRefs[0].artifactId)!.contentSha256,
        sourceJsonPointer: unit.sourceRefs[0].jsonPointer,
        role: unit.role,
        value,
      }),
    });
  });
  const units = source.units.map((unit) => ({
    ...unit,
    id: replacements.get(unit.id)!.id,
    value: replacements.get(unit.id)!.value,
    basisUnitIds: unit.basisUnitIds.map((id) => replacements.get(id)!.id),
  })) as EditorialMaterialUnit[];
  return {
    ...source,
    titleUnitId: source.titleUnitId === undefined ? undefined : replacements.get(source.titleUnitId)!.id,
    methodSummaryUnitId: replacements.get(source.methodSummaryUnitId)!.id,
    units,
  };
}

test('projects every active Deliverable through one Showcase adapter and compiler', () => {
  const fixture = showcaseFixture();
  const deliverableTypes: EditorialMaterial['deliverableType'][] = [
    'research_plan',
    'research_strategy_report',
    'competitive_analysis_report',
    'voc_diagnosis_report',
    'design_audit_report',
    'accessibility_audit_report',
  ];

  for (const deliverableType of deliverableTypes) {
    const material = { ...fixture.material, deliverableType };
    const sourcePacket = buildEditorialHtmlSourcePacket({
      material,
      presentationBrief: loadEditorialPresentationBrief().brief,
    }).packet;
    const projection = projectEditorialShowcaseSource({ material, sourcePacket });
    assert.equal(projection.deliverableType, deliverableType);
    const compiled = compileEditorialShowcase({ material, sourcePacket, intent: null });
    assert.ok(compiled.spec.sections.length > 1, deliverableType);
    assert.equal(compiled.spec.requiredBodyUnitIds.length, fixture.material.units.filter(({ requiredInBody }) => requiredInBody).length);
  }
});

test('projects research-plan structure without topic-specific rules', () => {
  const fixture = showcaseFixture();
  const projection = projectEditorialShowcaseSource({ material: fixture.material, sourcePacket: fixture.sourcePacket });

  assert.equal(projection.version, 'editorial-showcase-source-projection-v1');
  assert.equal(projection.deliverableType, 'research_plan');
  assert.deepEqual(projection.questionAnchors, [{ questionId: 'Q1', groupId: 'research-question:0' }]);
  assert.deepEqual(projection.journeyGroupIds, ['research-phase:0', 'research-phase:1']);
  assert.deepEqual(projection.journeyStages, [{
    groupId: 'research-phase:0', sequence: 0,
    durationUnitId: fixture.ids.phaseOneDuration,
    outputUnitIds: [fixture.ids.phaseOneOutput],
  }, {
    groupId: 'research-phase:1', sequence: 1,
    durationUnitId: fixture.ids.phaseTwoDuration,
    outputUnitIds: [fixture.ids.phaseTwoOutput],
  }]);
  assert.deepEqual(projection.validationGroupIds, ['research-quality:0', 'research-quality:1']);
  assert.deepEqual(projection.riskGroupIds, ['risk:0']);
  assert.deepEqual(projection.scopeUnitIds, [fixture.ids.scopeMarket, fixture.ids.scopeSubject]);
  assert.deepEqual(projection.deliverableUnitIds, [fixture.ids.deliverableOne, fixture.ids.deliverableTwo]);
  assert.deepEqual(projection.analysisMethodUnitIds, [fixture.ids.methodOne, fixture.ids.methodTwo]);
  assert.deepEqual(projection.dimensionGroups, [{
    groupId: 'research-dimension:D1',
    nameUnitId: fixture.ids.dimensionName,
    purposeUnitId: fixture.ids.dimensionPurpose,
    fieldUnitIds: [fixture.ids.dimensionField],
  }]);

  const compiled = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null });
  const rendered = renderEditorialShowcase({ spec: compiled.spec }).htmlBytes.toString('utf8');
  assert.ok(rendered.includes('宠物食品心智设计表达研究'));

  const rethemedMaterial = rethemeMaterial(fixture.material);
  const rethemedPacket = buildEditorialHtmlSourcePacket({
    material: rethemedMaterial,
    presentationBrief: loadEditorialPresentationBrief().brief,
  }).packet;
  const rethemed = compileEditorialShowcase({ material: rethemedMaterial, sourcePacket: rethemedPacket, intent: null });
  assert.deepEqual(
    rethemed.spec.sections.map(({ role, components }) => ({ role, kinds: components.map(({ kind }) => kind) })),
    compiled.spec.sections.map(({ role, components }) => ({ role, kinds: components.map(({ kind }) => kind) })),
  );
  assert.ok(renderEditorialShowcase({ spec: rethemed.spec }).htmlBytes.toString('utf8').includes('通用业务研究内容'));

  for (const path of [
    'apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts',
    'apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts',
    'apps/orchestrator-runtime/src/report/editorial-showcase-profile.ts',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /宠物|猫狗|众筹|京东/u, path);
  }
});
