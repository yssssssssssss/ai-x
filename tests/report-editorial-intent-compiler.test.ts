import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
} from '../packages/api-contract/report-editorial.ts';
import {
  compileReportEditorialIntent,
  createDeterministicReportEditorialIntentCompilation,
} from '../apps/orchestrator-runtime/src/report/report-editorial-intent-compiler.ts';
import { projectReportEditorialDocumentV4 } from '../apps/orchestrator-runtime/src/report/report-editorial-projector.ts';
import {
  deriveEditorialPlacementPolicy,
  assertEditorialPlacementPolicy,
} from '../apps/orchestrator-runtime/src/report/report-editorial-placement-policy.ts';
import { assertReportEditorialBlueprintIntegrity } from '../packages/report-rendering/report-editorial-validation.ts';

const SHA = `sha256:${'a'.repeat(64)}`;

function trace(pointer: string, questionIds: string[] = []) {
  return {
    supportMode: 'direct' as const,
    origins: [{
      artifactId: 'deliverable-1',
      contentSha256: SHA,
      schemaVersion: 'research-strategy-content-v2',
      jsonPointer: pointer,
      sourceNodeIds: [pointer],
      reviewState: 'passed' as const,
    }],
    support: {
      questionIds,
      evidenceIds: ['E1'],
      findingIds: ['F1'],
      summaryIds: ['S1'],
      status: 'supported' as const,
      confidence: 0.9,
    },
  };
}

/**
 * Builds a material with a mix of mandatory, optional, and system-supporting
 * units. This is the base fixture for most compiler tests.
 */
function richMaterialFixture(): ReportEditorialMaterialV1 {
  return {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      deliverableArtifactId: 'deliverable-1',
      deliverableContentSha256: SHA,
      reportReviewArtifactId: 'review-1',
    },
    document: {
      title: '众筹策略报告',
      decisionContext: '决定是否上线新品。',
      executiveAnswer: '建议分阶段上线。',
      deliverableType: 'research_strategy_report',
      requestedArtifactTypes: ['research_report'],
    },
    presentationUnits: [
      {
        id: 'answer-Q1',
        semanticKind: 'direct_answer',
        title: '应该上线吗？',
        shape: 'record',
        leafIds: ['leaf-answer-Q1'],
        leafId: 'leaf-answer-Q1',
        fields: [
          { key: 'answer', label: '答案', value: '建议分阶段上线。' },
        ],
      },
      {
        id: 'action-1',
        semanticKind: 'prioritized_action',
        title: '优先行动',
        shape: 'actions',
        leafIds: ['leaf-action-1'],
        actions: [{
          leafId: 'leaf-action-1',
          priority: 'P0',
          action: '先验证核心用户。',
        }],
      },
      {
        id: 'narrative-bg',
        semanticKind: 'narrative',
        title: '市场背景',
        shape: 'text',
        leafIds: ['leaf-narrative-bg'],
        leafId: 'leaf-narrative-bg',
        text: '市场规模持续增长。',
      },
      {
        id: 'risk-1',
        semanticKind: 'risk',
        title: '供应链风险',
        shape: 'text',
        leafIds: ['leaf-risk-1'],
        leafId: 'leaf-risk-1',
        text: '核心供应商产能不足。',
      },
      {
        id: 'risk-2',
        semanticKind: 'risk',
        title: '竞品风险',
        shape: 'text',
        leafIds: ['leaf-risk-2'],
        leafId: 'leaf-risk-2',
        text: '主要竞品计划同期发布。',
      },
      {
        id: 'binding-1',
        semanticKind: 'requested_artifact_binding',
        title: '交付绑定',
        shape: 'record',
        leafIds: ['leaf-binding-1'],
        leafId: 'leaf-binding-1',
        fields: [
          { key: 'type', label: '类型', value: 'research_report' },
        ],
      },
      {
        id: 'quality-1',
        semanticKind: 'research_plan_quality',
        title: '研究质量',
        shape: 'records',
        leafIds: ['leaf-quality-1'],
        records: [{
          id: 'q1',
          leafId: 'leaf-quality-1',
          title: '质量指标',
          fields: [{ key: 'score', label: '分数', value: 0.85 }],
        }],
      },
      {
        id: 'evidence-1',
        semanticKind: 'evidence_finding',
        title: '用户调研',
        shape: 'text',
        leafIds: ['leaf-evidence-1'],
        leafId: 'leaf-evidence-1',
        text: '80% 受访者表示愿意尝试。',
      },
      {
        id: 'limitation-1',
        semanticKind: 'limitation',
        title: '样本局限',
        shape: 'text',
        leafIds: ['leaf-limitation-1'],
        leafId: 'leaf-limitation-1',
        text: '样本量有限。',
      },
    ],
    leafTraceIndex: {
      'leaf-answer-Q1': trace('/answers/0', ['Q1']),
      'leaf-action-1': trace('/actions/0', ['Q1']),
      'leaf-narrative-bg': trace('/narrative/0', ['Q1']),
      'leaf-risk-1': trace('/risks/0', ['Q1']),
      'leaf-risk-2': trace('/risks/1', ['Q1']),
      'leaf-binding-1': trace('/binding/0', ['Q1']),
      'leaf-quality-1': trace('/quality/0', ['Q1']),
      'leaf-evidence-1': trace('/evidence/0', ['Q1']),
      'leaf-limitation-1': trace('/limitations/0', ['Q1']),
    },
    constraints: {
      requiredQuestionIds: ['Q1'],
      requiredPresentationUnitIds: [
        'answer-Q1', 'action-1', 'narrative-bg', 'risk-1', 'risk-2',
        'binding-1', 'quality-1', 'evidence-1', 'limitation-1',
      ],
      requiredLeafUnitIds: [
        'leaf-answer-Q1', 'leaf-action-1', 'leaf-narrative-bg',
        'leaf-risk-1', 'leaf-risk-2', 'leaf-binding-1',
        'leaf-quality-1', 'leaf-evidence-1', 'leaf-limitation-1',
      ],
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: {
        'answer-Q1': ['answer', 'record-table', 'list'],
        'action-1': ['priority-board', 'list'],
        'narrative-bg': ['paragraph', 'fact', 'list'],
        'risk-1': ['fact', 'paragraph', 'list'],
        'risk-2': ['fact', 'paragraph', 'list'],
        'binding-1': ['record-table', 'list'],
        'quality-1': ['card-grid', 'list'],
        'evidence-1': ['fact', 'paragraph', 'list'],
        'limitation-1': ['fact', 'paragraph', 'list'],
      },
    },
  };
}

function emptyIntent(): ReportEditorialIntentV1 {
  return {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [],
    copyFragments: [],
  };
}

// ── Placement Policy Tests ──────────────────────────────────────────

test('deriveEditorialPlacementPolicy identifies mandatory body units', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);

  assert.ok(policy.mandatoryBodyUnitIds.includes('answer-Q1'));
  assert.ok(policy.mandatoryBodyUnitIds.includes('action-1'));
  assert.ok(!policy.mandatoryBodyUnitIds.includes('narrative-bg'));
  assert.ok(!policy.mandatoryBodyUnitIds.includes('risk-1'));
});

test('deriveEditorialPlacementPolicy identifies system supporting units', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);

  assert.ok(policy.systemSupportingUnitIds.includes('binding-1'));
  assert.ok(policy.systemSupportingUnitIds.includes('quality-1'));
  assert.ok(!policy.systemSupportingUnitIds.includes('answer-Q1'));
});

test('deriveEditorialPlacementPolicy identifies coverage groups', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);

  const evidenceGroup = policy.mainCoverageGroups.find((g) => g.label === 'evidence_signal');
  assert.ok(evidenceGroup);
  assert.ok(evidenceGroup.unitIds.includes('evidence-1'));

  const riskGroup = policy.mainCoverageGroups.find((g) => g.label === 'risk_signal');
  assert.ok(riskGroup);
  assert.ok(riskGroup.unitIds.includes('risk-1'));
  assert.ok(riskGroup.unitIds.includes('risk-2'));
  assert.ok(riskGroup.unitIds.includes('limitation-1'));
});

test('deriveEditorialPlacementPolicy provides fallback primary when no mandatory', () => {
  const material = richMaterialFixture();
  // Remove all mandatory body units.
  material.presentationUnits = material.presentationUnits.filter(
    (u) => u.semanticKind !== 'direct_answer' && u.semanticKind !== 'prioritized_action',
  );
  material.constraints.requiredPresentationUnitIds = material.presentationUnits.map((u) => u.id);
  material.constraints.projectionProfilesByUnitId = Object.fromEntries(
    material.presentationUnits.map((u) => [u.id, material.constraints.projectionProfilesByUnitId[u.id]!]),
  );

  const policy = deriveEditorialPlacementPolicy(material);
  assert.equal(policy.mandatoryBodyUnitIds.length, 0);
  assert.ok(policy.fallbackPrimaryUnitId);
  // Should be the first non-system unit.
  assert.equal(policy.fallbackPrimaryUnitId, 'narrative-bg');
});

test('deriveEditorialPlacementPolicy mandatory and system supporting are disjoint', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);

  const mandatorySet = new Set(policy.mandatoryBodyUnitIds);
  for (const id of policy.systemSupportingUnitIds) {
    assert.ok(!mandatorySet.has(id), `${id} should not be both mandatory and system supporting`);
  }
});

// ── Compiler: Full Coverage ─────────────────────────────────────────

test('compiler with empty intent still covers all units', () => {
  const material = richMaterialFixture();
  const result = compileReportEditorialIntent(material, emptyIntent());

  assertReportEditorialBlueprintIntegrity(material, result.blueprint);
  const allRefs = result.blueprint.sections.flatMap((s) =>
    s.blocks.flatMap((b) => b.unitRefs),
  );
  assert.equal(allRefs.length, material.presentationUnits.length);
  assert.equal(new Set(allRefs).size, material.presentationUnits.length);
});

test('compiler with partial intent puts unselected units in appendix', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  const result = compileReportEditorialIntent(material, intent);
  assertReportEditorialBlueprintIntegrity(material, result.blueprint);

  // All units must be covered.
  const allRefs = result.blueprint.sections.flatMap((s) =>
    s.blocks.flatMap((b) => b.unitRefs),
  );
  assert.equal(allRefs.length, material.presentationUnits.length);

  // Unselected optional units should be in appendix.
  const appendixUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'appendix')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));
  assert.ok(appendixUnits.includes('narrative-bg'));
  assert.ok(appendixUnits.includes('risk-2'));
  const firstAppendixIndex = result.blueprint.sections.findIndex(
    ({ prominence }) => prominence === 'appendix',
  );
  assert.ok(firstAppendixIndex >= 0);
  assert.ok(result.blueprint.sections.slice(firstAppendixIndex)
    .every(({ prominence }) => prominence === 'appendix'));
});

// ── Compiler: Mandatory Body ────────────────────────────────────────

test('mandatory body units are auto-placed in primary even when model omits them', () => {
  const material = richMaterialFixture();
  const result = compileReportEditorialIntent(material, emptyIntent());

  const primaryUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'primary')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));

  assert.ok(primaryUnits.includes('answer-Q1'));
  assert.ok(primaryUnits.includes('action-1'));
  assert.ok(result.diagnostics.mandatoryAutoAddedCount >= 2);
});

test('mandatory body units in model supporting are promoted to primary', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'supporting',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  const result = compileReportEditorialIntent(material, intent);

  const primaryUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'primary')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));
  assert.ok(primaryUnits.includes('answer-Q1'));
});

// ── Compiler: System Supporting ─────────────────────────────────────

test('system supporting units go to supporting, never primary or appendix', () => {
  const material = richMaterialFixture();
  const result = compileReportEditorialIntent(material, emptyIntent());

  const supportingUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'supporting')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));

  assert.ok(supportingUnits.includes('binding-1'));
  assert.ok(supportingUnits.includes('quality-1'));

  // Must not be in primary.
  const primaryUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'primary')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));
  assert.ok(!primaryUnits.includes('binding-1'));
  assert.ok(!primaryUnits.includes('quality-1'));

  // Must not be in appendix.
  const appendixUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'appendix')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));
  assert.ok(!appendixUnits.includes('binding-1'));
  assert.ok(!appendixUnits.includes('quality-1'));
});

// ── Compiler: Coverage Groups ───────────────────────────────────────

test('coverage group gets at least one unit in primary when model omits all', () => {
  const material = richMaterialFixture();
  const result = compileReportEditorialIntent(material, emptyIntent());

  const primaryUnits = result.blueprint.sections
    .filter((s) => s.prominence === 'primary')
    .flatMap((s) => s.blocks.flatMap((b) => b.unitRefs));

  // Risk signal group: at least one of risk-1, risk-2, limitation-1 must be primary.
  const riskUnits = ['risk-1', 'risk-2', 'limitation-1'];
  const hasRiskInPrimary = riskUnits.some((id) => primaryUnits.includes(id));
  assert.ok(hasRiskInPrimary, 'at least one risk signal unit must be in primary');

  // Evidence signal group: evidence-1 must be primary.
  assert.ok(primaryUnits.includes('evidence-1'));
});

// ── Compiler: Placement Policy Assertion ────────────────────────────

test('compiled blueprint passes placement policy assertion', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);
  const result = compileReportEditorialIntent(material, emptyIntent());

  // Should not throw.
  assertEditorialPlacementPolicy(material, result.blueprint, policy);
});

test('deterministic Intent fallback satisfies the same placement policy', () => {
  const material = richMaterialFixture();
  const policy = deriveEditorialPlacementPolicy(material);
  const result = createDeterministicReportEditorialIntentCompilation(material);

  assertReportEditorialBlueprintIntegrity(material, result.blueprint);
  assertEditorialPlacementPolicy(material, result.blueprint, policy);
  assert.equal(result.blueprint.sections.find((section) =>
    section.blocks.some((block) => block.unitRefs.includes('binding-1')))?.prominence, 'supporting');
  assert.ok(result.blueprint.sections.some(({ prominence }) => prominence === 'appendix'));
});

// ── Compiler: Mixed Block Splitting ─────────────────────────────────

test('mixed block is split by resolved placement without losing or duplicating units', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'evidence',
      prominence: 'supporting',
      blocks: [{
        presentation: 'list',
        unitRefs: ['binding-1', 'risk-1'],
        visibility: 'collapsible',
      }],
    }, {
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [{
      target: { kind: 'section_title', sectionIndex: 0 },
      text: '交付说明',
      sourceLeafIds: ['leaf-binding-1'],
    }, {
      target: { kind: 'block_digest', sectionIndex: 0, blockIndex: 0 },
      text: '交付绑定',
      sourceLeafIds: ['leaf-binding-1'],
    }, {
      target: { kind: 'section_transition', sectionIndex: 0 },
      text: '风险之后进入上线判断。',
      sourceLeafIds: ['leaf-risk-1', 'leaf-answer-Q1'],
    }],
  };

  const result = compileReportEditorialIntent(material, intent);
  assertReportEditorialBlueprintIntegrity(material, result.blueprint);
  assert.equal(result.blueprint.style, 'editorial');

  const riskSection = result.blueprint.sections.find((section) =>
    section.blocks.some((block) => block.unitRefs.includes('risk-1')));
  const bindingSection = result.blueprint.sections.find((section) =>
    section.blocks.some((block) => block.unitRefs.includes('binding-1')));
  assert.equal(riskSection?.prominence, 'primary');
  assert.equal(bindingSection?.prominence, 'supporting');
  assert.ok(
    result.blueprint.sections.indexOf(bindingSection!)
      < result.blueprint.sections.indexOf(riskSection!),
    'mixed placement must preserve the source unit order',
  );
  assert.equal(
    result.blueprint.sections.flatMap((section) => section.blocks)
      .filter((block) => block.unitRefs.includes('risk-1')).length,
    1,
  );
  assert.equal(
    result.blueprint.sections.flatMap((section) => section.blocks)
      .filter((block) => block.unitRefs.includes('binding-1')).length,
    1,
  );
  const bindingSectionIndex = result.blueprint.sections.findIndex((section) =>
    section.blocks.some((block) => block.unitRefs.includes('binding-1')));
  assert.deepEqual(result.editorialCopy.fragments.map(({ target }) => target), [
    { kind: 'section_title', sectionIndex: bindingSectionIndex },
    { kind: 'block_digest', sectionIndex: bindingSectionIndex, blockIndex: 0 },
  ]);
  assert.equal(result.editorialCopy.rejectedFragments.length, 1);
  assert.ok(result.editorialCopy.rejectedFragments[0]?.reasonCodes.includes('target_out_of_range'));
});

test('compiler preserves repeated presentation block occurrences', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'evidence',
      prominence: 'primary',
      blocks: [{
        presentation: 'fact',
        unitRefs: ['risk-1'],
        visibility: 'always',
      }, {
        presentation: 'list',
        unitRefs: ['limitation-1'],
        visibility: 'always',
      }, {
        presentation: 'fact',
        unitRefs: ['risk-2'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  const result = compileReportEditorialIntent(material, intent);
  const section = result.blueprint.sections.find((candidate) =>
    candidate.blocks.some((block) => block.unitRefs.includes('risk-1')));
  assert.deepEqual(section?.blocks.slice(0, 3).map((block) => ({
    presentation: block.presentation,
    unitRefs: block.unitRefs,
  })), [{
    presentation: 'fact',
    unitRefs: ['risk-1'],
  }, {
    presentation: 'list',
    unitRefs: ['limitation-1'],
  }, {
    presentation: 'fact',
    unitRefs: ['risk-2'],
  }]);
});

test('compiler preserves model section order and remaps section Copy ordinals', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'first_source_title',
      view: 'actions',
      prominence: 'primary',
      blocks: [{
        presentation: 'priority-board',
        unitRefs: ['action-1'],
        visibility: 'always',
      }],
    }, {
      headingMode: 'first_source_title',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [{
      target: { kind: 'section_title', sectionIndex: 0 },
      text: '优先行动',
      sourceLeafIds: ['leaf-action-1'],
    }, {
      target: { kind: 'section_title', sectionIndex: 1 },
      text: '上线建议',
      sourceLeafIds: ['leaf-answer-Q1'],
    }],
  };

  const result = compileReportEditorialIntent(material, intent);
  const actionIndex = result.blueprint.sections.findIndex((section) =>
    section.blocks.some((block) => block.unitRefs.includes('action-1')));
  const answerIndex = result.blueprint.sections.findIndex((section) =>
    section.blocks.some((block) => block.unitRefs.includes('answer-Q1')));

  assert.ok(actionIndex >= 0 && answerIndex >= 0);
  assert.ok(actionIndex < answerIndex, 'retained model sections must keep their relative order');
  assert.deepEqual(result.editorialCopy.fragments.map(({ target }) => target), [
    { kind: 'section_title', sectionIndex: actionIndex },
    { kind: 'section_title', sectionIndex: answerIndex },
  ]);
  assert.deepEqual(result.editorialCopy.rejectedFragments, []);
});

// ── Compiler: Unknown/Duplicate unitRef ─────────────────────────────

test('unknown unitRef in intent throws', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['nonexistent-unit'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  assert.throws(() => compileReportEditorialIntent(material, intent), /unknown unit/);
});

test('unitRef in the wrong view throws', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'paragraph',
        unitRefs: ['narrative-bg'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  assert.throws(() => compileReportEditorialIntent(material, intent), /wrong view/);
});

test('duplicate unitRef in intent throws', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }, {
        presentation: 'list',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  assert.throws(() => compileReportEditorialIntent(material, intent), /more than once/);
});

// ── Compiler: Diagnostics ───────────────────────────────────────────

test('diagnostics report correct unit counts', () => {
  const material = richMaterialFixture();
  const result = compileReportEditorialIntent(material, emptyIntent());

  assert.equal(result.diagnostics.totalUnitCount, material.presentationUnits.length);
  assert.ok(result.diagnostics.primaryUnitCount > 0);
  assert.ok(result.diagnostics.appendixUnitCount >= 0);
  assert.equal(
    result.diagnostics.primaryUnitCount + result.diagnostics.supportingUnitCount + result.diagnostics.appendixUnitCount,
    result.diagnostics.totalUnitCount,
  );
  assert.ok(result.diagnostics.primaryUnitRatio > 0);
  assert.ok(result.diagnostics.primaryUnitRatio <= 1);
  assert.equal(result.diagnostics.copyAcceptedCount, 0);
  assert.equal(result.diagnostics.copyRejectedCount, 0);
  assert.equal(result.diagnostics.copyMissingCount, result.diagnostics.copySoftRequiredCount);
});

// ── Compiler: Copy Validation ───────────────────────────────────────

test('copy fragments are validated against the compiled blueprint', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [{
      target: { kind: 'report_title' },
      text: '众筹策略报告',
      sourceLeafIds: ['leaf-answer-Q1'],
    }],
  };

  const result = compileReportEditorialIntent(material, intent);
  assert.ok(result.editorialCopy.fragments.length > 0);
  assert.equal(result.editorialCopy.fragments[0]?.text, '众筹策略报告');
});

test('invalid copy fragments are rejected individually', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [
      {
        target: { kind: 'report_title' },
        text: '众筹策略报告',
        sourceLeafIds: ['leaf-answer-Q1'],
      },
      {
        target: { kind: 'report_title' },
        text: '重复标题',
        sourceLeafIds: ['leaf-answer-Q1'],
      },
    ],
  };

  const result = compileReportEditorialIntent(material, intent);
  // First fragment accepted, second rejected (duplicate target).
  assert.equal(result.editorialCopy.fragments.length, 1);
  assert.equal(result.editorialCopy.rejectedFragments.length, 1);
  assert.ok(result.editorialCopy.rejectedFragments[0]?.reasonCodes.includes('duplicate_target'));
});

// ── Compiler: Pure Narrative ────────────────────────────────────────

test('incompatible or disabled presentation is downgraded locally', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'operational',
    density: 'compact',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'record-table',
        unitRefs: ['answer-Q1'],
        visibility: 'always',
      }],
    }],
    copyFragments: [],
  };

  const result = compileReportEditorialIntent(material, intent, { recordTable: false });
  const answerBlock = result.blueprint.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ unitRefs }) => unitRefs.includes('answer-Q1'));
  assert.equal(result.blueprint.style, 'operational');
  assert.equal(answerBlock?.presentation, 'answer');
  assert.equal(result.diagnostics.presentationDowngradeCount, 1);
});

test('compiler enforces visibility and rejects ineligible digests and status drift', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'view_label',
      view: 'answers',
      prominence: 'primary',
      blocks: [{
        presentation: 'answer',
        unitRefs: ['answer-Q1'],
        visibility: 'collapsible',
      }],
    }],
    copyFragments: [{
      target: { kind: 'report_title' },
      text: 'Unanswered launch strategy',
      sourceLeafIds: ['leaf-answer-Q1'],
    }, {
      target: { kind: 'block_digest', sectionIndex: 0, blockIndex: 0 },
      text: '建议分阶段上线',
      sourceLeafIds: ['leaf-answer-Q1'],
    }],
  };

  const result = compileReportEditorialIntent(material, intent);
  const answerBlock = result.blueprint.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ unitRefs }) => unitRefs.includes('answer-Q1'));
  assert.equal(answerBlock?.visibility, 'always');
  assert.equal(result.editorialCopy.fragments.length, 0);
  assert.ok(result.editorialCopy.rejectedFragments.some(({ reasonCodes }) =>
    reasonCodes.includes('unsupported_protected_token')));
  assert.ok(result.editorialCopy.rejectedFragments.some(({ reasonCodes }) =>
    reasonCodes.includes('target_out_of_range')));
});

test('appendix titles are excluded from soft-required Copy completeness', () => {
  const material = richMaterialFixture();
  const intent: ReportEditorialIntentV1 = {
    version: 'report-editorial-intent-v1',
    style: 'editorial',
    density: 'comfortable',
    mainSections: [{
      headingMode: 'first_source_title',
      view: 'answers',
      prominence: 'primary',
      blocks: [{ presentation: 'answer', unitRefs: ['answer-Q1'], visibility: 'always' }],
    }, {
      headingMode: 'first_source_title',
      view: 'actions',
      prominence: 'primary',
      blocks: [{ presentation: 'priority-board', unitRefs: ['action-1'], visibility: 'always' }],
    }, {
      headingMode: 'first_source_title',
      view: 'evidence',
      prominence: 'primary',
      blocks: [{ presentation: 'fact', unitRefs: ['risk-1'], visibility: 'always' }],
    }, {
      headingMode: 'first_source_title',
      view: 'analysis',
      prominence: 'primary',
      blocks: [{ presentation: 'fact', unitRefs: ['evidence-1'], visibility: 'collapsible' }],
    }, {
      headingMode: 'first_source_title',
      view: 'evidence',
      prominence: 'supporting',
      blocks: [
        { presentation: 'list', unitRefs: ['binding-1'], visibility: 'collapsible' },
        { presentation: 'card-grid', unitRefs: ['quality-1'], visibility: 'always' },
      ],
    }],
    copyFragments: [{
      target: { kind: 'report_title' },
      text: '众筹上线策略',
      sourceLeafIds: ['leaf-answer-Q1'],
    }, {
      target: { kind: 'executive_summary' },
      text: '建议分阶段上线并先验证核心用户。',
      sourceLeafIds: ['leaf-answer-Q1', 'leaf-action-1'],
    },
    ...[
      ['回答', 'leaf-answer-Q1'],
      ['行动', 'leaf-action-1'],
      ['风险', 'leaf-risk-1'],
      ['证据', 'leaf-evidence-1'],
      ['交付说明', 'leaf-binding-1'],
    ].map(([text, leafId], sectionIndex) => ({
      target: { kind: 'section_title' as const, sectionIndex },
      text: text!,
      sourceLeafIds: [leafId!],
    }))],
  };

  const compiled = compileReportEditorialIntent(material, intent);
  assert.ok(compiled.blueprint.sections.some(({ prominence }) => prominence === 'appendix'));
  assert.equal(compiled.diagnostics.copyMissingCount, 0);
  const document = projectReportEditorialDocumentV4({
    material,
    blueprint: compiled.blueprint,
    editorialCopy: compiled.editorialCopy,
    layoutMode: 'model',
  });
  assert.equal(document.copyMode, 'model');
  assert.equal(document.notices.some(({ code }) => code === 'copy_fallback'), false);
});

test('pure narrative material still produces at least one primary section', () => {
  const material: ReportEditorialMaterialV1 = {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      deliverableArtifactId: 'deliverable-1',
      deliverableContentSha256: SHA,
      reportReviewArtifactId: 'review-1',
    },
    document: {
      title: '纯叙述报告',
      deliverableType: 'generic',
      requestedArtifactTypes: [],
    },
    presentationUnits: [{
      id: 'narrative-1',
      semanticKind: 'narrative',
      title: '背景',
      shape: 'text',
      leafIds: ['leaf-n1'],
      leafId: 'leaf-n1',
      text: '市场分析。',
    }],
    leafTraceIndex: {
      'leaf-n1': trace('/narrative/0'),
    },
    constraints: {
      requiredQuestionIds: [],
      requiredPresentationUnitIds: ['narrative-1'],
      requiredLeafUnitIds: ['leaf-n1'],
      allowedViews: ['topics'],
      projectionProfilesByUnitId: {
        'narrative-1': ['paragraph', 'fact', 'list'],
      },
    },
  };

  const result = compileReportEditorialIntent(material, emptyIntent());
  assertReportEditorialBlueprintIntegrity(material, result.blueprint);

  const primarySections = result.blueprint.sections.filter((s) => s.prominence === 'primary');
  assert.ok(primarySections.length > 0, 'must have at least one primary section');
});
