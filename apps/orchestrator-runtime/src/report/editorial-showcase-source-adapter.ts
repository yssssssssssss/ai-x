import { parseEditorialMaterial, type EditorialMaterial } from './editorial-report-contract.ts';
import type { EditorialHtmlSourcePacketV2 } from './editorial-html-source-packet.ts';

export interface EditorialShowcaseSourceProjectionV1 {
  version: 'editorial-showcase-source-projection-v1';
  deliverableType: EditorialMaterial['deliverableType'];
  heroGroupIds: string[];
  questionAnchors: Array<{ questionId: string; groupId: string }>;
  journeyGroupIds: string[];
  journeyStages: Array<{
    groupId: string;
    sequence: number;
    durationUnitId?: string;
    outputUnitIds: string[];
  }>;
  recordGroupIds: string[];
  validationGroupIds: string[];
  riskGroupIds: string[];
  scopeUnitIds: string[];
  scopeFields: Array<{ unitId: string; label: string }>;
  deliverableUnitIds: string[];
  analysisMethodUnitIds: string[];
  dimensionGroups: Array<{
    groupId: string;
    nameUnitId: string;
    purposeUnitId?: string;
    fieldUnitIds: string[];
  }>;
  strategyMatrixGroups: Array<{
    groupId: string;
    titleUnitId: string;
    rowUnitIds: string[];
    columnUnitIds: string[];
    cellUnitIds: string[];
  }>;
  priorityActionGroups: Array<{
    groupId: string;
    titleUnitId: string;
    priority: 'P0' | 'P1' | 'P2';
    itemUnitIds: string[];
  }>;
}

export class EditorialShowcaseSourceAdapterError extends Error {
  readonly name = 'EditorialShowcaseSourceAdapterError';
  constructor(readonly code: 'SHOWCASE_SOURCE_BINDING_INVALID') {
    super(code);
  }
}

export function projectEditorialShowcaseSource(input: {
  material: EditorialMaterial;
  sourcePacket: EditorialHtmlSourcePacketV2;
}): EditorialShowcaseSourceProjectionV1 {
  const material = parseEditorialMaterial(input.material);
  if (
    input.sourcePacket.version !== 'editorial-html-source-packet-v2'
    || input.sourcePacket.binding.taskId !== material.taskId
    || input.sourcePacket.binding.planVersionId !== material.planVersionId
    || input.sourcePacket.binding.attemptId !== material.attemptId
    || input.sourcePacket.binding.sourceReportPackageId !== material.sourceReportPackage.artifactId
    || input.sourcePacket.binding.sourceReportPackageHash !== material.sourceReportPackage.contentSha256
  ) throw new EditorialShowcaseSourceAdapterError('SHOWCASE_SOURCE_BINDING_INVALID');

  const groups = input.sourcePacket.groups;
  const indexedQuestionGroups = groups
    .filter(({ id }) => /^research-question:\d+$/u.test(id))
    .sort((left, right) => Number(left.id.split(':')[1]) - Number(right.id.split(':')[1]));
  const questionAnchors = input.sourcePacket.report.requiredQuestionIds.flatMap((questionId, index) => {
    const group = groups.find(({ id, questionIds, bodyUnitIds }) => (
      id.startsWith('strategy-answer:') && bodyUnitIds.length > 0 && questionIds.includes(questionId)
    )) ?? indexedQuestionGroups[index] ?? groups.find(({ role, questionIds, bodyUnitIds }) => (
      role === 'answer' && bodyUnitIds.length > 0 && questionIds.includes(questionId)
    ));
    return group ? [{ questionId, groupId: group.id }] : [];
  });
  const journeyGroups = groups
    .filter(({ role, sequence }) => role === 'journey' && sequence !== undefined)
    .sort((left, right) => left.sequence! - right.sequence!);
  const journeyGroupIds = journeyGroups.map(({ id }) => id);
  const journeyStages = journeyGroups.map((group) => {
    const units = input.sourcePacket.units.filter(({ groupId }) => groupId === group.id);
    const duration = units.find(({ sourceJsonPointer }) => /\/duration$/u.test(sourceJsonPointer));
    const outputUnitIds = units
      .filter(({ sourceJsonPointer }) => /\/outputs\/\d+$/u.test(sourceJsonPointer))
      .map(({ id }) => id);
    return {
      groupId: group.id,
      sequence: group.sequence!,
      ...(duration === undefined ? {} : { durationUnitId: duration.id }),
      outputUnitIds,
    };
  });
  const recordRoles = new Set(['answer', 'finding', 'strategy', 'action', 'decision']);
  const scopeUnits = input.sourcePacket.units.filter(({ requiredInBody, sourceJsonPointer }) => (
    requiredInBody && /^\/payload\/scope\//u.test(sourceJsonPointer)
  ));
  const scopeFields = scopeUnits.map((unit, index) => {
    const pointer = unit.sourceJsonPointer;
    const label = pointer === '/payload/scope/market'
      ? '地域与市场'
      : pointer === '/payload/scope/timeWindow'
        ? '时间范围'
        : /^\/payload\/scope\/subjects\/\d+$/u.test(pointer)
          ? `研究对象 ${index}`
          : `范围项 ${index + 1}`;
    return { unitId: unit.id, label };
  });
  const deliverableUnitIds = input.sourcePacket.units
    .filter(({ requiredInBody, sourceJsonPointer }) => (
      requiredInBody && /^\/payload\/deliverables\/\d+$/u.test(sourceJsonPointer)
    ))
    .map(({ id }) => id);
  const analysisMethodUnitIds = input.sourcePacket.units
    .filter(({ sourceJsonPointer }) => /^\/payload\/analysisMethods\/\d+$/u.test(sourceJsonPointer))
    .map(({ id }) => id);
  const dimensionGroups = groups
    .filter(({ id }) => id.startsWith('research-dimension:'))
    .flatMap((group) => {
      const units = input.sourcePacket.units.filter(({ groupId }) => groupId === group.id);
      const name = units.find(({ sourceJsonPointer }) => /\/name$/u.test(sourceJsonPointer));
      if (!name) return [];
      const purpose = units.find(({ sourceJsonPointer }) => /\/purpose$/u.test(sourceJsonPointer));
      const fieldUnitIds = units
        .filter(({ sourceJsonPointer }) => /\/collectionFields\/\d+$/u.test(sourceJsonPointer))
        .map(({ id }) => id);
      return [{
        groupId: group.id,
        nameUnitId: name.id,
        ...(purpose === undefined ? {} : { purposeUnitId: purpose.id }),
        fieldUnitIds,
      }];
    });
  const strategyMatrixGroups = groups
    .filter(({ id }) => /^strategy-content:(?:comparison_matrix|strategy_map):/u.test(id))
    .flatMap((group) => {
      const units = input.sourcePacket.units.filter(({ groupId }) => groupId === group.id);
      const title = units.find(({ sourceJsonPointer }) => /\/title$/u.test(sourceJsonPointer));
      if (!title) return [];
      return [{
        groupId: group.id,
        titleUnitId: title.id,
        rowUnitIds: units.filter(({ sourceJsonPointer }) => /\/rows\/\d+$/u.test(sourceJsonPointer)).map(({ id }) => id),
        columnUnitIds: units.filter(({ sourceJsonPointer }) => /\/columns\/\d+$/u.test(sourceJsonPointer)).map(({ id }) => id),
        cellUnitIds: units.filter(({ sourceJsonPointer }) => /\/cells\/\d+\/statement$/u.test(sourceJsonPointer)).map(({ id }) => id),
      }];
    });
  const priorityActionGroups = groups
    .filter(({ id }) => /^strategy-content:(?:prioritized_actions|action_plan):/u.test(id))
    .flatMap((group) => {
      const units = input.sourcePacket.units.filter(({ groupId }) => groupId === group.id);
      const title = units.find(({ sourceJsonPointer }) => /\/title$/u.test(sourceJsonPointer));
      const priorities = units.filter(({ sourceJsonPointer, value }) => (
        /\/priority$/u.test(sourceJsonPointer) && (value === 'P0' || value === 'P1' || value === 'P2')
      ));
      if (!title || priorities.length === 0) return [];
      return priorities.map((priority) => {
        const itemPrefix = priority.sourceJsonPointer.slice(0, -'/priority'.length);
        return {
          groupId: group.id,
          titleUnitId: title.id,
          priority: priority.value as 'P0' | 'P1' | 'P2',
          itemUnitIds: units
            .filter(({ sourceJsonPointer }) => sourceJsonPointer.startsWith(`${itemPrefix}/`))
            .map(({ id }) => id),
        };
      });
    });
  return {
    version: 'editorial-showcase-source-projection-v1',
    deliverableType: material.deliverableType,
    heroGroupIds: groups
      .filter(({ role, bodyUnitIds }) => role === 'decision' && bodyUnitIds.length > 0)
      .map(({ id }) => id),
    questionAnchors,
    journeyGroupIds,
    journeyStages,
    recordGroupIds: groups.filter(({ role, bodyUnitIds }) => recordRoles.has(role) && bodyUnitIds.length > 0).map(({ id }) => id),
    validationGroupIds: groups.filter(({ role, bodyUnitIds }) => role === 'validation' && bodyUnitIds.length > 0).map(({ id }) => id),
    riskGroupIds: groups.filter(({ role, bodyUnitIds }) => role === 'risk' && bodyUnitIds.length > 0).map(({ id }) => id),
    scopeUnitIds: scopeUnits.map(({ id }) => id),
    scopeFields,
    deliverableUnitIds,
    analysisMethodUnitIds,
    dimensionGroups,
    strategyMatrixGroups,
    priorityActionGroups,
  };
}
