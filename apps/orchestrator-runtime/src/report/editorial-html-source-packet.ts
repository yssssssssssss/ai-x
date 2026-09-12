import {
  EDITORIAL_MAX_MODEL_CONTEXT_BYTES,
  canonicalJsonBytes,
  hashBytes,
  parseEditorialMaterial,
  type EditorialMaterial,
  type EditorialMaterialAsset,
  type EditorialMaterialUnit,
  type Sha256,
} from './editorial-report-contract.ts';
import type {
  EditorialPresentationBriefV1,
  EditorialPresentationKindV1,
} from './editorial-presentation-brief.ts';

export const EDITORIAL_HTML_SOURCE_PACKET_VERSION = 'editorial-html-source-packet-v2' as const;

export type EditorialSourceGroupRoleV2 =
  | 'decision'
  | 'answer'
  | 'finding'
  | 'journey'
  | 'strategy'
  | 'action'
  | 'validation'
  | 'risk'
  | 'audit';

export interface EditorialSourceUnitV2 {
  id: string;
  value: string | number | boolean;
  role: EditorialMaterialUnit['role'];
  epistemicStatus?: 'fact' | 'inference' | 'unknown';
  metricEligible: boolean;
  unit?: string;
  groupId?: string;
  sourceJsonPointer: string;
  basisUnitIds: string[];
  evidenceIds: string[];
  questionIds: string[];
  requiredInBody: boolean;
  requiredInOutput: boolean;
}

export interface EditorialSourceGroupV2 {
  id: string;
  role: EditorialSourceGroupRoleV2;
  titleUnitIds: string[];
  bodyUnitIds: string[];
  supportingUnitIds: string[];
  questionIds: string[];
  evidenceIds: string[];
  sequence?: number;
  priority?: 'P0' | 'P1' | 'P2';
  eligiblePresentations: EditorialPresentationKindV1[];
}

export interface EditorialSourceRelationV2 {
  fromGroupId: string;
  toGroupId: string;
  kind: 'sequence' | 'supports' | 'contrasts' | 'depends_on' | 'validates' | 'contains';
  sourceUnitIds: string[];
}

export interface EditorialVisualizationCandidateV2 {
  id: string;
  kind: EditorialPresentationKindV1;
  sourceGroupIds: string[];
  sourceUnitIds: string[];
  eligibilityReason: string;
  required: boolean;
}

export interface EditorialHtmlSourcePacketV2 {
  version: typeof EDITORIAL_HTML_SOURCE_PACKET_VERSION;
  binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    sourceReportPackageId: string;
    sourceReportPackageHash: Sha256;
    materialHash: Sha256;
  };
  report: {
    deliverableType: EditorialMaterial['deliverableType'];
    titleUnitId?: string;
    methodSummaryUnitId: string;
    requiredQuestionIds: string[];
    requestedDeliverables: string[];
  };
  groups: EditorialSourceGroupV2[];
  units: EditorialSourceUnitV2[];
  relations: EditorialSourceRelationV2[];
  visualizationCandidates: EditorialVisualizationCandidateV2[];
  evidence: Array<{ id: string; sourceUrl?: string }>;
  assets: Array<{
    id: string;
    visualRole: EditorialMaterialAsset['visualRole'];
    width: number;
    height: number;
    captionUnitId: string;
    altTextUnitId: string;
    evidenceIds: string[];
  }>;
  deterministicAuditUnitIds: string[];
  presentationBrief: EditorialPresentationBriefV1;
}

export interface EditorialHtmlSourcePacketResult {
  packet: EditorialHtmlSourcePacketV2;
  bytes: Buffer;
  hash: Sha256;
  byteSize: number;
}

export class EditorialHtmlSourcePacketError extends Error {
  readonly name = 'EditorialHtmlSourcePacketError';

  constructor(readonly code: 'EDITORIAL_HTML_SOURCE_PACKET_BUDGET_EXCEEDED') {
    super(code);
  }
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function pointer(unit: EditorialMaterialUnit): string {
  return unit.sourceRefs[0].jsonPointer;
}

function groupId(unit: EditorialMaterialUnit): string {
  return unit.groupId ?? `unit:${unit.id}`;
}

function groupRole(id: string, units: readonly EditorialMaterialUnit[]): EditorialSourceGroupRoleV2 {
  if (units.every(({ requiredInBody }) => !requiredInBody)) return 'audit';
  if (/^research-phase:\d+$/u.test(id)) return 'journey';
  if (id === 'research-plan' || id === 'strategy-report' || id === 'report-title' || id.startsWith('conclusion:')) return 'decision';
  if (id.startsWith('strategy-answer:')) return 'answer';
  if (units.some(({ role }) => role === 'risk')) return 'risk';
  if (units.some(({ role }) => role === 'validation')) return 'validation';
  if (units.some(({ role }) => role === 'recommendation')) return 'action';
  if (units.some(({ questionIds }) => questionIds.length > 0)) return 'answer';
  if (units.some(({ role }) => role === 'claim')) return 'finding';
  if (id.startsWith('analysis:') || id.startsWith('summary:')) return 'strategy';
  return 'strategy';
}

function titleUnitIds(units: readonly EditorialMaterialUnit[]): string[] {
  const explicit = units.filter((unit) => (
    /\/(?:title|phase|name|label|dimension|priority|field)$/u.test(pointer(unit))
    && typeof unit.value === 'string'
  ));
  if (explicit.length > 0) return [explicit[0]!.id];
  const context = units.find((unit) => unit.role === 'context' && typeof unit.value === 'string');
  return context ? [context.id] : [];
}

function phaseSequence(id: string): number | undefined {
  const match = /^research-phase:(\d+)$/u.exec(id);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function priority(units: readonly EditorialMaterialUnit[]): 'P0' | 'P1' | 'P2' | undefined {
  const candidate = units.find((unit) => /\/priority$/u.test(pointer(unit)));
  return candidate?.value === 'P0' || candidate?.value === 'P1' || candidate?.value === 'P2'
    ? candidate.value
    : undefined;
}

function orderedGroupEntries(material: EditorialMaterial): Array<[string, EditorialMaterialUnit[]]> {
  const groups = new Map<string, EditorialMaterialUnit[]>();
  for (const unit of material.units) {
    const id = groupId(unit);
    const group = groups.get(id) ?? [];
    group.push(unit);
    groups.set(id, group);
  }
  return [...groups.entries()];
}

function addRelation(
  target: Map<string, EditorialSourceRelationV2>,
  relation: EditorialSourceRelationV2,
): void {
  const key = `${relation.kind}\u0000${relation.fromGroupId}\u0000${relation.toGroupId}`;
  const current = target.get(key);
  if (current) {
    current.sourceUnitIds = unique([...current.sourceUnitIds, ...relation.sourceUnitIds]);
  } else {
    target.set(key, { ...relation, sourceUnitIds: unique(relation.sourceUnitIds) });
  }
}

function sourceIds(groups: readonly EditorialSourceGroupV2[]): string[] {
  return unique(groups.flatMap(({ bodyUnitIds }) => bodyUnitIds));
}

function candidate(input: {
  kind: EditorialPresentationKindV1;
  groups: readonly EditorialSourceGroupV2[];
  reason: string;
  required?: boolean;
}): EditorialVisualizationCandidateV2 {
  return {
    id: `presentation:${input.kind}`,
    kind: input.kind,
    sourceGroupIds: input.groups.map(({ id }) => id),
    sourceUnitIds: sourceIds(input.groups),
    eligibilityReason: input.reason,
    required: input.required ?? false,
  };
}

function deriveCandidates(
  material: EditorialMaterial,
  groups: readonly EditorialSourceGroupV2[],
  relations: readonly EditorialSourceRelationV2[],
): EditorialVisualizationCandidateV2[] {
  const result: EditorialVisualizationCandidateV2[] = [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const unitsById = new Map(material.units.map((unit) => [unit.id, unit]));
  const bodyGroups = groups.filter(({ bodyUnitIds }) => bodyUnitIds.length > 0);
  const metricGroups = groups.filter((group) => group.bodyUnitIds.some((id) => {
    const unit = unitsById.get(id);
    if (!unit?.metricEligible || typeof unit.value !== 'number') return false;
    return material.units.some((label) => (
      typeof label.value === 'string'
      && (label.groupId === unit.groupId || unit.basisUnitIds.includes(label.id))
    ));
  }));
  if (metricGroups.length > 0) result.push(candidate({
    kind: 'metric-cards', groups: metricGroups, reason: 'numeric units have explicit labels and units',
  }));

  const statuses = new Set(material.units
    .filter(({ requiredInBody }) => requiredInBody)
    .flatMap((unit) => 'epistemicStatus' in unit && unit.epistemicStatus ? [unit.epistemicStatus] : []));
  if (statuses.size >= 2) result.push(candidate({
    kind: 'truth-triad',
    groups: bodyGroups.filter((group) => group.bodyUnitIds.some((id) => {
      const unit = unitsById.get(id);
      return unit !== undefined && 'epistemicStatus' in unit && unit.epistemicStatus !== undefined;
    })),
    reason: 'at least two explicit epistemic states are present',
  }));

  const roleBuckets = new Map<EditorialSourceGroupRoleV2, EditorialSourceGroupV2[]>();
  for (const group of bodyGroups) {
    const bucket = roleBuckets.get(group.role) ?? [];
    bucket.push(group);
    roleBuckets.set(group.role, bucket);
  }
  const cardGroups = [...roleBuckets.values()]
    .filter((bucket) => bucket.length >= 2)
    .flatMap((bucket) => bucket)
    .filter(({ role }) => role !== 'journey' && role !== 'audit');
  if (cardGroups.length >= 2) result.push(candidate({
    kind: 'card-grid', groups: cardGroups, reason: 'multiple same-role source groups have stable titles and body units',
  }));

  const journeyGroups = groups
    .filter(({ id, sequence, bodyUnitIds }) => /^research-phase:\d+$/u.test(id) && sequence !== undefined && bodyUnitIds.length >= 2)
    .sort((left, right) => left.sequence! - right.sequence!);
  if (journeyGroups.length >= 2) {
    result.push(candidate({ kind: 'journey-flow', groups: journeyGroups, reason: 'explicit ordered research phases are present' }));
    result.push(candidate({ kind: 'roadmap', groups: journeyGroups, reason: 'research phases contain explicit activities' }));
  }

  const riskGroups = groups.filter(({ role, bodyUnitIds }) => role === 'risk' && bodyUnitIds.length > 0);
  if (riskGroups.length > 0) result.push(candidate({
    kind: 'risk-register', groups: riskGroups, reason: 'required risk units are present', required: true,
  }));

  const validationGroups = groups.filter(({ role, bodyUnitIds }) => role === 'validation' && bodyUnitIds.length > 0);
  const validationUnitCount = validationGroups.reduce((count, group) => count + group.bodyUnitIds.length, 0);
  if (validationUnitCount >= 2 || validationGroups.some(({ bodyUnitIds }) => bodyUnitIds.length >= 2)) result.push(candidate({
    kind: 'validation-gates', groups: validationGroups, reason: 'multiple explicit validation checks or a complete validation group are present',
  }));

  const relatedGroupIds = unique(relations
    .filter(({ kind }) => kind === 'supports' || kind === 'depends_on' || kind === 'contrasts')
    .flatMap(({ fromGroupId, toGroupId }) => [fromGroupId, toGroupId]));
  if (relations.filter(({ kind }) => kind === 'supports' || kind === 'depends_on' || kind === 'contrasts').length >= 2) {
    result.push(candidate({
      kind: 'mind-model',
      groups: relatedGroupIds.flatMap((id) => byId.get(id) ?? []),
      reason: 'multiple explicit cross-group basis relations are present',
    }));
  }

  return result;
}

function groupEligiblePresentations(
  group: EditorialSourceGroupV2,
  candidates: readonly EditorialVisualizationCandidateV2[],
): EditorialPresentationKindV1[] {
  return unique(candidates
    .filter(({ sourceGroupIds }) => sourceGroupIds.includes(group.id))
    .map(({ kind }) => kind));
}

export function buildEditorialHtmlSourcePacket(input: {
  material: EditorialMaterial;
  presentationBrief: EditorialPresentationBriefV1;
}): EditorialHtmlSourcePacketResult {
  const material = parseEditorialMaterial(input.material);
  const materialBytes = canonicalJsonBytes(material);
  const entries = orderedGroupEntries(material);
  const unitGroup = new Map(material.units.map((unit) => [unit.id, groupId(unit)]));
  const relationMap = new Map<string, EditorialSourceRelationV2>();

  for (const unit of material.units) {
    const toGroupId = groupId(unit);
    for (const basisId of unit.basisUnitIds) {
      const fromGroupId = unitGroup.get(basisId);
      if (!fromGroupId || fromGroupId === toGroupId) continue;
      addRelation(relationMap, {
        fromGroupId,
        toGroupId,
        kind: unit.role === 'validation' ? 'validates' : 'supports',
        sourceUnitIds: [basisId, unit.id],
      });
    }
  }

  const phases = entries
    .map(([id, units]) => ({ id, units, sequence: phaseSequence(id) }))
    .filter((entry): entry is { id: string; units: EditorialMaterialUnit[]; sequence: number } => entry.sequence !== undefined)
    .sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < phases.length; index += 1) {
    const previous = phases[index - 1]!;
    const current = phases[index]!;
    addRelation(relationMap, {
      fromGroupId: previous.id,
      toGroupId: current.id,
      kind: 'sequence',
      sourceUnitIds: unique([...previous.units, ...current.units].map(({ id }) => id)),
    });
  }

  const baseGroups: EditorialSourceGroupV2[] = entries.map(([id, units]) => {
    const sequence = phaseSequence(id);
    const groupPriority = priority(units);
    return {
      id,
      role: groupRole(id, units),
      titleUnitIds: titleUnitIds(units),
      bodyUnitIds: units.filter(({ requiredInBody }) => requiredInBody).map(({ id }) => id),
      supportingUnitIds: units.filter(({ requiredInBody }) => !requiredInBody).map(({ id }) => id),
      questionIds: unique(units.flatMap(({ questionIds }) => questionIds)).sort(),
      evidenceIds: unique(units.flatMap(({ evidenceIds }) => evidenceIds)).sort(),
      ...(sequence === undefined ? {} : { sequence }),
      ...(groupPriority === undefined ? {} : { priority: groupPriority }),
      eligiblePresentations: [],
    };
  });
  const relations = [...relationMap.values()];
  const visualizationCandidates = deriveCandidates(material, baseGroups, relations);
  const groups = baseGroups.map((group) => ({
    ...group,
    eligiblePresentations: groupEligiblePresentations(group, visualizationCandidates),
  }));
  const packet: EditorialHtmlSourcePacketV2 = {
    version: EDITORIAL_HTML_SOURCE_PACKET_VERSION,
    binding: {
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      sourceReportPackageId: material.sourceReportPackage.artifactId,
      sourceReportPackageHash: material.sourceReportPackage.contentSha256,
      materialHash: hashBytes(materialBytes),
    },
    report: {
      deliverableType: material.deliverableType,
      ...(material.titleUnitId === undefined ? {} : { titleUnitId: material.titleUnitId }),
      methodSummaryUnitId: material.methodSummaryUnitId,
      requiredQuestionIds: unique(material.units.filter(({ requiredInBody }) => requiredInBody).flatMap(({ questionIds }) => questionIds)).sort(),
      requestedDeliverables: material.units
        .filter((unit) => /^\/payload\/deliverables\/\d+$/u.test(pointer(unit)))
        .map(({ value }) => String(value)),
    },
    groups,
    units: material.units.map((unit) => ({
      id: unit.id,
      value: unit.value,
      role: unit.role,
      ...('epistemicStatus' in unit && unit.epistemicStatus !== undefined ? { epistemicStatus: unit.epistemicStatus } : {}),
      metricEligible: unit.metricEligible,
      ...(unit.unit === undefined ? {} : { unit: unit.unit }),
      ...(unit.groupId === undefined ? {} : { groupId: unit.groupId }),
      sourceJsonPointer: pointer(unit),
      basisUnitIds: [...unit.basisUnitIds],
      evidenceIds: [...unit.evidenceIds],
      questionIds: [...unit.questionIds],
      requiredInBody: unit.requiredInBody,
      requiredInOutput: unit.requiredInOutput,
    })),
    relations,
    visualizationCandidates,
    evidence: material.evidence.map((entry) => ({
      id: entry.id,
      ...(entry.sourceUrl === undefined ? {} : { sourceUrl: entry.sourceUrl }),
    })),
    assets: material.assets.map((asset) => ({
      id: asset.id,
      visualRole: asset.visualRole,
      width: asset.width,
      height: asset.height,
      captionUnitId: asset.captionUnitId,
      altTextUnitId: asset.altTextUnitId,
      evidenceIds: [...asset.evidenceIds],
    })),
    deterministicAuditUnitIds: material.units
      .filter(({ requiredInOutput, requiredInBody }) => requiredInOutput && !requiredInBody)
      .map(({ id }) => id),
    presentationBrief: input.presentationBrief,
  };
  const bytes = canonicalJsonBytes(packet);
  if (bytes.byteLength > EDITORIAL_MAX_MODEL_CONTEXT_BYTES) {
    throw new EditorialHtmlSourcePacketError('EDITORIAL_HTML_SOURCE_PACKET_BUDGET_EXCEEDED');
  }
  return { packet, bytes, hash: hashBytes(bytes), byteSize: bytes.byteLength };
}
