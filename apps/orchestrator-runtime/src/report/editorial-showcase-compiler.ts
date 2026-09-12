import type {
  EditorialPresentationComponentV1,
  EditorialPresentationSectionV1,
  EditorialPresentationSpecV1,
  EditorialShowcaseIntentV1,
  EditorialShowcaseStatusV1,
  EditorialShowcaseUnitV1,
} from '../../../../packages/api-contract/editorial-showcase.ts';
import { EDITORIAL_SHOWCASE_COMPONENT_ROLES } from '../../../../packages/api-contract/editorial-showcase.ts';
import {
  canonicalJsonBytes,
  hashBytes,
  parseEditorialMaterial,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type Sha256,
} from './editorial-report-contract.ts';
import type {
  EditorialHtmlSourcePacketV2,
  EditorialSourceGroupV2,
  EditorialSourceRelationV2,
} from './editorial-html-source-packet.ts';
import { projectEditorialShowcaseSource } from './editorial-showcase-source-adapter.ts';

export const EDITORIAL_SHOWCASE_COMPILER_VERSION = 'editorial-showcase-compiler-v1' as const;

export interface EditorialShowcaseCompilationResult {
  spec: EditorialPresentationSpecV1;
  bytes: Buffer;
  hash: Sha256;
}

export class EditorialShowcaseCompilerError extends Error {
  readonly name = 'EditorialShowcaseCompilerError';

  constructor(
    readonly code:
      | 'SHOWCASE_INVALID_BINDING'
      | 'SHOWCASE_INVALID_INTENT'
      | 'SHOWCASE_COMPILATION_FAILED',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

function fail(code: EditorialShowcaseCompilerError['code'], detail?: string): never {
  throw new EditorialShowcaseCompilerError(code, detail);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function relationId(relation: EditorialSourceRelationV2): string {
  return `relation:${relation.kind}:${relation.fromGroupId}:${relation.toGroupId}`;
}

function unitStatus(unit: EditorialMaterialUnit): EditorialShowcaseStatusV1 | undefined {
  if ('epistemicStatus' in unit && unit.epistemicStatus !== undefined) return unit.epistemicStatus;
  return undefined;
}

function conservativeStatus(units: readonly EditorialMaterialUnit[]): EditorialShowcaseStatusV1 | undefined {
  const statuses = units.flatMap((unit) => {
    const status = unitStatus(unit);
    return status === undefined ? [] : [status];
  });
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('inference')) return 'inference';
  if (statuses.includes('fact')) return 'fact';
  return undefined;
}

function ref(unit: EditorialMaterialUnit): EditorialShowcaseUnitV1 {
  const status = unitStatus(unit);
  return {
    unitId: unit.id,
    value: unit.value,
    ...(unit.unit === undefined ? {} : { unit: unit.unit }),
    role: unit.role,
    ...(status === undefined ? {} : { status }),
    evidenceIds: [...unit.evidenceIds],
  };
}

function componentBase(input: {
  id: string;
  ownedUnits: readonly EditorialMaterialUnit[];
  sourceUnits?: readonly EditorialMaterialUnit[];
  sourceGroupIds?: readonly string[];
  sourceRelationIds?: readonly string[];
}): Omit<EditorialPresentationComponentV1, 'kind' | 'content'> {
  const sourceUnits = unique([
    ...input.ownedUnits.map(({ id }) => id),
    ...(input.sourceUnits ?? []).map(({ id }) => id),
  ]);
  const allUnits = unique([
    ...input.ownedUnits.map(({ id }) => id),
    ...(input.sourceUnits ?? []).map(({ id }) => id),
  ]);
  const evidenceIds = unique(allUnits.flatMap((id) => {
    const unit = [...input.ownedUnits, ...(input.sourceUnits ?? [])].find((candidate) => candidate.id === id);
    return unit?.evidenceIds ?? [];
  }));
  const status = conservativeStatus([...input.ownedUnits, ...(input.sourceUnits ?? [])]);
  return {
    id: input.id,
    ownedUnitIds: input.ownedUnits.map(({ id }) => id),
    sourceUnitIds: sourceUnits,
    sourceGroupIds: unique(input.sourceGroupIds ?? []),
    sourceRelationIds: unique(input.sourceRelationIds ?? []),
    evidenceIds,
    ...(status === undefined ? {} : { status }),
  } as Omit<EditorialPresentationComponentV1, 'kind' | 'content'>;
}

function bindingMatches(material: EditorialMaterial, packet: EditorialHtmlSourcePacketV2): boolean {
  return packet.version === 'editorial-html-source-packet-v2'
    && packet.binding.taskId === material.taskId
    && packet.binding.planVersionId === material.planVersionId
    && packet.binding.attemptId === material.attemptId
    && packet.binding.sourceReportPackageId === material.sourceReportPackage.artifactId
    && packet.binding.sourceReportPackageHash === material.sourceReportPackage.contentSha256
    && packet.binding.materialHash === hashBytes(canonicalJsonBytes(material));
}

function firstUnit(
  group: EditorialSourceGroupV2,
  byId: ReadonlyMap<string, EditorialMaterialUnit>,
): EditorialMaterialUnit | undefined {
  return [...group.titleUnitIds, ...group.bodyUnitIds, ...group.supportingUnitIds]
    .map((id) => byId.get(id))
    .find((unit): unit is EditorialMaterialUnit => unit !== undefined);
}

const SHOWCASE_CONTROLLED_LABELS = new Set([
  '核心判断', '证据边界', '研究范围', '直接答案', '分析依据', '建议行动',
  '最终交付物', '分析维度与方法', '执行计划', '验证计划', '风险与边界',
]);

function applyModelIntent(input: {
  intent: EditorialShowcaseIntentV1;
  deterministic: EditorialPresentationSpecV1;
}): EditorialShowcaseCompilationResult {
  const { intent, deterministic } = input;
  if (intent.version !== 'universal-editorial-showcase-intent-v1' || intent.profileId !== deterministic.profileId) {
    fail('SHOWCASE_INVALID_INTENT');
  }
  const allowedTitles = new Set([
    ...SHOWCASE_CONTROLLED_LABELS,
    ...deterministic.sections.map(({ title }) => title),
  ]);
  const deterministicComponents = new Map(
    deterministic.sections.flatMap(({ components }) => components.map((component) => [component.id, component] as const)),
  );
  const used = new Set<string>();
  const sectionIds = new Set<string>();
  const sections: EditorialPresentationSectionV1[] = [];
  for (const section of intent.sections) {
    if (
      sectionIds.has(section.id)
      || !allowedTitles.has(section.title)
      || (section.lead !== undefined && !allowedTitles.has(section.lead))
    ) fail('SHOWCASE_INVALID_INTENT');
    sectionIds.add(section.id);
    const components: EditorialPresentationComponentV1[] = [];
    for (const componentId of section.componentIds) {
      const matched = deterministicComponents.get(componentId);
      if (
        !matched
        || used.has(componentId)
        || matched.kind === 'analysis-appendix'
        || matched.kind === 'source-register'
        || !(EDITORIAL_SHOWCASE_COMPONENT_ROLES[matched.kind] as readonly string[]).includes(section.role)
      ) {
        fail('SHOWCASE_INVALID_INTENT');
      }
      used.add(componentId);
      components.push(structuredClone(matched));
    }
    if (components.length === 0) fail('SHOWCASE_INVALID_INTENT');
    sections.push({
      id: section.id,
      role: section.role,
      title: section.title,
      ...(section.lead === undefined ? {} : { lead: section.lead }),
      components,
    });
  }
  if (sections[0]?.components[0]?.kind !== 'editorial-hero') fail('SHOWCASE_INVALID_INTENT');
  for (const section of deterministic.sections) {
    const components = section.components.filter((component) => !used.has(component.id));
    if (components.length === 0) continue;
    if (sectionIds.has(section.id)) fail('SHOWCASE_INVALID_INTENT');
    sectionIds.add(section.id);
    sections.push({ ...structuredClone(section), components });
  }
  const appendixIndex = sections.findIndex(({ role }) => role === 'appendix');
  if (appendixIndex >= 0 && appendixIndex !== sections.length - 1) {
    const [appendix] = sections.splice(appendixIndex, 1);
    sections.push(appendix!);
  }
  const spec: EditorialPresentationSpecV1 = {
    ...structuredClone(deterministic),
    generationMode: 'model_intent',
    sections,
    notices: [...deterministic.notices, '模型仅调整展示章节与组件顺序，内容和来源由 Compiler 保持不变。'],
  };
  const bytes = canonicalJsonBytes(spec);
  return { spec, bytes, hash: hashBytes(bytes) };
}

export function compileEditorialShowcase(input: {
  material: EditorialMaterial;
  sourcePacket: EditorialHtmlSourcePacketV2;
  intent: EditorialShowcaseIntentV1 | null;
}): EditorialShowcaseCompilationResult {
  const material = parseEditorialMaterial(input.material);
  if (!bindingMatches(material, input.sourcePacket)) fail('SHOWCASE_INVALID_BINDING');
  if (input.intent !== null) {
    const deterministic = compileEditorialShowcase({ material, sourcePacket: input.sourcePacket, intent: null });
    return applyModelIntent({ intent: input.intent, deterministic: deterministic.spec });
  }
  const sourceProjection = projectEditorialShowcaseSource({ material, sourcePacket: input.sourcePacket });

  const byId = new Map(material.units.map((unit) => [unit.id, unit]));
  const groupById = new Map(input.sourcePacket.groups.map((group) => [group.id, group]));
  const promotedSupportingUnitIds = unique([
    ...sourceProjection.journeyStages.flatMap((stage) => [
      ...(stage.durationUnitId === undefined ? [] : [stage.durationUnitId]),
      ...stage.outputUnitIds,
    ]),
    ...sourceProjection.dimensionGroups.flatMap((group) => [
      group.nameUnitId,
      ...(group.purposeUnitId === undefined ? [] : [group.purposeUnitId]),
      ...group.fieldUnitIds,
    ]),
    ...sourceProjection.analysisMethodUnitIds,
  ]).filter((id) => byId.get(id)?.requiredInOutput === true && byId.get(id)?.requiredInBody === false);
  const mainEligibleUnitIds = new Set([
    ...material.units.filter(({ requiredInBody }) => requiredInBody).map(({ id }) => id),
    ...promotedSupportingUnitIds,
  ]);
  const owned = new Set<string>();
  const take = (ids: readonly string[]): EditorialMaterialUnit[] => ids.flatMap((id) => {
    const unit = byId.get(id);
    if (!unit || !unit.requiredInOutput || !mainEligibleUnitIds.has(id) || owned.has(id)) return [];
    owned.add(id);
    return [unit];
  });
  const bodyUnits = material.units.filter(({ requiredInBody }) => requiredInBody);
  const sections: EditorialPresentationSectionV1[] = [];

  const decisionGroup = sourceProjection.heroGroupIds
    .map((id) => groupById.get(id))
    .find((group): group is EditorialSourceGroupV2 => group !== undefined);
  const heroIds = unique([
    ...(material.titleUnitId === undefined ? [] : [material.titleUnitId]),
    material.methodSummaryUnitId,
    ...(decisionGroup?.bodyUnitIds ?? []),
  ]);
  const heroOwned = take(heroIds);
  if (heroOwned.length === 0) fail('SHOWCASE_COMPILATION_FAILED');
  const title = material.titleUnitId === undefined ? heroOwned[0]! : byId.get(material.titleUnitId)!;
  const deck = byId.get(material.methodSummaryUnitId) ?? heroOwned.find(({ id }) => id !== title.id) ?? title;
  const heroSources = bodyUnits.filter((unit) => unit.role === 'risk').slice(0, 3);
  const hero: EditorialPresentationComponentV1 = {
    ...componentBase({
      id: 'showcase-hero',
      ownedUnits: heroOwned,
      sourceUnits: heroSources,
      sourceGroupIds: sourceProjection.heroGroupIds,
    }),
    kind: 'editorial-hero',
    content: {
      title: ref(title),
      deck: ref(deck),
      highlights: heroOwned.filter(({ id }) => id !== title.id && id !== deck.id).map(ref),
      boundary: heroSources.map(ref),
    },
  };

  const statusUnits = bodyUnits.filter((unit) => unitStatus(unit) !== undefined);
  const statusOrder: EditorialShowcaseStatusV1[] = ['fact', 'inference', 'unknown'];
  const evidenceBoundary: EditorialPresentationComponentV1 | null = new Set(statusUnits.map(unitStatus)).size >= 2
    ? {
        ...componentBase({ id: 'showcase-evidence-boundary', ownedUnits: [], sourceUnits: statusUnits }),
        kind: 'evidence-boundary',
        content: {
          columns: statusOrder.flatMap((status) => {
            const items = statusUnits.filter((unit) => unitStatus(unit) === status).slice(0, 6).map(ref);
            return items.length === 0 ? [] : [{ status, items }];
          }),
        },
      }
    : null;

  const metricUnits = bodyUnits.filter((unit) => unit.metricEligible && typeof unit.value === 'number');
  const metricOwned = take(metricUnits.map(({ id }) => id));
  const metricItems = metricOwned.flatMap((metric) => {
    const label = metric.basisUnitIds.map((id) => byId.get(id)).find((unit): unit is EditorialMaterialUnit => (
      unit !== undefined && typeof unit.value === 'string'
    )) ?? material.units.find((unit) => (
      unit.groupId !== undefined && unit.groupId === metric.groupId && typeof unit.value === 'string' && unit.id !== metric.id
    ));
    return label ? [{ label: ref(label), value: ref(metric) }] : [];
  });
  const metricComponent: EditorialPresentationComponentV1 | null = metricItems.length === 0
    ? null
    : {
        ...componentBase({
          id: 'showcase-metrics',
          ownedUnits: metricOwned,
          sourceUnits: metricItems.map(({ label }) => byId.get(label.unitId)!),
          sourceGroupIds: unique(metricOwned.flatMap(({ groupId }) => groupId ? [groupId] : [])),
        }),
        kind: 'metric-cards',
        content: { items: metricItems },
      };

  sections.push({
    id: 'decision', role: 'decision', title: '先看结论与证据边界',
    components: [hero, ...(evidenceBoundary ? [evidenceBoundary] : []), ...(metricComponent ? [metricComponent] : [])],
  });

  const scopeOwned = take(sourceProjection.scopeUnitIds);
  if (scopeOwned.length > 0) {
    const scopeById = new Map(scopeOwned.map((unit) => [unit.id, unit]));
    const records = sourceProjection.scopeFields.flatMap(({ unitId, label }) => {
      const unit = scopeById.get(unitId);
      return unit ? [{ groupId: 'research-scope', label, items: [ref(unit)] }] : [];
    });
    sections.push({
      id: 'scope', role: 'strategy', title: '研究范围与对象',
      components: [{
        ...componentBase({ id: 'showcase-scope-table', ownedUnits: scopeOwned, sourceGroupIds: ['research-scope'] }),
        kind: 'record-table', content: { records },
      }],
    });
  }

  const questionGroups = sourceProjection.questionAnchors
    .map(({ groupId }) => groupById.get(groupId))
    .filter((group): group is EditorialSourceGroupV2 => group !== undefined);
  const questionOrder = sourceProjection.questionAnchors.map(({ questionId }) => questionId);
  for (const [questionIndex, questionId] of questionOrder.entries()) {
    const questionGroup = questionGroups[questionIndex];
    const questionUnit = questionGroup?.bodyUnitIds.map((id) => byId.get(id)).find((unit) => unit !== undefined);
    const explicitAnswerGroup = questionGroup?.id.startsWith('strategy-answer:') === true;
    const related = explicitAnswerGroup
      ? []
      : bodyUnits.filter((unit) => (
          !owned.has(unit.id)
          && unit.role !== 'risk'
          && unit.role !== 'validation'
          && unit.questionIds.includes(questionId)
          && unit.questionIds.find((id) => questionOrder.includes(id)) === questionId
        ));
    const candidateIds = unique([
      ...(questionGroup?.bodyUnitIds ?? []),
      ...related.map(({ id }) => id),
    ]);
    const answerOwned = take(candidateIds);
    if (answerOwned.length === 0) continue;
    const answer = answerOwned.find((unit) => unit.groupId?.startsWith('summary:'))
      ?? answerOwned.find((unit) => unit.groupId?.startsWith('conclusion:'))
      ?? answerOwned.find((unit) => unit.groupId?.startsWith('analysis:'))
      ?? answerOwned.find((unit) => unit.role === 'claim')
      ?? answerOwned[0]!;
    const question = questionUnit && answerOwned.some(({ id }) => id === questionUnit.id)
      ? questionUnit
      : answer;
    const actions = answerOwned.filter((unit) => unit.role === 'recommendation');
    const supporting = answerOwned.filter((unit) => (
      unit.id !== question.id && unit.id !== answer.id && unit.role !== 'recommendation'
    ));
    const answerGroupIds = unique(answerOwned.flatMap(({ groupId }) => groupId ? [groupId] : []));
    const relatedRelations = input.sourcePacket.relations.filter(({ fromGroupId, toGroupId }) => (
      answerGroupIds.includes(fromGroupId) || answerGroupIds.includes(toGroupId)
    ));
    const relationSourceUnits = unique(relatedRelations.flatMap(({ sourceUnitIds }) => sourceUnitIds))
      .map((id) => byId.get(id))
      .filter((unit): unit is EditorialMaterialUnit => unit !== undefined);
    const answerChain: EditorialPresentationComponentV1 = {
      ...componentBase({
        id: `showcase-answer-${questionId.toLowerCase()}`,
        ownedUnits: answerOwned,
        sourceUnits: relationSourceUnits,
        sourceGroupIds: answerGroupIds,
        sourceRelationIds: relatedRelations.map(relationId),
      }),
      kind: 'answer-chain',
      content: {
        question: ref(question),
        answer: ref(answer),
        supporting: supporting.map(ref),
        actions: actions.map(ref),
      },
    };
    sections.push({
      id: `answer-${questionId.toLowerCase()}`,
      role: actions.length > 0 ? 'strategy' : 'analysis',
      title: typeof question.value === 'string' ? question.value : `研究问题 ${questionId}`,
      components: [answerChain],
    });
  }

  for (const [matrixIndex, matrixGroup] of sourceProjection.strategyMatrixGroups.entries()) {
    const titleUnit = byId.get(matrixGroup.titleUnitId);
    const rowUnits = matrixGroup.rowUnitIds.map((id) => byId.get(id));
    const columnUnits = matrixGroup.columnUnitIds.map((id) => byId.get(id));
    const cellUnits = matrixGroup.cellUnitIds.map((id) => byId.get(id));
    if (
      !titleUnit
      || rowUnits.some((unit) => unit === undefined)
      || columnUnits.some((unit) => unit === undefined)
      || cellUnits.some((unit) => unit === undefined)
    ) continue;
    const rows = (rowUnits as EditorialMaterialUnit[]).map((row) => ({
      label: ref(row),
      cells: (columnUnits as EditorialMaterialUnit[]).flatMap((column) => {
        const cell = (cellUnits as EditorialMaterialUnit[]).find((candidate) => (
          candidate.basisUnitIds.includes(row.id) && candidate.basisUnitIds.includes(column.id)
        ));
        return cell ? [ref(cell)] : [];
      }),
    }));
    if (rows.some(({ cells }) => cells.length !== columnUnits.length)) continue;
    const matrixOwned = take([
      titleUnit.id,
      ...(rowUnits as EditorialMaterialUnit[]).map(({ id }) => id),
      ...(columnUnits as EditorialMaterialUnit[]).map(({ id }) => id),
      ...(cellUnits as EditorialMaterialUnit[]).map(({ id }) => id),
    ]);
    if (matrixOwned.length === 0) continue;
    sections.push({
      id: `strategy-matrix-${matrixIndex + 1}`,
      role: 'strategy',
      title: String(titleUnit.value),
      components: [{
        ...componentBase({
          id: `showcase-strategy-matrix-${matrixIndex + 1}`,
          ownedUnits: matrixOwned,
          sourceGroupIds: [matrixGroup.groupId],
        }),
        kind: 'matrix',
        content: {
          title: ref(titleUnit),
          columns: (columnUnits as EditorialMaterialUnit[]).map(ref),
          rows,
        },
      }],
    });
  }

  const actionGroups = new Map<string, typeof sourceProjection.priorityActionGroups>();
  for (const actionGroup of sourceProjection.priorityActionGroups) {
    const entries = actionGroups.get(actionGroup.groupId) ?? [];
    entries.push(actionGroup);
    actionGroups.set(actionGroup.groupId, entries);
  }
  let priorityIndex = 0;
  for (const [groupId, actionEntries] of actionGroups) {
    const titleUnit = byId.get(actionEntries[0]!.titleUnitId);
    if (!titleUnit) continue;
    const ownedUnits = take(unique([
      titleUnit.id,
      ...actionEntries.flatMap(({ itemUnitIds }) => itemUnitIds),
    ]));
    if (ownedUnits.length === 0) continue;
    const ownedIds = new Set(ownedUnits.map(({ id }) => id));
    const lanes = (['P0', 'P1', 'P2'] as const).flatMap((priority) => {
      const items = actionEntries
        .filter((entry) => entry.priority === priority)
        .flatMap(({ itemUnitIds }) => itemUnitIds)
        .map((id) => byId.get(id))
        .filter((unit): unit is EditorialMaterialUnit => unit !== undefined && ownedIds.has(unit.id) && unit.id !== titleUnit.id)
        .map(ref);
      return items.length === 0 ? [] : [{ priority, items }];
    });
    if (lanes.length === 0) continue;
    priorityIndex += 1;
    sections.push({
      id: `priority-actions-${priorityIndex}`,
      role: 'execution',
      title: String(titleUnit.value),
      components: [{
        ...componentBase({
          id: `showcase-priority-actions-${priorityIndex}`,
          ownedUnits,
          sourceGroupIds: [groupId],
        }),
        kind: 'priority-lanes',
        content: { title: ref(titleUnit), lanes },
      }],
    });
  }

  const deliverableOwned = take(sourceProjection.deliverableUnitIds);
  if (deliverableOwned.length > 0) {
    sections.push({
      id: 'deliverables', role: 'strategy', title: '最终交付物',
      components: [{
        ...componentBase({
          id: 'showcase-deliverables', ownedUnits: deliverableOwned,
          sourceGroupIds: unique(deliverableOwned.flatMap(({ groupId }) => groupId ? [groupId] : [])),
        }),
        kind: 'deliverable-map', content: { items: deliverableOwned.map(ref) },
      }],
    });
  }

  const dimensionOwned = take(sourceProjection.dimensionGroups.flatMap((group) => [
    group.nameUnitId,
    ...(group.purposeUnitId === undefined ? [] : [group.purposeUnitId]),
    ...group.fieldUnitIds,
  ]));
  const dimensionOwnedIds = new Set(dimensionOwned.map(({ id }) => id));
  const dimensionRows = sourceProjection.dimensionGroups.flatMap((group) => {
    const name = byId.get(group.nameUnitId);
    if (!name || !dimensionOwnedIds.has(name.id)) return [];
    const purpose = group.purposeUnitId === undefined ? undefined : byId.get(group.purposeUnitId);
    const fields = group.fieldUnitIds
      .map((id) => byId.get(id))
      .filter((unit): unit is EditorialMaterialUnit => unit !== undefined && dimensionOwnedIds.has(unit.id));
    return [{
      groupId: group.groupId,
      name: ref(name),
      ...(purpose === undefined || !dimensionOwnedIds.has(purpose.id) ? {} : { purpose: ref(purpose) }),
      fields: fields.map(ref),
    }];
  });
  const methodOwned = take(sourceProjection.analysisMethodUnitIds);
  const frameworkComponents: EditorialPresentationComponentV1[] = [];
  if (dimensionRows.length > 0) {
    frameworkComponents.push({
      ...componentBase({
        id: 'showcase-dimensions', ownedUnits: dimensionOwned,
        sourceGroupIds: sourceProjection.dimensionGroups.map(({ groupId }) => groupId),
      }),
      kind: 'dimension-table', content: { rows: dimensionRows },
    });
  }
  if (methodOwned.length > 0) {
    frameworkComponents.push({
      ...componentBase({
        id: 'showcase-methods', ownedUnits: methodOwned,
        sourceGroupIds: unique(methodOwned.flatMap(({ groupId }) => groupId ? [groupId] : [])),
      }),
      kind: 'method-board', content: { items: methodOwned.map(ref) },
    });
  }
  if (frameworkComponents.length > 0) {
    sections.push({
      id: 'framework', role: 'strategy', title: '分析维度与方法',
      components: frameworkComponents,
    });
  }

  const journeyGroups = sourceProjection.journeyGroupIds
    .map((id) => groupById.get(id))
    .filter((group): group is EditorialSourceGroupV2 => group !== undefined);
  const journeyStageByGroupId = new Map(sourceProjection.journeyStages.map((stage) => [stage.groupId, stage]));
  const journeyOwned = take(sourceProjection.journeyStages.flatMap((stage) => [
    ...(groupById.get(stage.groupId)?.bodyUnitIds ?? []),
    ...(stage.durationUnitId === undefined ? [] : [stage.durationUnitId]),
    ...stage.outputUnitIds,
  ]));
  const journeyOwnedIds = new Set(journeyOwned.map(({ id }) => id));
  const stages = journeyGroups.flatMap((group) => {
    const stageProjection = journeyStageByGroupId.get(group.id);
    const label = firstUnit(group, byId);
    const duration = stageProjection?.durationUnitId === undefined ? undefined : byId.get(stageProjection.durationUnitId);
    const outputs = (stageProjection?.outputUnitIds ?? [])
      .map((id) => byId.get(id))
      .filter((unit): unit is EditorialMaterialUnit => unit !== undefined && journeyOwnedIds.has(unit.id));
    const items = group.bodyUnitIds.map((id) => byId.get(id)).filter((unit): unit is EditorialMaterialUnit => (
      unit !== undefined && journeyOwnedIds.has(unit.id) && unit.id !== label?.id
    ));
    return label && journeyOwnedIds.has(label.id)
      ? [{
          groupId: group.id,
          sequence: group.sequence!,
          label: ref(label),
          ...(duration === undefined || !journeyOwnedIds.has(duration.id) ? {} : { duration: ref(duration) }),
          items: items.map(ref),
          outputs: outputs.map(ref),
        }]
      : [];
  });
  const stageFlow: EditorialPresentationComponentV1 | null = stages.length === 0
    ? null
    : {
        ...componentBase({
          id: 'showcase-stage-flow', ownedUnits: journeyOwned,
          sourceGroupIds: journeyGroups.map(({ id }) => id),
          sourceRelationIds: input.sourcePacket.relations.filter(({ kind }) => kind === 'sequence').map(relationId),
        }),
        kind: 'stage-flow', content: { stages },
      };
  if (stageFlow) sections.push({ id: 'execution', role: 'execution', title: '研究如何推进', components: [stageFlow] });

  const relational = input.sourcePacket.relations.filter(({ kind }) => kind !== 'sequence' && kind !== 'contains');
  const relationGroupIds = unique(relational.flatMap(({ fromGroupId, toGroupId }) => [fromGroupId, toGroupId]));
  const relationOwnedCandidates = relational.flatMap((relation) => relation.sourceUnitIds.flatMap((id) => {
    const unit = byId.get(id);
    return unit && unit.requiredInBody && unit.groupId === relation.toGroupId && unit.role !== 'risk' && unit.role !== 'validation'
      ? [unit.id]
      : [];
  }));
  const relationOwned = take(unique(relationOwnedCandidates));
  const relationOwnedIds = new Set(relationOwned.map(({ id }) => id));
  const relationSources = unique(relational.flatMap(({ sourceUnitIds }) => sourceUnitIds))
    .map((id) => byId.get(id))
    .filter((unit): unit is EditorialMaterialUnit => unit !== undefined);
  const relationMap: EditorialPresentationComponentV1 | null = relational.length < 2 || relationOwned.length === 0
    ? null
    : {
        ...componentBase({
          id: 'showcase-relation-map', ownedUnits: relationOwned, sourceUnits: relationSources,
          sourceGroupIds: relationGroupIds, sourceRelationIds: relational.map(relationId),
        }),
        kind: 'relation-map',
        content: {
          nodes: relationGroupIds.flatMap((id) => {
            const group = groupById.get(id);
            const label = group ? firstUnit(group, byId) : undefined;
            if (!group || !label) return [];
            const items = group.bodyUnitIds
              .map((unitId) => byId.get(unitId))
              .filter((unit): unit is EditorialMaterialUnit => (
                unit !== undefined && relationOwnedIds.has(unit.id) && unit.id !== label.id
              ));
            return [{ groupId: id, label: ref(label), items: items.map(ref) }];
          }),
          edges: relational.map((relation) => ({
            relationId: relationId(relation),
            fromGroupId: relation.fromGroupId,
            toGroupId: relation.toGroupId,
            kind: relation.kind,
          })),
        },
      };
  if (relationMap) sections.push({ id: 'analysis', role: 'analysis', title: '结论如何相互支撑', components: [relationMap] });

  const recordGroupIds = new Set(sourceProjection.recordGroupIds);
  const recordCandidates = input.sourcePacket.groups.flatMap((group) => {
    if (!recordGroupIds.has(group.id)) return [];
    const availableIds = group.bodyUnitIds.filter((id) => !owned.has(id));
    if (availableIds.length === 0) return [];
    const titleUnit = firstUnit(group, byId);
    return [{ group, availableIds, titleUnit }];
  });
  if (recordCandidates.length >= 2) {
    const recordOwned = take(recordCandidates.flatMap(({ availableIds }) => availableIds));
    const recordOwnedIds = new Set(recordOwned.map(({ id }) => id));
    const records = recordCandidates.flatMap(({ group, availableIds, titleUnit }) => {
      const items = availableIds
        .map((id) => byId.get(id))
        .filter((unit): unit is EditorialMaterialUnit => (
          unit !== undefined && recordOwnedIds.has(unit.id) && unit.id !== titleUnit?.id
        ));
      const ownedTitle = titleUnit && recordOwnedIds.has(titleUnit.id) ? titleUnit : undefined;
      if (!ownedTitle && items.length === 0) return [];
      return [{
        groupId: group.id,
        ...(titleUnit === undefined ? {} : { title: ref(titleUnit) }),
        items: items.map(ref),
      }];
    });
    const recordSources = recordCandidates.flatMap(({ titleUnit }) => titleUnit ? [titleUnit] : []);
    sections.push({
      id: 'structured-records', role: 'strategy', title: '关键问题与内容结构',
      components: [{
        ...componentBase({
          id: 'showcase-record-grid', ownedUnits: recordOwned, sourceUnits: recordSources,
          sourceGroupIds: recordCandidates.map(({ group }) => group.id),
        }),
        kind: 'record-grid', content: { records },
      }],
    });
  }

  const validationGroupIds = new Set(sourceProjection.validationGroupIds);
  const validationOwned = take(bodyUnits.filter((unit) => unit.groupId !== undefined && validationGroupIds.has(unit.groupId)).map(({ id }) => id));
  if (validationOwned.length > 0) {
    sections.push({
      id: 'validation', role: 'validation', title: '验证闸门',
      components: [{
        ...componentBase({ id: 'showcase-validation', ownedUnits: validationOwned }),
        kind: 'validation-list', content: { items: validationOwned.map(ref) },
      }],
    });
  }

  const riskGroupIds = new Set(sourceProjection.riskGroupIds);
  const riskOwned = take(bodyUnits.filter((unit) => unit.groupId !== undefined && riskGroupIds.has(unit.groupId)).map(({ id }) => id));
  if (riskOwned.length > 0) {
    sections.push({
      id: 'risk', role: 'risk', title: '风险与待验证边界',
      components: [{
        ...componentBase({ id: 'showcase-risks', ownedUnits: riskOwned }),
        kind: 'risk-register', content: { items: riskOwned.map(ref) },
      }],
    });
  }

  const remaining = take(bodyUnits.map(({ id }) => id));
  if (remaining.length > 0) {
    const narrative: EditorialPresentationComponentV1 = {
      ...componentBase({ id: 'showcase-complete-analysis', ownedUnits: remaining }),
      kind: 'narrative-list', content: { items: remaining.map(ref) },
    };
    const index = Math.min(2, sections.length);
    sections.splice(index, 0, {
      id: 'complete-analysis', role: 'strategy', title: '完整分析与行动输入', components: [narrative],
    });
  }

  const auditUnits = material.units.filter(({ id, requiredInOutput }) => requiredInOutput && !owned.has(id));
  const appendix: EditorialPresentationComponentV1 = {
    ...componentBase({ id: 'showcase-appendix', ownedUnits: auditUnits }),
    kind: 'analysis-appendix', content: { items: auditUnits.map(ref) },
  };
  const sourceRegister: EditorialPresentationComponentV1 = {
    ...componentBase({ id: 'showcase-sources', ownedUnits: [], sourceUnits: material.units }),
    kind: 'source-register',
    content: {
      evidence: material.evidence.map(({ id, sourceUrl }) => ({
        id,
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
      })),
    },
  };
  sections.push({
    id: 'appendix', role: 'appendix', title: '完整分析与来源附件',
    components: [appendix, sourceRegister],
  });

  const requiredBodyUnitIds = bodyUnits.map(({ id }) => id);
  const requiredAuditUnitIds = auditUnits.map(({ id }) => id);
  const observedBody = sections
    .filter(({ role }) => role !== 'appendix')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const expectedMainUnitIds = [...requiredBodyUnitIds, ...promotedSupportingUnitIds];
  const observedAudit = appendix.ownedUnitIds;
  if (
    observedBody.length !== new Set(observedBody).size
    || observedAudit.length !== new Set(observedAudit).size
    || canonicalJsonBytes([...observedBody].sort()).compare(canonicalJsonBytes([...expectedMainUnitIds].sort())) !== 0
    || canonicalJsonBytes([...observedAudit].sort()).compare(canonicalJsonBytes([...requiredAuditUnitIds].sort())) !== 0
  ) {
    const missingBody = expectedMainUnitIds.filter((id) => !observedBody.includes(id));
    const unexpectedBody = observedBody.filter((id) => !expectedMainUnitIds.includes(id));
    const missingAudit = requiredAuditUnitIds.filter((id) => !observedAudit.includes(id));
    fail(
      'SHOWCASE_COMPILATION_FAILED',
      `ownership mismatch; missing body=${missingBody.join(',') || 'none'}; unexpected body=${unexpectedBody.join(',') || 'none'}; missing audit=${missingAudit.join(',') || 'none'}`,
    );
  }

  const materialHash = hashBytes(canonicalJsonBytes(material));
  const sourcePacketHash = hashBytes(canonicalJsonBytes(input.sourcePacket));
  const spec: EditorialPresentationSpecV1 = {
    version: 'universal-editorial-presentation-spec-v1',
    binding: {
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      sourceReportPackageId: material.sourceReportPackage.artifactId,
      sourceReportPackageHash: material.sourceReportPackage.contentSha256,
      materialHash,
      sourcePacketHash,
    },
    profileId: 'universal-editorial-showcase-v1',
    generationMode: 'deterministic_showcase',
    ...(material.titleUnitId === undefined ? {} : { titleUnitId: material.titleUnitId }),
    sections,
    requiredBodyUnitIds,
    promotedSupportingUnitIds,
    requiredAuditUnitIds,
    evidenceIds: material.evidence.map(({ id }) => id),
    notices: ['Showcase 为已审材料的派生呈现，不替代原报告。'],
  };
  const bytes = canonicalJsonBytes(spec);
  return { spec, bytes, hash: hashBytes(bytes) };
}
