import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReportEditorialMaterialV1 } from '../packages/api-contract/report-editorial.ts';
import {
  bindEditorialShowcaseContributions,
  compileEditorialShowcase,
  createDeterministicEditorialShowcaseSpec,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import {
  showcaseIntentFixture,
  showcaseMaterialFixture,
} from './fixtures/report-editorial/showcase-fixtures.ts';

test('compiler derives provenance and appends every unselected optional unit to the full analysis appendix', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'optional-context',
    semanticKind: 'narrative',
    title: '补充背景',
    shape: 'text',
    leafIds: ['leaf-optional-context'],
    leafId: 'leaf-optional-context',
    text: '只在完整分析附件中保留的补充背景。',
  });
  material.leafTraceIndex['leaf-optional-context'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/context',
      sourceNodeIds: ['/payload/context'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('optional-context');
  material.constraints.requiredLeafUnitIds.push('leaf-optional-context');
  material.constraints.projectionProfilesByUnitId['optional-context'] = ['paragraph', 'list'];
  const result = compileEditorialShowcase(material, showcaseIntentFixture(), 'model');

  assert.equal(result.spec.version, 'editorial-presentation-spec-v1');
  assert.equal(result.spec.profileId, 'editorial-showcase-v1');
  assert.equal(result.spec.generationMode, 'model');
  assert.equal(result.spec.sections.at(-1)?.prominence, 'appendix');
  assert.deepEqual(result.spec.sections.at(-1)?.components[0]?.ownedUnitIds, ['optional-context']);
  assert.deepEqual(
    result.spec.sections.flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds)),
    material.constraints.requiredPresentationUnitIds,
  );
  assert.deepEqual(
    result.spec.sections.flatMap(({ components }) => components.flatMap(({ ownedLeafIds }) => ownedLeafIds)).sort(),
    [...material.constraints.requiredLeafUnitIds].sort(),
  );
  const profile = result.spec.sections[1]?.components[0];
  assert.equal(profile?.status, 'provisional');
  assert.equal(profile?.confidence, 0.55);
  assert.deepEqual(profile?.evidenceIds, ['E1-1', 'E1-3']);
  assert.deepEqual(profile?.sourceContributionUnitIds, []);
  assert.match(result.spec.showcaseOutlineSignature, /^sha256:[a-f0-9]{64}$/u);
});

test('compiler diagnostics distinguish primary, supporting, and appendix ownership', () => {
  const material = showcaseMaterialFixture();
  const result = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'analysis',
      layout: 'single',
      components: [{
        kind: 'profile-grid',
        variant: 'asymmetric',
        emphasis: 'secondary',
        span: 'full',
        unitRefs: ['mind-model'],
        sourceLeafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
      }],
    }],
  }, 'model');

  assert.equal(result.diagnostics.primaryUnitCount, 3);
  assert.equal(result.diagnostics.supportingUnitCount, 1);
  assert.equal(result.diagnostics.appendixUnitCount, 0);
});

test('deterministic fallback remains content-driven and produces different outlines for different semantic shapes', () => {
  const material = showcaseMaterialFixture();
  const strategy = createDeterministicEditorialShowcaseSpec(material);
  const narrativeMaterial: ReportEditorialMaterialV1 = {
    ...material,
    presentationUnits: material.presentationUnits.filter(({ semanticKind }) => (
      semanticKind === 'direct_answer' || semanticKind === 'open_question'
    )),
    leafTraceIndex: {
      'leaf-answer': material.leafTraceIndex['leaf-answer']!,
      'leaf-question': material.leafTraceIndex['leaf-question']!,
    },
    constraints: {
      ...material.constraints,
      requiredPresentationUnitIds: ['answer-Q1', 'open-question'],
      requiredLeafUnitIds: ['leaf-answer', 'leaf-question'],
      projectionProfilesByUnitId: {
        'answer-Q1': material.constraints.projectionProfilesByUnitId['answer-Q1']!,
        'open-question': material.constraints.projectionProfilesByUnitId['open-question']!,
      },
    },
  };
  const narrative = createDeterministicEditorialShowcaseSpec(narrativeMaterial);
  const stagedMaterial: ReportEditorialMaterialV1 = structuredClone(narrativeMaterial);
  stagedMaterial.presentationUnits.push({
    id: 'execution-stages',
    semanticKind: 'research_plan_execution',
    title: '执行阶段',
    shape: 'stages',
    leafIds: ['leaf-stage'],
    stages: [{
      id: 'stage-1',
      leafId: 'leaf-stage',
      label: '验证',
      description: '验证关键假设。',
      activities: ['访谈'],
      outputs: ['证据记录'],
    }],
  });
  stagedMaterial.leafTraceIndex['leaf-stage'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/execution/0',
      sourceNodeIds: ['/payload/execution/0'],
    })),
  };
  stagedMaterial.constraints.requiredPresentationUnitIds.push('execution-stages');
  stagedMaterial.constraints.requiredLeafUnitIds.push('leaf-stage');
  stagedMaterial.constraints.projectionProfilesByUnitId['execution-stages'] = ['stage-flow', 'list'];
  const staged = createDeterministicEditorialShowcaseSpec(stagedMaterial);

  assert.equal(new Set([
    strategy.showcaseOutlineSignature,
    narrative.showcaseOutlineSignature,
    staged.showcaseOutlineSignature,
  ]).size, 3);
  assert.notEqual(strategy.showcaseOutlineSignature, narrative.showcaseOutlineSignature);
  assert(strategy.sections.some(({ components }) => components.some(({ kind }) => kind === 'profile-grid')));
  assert(strategy.sections.some(({ components }) => components.some(({ kind }) => kind === 'priority-lanes')));
  assert.equal(
    narrative.sections.some(({ components }) => components.some(({ kind }) => kind === 'profile-grid')),
    false,
  );
  assert.ok(staged.sections.some(({ components }) => components.some(({ kind }) => kind === 'stage-flow')));
});

test('outline signature captures component ownership cardinality, not only component names', () => {
  const material = showcaseMaterialFixture();
  const baseline = createDeterministicEditorialShowcaseSpec(material);
  const expanded = structuredClone(material);
  const mindModel = expanded.presentationUnits.find(({ id }) => id === 'mind-model');
  if (!mindModel || mindModel.shape !== 'graph') throw new Error('mind-model fixture must be graph-shaped');
  mindModel.leafIds.push('leaf-node-3');
  mindModel.nodes.push({
    id: 'n3',
    leafId: 'leaf-node-3',
    label: '新增角色',
    description: '新的 Canonical leaf 应改变 ownership cardinality。',
  });
  expanded.leafTraceIndex['leaf-node-3'] = {
    ...material.leafTraceIndex['leaf-node-1']!,
    origins: material.leafTraceIndex['leaf-node-1']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/contentBlocks/0/nodes/2',
      sourceNodeIds: ['/payload/contentBlocks/0/nodes/2'],
    })),
  };
  expanded.constraints.requiredLeafUnitIds.push('leaf-node-3');
  const changed = createDeterministicEditorialShowcaseSpec(expanded);

  assert.deepEqual(
    baseline.sections.flatMap(({ components }) => components.map(({ kind }) => kind)),
    changed.sections.flatMap(({ components }) => components.map(({ kind }) => kind)),
  );
  assert.notEqual(baseline.showcaseOutlineSignature, changed.showcaseOutlineSignature);
});

test('compiler promotes omitted mandatory and coverage units into the main Showcase', () => {
  const material = showcaseMaterialFixture();
  const result = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'profiles',
      layout: 'asymmetric',
      components: [{
        kind: 'profile-grid',
        variant: 'asymmetric',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['mind-model'],
        sourceLeafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
      }],
    }],
  }, 'model');

  const primaryUnits = result.spec.sections
    .filter(({ prominence }) => prominence === 'primary')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const appendixUnits = result.spec.sections
    .filter(({ prominence }) => prominence === 'appendix')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  assert.equal(result.spec.sections[0]?.purpose, 'decision');
  assert.ok(primaryUnits.includes('answer-Q1'));
  assert.ok(primaryUnits.includes('action-plan'));
  assert.ok(primaryUnits.includes('open-question'));
  assert.equal(appendixUnits.includes('answer-Q1'), false);
  assert.equal(appendixUnits.includes('action-plan'), false);
  assert.equal(appendixUnits.includes('open-question'), false);
});

test('source leaves may repeat across components and conservatively affect provenance status', () => {
  const material = showcaseMaterialFixture();
  material.leafTraceIndex['leaf-question']!.support.evidenceIds = ['E2'];
  const intent = showcaseIntentFixture();
  intent.sections[1]!.components[0]!.sourceLeafIds.push('leaf-question');

  const result = compileEditorialShowcase(material, intent, 'model');
  const profile = result.spec.sections[1]?.components[0];
  assert.ok(profile?.sourceLeafIds.includes('leaf-question'));
  assert.equal(profile?.ownedLeafIds.includes('leaf-question'), false);
  assert.equal(profile?.status, 'unanswered');
  assert.equal(profile?.confidence, undefined);
  assert.deepEqual(profile?.evidenceIds, ['E1-1', 'E1-3', 'E2']);
});

test('compiler requires every owned leaf to remain in component provenance', () => {
  const intent = showcaseIntentFixture();
  intent.sections[1]!.components[0]!.sourceLeafIds = ['leaf-node-1'];

  assert.throws(
    () => compileEditorialShowcase(showcaseMaterialFixture(), intent, 'model'),
    /source leaves must include every owned leaf/u,
  );
});

test('deterministic fallback keeps one risk signal in the main report and sends the remainder to the appendix', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'open-question-2',
    semanticKind: 'open_question',
    title: '第二个待验证问题',
    shape: 'text',
    leafIds: ['leaf-question-2'],
    leafId: 'leaf-question-2',
    text: '当前支付链路是否可用？',
  });
  material.leafTraceIndex['leaf-question-2'] = {
    ...material.leafTraceIndex['leaf-question']!,
    origins: material.leafTraceIndex['leaf-question']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/openQuestions/1',
      sourceNodeIds: ['/payload/openQuestions/1'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('open-question-2');
  material.constraints.requiredLeafUnitIds.push('leaf-question-2');
  material.constraints.projectionProfilesByUnitId['open-question-2'] = ['fact', 'list'];
  for (const suffix of ['one', 'two']) {
    const unitId = `principle-${suffix}`;
    const leafId = `leaf-principle-${suffix}`;
    material.presentationUnits.push({
      id: unitId,
      semanticKind: 'design_principle',
      title: `原则 ${suffix}`,
      shape: 'record',
      leafIds: [leafId],
      leafId,
      fields: [{ key: 'statement', label: '原则', value: `原则内容 ${suffix}` }],
    });
    material.leafTraceIndex[leafId] = {
      ...material.leafTraceIndex['leaf-answer']!,
      origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
        ...origin,
        jsonPointer: `/payload/principles/${suffix}`,
        sourceNodeIds: [`/payload/principles/${suffix}`],
      })),
    };
    material.constraints.requiredPresentationUnitIds.push(unitId);
    material.constraints.requiredLeafUnitIds.push(leafId);
    material.constraints.projectionProfilesByUnitId[unitId] = ['answer', 'list'];
  }

  const spec = createDeterministicEditorialShowcaseSpec(material);
  const validationComponents = spec.sections
    .flatMap(({ components }) => components)
    .filter(({ kind }) => kind === 'validation-list');
  assert.equal(validationComponents.length, 1);
  assert.deepEqual(validationComponents[0]?.ownedUnitIds, ['open-question']);
  const appendixUnits = spec.sections
    .filter(({ prominence }) => prominence === 'appendix')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  assert.deepEqual(appendixUnits, ['open-question-2']);
  const principleUnits = spec.sections
    .flatMap(({ components }) => components)
    .find(({ kind }) => kind === 'principle-list')?.ownedUnitIds;
  assert.deepEqual(principleUnits, ['principle-one', 'principle-two']);
});

test('Contribution bindings include only reviewed included or merged units with matching source nodes', () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  const bound = bindEditorialShowcaseContributions(spec, material, {
    version: 'report-audit-appendix-material-v1',
    binding: material.binding,
    records: [{
      id: 'audit-1',
      contributionArtifactId: 'contribution-1',
      sourceUnitKey: 'unit-1',
      sourceSemanticHash: `sha256:${'b'.repeat(64)}`,
      disposition: 'included',
      canonicalNodeIds: ['/payload/directAnswers/0'],
      reviewIssueIds: [],
    }, {
      id: 'audit-2',
      contributionArtifactId: 'contribution-2',
      sourceUnitKey: 'unit-2',
      sourceSemanticHash: `sha256:${'c'.repeat(64)}`,
      disposition: 'omitted',
      canonicalNodeIds: ['/payload/directAnswers/0'],
      reviewIssueIds: [],
    }],
  });

  assert.deepEqual(
    bound.sections[0]?.components[0]?.sourceContributionUnitIds,
    ['contribution-1:unit-1'],
  );
  assert.equal(JSON.stringify(bound).includes('contribution-2:unit-2'), false);
});

test('compiler rejects a component variant that is not defined for its kind', () => {
  const intent = showcaseIntentFixture();
  intent.sections[0]!.components[0]!.variant = 'register';

  assert.throws(
    () => compileEditorialShowcase(showcaseMaterialFixture(), intent, 'model'),
    /variant register is incompatible with editorial-hero/u,
  );
});

test('compiler rejects incompatible rich components instead of fabricating structure', () => {
  const intent = showcaseIntentFixture();
  intent.sections[1]!.components[0] = {
    kind: 'timeline',
    variant: 'horizontal',
    emphasis: 'primary',
    span: 'full',
    unitRefs: ['mind-model'],
    sourceLeafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
  };

  assert.throws(
    () => compileEditorialShowcase(showcaseMaterialFixture(), intent, 'model'),
    /timeline requires explicit stages/u,
  );
});
