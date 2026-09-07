import {
  EDITORIAL_MAX_MODEL_CONTEXT_BYTES,
  canonicalJsonBytes,
  canonicalSha256,
  editorialScalarText,
  hashBytes,
  parseEditorialMaterial,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type EditorialTaskContext,
  type Sha256,
} from './editorial-report-contract.ts';

export const EDITORIAL_SUMMARY_SOURCE_VERSION = 'editorial-summary-source-v1' as const;

export interface EditorialSummaryAtomV1 {
  id: string;
  text: string;
  roles: EditorialMaterialUnit['role'][];
  epistemicStatus?: 'fact' | 'inference' | 'unknown';
  sourceUnitIds: string[];
  groupIds: string[];
  questionIds: string[];
  evidenceIds: string[];
  requiredInBody: boolean;
}

export interface EditorialSummarySourceGroupV1 {
  id: string;
  sourceUnitIds: string[];
  questionIds: string[];
  evidenceIds: string[];
  priority?: 'P0' | 'P1' | 'P2';
}

export interface EditorialSummarySourceV1 {
  version: typeof EDITORIAL_SUMMARY_SOURCE_VERSION;
  binding: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    sourceReportPackageId: string;
    sourceReportPackageHash: Sha256;
  };
  report: {
    deliverableType: EditorialMaterial['deliverableType'];
    language: 'zh-CN' | 'en';
    title?: string;
    methodSummary: string;
    requiredQuestionIds: string[];
  };
  requirement?: EditorialTaskContext;
  sourceUnitCount: number;
  atoms: EditorialSummaryAtomV1[];
  groups: EditorialSummarySourceGroupV1[];
  requiredCoverage: {
    requestedArtifactGroupIds: string[];
    priorityZeroGroupIds: string[];
    riskSourceUnitIds: string[];
    simulationSourceUnitIds: string[];
  };
  evidence: Array<{
    id: string;
    evidenceClass: string;
    kind: string;
    sourceUrl?: string;
  }>;
  detailAnchors: Array<{ id: string; sourceUnitIds: string[] }>;
  review: {
    verdict: 'pass';
    dimensions?: unknown[];
    revisionRound?: number;
  };
}

export interface EditorialSummarySourceResult {
  source: EditorialSummarySourceV1;
  bytes: Buffer;
  hash: Sha256;
}

export class EditorialSummarySourceError extends Error {
  readonly name = 'EditorialSummarySourceError';
  constructor(readonly code: 'SUMMARY_SOURCE_BUDGET_EXCEEDED') { super(code); }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function epistemicStatus(unit: EditorialMaterialUnit): 'fact' | 'inference' | 'unknown' | undefined {
  return 'epistemicStatus' in unit ? unit.epistemicStatus : undefined;
}

function isRequestedArtifact(unit: EditorialMaterialUnit): boolean {
  const pointer = unit.sourceRefs[0].jsonPointer;
  const groupId = unit.groupId ?? '';
  return /\/(?:deliverables|requestedArtifacts|contentBlocks)\//u.test(pointer)
    || /(?:^|[-:])requested-artifact(?:[-:]|$)/u.test(groupId)
    || groupId.startsWith('strategy-content:');
}

function requestedArtifactGroupIds(material: EditorialMaterial): string[] {
  const contentGroups = unique(material.units
    .filter((unit) => (
      /\/contentBlocks\//u.test(unit.sourceRefs[0].jsonPointer)
      || unit.groupId?.startsWith('strategy-content:') === true
    ))
    .map((unit) => unit.groupId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0));
  if (contentGroups.length > 0) return contentGroups;
  return unique(material.units
    .filter(isRequestedArtifact)
    .map((unit) => unit.groupId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function sourceGroups(material: EditorialMaterial): EditorialSummarySourceGroupV1[] {
  const groups = new Map<string, EditorialMaterialUnit[]>();
  for (const unit of material.units) {
    const id = unit.groupId ?? `unit:${unit.id}`;
    const values = groups.get(id) ?? [];
    values.push(unit);
    groups.set(id, values);
  }
  return [...groups].map(([id, units]) => {
    const priorityUnit = units.find(({ value, sourceRefs }) => (
      (value === 'P0' || value === 'P1' || value === 'P2')
      && /\/priority$/u.test(sourceRefs[0].jsonPointer)
    ));
    const priority = priorityUnit?.value === 'P0'
      || priorityUnit?.value === 'P1'
      || priorityUnit?.value === 'P2'
      ? priorityUnit.value
      : undefined;
    return {
      id,
      sourceUnitIds: units.map(({ id: unitId }) => unitId),
      questionIds: unique(units.flatMap(({ questionIds }) => questionIds)),
      evidenceIds: unique(units.flatMap(({ evidenceIds }) => evidenceIds)),
      ...(priority === undefined ? {} : { priority }),
    };
  });
}

function sourceAtoms(material: EditorialMaterial): EditorialSummaryAtomV1[] {
  const atoms = new Map<string, EditorialSummaryAtomV1>();
  for (const unit of material.units) {
    const text = editorialScalarText(unit.value);
    const status = epistemicStatus(unit);
    const signature = canonicalSha256({ text, role: unit.role, status: status ?? null });
    const current = atoms.get(signature);
    if (current) {
      current.sourceUnitIds.push(unit.id);
      if (unit.groupId && !current.groupIds.includes(unit.groupId)) current.groupIds.push(unit.groupId);
      current.questionIds = unique([...current.questionIds, ...unit.questionIds]);
      current.evidenceIds = unique([...current.evidenceIds, ...unit.evidenceIds]);
      current.requiredInBody ||= unit.requiredInBody;
      if (!current.roles.includes(unit.role)) current.roles.push(unit.role);
      continue;
    }
    atoms.set(signature, {
      id: `esa_${signature.slice('sha256:'.length)}`,
      text,
      roles: [unit.role],
      ...(status === undefined ? {} : { epistemicStatus: status }),
      sourceUnitIds: [unit.id],
      groupIds: unit.groupId ? [unit.groupId] : [],
      questionIds: [...unit.questionIds],
      evidenceIds: [...unit.evidenceIds],
      requiredInBody: unit.requiredInBody,
    });
  }
  return [...atoms.values()];
}

export function buildEditorialSummarySource(input: {
  material: EditorialMaterial;
  reportReview: unknown;
  taskContext?: EditorialTaskContext;
}): EditorialSummarySourceResult {
  const material = parseEditorialMaterial(input.material);
  const review = input.reportReview !== null && typeof input.reportReview === 'object' && !Array.isArray(input.reportReview)
    ? input.reportReview as Record<string, unknown>
    : {};
  if (review.verdict !== 'pass') throw new Error('Editorial Summary requires a passed Final Review');
  const units = new Map(material.units.map((unit) => [unit.id, unit]));
  const titleUnit = material.titleUnitId ? units.get(material.titleUnitId) : undefined;
  const methodUnit = units.get(material.methodSummaryUnitId);
  if (!methodUnit) throw new Error('Editorial Summary source has no method summary');
  const title = titleUnit === undefined ? undefined : editorialScalarText(titleUnit.value);
  const methodSummary = editorialScalarText(methodUnit.value);
  const language = /\p{Script=Han}/u.test(`${input.taskContext?.researchGoal ?? ''}${title ?? ''}${methodSummary}`)
    ? 'zh-CN' as const
    : 'en' as const;
  const groups = sourceGroups(material);
  const simulationEvidenceIds = new Set(material.evidence
    .filter(({ evidenceClass }) => evidenceClass === 'simulation')
    .map(({ id }) => id));
  const source: EditorialSummarySourceV1 = {
    version: EDITORIAL_SUMMARY_SOURCE_VERSION,
    binding: {
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      sourceReportPackageId: material.sourceReportPackage.artifactId,
      sourceReportPackageHash: material.sourceReportPackage.contentSha256,
    },
    report: {
      deliverableType: material.deliverableType,
      language,
      ...(title === undefined ? {} : { title }),
      methodSummary,
      requiredQuestionIds: unique(material.units
        .filter(({ requiredInBody }) => requiredInBody)
        .flatMap(({ questionIds }) => questionIds)),
    },
    ...(input.taskContext === undefined ? {} : { requirement: structuredClone(input.taskContext) }),
    sourceUnitCount: material.units.length,
    atoms: sourceAtoms(material),
    groups,
    requiredCoverage: {
      requestedArtifactGroupIds: requestedArtifactGroupIds(material),
      priorityZeroGroupIds: groups.filter(({ priority }) => priority === 'P0').map(({ id }) => id),
      riskSourceUnitIds: material.units.filter(({ role }) => role === 'risk').map(({ id }) => id),
      simulationSourceUnitIds: material.units
        .filter(({ evidenceIds }) => evidenceIds.some((id) => simulationEvidenceIds.has(id)))
        .map(({ id }) => id),
    },
    evidence: material.evidence.map(({ id, evidenceClass, kind, sourceUrl }) => ({
      id,
      evidenceClass,
      kind,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    })),
    detailAnchors: groups.map(({ id, sourceUnitIds }) => ({ id, sourceUnitIds })),
    review: {
      verdict: 'pass',
      ...(Array.isArray(review.dimensions) ? { dimensions: structuredClone(review.dimensions) } : {}),
      ...(Number.isInteger(review.revisionRound) ? { revisionRound: review.revisionRound as number } : {}),
    },
  };
  const bytes = canonicalJsonBytes(source);
  if (bytes.byteLength > EDITORIAL_MAX_MODEL_CONTEXT_BYTES) {
    throw new EditorialSummarySourceError('SUMMARY_SOURCE_BUDGET_EXCEEDED');
  }
  return { source, bytes, hash: hashBytes(bytes) };
}
