import { createHash } from 'node:crypto';

import type {
  ReportAuditAppendixMaterialV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
  ReportEditorialSemanticKindV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import {
  EDITORIAL_SHOWCASE_PROFILE_V1,
  type EditorialPresentationSpecV1,
  type EditorialShowcaseCompilationV1,
  type EditorialShowcaseComponentKindV1,
  type EditorialShowcaseComponentV1,
  type EditorialShowcasePurposeV1,
  type EditorialShowcaseSectionLayoutV1,
  type EditorialShowcaseSectionV1,
  type EditorialShowcaseVariantV1,
  type ReportEditorialShowcaseIntentComponentV1,
  type ReportEditorialShowcaseIntentV1,
} from '../../../../packages/api-contract/report-editorial-showcase.ts';
import { assertReportEditorialMaterialIntegrity } from '../../../../packages/report-rendering/report-editorial-validation.ts';
import { deriveEditorialPlacementPolicy } from './report-editorial-placement-policy.ts';

const SECTION_TITLES: Record<EditorialShowcasePurposeV1, string> = {
  decision: '决策摘要',
  evolution: '演变与背景',
  profiles: '用户与对象',
  motivation: '任务与动机',
  journey: '阶段与路径',
  principles: '原则与护栏',
  actions: '行动路线',
  validation: '验证方案',
  evidence: '证据边界',
  analysis: '分析与风险',
  full_analysis_appendix: '完整分析附件',
};

const COMPONENT_TITLES: Record<EditorialShowcaseComponentKindV1, string> = {
  'editorial-hero': '核心判断',
  'evidence-boundary': '证据边界',
  'confidence-bars': '置信度',
  timeline: '演变时间线',
  'profile-grid': '用户与对象原型',
  matrix: '分析矩阵',
  'stage-flow': '阶段路径',
  'tension-map': '阻力与响应',
  'principle-list': '设计原则',
  'priority-lanes': '行动优先级',
  'validation-list': '验证清单',
  'source-register': '证据登记',
  'narrative-list': '完整内容',
};

const VARIANTS_BY_COMPONENT: Record<
  EditorialShowcaseComponentKindV1,
  readonly EditorialShowcaseVariantV1[]
> = {
  'editorial-hero': ['statement'],
  'evidence-boundary': ['split'],
  'confidence-bars': ['ledger'],
  timeline: ['horizontal'],
  'profile-grid': ['asymmetric', 'columns', 'list'],
  matrix: ['table'],
  'stage-flow': ['stepped'],
  'tension-map': ['two-sided'],
  'principle-list': ['columns'],
  'priority-lanes': ['lanes'],
  'validation-list': ['ledger'],
  'source-register': ['register'],
  'narrative-list': ['list'],
};

function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function statusFor(
  material: ReportEditorialMaterialV1,
  leafIds: readonly string[],
): 'supported' | 'provisional' | 'unanswered' | undefined {
  const statuses = leafIds
    .map((leafId) => material.leafTraceIndex[leafId]?.support.status)
    .filter((value): value is 'supported' | 'provisional' | 'unanswered' => value !== undefined);
  if (statuses.includes('unanswered')) return 'unanswered';
  if (statuses.includes('provisional')) return 'provisional';
  if (statuses.includes('supported')) return 'supported';
  return undefined;
}

function confidenceFor(
  material: ReportEditorialMaterialV1,
  leafIds: readonly string[],
): number | undefined {
  const values = leafIds.map((leafId) => material.leafTraceIndex[leafId]?.support.confidence);
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  return Math.min(...(values as number[]));
}

function evidenceFor(material: ReportEditorialMaterialV1, leafIds: readonly string[]): string[] {
  return unique(leafIds.flatMap((leafId) => (
    material.leafTraceIndex[leafId]?.support.evidenceIds ?? []
  )));
}

function assertCompatible(
  kind: EditorialShowcaseComponentKindV1,
  variant: EditorialShowcaseVariantV1,
  units: readonly ReportEditorialPresentationUnitV1[],
  sourceLeafIds: readonly string[],
  material: ReportEditorialMaterialV1,
): void {
  if (!VARIANTS_BY_COMPONENT[kind].includes(variant)) {
    throw new Error(`showcase variant ${variant} is incompatible with ${kind}`);
  }
  if (units.length === 0) throw new Error(`showcase ${kind} must own at least one unit`);
  const all = (predicate: (unit: ReportEditorialPresentationUnitV1) => boolean) => units.every(predicate);
  if (kind === 'profile-grid' && !all(({ shape }) => shape === 'graph' || shape === 'records')) {
    throw new Error('profile-grid requires graph or records material');
  }
  if (kind === 'matrix' && !all(({ shape }) => shape === 'matrix' || shape === 'records')) {
    throw new Error('matrix requires explicit matrix or records material');
  }
  if (kind === 'timeline' && !all(({ shape }) => shape === 'stages')) {
    throw new Error('timeline requires explicit stages');
  }
  if (kind === 'stage-flow' && !all(({ shape }) => shape === 'stages')) {
    throw new Error('stage-flow requires explicit stages');
  }
  if (kind === 'tension-map' && !all(({ shape }) => shape === 'graph')) {
    throw new Error('tension-map requires explicit graph material');
  }
  if (kind === 'principle-list' && !all(({ semanticKind }) => semanticKind === 'design_principle')) {
    throw new Error('principle-list requires design principle material');
  }
  if (kind === 'priority-lanes') {
    const actions = units.flatMap((unit) => unit.shape === 'actions' ? unit.actions : []);
    if (!all(({ shape }) => shape === 'actions') || actions.length === 0 || actions.some(({ priority }) => !priority)) {
      throw new Error('priority-lanes requires explicitly prioritized actions');
    }
  }
  if (kind === 'confidence-bars' && sourceLeafIds.some((leafId) => (
    material.leafTraceIndex[leafId]?.support.confidence === undefined
  ))) {
    throw new Error('confidence-bars requires explicit confidence values');
  }
}

export function editorialShowcaseSectionTitle(purpose: EditorialShowcasePurposeV1): string {
  return SECTION_TITLES[purpose];
}

export function editorialShowcaseComponentTitle(
  kind: EditorialShowcaseComponentKindV1,
  units: readonly ReportEditorialPresentationUnitV1[],
): string {
  return units.length === 1 && units[0]?.title?.trim()
    ? units[0].title
    : COMPONENT_TITLES[kind];
}

export function editorialShowcaseNotices(
  generationMode: 'model' | 'fallback',
): EditorialPresentationSpecV1['notices'] {
  return generationMode === 'fallback'
    ? [{ code: 'showcase_fallback', severity: 'info', message: '本报告使用确定性 Showcase 编排。' }]
    : [];
}

function componentFromIntent(input: {
  material: ReportEditorialMaterialV1;
  unitById: ReadonlyMap<string, ReportEditorialPresentationUnitV1>;
  component: ReportEditorialShowcaseIntentComponentV1;
  sectionIndex: number;
  componentIndex: number;
}): EditorialShowcaseComponentV1 {
  const units = input.component.unitRefs.map((unitId) => {
    const unit = input.unitById.get(unitId);
    if (!unit) throw new Error(`showcase references unknown unit ${unitId}`);
    return unit;
  });
  const ownedLeafIds = unique(units.flatMap(({ leafIds }) => leafIds));
  const sourceLeafIds = input.component.sourceLeafIds.length > 0
    ? unique(input.component.sourceLeafIds)
    : ownedLeafIds;
  for (const leafId of sourceLeafIds) {
    if (!input.material.leafTraceIndex[leafId]) {
      throw new Error(`showcase references unknown leaf ${leafId}`);
    }
  }
  if (ownedLeafIds.some((leafId) => !sourceLeafIds.includes(leafId))) {
    throw new Error(`showcase ${input.component.kind} source leaves must include every owned leaf`);
  }
  assertCompatible(
    input.component.kind,
    input.component.variant,
    units,
    sourceLeafIds,
    input.material,
  );
  const status = statusFor(input.material, sourceLeafIds);
  const confidence = confidenceFor(input.material, sourceLeafIds);
  return {
    id: `showcase-component-${String(input.sectionIndex + 1).padStart(3, '0')}-${String(input.componentIndex + 1).padStart(3, '0')}`,
    kind: input.component.kind,
    variant: input.component.variant,
    emphasis: input.component.emphasis,
    span: input.component.span,
    ownedUnitIds: units.map(({ id }) => id),
    ownedLeafIds,
    sourceLeafIds,
    sourceContributionUnitIds: [],
    evidenceIds: evidenceFor(input.material, sourceLeafIds),
    ...(status === undefined ? {} : { status }),
    ...(confidence === undefined ? {} : { confidence }),
    title: editorialShowcaseComponentTitle(input.component.kind, units),
  };
}

function sectionFromIntent(input: {
  material: ReportEditorialMaterialV1;
  unitById: ReadonlyMap<string, ReportEditorialPresentationUnitV1>;
  purpose: Exclude<EditorialShowcasePurposeV1, 'full_analysis_appendix'>;
  layout: EditorialShowcaseSectionLayoutV1;
  components: ReportEditorialShowcaseIntentComponentV1[];
  requiredPrimaryUnitIds: ReadonlySet<string>;
  requiredSupportingUnitIds: ReadonlySet<string>;
  sectionIndex: number;
}): EditorialShowcaseSectionV1 {
  if (input.components.length === 0) throw new Error('showcase section must contain at least one component');
  const components = input.components.map((component, componentIndex) => componentFromIntent({
    material: input.material,
    unitById: input.unitById,
    component,
    sectionIndex: input.sectionIndex,
    componentIndex,
  }));
  const unitIds = components.flatMap(({ ownedUnitIds }) => ownedUnitIds);
  const hasRequiredPrimary = unitIds.some((unitId) => input.requiredPrimaryUnitIds.has(unitId));
  const hasRequiredSupporting = unitIds.some((unitId) => input.requiredSupportingUnitIds.has(unitId));
  if (hasRequiredPrimary && hasRequiredSupporting) {
    throw new Error('showcase section mixes mandatory primary and system supporting units');
  }
  return {
    id: `showcase-section-${String(input.sectionIndex + 1).padStart(3, '0')}`,
    purpose: input.purpose,
    layout: input.layout,
    prominence: hasRequiredPrimary
      ? 'primary'
      : hasRequiredSupporting || input.purpose === 'evidence' || input.purpose === 'analysis'
        ? 'supporting'
        : 'primary',
    title: editorialShowcaseSectionTitle(input.purpose),
    components,
  };
}

function appendixSection(input: {
  material: ReportEditorialMaterialV1;
  unitById: ReadonlyMap<string, ReportEditorialPresentationUnitV1>;
  missingUnitIds: string[];
  sectionIndex: number;
}): EditorialShowcaseSectionV1 | null {
  if (input.missingUnitIds.length === 0) return null;
  const component = componentFromIntent({
    material: input.material,
    unitById: input.unitById,
    sectionIndex: input.sectionIndex,
    componentIndex: 0,
    component: {
      kind: 'narrative-list',
      variant: 'list',
      emphasis: 'secondary',
      span: 'full',
      unitRefs: input.missingUnitIds,
      sourceLeafIds: input.missingUnitIds.flatMap((unitId) => input.unitById.get(unitId)?.leafIds ?? []),
    },
  });
  return {
    id: `showcase-section-${String(input.sectionIndex + 1).padStart(3, '0')}`,
    purpose: 'full_analysis_appendix',
    layout: 'single',
    prominence: 'appendix',
    title: editorialShowcaseSectionTitle('full_analysis_appendix'),
    components: [component],
  };
}

function assertCompleteOwnership(
  material: ReportEditorialMaterialV1,
  sections: readonly EditorialShowcaseSectionV1[],
): void {
  const ownedUnits = sections.flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const ownedLeaves = sections.flatMap(({ components }) => components.flatMap(({ ownedLeafIds }) => ownedLeafIds));
  if (
    ownedUnits.length !== new Set(ownedUnits).size
    || ownedUnits.length !== material.constraints.requiredPresentationUnitIds.length
    || material.constraints.requiredPresentationUnitIds.some((unitId) => !ownedUnits.includes(unitId))
  ) throw new Error('showcase unit ownership must cover every required unit exactly once');
  if (
    ownedLeaves.length !== new Set(ownedLeaves).size
    || ownedLeaves.length !== material.constraints.requiredLeafUnitIds.length
    || material.constraints.requiredLeafUnitIds.some((leafId) => !ownedLeaves.includes(leafId))
  ) throw new Error('showcase leaf ownership must cover every required leaf exactly once');
}

function assertShowcasePlacement(
  sections: readonly EditorialShowcaseSectionV1[],
  policy: ReturnType<typeof deriveEditorialPlacementPolicy>,
): void {
  const placement = new Map<string, EditorialShowcaseSectionV1['prominence']>();
  for (const section of sections) {
    for (const component of section.components) {
      for (const unitId of component.ownedUnitIds) placement.set(unitId, section.prominence);
    }
  }
  for (const unitId of policy.mandatoryBodyUnitIds) {
    if (placement.get(unitId) !== 'primary') {
      throw new Error(`showcase mandatory unit ${unitId} must be primary`);
    }
  }
  for (const group of policy.mainCoverageGroups) {
    if (!group.unitIds.some((unitId) => placement.get(unitId) === 'primary')) {
      throw new Error(`showcase coverage group ${group.label} must have a primary unit`);
    }
  }
  for (const unitId of policy.systemSupportingUnitIds) {
    if (placement.get(unitId) !== 'supporting') {
      throw new Error(`showcase system supporting unit ${unitId} must be supporting`);
    }
  }
  if (!sections.some(({ prominence }) => prominence === 'primary')) {
    throw new Error('showcase must contain a primary section');
  }
}

export function editorialShowcaseOutlineSignature(
  sections: readonly EditorialShowcaseSectionV1[],
): string {
  return stableHash(sections.map(({ purpose, layout, components }) => ({
    purpose,
    layout,
    components: components.map(({
      kind,
      variant,
      emphasis,
      span,
      ownedUnitIds,
      ownedLeafIds,
    }) => ({
      kind,
      variant,
      emphasis,
      span,
      ownedUnitCount: ownedUnitIds.length,
      ownedLeafCount: ownedLeafIds.length,
    })),
  })));
}

export function bindEditorialShowcaseEvidenceManifest(
  spec: EditorialPresentationSpecV1,
  evidence: {
    artifactId: string;
    contentSha256: string;
    manifestHash: string;
  },
): EditorialPresentationSpecV1 {
  if (!evidence.artifactId.trim()) throw new Error('Showcase Evidence Manifest Artifact ID is required');
  for (const [label, value] of [
    ['Artifact content hash', evidence.contentSha256],
    ['manifest hash', evidence.manifestHash],
  ] as const) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`Showcase Evidence Manifest ${label} is invalid`);
    }
  }
  const existing = spec.binding;
  if (
    (existing.evidenceManifestArtifactId !== undefined
      && existing.evidenceManifestArtifactId !== evidence.artifactId)
    || (existing.evidenceManifestContentSha256 !== undefined
      && existing.evidenceManifestContentSha256 !== evidence.contentSha256)
    || (existing.evidenceManifestHash !== undefined
      && existing.evidenceManifestHash !== evidence.manifestHash)
  ) {
    throw new Error('Showcase Evidence Manifest binding cannot be replaced');
  }
  return {
    ...spec,
    binding: {
      ...spec.binding,
      evidenceManifestArtifactId: evidence.artifactId,
      evidenceManifestContentSha256: evidence.contentSha256,
      evidenceManifestHash: evidence.manifestHash,
    },
  };
}

export function bindEditorialShowcaseContributions(
  spec: EditorialPresentationSpecV1,
  material: ReportEditorialMaterialV1,
  auditAppendix: ReportAuditAppendixMaterialV1 | undefined,
): EditorialPresentationSpecV1 {
  if (!auditAppendix) return spec;
  for (const key of ['taskId', 'planVersionId', 'attemptId', 'deliverableArtifactId', 'deliverableContentSha256', 'reportReviewArtifactId'] as const) {
    if (auditAppendix.binding[key] !== material.binding[key]) {
      throw new Error(`Showcase Contribution binding ${key} does not match Material`);
    }
  }
  const allowed = auditAppendix.records.filter(({ disposition }) => (
    disposition === 'included' || disposition === 'merged'
  ));
  return {
    ...spec,
    sections: spec.sections.map((section) => ({
      ...section,
      components: section.components.map((component) => {
        const nodeIds = new Set(component.sourceLeafIds.flatMap((leafId) => (
          material.leafTraceIndex[leafId]?.origins.flatMap(({ sourceNodeIds }) => sourceNodeIds) ?? []
        )));
        const sourceContributionUnitIds = allowed
          .filter(({ canonicalNodeIds }) => canonicalNodeIds.some((nodeId) => nodeIds.has(nodeId)))
          .map(({ contributionArtifactId, sourceUnitKey }) => `${contributionArtifactId}:${sourceUnitKey}`);
        return { ...component, sourceContributionUnitIds: unique(sourceContributionUnitIds) };
      }),
    })),
  };
}

export function compileEditorialShowcase(
  material: ReportEditorialMaterialV1,
  intent: ReportEditorialShowcaseIntentV1,
  generationMode: 'model' | 'fallback' = 'model',
): EditorialShowcaseCompilationV1 {
  assertReportEditorialMaterialIntegrity(material);
  if (intent.profileId !== EDITORIAL_SHOWCASE_PROFILE_V1) {
    throw new Error(`unsupported showcase profile ${intent.profileId}`);
  }
  if (intent.sections.length === 0) throw new Error('showcase intent must contain at least one section');
  const unitById = new Map(material.presentationUnits.map((unit) => [unit.id, unit]));
  const selectedUnitIds = intent.sections.flatMap(({ components }) => components.flatMap(({ unitRefs }) => unitRefs));
  if (selectedUnitIds.length !== new Set(selectedUnitIds).size) {
    throw new Error('showcase intent assigns one unit more than once');
  }
  const policy = deriveEditorialPlacementPolicy(material);
  const selected = new Set(selectedUnitIds);
  const requiredPrimaryUnitIds = new Set(policy.mandatoryBodyUnitIds);
  for (const group of policy.mainCoverageGroups) {
    const selectedCoverageUnit = group.unitIds.find((unitId) => selected.has(unitId));
    const requiredUnitId = selectedCoverageUnit ?? group.unitIds[0];
    if (requiredUnitId) requiredPrimaryUnitIds.add(requiredUnitId);
  }
  if (requiredPrimaryUnitIds.size === 0 && policy.fallbackPrimaryUnitId) {
    requiredPrimaryUnitIds.add(policy.fallbackPrimaryUnitId);
  }
  const requiredSupportingUnitIds = new Set(policy.systemSupportingUnitIds);
  const autoAddedUnitIds = material.constraints.requiredPresentationUnitIds.filter((unitId) => (
    !selected.has(unitId)
    && (requiredPrimaryUnitIds.has(unitId) || requiredSupportingUnitIds.has(unitId))
  ));
  const autoIntentSections = intentSectionsForUnitIds(material, new Set(autoAddedUnitIds));
  const autoDecisionSections = autoIntentSections.filter(({ purpose }) => purpose === 'decision');
  const remainingAutoSections = autoIntentSections.filter(({ purpose }) => purpose !== 'decision');
  const normalizedIntentSections = [
    ...autoDecisionSections,
    ...intent.sections,
    ...remainingAutoSections,
  ];
  for (const unitId of autoAddedUnitIds) selected.add(unitId);
  const sections = normalizedIntentSections.map((section, sectionIndex) => sectionFromIntent({
    material,
    unitById,
    purpose: section.purpose,
    layout: section.layout,
    components: section.components,
    requiredPrimaryUnitIds,
    requiredSupportingUnitIds,
    sectionIndex,
  }));
  const missingUnitIds = material.constraints.requiredPresentationUnitIds.filter((unitId) => !selected.has(unitId));
  const appendix = appendixSection({ material, unitById, missingUnitIds, sectionIndex: sections.length });
  if (appendix) sections.push(appendix);
  assertCompleteOwnership(material, sections);
  assertShowcasePlacement(sections, policy);
  const sourceLeafIds = unique(sections.flatMap(({ components }) => components.flatMap(({ sourceLeafIds }) => sourceLeafIds)));
  const evidenceIds = unique(sections.flatMap(({ components }) => components.flatMap(({ evidenceIds }) => evidenceIds)));
  const primaryUnits = sections
    .filter(({ prominence }) => prominence === 'primary')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const supportingUnits = sections
    .filter(({ prominence }) => prominence === 'supporting')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const spec: EditorialPresentationSpecV1 = {
    version: 'editorial-presentation-spec-v1',
    binding: { ...material.binding },
    profileId: EDITORIAL_SHOWCASE_PROFILE_V1,
    generationMode,
    showcaseOutlineSignature: editorialShowcaseOutlineSignature(sections),
    sections,
    notices: editorialShowcaseNotices(generationMode),
  };
  return {
    spec,
    diagnostics: {
      sectionCount: sections.length,
      componentCount: sections.reduce((count, { components }) => count + components.length, 0),
      primaryUnitCount: primaryUnits.length,
      supportingUnitCount: supportingUnits.length,
      appendixUnitCount: missingUnitIds.length,
      sourceLeafCount: sourceLeafIds.length,
      evidenceCount: evidenceIds.length,
    },
  };
}

function fallbackComponentFor(unit: ReportEditorialPresentationUnitV1): ReportEditorialShowcaseIntentComponentV1 {
  let kind: EditorialShowcaseComponentKindV1 = 'narrative-list';
  let variant: EditorialShowcaseVariantV1 = 'list';
  if (unit.semanticKind === 'direct_answer') {
    kind = 'editorial-hero';
    variant = 'statement';
  } else if (unit.semanticKind === 'mind_model' && (unit.shape === 'graph' || unit.shape === 'records')) {
    kind = 'profile-grid';
    variant = 'asymmetric';
  } else if ((unit.semanticKind === 'comparison_matrix' || unit.semanticKind === 'strategy_map')
    && (unit.shape === 'matrix' || unit.shape === 'records')) {
    kind = 'matrix';
    variant = 'table';
  } else if (unit.shape === 'stages') {
    kind = 'stage-flow';
    variant = 'stepped';
  } else if (unit.semanticKind === 'design_principle') {
    kind = 'principle-list';
    variant = 'columns';
  } else if (unit.shape === 'actions' && unit.actions.length > 0 && unit.actions.every(({ priority }) => priority)) {
    kind = 'priority-lanes';
    variant = 'lanes';
  } else if (unit.semanticKind === 'evidence_finding') {
    kind = 'evidence-boundary';
    variant = 'split';
  } else if (unit.semanticKind === 'risk'
    || unit.semanticKind === 'limitation'
    || unit.semanticKind === 'open_question') {
    kind = 'validation-list';
    variant = 'ledger';
  }
  return {
    kind,
    variant,
    emphasis: kind === 'editorial-hero' ? 'hero' : 'primary',
    span: 'full',
    unitRefs: [unit.id],
    sourceLeafIds: [...unit.leafIds],
  };
}

function purposeFor(kind: ReportEditorialSemanticKindV1): Exclude<EditorialShowcasePurposeV1, 'full_analysis_appendix'> {
  if (kind === 'direct_answer' || kind === 'research_plan_overview') return 'decision';
  if (kind === 'mind_model') return 'profiles';
  if (kind === 'comparison_matrix' || kind === 'strategy_map') return 'motivation';
  if (kind === 'action_plan' || kind === 'prioritized_action' || kind === 'opportunity') return 'actions';
  if (kind === 'design_principle') return 'principles';
  if (kind === 'evidence_finding') return 'evidence';
  if (kind === 'risk' || kind === 'limitation' || kind === 'open_question') return 'validation';
  if (kind === 'research_plan_execution') return 'journey';
  return 'analysis';
}

function intentSectionsForUnitIds(
  material: ReportEditorialMaterialV1,
  selectedUnitIds: ReadonlySet<string>,
): ReportEditorialShowcaseIntentV1['sections'] {
  const groups = new Map<Exclude<EditorialShowcasePurposeV1, 'full_analysis_appendix'>, ReportEditorialShowcaseIntentComponentV1[]>();
  for (const unit of material.presentationUnits) {
    if (!selectedUnitIds.has(unit.id)) continue;
    const purpose = purposeFor(unit.semanticKind);
    const components = groups.get(purpose) ?? [];
    const candidate = fallbackComponentFor(unit);
    const groupable = candidate.kind !== 'matrix';
    const existing = groupable
      ? components.find(({ kind, variant }) => kind === candidate.kind && variant === candidate.variant)
      : undefined;
    if (existing) {
      existing.unitRefs.push(...candidate.unitRefs);
      existing.sourceLeafIds.push(...candidate.sourceLeafIds);
    } else {
      components.push(candidate);
    }
    groups.set(purpose, components);
  }
  const order: Array<Exclude<EditorialShowcasePurposeV1, 'full_analysis_appendix'>> = [
    'decision', 'evolution', 'profiles', 'motivation', 'journey', 'principles',
    'actions', 'validation', 'evidence', 'analysis',
  ];
  return order.flatMap((purpose) => {
    const components = groups.get(purpose);
    if (!components || components.length === 0) return [];
    const layout: EditorialShowcaseSectionLayoutV1 = components.some(({ kind }) => (
      kind === 'profile-grid' || kind === 'priority-lanes'
    )) ? 'asymmetric' : components.length > 1 ? 'columns' : 'single';
    return [{ purpose, layout, components }];
  });
}

export function createDeterministicEditorialShowcaseSpec(
  material: ReportEditorialMaterialV1,
): EditorialPresentationSpecV1 {
  assertReportEditorialMaterialIntegrity(material);
  const policy = deriveEditorialPlacementPolicy(material);
  const selectedUnitIds = new Set<string>([
    ...policy.mandatoryBodyUnitIds,
    ...policy.systemSupportingUnitIds,
    ...policy.mainCoverageGroups.flatMap(({ unitIds }) => unitIds.slice(0, 1)),
    ...(policy.fallbackPrimaryUnitId ? [policy.fallbackPrimaryUnitId] : []),
  ]);
  const representativeKinds: readonly ReportEditorialSemanticKindV1[] = [
    'strategy_map',
    'comparison_matrix',
    'mind_model',
    'design_principle',
    'opportunity',
    'channel_strategy',
    'research_plan_methods',
    'research_plan_execution',
  ];
  for (const semanticKind of representativeKinds) {
    for (const unit of material.presentationUnits) {
      if (unit.semanticKind === semanticKind) selectedUnitIds.add(unit.id);
    }
  }
  const intent: ReportEditorialShowcaseIntentV1 = {
    profileId: EDITORIAL_SHOWCASE_PROFILE_V1,
    sections: intentSectionsForUnitIds(material, selectedUnitIds),
  };
  return compileEditorialShowcase(material, intent, 'fallback').spec;
}
