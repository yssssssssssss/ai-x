import type {
  EvidenceEntry,
  ResearchDeliverableEnvelope,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ReportDocument } from './report-document-composer.ts';
import type { VerifiedVisualAsset } from './visual-asset-service.ts';
import {
  EDITORIAL_MATERIAL_VERSION,
  assertValidEditorialMaterial,
  canonicalJsonBytes,
  canonicalSha256,
  createEditorialVisualWarning,
  createEditorialMaterialUnitId,
  hashBytes,
  normalizeEditorialScalar,
  projectEditorialModelContext,
  type EditorialDiagnosticIssue,
  type EditorialEvidenceEntry,
  type EditorialMaterial,
  type EditorialMaterialAsset,
  type EditorialMaterializationWarningCode,
  type EditorialMaterialUnit,
  type EditorialMaterialUnitBase,
  type EditorialModelContext,
  type EditorialSourcePolicyMetadata,
  type EpistemicStatus,
  type FrozenEditorialSource,
  type Sha256,
  type SourceArtifactRef,
} from './editorial-report-contract.ts';

const MAX_IDENTIFIER_BYTES = 256;

export class EditorialMaterializationError extends Error {
  readonly name = 'EditorialMaterializationError';

  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export interface EditorialMaterializationResult {
  material: EditorialMaterial;
  materialBytes: Buffer;
  materialHash: Sha256;
  modelContext: EditorialModelContext;
  modelContextBytes: Buffer;
  modelContextHash: Sha256;
  modelContextByteSize: number;
  sourcePolicyMetadata: EditorialSourcePolicyMetadata[];
  warnings: EditorialDiagnosticIssue[];
}

type UnitRole = EditorialMaterialUnit['role'];

interface AddUnitInput {
  pointer: string;
  value: string | number | boolean;
  role: UnitRole;
  epistemicStatus?: EpistemicStatus;
  groupId?: string;
  unit?: EditorialMaterialUnitBase['unit'];
  metricEligible?: boolean;
  basisUnitIds?: string[];
  evidenceIds?: string[];
  questionIds?: string[];
  requiredInBody?: boolean;
  artifact?: SourceArtifactRef;
}

function fail(code: string, message: string): never {
  throw new EditorialMaterializationError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('EDITORIAL_PAYLOAD_INVALID', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail('EDITORIAL_PAYLOAD_INVALID', `${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('EDITORIAL_PAYLOAD_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function scalar(value: unknown, label: string): string | number | boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    fail('EDITORIAL_PAYLOAD_INVALID', `${label} must be a scalar`);
  }
  return normalizeEditorialScalar(value);
}

function identifier(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (Buffer.byteLength(parsed, 'utf8') > MAX_IDENTIFIER_BYTES) {
    fail('EDITORIAL_IDENTIFIER_TOO_LARGE', `${label} exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes`);
  }
  return parsed;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireUniqueIds(values: readonly Record<string, unknown>[], label: string): Map<string, number> {
  const indexes = new Map<string, number>();
  values.forEach((value, index) => {
    const id = identifier(value.id, `${label}/${index}/id`);
    if (indexes.has(id)) fail('EDITORIAL_RELATION_INVALID', `${label} contains duplicate id ${id}`);
    indexes.set(id, index);
  });
  return indexes;
}

function asSha256(value: string, label: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail('SOURCE_INTEGRITY', `${label} is not a SHA-256`);
  return value as Sha256;
}

function findArtifact(source: FrozenEditorialSource, artifactId: string, label: string): SourceArtifactRef {
  const artifact = source.sourceArtifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) fail('SOURCE_INTEGRITY', `${label} Artifact ${artifactId} is not in the frozen source set`);
  return artifact;
}

function publicEvidenceUrl(entry: EvidenceEntry): string | undefined {
  if (entry.evidenceClass !== 'public_source' || entry.sensitivity !== 'public' || !entry.sourceUrl) {
    return undefined;
  }
  try {
    const url = new URL(entry.sourceUrl);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

class MaterialBuilder {
  readonly units: EditorialMaterialUnit[] = [];
  readonly assets: EditorialMaterialAsset[] = [];
  readonly warnings: Array<EditorialDiagnosticIssue & { code: EditorialMaterializationWarningCode }> = [];
  readonly logicalUnitIds = new Map<string, string>();
  titleUnitId: string | undefined;
  private readonly unitIds = new Set<string>();
  private readonly evidenceById: Map<string, EvidenceEntry>;
  private readonly usedEvidenceIds = new Set<string>();

  constructor(
    readonly source: FrozenEditorialSource,
    readonly deliverableArtifact: SourceArtifactRef,
    readonly evidenceManifestArtifact: SourceArtifactRef,
    readonly reportDocumentArtifact: SourceArtifactRef | null,
  ) {
    this.evidenceById = new Map(source.current.evidenceManifest.entries.map((entry) => [entry.id, entry]));
  }

  addUnit(input: AddUnitInput): EditorialMaterialUnit {
    const artifact = input.artifact ?? this.deliverableArtifact;
    const value = scalar(input.value, input.pointer);
    const basisUnitIds = uniqueStrings(input.basisUnitIds ?? []);
    const evidenceIds = uniqueStrings(input.evidenceIds ?? []);
    const questionIds = uniqueStrings(input.questionIds ?? []);
    for (const evidenceId of evidenceIds) {
      const evidence = this.evidenceById.get(evidenceId);
      if (!evidence) fail('EDITORIAL_EVIDENCE_INVALID', `Evidence ${evidenceId} is not in the verified manifest`);
      if (evidence.redaction === 'blocked' || evidence.sensitivity === 'sensitive') {
        fail('EDITORIAL_SENSITIVE_EVIDENCE', `Evidence ${evidenceId} is not eligible for the Editorial sidecar`);
      }
      this.usedEvidenceIds.add(evidenceId);
    }
    const id = createEditorialMaterialUnitId({
      sourceArtifactId: artifact.artifactId,
      sourceArtifactContentSha256: artifact.contentSha256,
      sourceJsonPointer: input.pointer,
      role: input.role,
      value,
    });
    if (this.unitIds.has(id)) fail('EDITORIAL_UNIT_DUPLICATE', `Unit ${id} is duplicated`);
    this.unitIds.add(id);
    const base: EditorialMaterialUnitBase = {
      id,
      value,
      metricEligible: input.metricEligible ?? false,
      sourceRefs: [{ artifactId: artifact.artifactId, jsonPointer: input.pointer }],
      basisUnitIds,
      evidenceIds,
      questionIds,
      requiredInOutput: true,
      requiredInBody: input.requiredInBody ?? (
        input.role === 'claim'
        || input.role === 'recommendation'
        || input.role === 'risk'
        || input.role === 'validation'
      ),
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      ...(input.unit === undefined ? {} : { unit: input.unit }),
    };
    let unit: EditorialMaterialUnit;
    if (input.role === 'claim') {
      unit = { ...base, role: 'claim', epistemicStatus: input.epistemicStatus ?? 'inference' };
    } else if (input.role === 'recommendation') {
      unit = { ...base, role: 'recommendation', epistemicStatus: 'inference' };
    } else if (input.role === 'risk' || input.role === 'validation') {
      unit = { ...base, role: input.role, epistemicStatus: 'unknown' };
    } else {
      unit = { ...base, role: input.role };
    }
    this.units.push(unit);
    return unit;
  }

  remember(logicalId: string, unit: EditorialMaterialUnit): void {
    if (this.logicalUnitIds.has(logicalId)) {
      fail('EDITORIAL_RELATION_INVALID', `logical content id ${logicalId} is duplicated`);
    }
    this.logicalUnitIds.set(logicalId, unit.id);
  }

  requireLogical(logicalId: string, label: string): string {
    const unitId = this.logicalUnitIds.get(logicalId);
    if (!unitId) fail('EDITORIAL_RELATION_INVALID', `${label} references unknown id ${logicalId}`);
    return unitId;
  }

  evidence(): EditorialEvidenceEntry[] {
    return this.source.current.evidenceManifest.entries
      .filter(({ id }) => this.usedEvidenceIds.has(id))
      .map((entry) => {
        const sourceUrl = publicEvidenceUrl(entry);
        return {
          id: entry.id,
          kind: entry.kind,
          evidenceClass: entry.evidenceClass,
          artifactId: entry.artifactId,
          artifactContentSha256: entry.artifactContentSha256,
          jsonPointer: entry.jsonPointer,
          sensitivity: entry.sensitivity,
          redaction: entry.redaction,
          ...(entry.toolId === undefined ? {} : { toolId: entry.toolId }),
          ...(entry.toolTier === undefined ? {} : { toolTier: entry.toolTier }),
          ...(entry.toolProof === undefined ? {} : { toolProof: structuredClone(entry.toolProof) }),
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
        };
      }) as EditorialEvidenceEntry[];
  }
}

function projectFindingGraph(
  builder: MaterialBuilder,
  deliverable: ResearchDeliverableEnvelope<unknown>,
): string {
  const deliverableArtifact = builder.deliverableArtifact;
  const questionBySummary = new Map<string, string[]>();
  for (const binding of deliverable.coverage.questionBindings) {
    for (const summaryId of binding.summaryIds) {
      questionBySummary.set(summaryId, uniqueStrings([...(questionBySummary.get(summaryId) ?? []), binding.questionId]));
    }
  }
  const summaryIdsByFinding = new Map<string, string[]>();
  const summaryIdsByAnalysis = new Map<string, string[]>();
  deliverable.findingGraph.subQuestionSummaries.forEach((summary) => {
    summary.findingIds.forEach((id) => summaryIdsByFinding.set(id, [...(summaryIdsByFinding.get(id) ?? []), summary.id]));
    summary.analysisIds.forEach((id) => summaryIdsByAnalysis.set(id, [...(summaryIdsByAnalysis.get(id) ?? []), summary.id]));
  });
  const questionsForSummaries = (summaryIds: readonly string[]): string[] => uniqueStrings(
    summaryIds.flatMap((id) => questionBySummary.get(id) ?? []),
  );

  const method = builder.addUnit({
    pointer: '/methodSummary',
    value: deliverable.methodSummary,
    role: 'context',
    groupId: 'method',
    requiredInBody: true,
    artifact: deliverableArtifact,
  });

  deliverable.findingGraph.findings.forEach((finding, index) => {
    const unit = builder.addUnit({
      pointer: `/findingGraph/findings/${index}/statement`,
      value: finding.statement,
      role: 'claim',
      epistemicStatus: finding.kind === 'fact' ? 'fact' : 'inference',
      groupId: `finding:${finding.id}`,
      evidenceIds: finding.kind === 'fact' ? finding.evidenceIds : [],
      questionIds: questionsForSummaries(summaryIdsByFinding.get(finding.id) ?? []),
    });
    builder.remember(`finding:${identifier(finding.id, `findingGraph/findings/${index}/id`)}`, unit);
  });
  deliverable.findingGraph.findings.forEach((finding, index) => {
    if (finding.kind !== 'inference') return;
    const unitId = builder.requireLogical(`finding:${finding.id}`, `finding ${finding.id}`);
    const unit = builder.units.find(({ id }) => id === unitId)!;
    unit.basisUnitIds = finding.findingIds.map((id) => builder.requireLogical(`finding:${id}`, `finding ${index}`));
  });

  deliverable.findingGraph.analyses.forEach((analysis, index) => {
    const unit = builder.addUnit({
      pointer: `/findingGraph/analyses/${index}/statement`,
      value: analysis.statement,
      role: 'claim',
      epistemicStatus: 'inference',
      groupId: `analysis:${analysis.id}`,
      basisUnitIds: analysis.findingIds.map((id) => builder.requireLogical(`finding:${id}`, `analysis ${analysis.id}`)),
      questionIds: questionsForSummaries(summaryIdsByAnalysis.get(analysis.id) ?? []),
    });
    builder.remember(`analysis:${identifier(analysis.id, `findingGraph/analyses/${index}/id`)}`, unit);
  });

  deliverable.findingGraph.subQuestionSummaries.forEach((summary, index) => {
    const unit = builder.addUnit({
      pointer: `/findingGraph/subQuestionSummaries/${index}/summary`,
      value: summary.summary,
      role: 'claim',
      epistemicStatus: 'inference',
      groupId: `summary:${summary.id}`,
      basisUnitIds: [
        ...summary.findingIds.map((id) => builder.requireLogical(`finding:${id}`, `summary ${summary.id}`)),
        ...summary.analysisIds.map((id) => builder.requireLogical(`analysis:${id}`, `summary ${summary.id}`)),
      ],
      questionIds: questionBySummary.get(summary.id) ?? [],
    });
    builder.remember(`summary:${identifier(summary.id, `findingGraph/subQuestionSummaries/${index}/id`)}`, unit);
  });

  deliverable.findingGraph.overallConclusions.forEach((conclusion, index) => {
    const unit = builder.addUnit({
      pointer: `/findingGraph/overallConclusions/${index}/statement`,
      value: conclusion.statement,
      role: 'claim',
      epistemicStatus: 'inference',
      groupId: `conclusion:${conclusion.id}`,
      basisUnitIds: conclusion.summaryIds.map((id) => builder.requireLogical(`summary:${id}`, `conclusion ${conclusion.id}`)),
      questionIds: questionsForSummaries(conclusion.summaryIds),
    });
    builder.remember(`conclusion:${identifier(conclusion.id, `findingGraph/overallConclusions/${index}/id`)}`, unit);
  });

  deliverable.recommendations.forEach((recommendation, index) => {
    const unit = builder.addUnit({
      pointer: `/recommendations/${index}/statement`,
      value: recommendation.statement,
      role: 'recommendation',
      groupId: `recommendation:${recommendation.id}`,
      basisUnitIds: recommendation.summaryIds.map((id) => builder.requireLogical(`summary:${id}`, `recommendation ${recommendation.id}`)),
      questionIds: questionsForSummaries(recommendation.summaryIds),
    });
    builder.remember(`recommendation:${identifier(recommendation.id, `recommendations/${index}/id`)}`, unit);
  });

  deliverable.risksAndOpenIssues.forEach((risk, index) => {
    builder.addUnit({
      pointer: `/risksAndOpenIssues/${index}`,
      value: risk,
      role: 'risk',
      groupId: `risk:${index}`,
    });
  });
  return method.id;
}

function projectResearchPlan(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = record(payloadValue, 'research_plan payload');
  const title = builder.addUnit({ pointer: '/payload/title', value: scalar(payload.title, 'title'), role: 'context', groupId: 'research-plan', requiredInBody: true });
  builder.titleUnitId = title.id;
  builder.addUnit({ pointer: '/payload/researchGoal', value: scalar(payload.researchGoal, 'researchGoal'), role: 'context', groupId: 'research-plan', requiredInBody: true });
  const scope = record(payload.scope, 'scope');
  builder.addUnit({ pointer: '/payload/scope/market', value: scalar(scope.market, 'scope.market'), role: 'context', groupId: 'research-scope', requiredInBody: true });
  list(scope.subjects, 'scope.subjects').forEach((value, index) => builder.addUnit({ pointer: `/payload/scope/subjects/${index}`, value: scalar(value, 'scope.subject'), role: 'context', groupId: 'research-scope', requiredInBody: true }));
  builder.addUnit({ pointer: '/payload/scope/timeWindow', value: scalar(scope.timeWindow, 'scope.timeWindow'), role: 'context', groupId: 'research-scope', requiredInBody: true });
  const sampling = record(payload.competitorSampling, 'competitorSampling');
  const strategy = builder.addUnit({ pointer: '/payload/competitorSampling/strategy', value: scalar(sampling.strategy, 'sampling.strategy'), role: 'audit', groupId: 'research-sampling' });
  const target = builder.addUnit({ pointer: '/payload/competitorSampling/targetCount', value: scalar(sampling.targetCount, 'sampling.targetCount'), role: 'context', groupId: 'research-sampling', basisUnitIds: [strategy.id], unit: '个', metricEligible: true, requiredInBody: true });
  builder.remember('research:target-count', target);
  for (const field of ['inclusionCriteria', 'exclusionCriteria'] as const) {
    list(sampling[field], `sampling.${field}`).forEach((value, index) => builder.addUnit({ pointer: `/payload/competitorSampling/${field}/${index}`, value: scalar(value, field), role: 'audit', groupId: 'research-sampling', basisUnitIds: [strategy.id] }));
  }
  list(payload.researchQuestions, 'researchQuestions').forEach((value, index) => builder.addUnit({ pointer: `/payload/researchQuestions/${index}`, value: scalar(value, 'research question'), role: 'context', groupId: `research-question:${index}`, requiredInBody: true }));
  list(payload.comparisonDimensions, 'comparisonDimensions').forEach((raw, index) => {
    const item = record(raw, `comparisonDimensions/${index}`);
    const id = identifier(item.id, `comparisonDimensions/${index}/id`);
    const name = builder.addUnit({ pointer: `/payload/comparisonDimensions/${index}/name`, value: scalar(item.name, 'dimension name'), role: 'audit', groupId: `research-dimension:${id}` });
    builder.addUnit({ pointer: `/payload/comparisonDimensions/${index}/purpose`, value: scalar(item.purpose, 'dimension purpose'), role: 'audit', groupId: `research-dimension:${id}`, basisUnitIds: [name.id] });
    list(item.collectionFields, 'collectionFields').forEach((value, child) => builder.addUnit({ pointer: `/payload/comparisonDimensions/${index}/collectionFields/${child}`, value: scalar(value, 'collection field'), role: 'audit', groupId: `research-dimension:${id}`, basisUnitIds: [name.id] }));
  });
  list(payload.sourcePlan, 'sourcePlan').forEach((raw, index) => {
    const item = record(raw, `sourcePlan/${index}`);
    const groupId = `research-source:${index}`;
    const evidenceClass = builder.addUnit({ pointer: `/payload/sourcePlan/${index}/evidenceClass`, value: scalar(item.evidenceClass, 'evidenceClass'), role: 'audit', groupId });
    list(item.sourceTypes, 'sourceTypes').forEach((value, child) => builder.addUnit({ pointer: `/payload/sourcePlan/${index}/sourceTypes/${child}`, value: scalar(value, 'source type'), role: 'audit', groupId, basisUnitIds: [evidenceClass.id] }));
    builder.addUnit({ pointer: `/payload/sourcePlan/${index}/purpose`, value: scalar(item.purpose, 'source purpose'), role: 'audit', groupId, basisUnitIds: [evidenceClass.id] });
  });
  list(payload.executionPlan, 'executionPlan').forEach((raw, index) => {
    const item = record(raw, `executionPlan/${index}`);
    const groupId = `research-phase:${index}`;
    const phase = builder.addUnit({ pointer: `/payload/executionPlan/${index}/phase`, value: scalar(item.phase, 'phase'), role: 'context', groupId, requiredInBody: true });
    list(item.activities, 'activities').forEach((value, child) => builder.addUnit({ pointer: `/payload/executionPlan/${index}/activities/${child}`, value: scalar(value, 'activity'), role: 'recommendation', groupId, basisUnitIds: [phase.id] }));
    builder.addUnit({ pointer: `/payload/executionPlan/${index}/duration`, value: scalar(item.duration, 'duration'), role: 'audit', groupId, basisUnitIds: [phase.id] });
    list(item.outputs, 'outputs').forEach((value, child) => builder.addUnit({ pointer: `/payload/executionPlan/${index}/outputs/${child}`, value: scalar(value, 'output'), role: 'audit', groupId, basisUnitIds: [phase.id] }));
  });
  list(payload.collectionTemplate, 'collectionTemplate').forEach((raw, index) => {
    const item = record(raw, `collectionTemplate/${index}`);
    const groupId = `collection-field:${index}`;
    const field = builder.addUnit({ pointer: `/payload/collectionTemplate/${index}/field`, value: scalar(item.field, 'field'), role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/collectionTemplate/${index}/description`, value: scalar(item.description, 'description'), role: 'audit', groupId, basisUnitIds: [field.id] });
    builder.addUnit({ pointer: `/payload/collectionTemplate/${index}/evidenceRequired`, value: scalar(item.evidenceRequired, 'evidenceRequired'), role: 'audit', groupId, basisUnitIds: [field.id] });
  });
  list(payload.analysisMethods, 'analysisMethods').forEach((value, index) => builder.addUnit({ pointer: `/payload/analysisMethods/${index}`, value: scalar(value, 'analysis method'), role: 'audit', groupId: `research-method:${index}` }));
  list(payload.deliverables, 'deliverables').forEach((value, index) => builder.addUnit({ pointer: `/payload/deliverables/${index}`, value: scalar(value, 'deliverable'), role: 'context', groupId: `research-deliverable:${index}`, requiredInBody: true }));
  list(payload.qualityChecks, 'qualityChecks').forEach((value, index) => builder.addUnit({ pointer: `/payload/qualityChecks/${index}`, value: scalar(value, 'quality check'), role: 'validation', groupId: `research-quality:${index}` }));
}

function evidenceIds(value: unknown, label: string): string[] {
  return list(value, label).map((item, index) => identifier(item, `${label}/${index}`));
}

interface ReportVisualBindings {
  standaloneAssetIds: Set<string>;
  comparisonPairs: Set<string>;
  comparisonAfterAssetIds: Set<string>;
}

function comparisonKey(beforeAssetId: string, afterAssetId: string): string {
  return `${beforeAssetId}\u0000${afterAssetId}`;
}

function reportVisualBindings(builder: MaterialBuilder): ReportVisualBindings {
  const bindings: ReportVisualBindings = {
    standaloneAssetIds: new Set(),
    comparisonPairs: new Set(),
    comparisonAfterAssetIds: new Set(),
  };
  if (builder.source.current.presentationMode !== 'multimodal') return bindings;
  for (const block of builder.source.current.reportDocument.sections.flatMap(({ blocks }) => blocks)) {
    if (block.type === 'image') {
      bindings.standaloneAssetIds.add(block.assetRef.assetId);
    } else if (block.type === 'image-comparison') {
      bindings.comparisonPairs.add(comparisonKey(block.beforeAssetRef.assetId, block.afterAssetRef.assetId));
      bindings.comparisonAfterAssetIds.add(block.afterAssetRef.assetId);
    }
  }
  return bindings;
}

function projectCompetitive(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = record(payloadValue, 'competitive payload');
  const visualBindings = reportVisualBindings(builder);
  const samples = list(payload.competitorSamples, 'competitorSamples').map((item, index) => record(item, `competitorSamples/${index}`));
  const sampleIndexes = requireUniqueIds(samples, 'competitorSamples');
  const sampleNameIds = new Map<string, string>();
  samples.forEach((sample, index) => {
    const id = identifier(sample.id, `competitorSamples/${index}/id`);
    const name = builder.addUnit({ pointer: `/payload/competitorSamples/${index}/name`, value: scalar(sample.name, 'sample name'), role: 'context', groupId: `competitive-sample:${id}`, requiredInBody: true });
    sampleNameIds.set(id, name.id);
    builder.addUnit({ pointer: `/payload/competitorSamples/${index}/rationale`, value: scalar(sample.rationale, 'sample rationale'), role: 'claim', groupId: `competitive-sample:${id}`, basisUnitIds: [name.id], evidenceIds: evidenceIds(sample.evidenceIds, 'sample evidenceIds') });
  });
  list(payload.dimensionMatrix, 'dimensionMatrix').forEach((raw, index) => {
    const row = record(raw, `dimensionMatrix/${index}`);
    const dimension = builder.addUnit({ pointer: `/payload/dimensionMatrix/${index}/dimension`, value: scalar(row.dimension, 'dimension'), role: 'context', groupId: `competitive-dimension:${index}`, requiredInBody: true });
    if (row.weight !== undefined) builder.addUnit({ pointer: `/payload/dimensionMatrix/${index}/weight`, value: scalar(row.weight, 'weight'), role: 'audit', groupId: `competitive-dimension:${index}`, unit: 'ratio', basisUnitIds: [dimension.id] });
    list(row.values, 'dimension values').forEach((rawValue, child) => {
      const value = record(rawValue, `dimensionMatrix/${index}/values/${child}`);
      const sampleId = identifier(value.sampleId, 'dimension sampleId');
      if (!sampleIndexes.has(sampleId)) fail('EDITORIAL_RELATION_INVALID', `matrix references unknown sample ${sampleId}`);
      const sampleName = sampleNameIds.get(sampleId)!;
      const groupId = `competitive-cell:${index}:${sampleId}`;
      const cell = builder.addUnit({ pointer: `/payload/dimensionMatrix/${index}/values/${child}/value`, value: scalar(value.value, 'matrix value'), role: 'claim', groupId, basisUnitIds: [dimension.id, sampleName], evidenceIds: evidenceIds(value.evidenceIds, 'matrix evidenceIds') });
      if (value.score !== undefined) builder.addUnit({ pointer: `/payload/dimensionMatrix/${index}/values/${child}/score`, value: scalar(value.score, 'matrix score'), role: 'claim', groupId, basisUnitIds: [dimension.id, sampleName, cell.id], evidenceIds: evidenceIds(value.evidenceIds, 'matrix evidenceIds'), unit: '/5', metricEligible: true });
    });
  });
  const differences = list(payload.differences, 'differences').map((item, index) => record(item, `differences/${index}`));
  const differenceIndexes = requireUniqueIds(differences, 'differences');
  const differenceUnitIds = new Map<string, string>();
  differences.forEach((difference, index) => {
    const id = identifier(difference.id, `differences/${index}/id`);
    const groupId = `competitive-difference:${id}`;
    const dimension = builder.addUnit({ pointer: `/payload/differences/${index}/dimension`, value: scalar(difference.dimension, 'difference dimension'), role: 'context', groupId, requiredInBody: true });
    const statement = builder.addUnit({ pointer: `/payload/differences/${index}/statement`, value: scalar(difference.statement, 'difference statement'), role: 'claim', groupId, basisUnitIds: [dimension.id], evidenceIds: evidenceIds(difference.evidenceIds, 'difference evidenceIds') });
    differenceUnitIds.set(id, statement.id);
  });
  list(payload.impacts, 'impacts').forEach((raw, index) => {
    const impact = record(raw, `impacts/${index}`);
    const differenceId = identifier(impact.differenceId, 'impact differenceId');
    if (!differenceIndexes.has(differenceId)) fail('EDITORIAL_RELATION_INVALID', `impact references unknown difference ${differenceId}`);
    const basis = differenceUnitIds.get(differenceId)!;
    const groupId = `competitive-difference:${differenceId}`;
    builder.addUnit({ pointer: `/payload/impacts/${index}/audience`, value: scalar(impact.audience, 'impact audience'), role: 'context', groupId, basisUnitIds: [basis], requiredInBody: true });
    builder.addUnit({ pointer: `/payload/impacts/${index}/statement`, value: scalar(impact.statement, 'impact statement'), role: 'claim', groupId, basisUnitIds: [basis] });
  });
  list(payload.actionRecommendations, 'actionRecommendations').forEach((raw, index) => {
    const action = record(raw, `actionRecommendations/${index}`);
    const id = identifier(action.id, `actionRecommendations/${index}/id`);
    const basis = evidenceIds(action.differenceIds, 'action differenceIds').map((differenceId) => {
      const unitId = differenceUnitIds.get(differenceId);
      if (!unitId) fail('EDITORIAL_RELATION_INVALID', `action references unknown difference ${differenceId}`);
      return unitId;
    });
    const groupId = `competitive-action:${id}`;
    builder.addUnit({ pointer: `/payload/actionRecommendations/${index}/statement`, value: scalar(action.statement, 'action statement'), role: 'recommendation', groupId, basisUnitIds: basis });
    builder.addUnit({ pointer: `/payload/actionRecommendations/${index}/priority`, value: scalar(action.priority, 'action priority'), role: 'recommendation', groupId, basisUnitIds: basis });
  });
  if (payload.scoringMethod !== undefined) list(payload.scoringMethod, 'scoringMethod').forEach((value, index) => builder.addUnit({ pointer: `/payload/scoringMethod/${index}`, value: scalar(value, 'scoring method'), role: 'audit', groupId: `competitive-scoring:${index}` }));
  if (payload.roadmap !== undefined) list(payload.roadmap, 'roadmap').forEach((raw, index) => {
    const item = record(raw, `roadmap/${index}`);
    const groupId = `competitive-roadmap:${index}`;
    const statement = builder.addUnit({ pointer: `/payload/roadmap/${index}/statement`, value: scalar(item.statement, 'roadmap statement'), role: 'recommendation', groupId });
    builder.addUnit({ pointer: `/payload/roadmap/${index}/priority`, value: scalar(item.priority, 'roadmap priority'), role: 'recommendation', groupId, basisUnitIds: [statement.id] });
    builder.addUnit({ pointer: `/payload/roadmap/${index}/metric`, value: scalar(item.metric, 'roadmap metric'), role: 'validation', groupId, basisUnitIds: [statement.id] });
    builder.addUnit({ pointer: `/payload/roadmap/${index}/validationMethod`, value: scalar(item.validationMethod, 'validation method'), role: 'validation', groupId, basisUnitIds: [statement.id] });
  });
  for (const field of ['instrumentationPlan', 'userTestScript'] as const) {
    if (payload[field] === undefined) continue;
    list(payload[field], field).forEach((value, index) => builder.addUnit({ pointer: `/payload/${field}/${index}`, value: scalar(value, field), role: 'validation', groupId: `competitive-${field}:${index}` }));
  }
  for (const field of ['visualEvidence', 'screenshotComparisons'] as const) {
    if (payload[field] === undefined) continue;
    const items = list(payload[field], field).map((raw, index) => record(raw, `${field}/${index}`));
    requireUniqueIds(items, field);
    items.forEach((item, index) => {
      const id = identifier(item.id, `${field}/${index}/id`);
      evidenceIds(item.sampleIds, `${field} sampleIds`).forEach((sampleId) => {
        if (!sampleIndexes.has(sampleId)) fail('EDITORIAL_RELATION_INVALID', `${field} references unknown sample ${sampleId}`);
      });
      if (field === 'visualEvidence') {
        const assetId = identifier(item.assetId, `${field}/${index}/assetId`);
        if (!visualBindings.standaloneAssetIds.has(assetId)) {
          fail('EDITORIAL_RELATION_INVALID', `${field} references an Asset not bound by the frozen ReportDocument`);
        }
      } else {
        const assetIds = evidenceIds(item.assetIds, `${field}/${index}/assetIds`);
        if (assetIds.length !== 2 || !visualBindings.comparisonPairs.has(comparisonKey(assetIds[0]!, assetIds[1]!))) {
          fail('EDITORIAL_RELATION_INVALID', `${field} does not match a frozen ReportDocument comparison`);
        }
      }
      const groupId = field === 'visualEvidence' ? `competitive-visual:${id}` : `competitive-comparison:${id}`;
      const directEvidence = item.evidenceIds === undefined ? [] : evidenceIds(item.evidenceIds, `${field} evidenceIds`);
      const dimension = builder.addUnit({ pointer: `/payload/${field}/${index}/dimension`, value: scalar(item.dimension, `${field} dimension`), role: 'context', groupId, evidenceIds: directEvidence, requiredInBody: true });
      builder.addUnit({ pointer: `/payload/${field}/${index}/caption`, value: scalar(item.caption, `${field} caption`), role: 'context', groupId, basisUnitIds: [dimension.id], evidenceIds: directEvidence, requiredInBody: true });
    });
  }
}

function projectVoc(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = record(payloadValue, 'VOC payload');
  const datasets = list(payload.datasets, 'datasets').map((item, index) => record(item, `datasets/${index}`));
  const datasetIndexes = requireUniqueIds(datasets, 'datasets');
  const datasetNames = new Map<string, string>();
  datasets.forEach((dataset, index) => {
    const id = identifier(dataset.id, `datasets/${index}/id`);
    const groupId = `voc-dataset:${id}`;
    const name = builder.addUnit({ pointer: `/payload/datasets/${index}/name`, value: scalar(dataset.name, 'dataset name'), role: 'context', groupId, requiredInBody: true });
    datasetNames.set(id, name.id);
    builder.addUnit({ pointer: `/payload/datasets/${index}/source`, value: scalar(dataset.source, 'dataset source'), role: 'audit', groupId, basisUnitIds: [name.id] });
    builder.addUnit({ pointer: `/payload/datasets/${index}/recordCount`, value: scalar(dataset.recordCount, 'record count'), role: 'context', groupId, basisUnitIds: [name.id], unit: '条', metricEligible: true, requiredInBody: true });
  });
  const themes = list(payload.themes, 'themes').map((item, index) => record(item, `themes/${index}`));
  const themeIndexes = requireUniqueIds(themes, 'themes');
  const themeUnits = new Map<string, string>();
  const themeEvidence = new Map<string, string[]>();
  themes.forEach((theme, index) => {
    const id = identifier(theme.id, `themes/${index}/id`);
    const datasetIds = evidenceIds(theme.datasetIds, 'theme datasetIds');
    const basis = datasetIds.map((datasetId) => {
      if (!datasetIndexes.has(datasetId)) fail('EDITORIAL_RELATION_INVALID', `theme references unknown dataset ${datasetId}`);
      return datasetNames.get(datasetId)!;
    });
    const directEvidence = evidenceIds(theme.evidenceIds, 'theme evidenceIds');
    const unit = builder.addUnit({ pointer: `/payload/themes/${index}/label`, value: scalar(theme.label, 'theme label'), role: 'claim', groupId: `voc-theme:${id}`, basisUnitIds: basis, evidenceIds: directEvidence });
    themeUnits.set(id, unit.id);
    themeEvidence.set(id, directEvidence);
  });
  const related = new Map<string, string[]>();
  for (const field of ['frequencies', 'sentiments'] as const) {
    list(payload[field], field).forEach((raw, index) => {
      const item = record(raw, `${field}/${index}`);
      const themeId = identifier(item.themeId, `${field} themeId`);
      if (!themeIndexes.has(themeId)) fail('EDITORIAL_RELATION_INVALID', `${field} references unknown theme ${themeId}`);
      const groupId = `voc-theme:${themeId}`;
      const basis = [themeUnits.get(themeId)!];
      const ids: string[] = [];
      const fields = field === 'frequencies' ? ['count', 'share'] as const : ['label', 'score'] as const;
      for (const child of fields) {
        const unit = builder.addUnit({ pointer: `/payload/${field}/${index}/${child}`, value: scalar(item[child], `${field} ${child}`), role: 'claim', groupId, basisUnitIds: basis, evidenceIds: themeEvidence.get(themeId)!, ...(child === 'count' ? { unit: '条' as const, metricEligible: true } : child === 'share' ? { unit: 'ratio' as const, metricEligible: true } : child === 'score' ? { metricEligible: true } : {}) });
        ids.push(unit.id);
      }
      related.set(themeId, [...(related.get(themeId) ?? []), ...ids]);
    });
  }
  list(payload.representativeQuotes, 'representativeQuotes').forEach((raw, index) => {
    const item = record(raw, `representativeQuotes/${index}`);
    const themeId = identifier(item.themeId, 'quote themeId');
    if (!themeIndexes.has(themeId)) fail('EDITORIAL_RELATION_INVALID', `quote references unknown theme ${themeId}`);
    builder.addUnit({ pointer: `/payload/representativeQuotes/${index}/quote`, value: scalar(item.quote, 'quote'), role: 'audit', groupId: `voc-theme:${themeId}`, basisUnitIds: [themeUnits.get(themeId)!], evidenceIds: [identifier(item.evidenceId, 'quote evidenceId')], requiredInBody: true });
  });
  const severityIds = new Map<string, string[]>();
  list(payload.severities, 'severities').forEach((raw, index) => {
    const item = record(raw, `severities/${index}`);
    const themeId = identifier(item.themeId, 'severities themeId');
    if (!themeIndexes.has(themeId)) fail('EDITORIAL_RELATION_INVALID', `severities references unknown theme ${themeId}`);
    const basis = [themeUnits.get(themeId)!, ...(related.get(themeId) ?? [])];
    const groupId = `voc-theme:${themeId}`;
    const created = [
      builder.addUnit({ pointer: `/payload/severities/${index}/level`, value: scalar(item.level, 'severities level'), role: 'claim', groupId, basisUnitIds: basis }).id,
      builder.addUnit({ pointer: `/payload/severities/${index}/rationale`, value: scalar(item.rationale, 'severities rationale'), role: 'claim', groupId, basisUnitIds: basis }).id,
    ];
    severityIds.set(themeId, [...(severityIds.get(themeId) ?? []), ...created]);
  });
  list(payload.priorities, 'priorities').forEach((raw, index) => {
    const item = record(raw, `priorities/${index}`);
    const themeId = identifier(item.themeId, 'priorities themeId');
    if (!themeIndexes.has(themeId)) fail('EDITORIAL_RELATION_INVALID', `priorities references unknown theme ${themeId}`);
    const basis = [
      themeUnits.get(themeId)!,
      ...(related.get(themeId) ?? []),
      ...(severityIds.get(themeId) ?? []),
    ];
    const groupId = `voc-theme:${themeId}`;
    builder.addUnit({ pointer: `/payload/priorities/${index}/level`, value: scalar(item.level, 'priorities level'), role: 'claim', groupId, basisUnitIds: basis });
    builder.addUnit({ pointer: `/payload/priorities/${index}/rationale`, value: scalar(item.rationale, 'priorities rationale'), role: 'claim', groupId, basisUnitIds: basis });
  });
}

function projectDesignAudit(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = record(payloadValue, 'design audit payload');
  const visualBindings = reportVisualBindings(builder);
  const pages = list(payload.pages, 'pages').map((item, index) => record(item, `pages/${index}`));
  const pageIndexes = requireUniqueIds(pages, 'pages');
  const pageBasis = new Map<string, string[]>();
  pages.forEach((page, index) => {
    const id = identifier(page.id, `pages/${index}/id`);
    const groupId = `design-page:${id}`;
    const name = builder.addUnit({ pointer: `/payload/pages/${index}/name`, value: scalar(page.name, 'page name'), role: 'context', groupId, requiredInBody: true });
    const state = builder.addUnit({ pointer: `/payload/pages/${index}/state`, value: scalar(page.state, 'page state'), role: 'context', groupId, basisUnitIds: [name.id], requiredInBody: true });
    pageBasis.set(id, [name.id, state.id]);
  });
  const issues = list(payload.issues, 'issues').map((item, index) => record(item, `issues/${index}`));
  const issueIndexes = requireUniqueIds(issues, 'issues');
  const issueBasis = new Map<string, string[]>();
  issues.forEach((issue, index) => {
    const id = identifier(issue.id, `issues/${index}/id`);
    const pageId = identifier(issue.pageId, `issues/${index}/pageId`);
    if (!pageIndexes.has(pageId)) fail('EDITORIAL_RELATION_INVALID', `issue references unknown page ${pageId}`);
    const statement = builder.addUnit({ pointer: `/payload/issues/${index}/statement`, value: scalar(issue.statement, 'issue statement'), role: 'claim', groupId: `design-issue:${id}`, basisUnitIds: pageBasis.get(pageId)! });
    issueBasis.set(id, [statement.id]);
  });
  const projectIssueFields = (
    field: string,
    specs: Array<{ name: string; role: UnitRole }>,
    basisFor: (issueId: string, name: string, created: readonly string[]) => string[],
    collectInto?: Map<string, string[]>,
  ): void => {
    list(payload[field], field).forEach((raw, index) => {
      const item = record(raw, `${field}/${index}`);
      const issueId = identifier(item.issueId, `${field} issueId`);
      if (!issueIndexes.has(issueId)) fail('EDITORIAL_RELATION_INVALID', `${field} references unknown issue ${issueId}`);
      const groupId = `design-issue:${issueId}`;
      const created: string[] = [];
      specs.forEach((spec) => {
        const basis = basisFor(issueId, spec.name, created);
        if (spec.name === 'acceptanceCriteria') {
          list(item[spec.name], `${field} acceptanceCriteria`).forEach((value, child) => created.push(builder.addUnit({ pointer: `/payload/${field}/${index}/${spec.name}/${child}`, value: scalar(value, spec.name), role: spec.role, groupId, basisUnitIds: basis }).id));
        } else {
          created.push(builder.addUnit({ pointer: `/payload/${field}/${index}/${spec.name}`, value: scalar(item[spec.name], `${field} ${spec.name}`), role: spec.role, groupId, basisUnitIds: basis }).id);
        }
      });
      if (collectInto) collectInto.set(issueId, uniqueStrings([...(collectInto.get(issueId) ?? []), ...created]));
    });
  };
  const principleIds = new Map<string, string[]>();
  const severityIds = new Map<string, string[]>();
  const remediationIds = new Map<string, string[]>();
  projectIssueFields(
    'principles',
    [{ name: 'principle', role: 'claim' }, { name: 'rationale', role: 'claim' }],
    (issueId) => issueBasis.get(issueId)!,
    principleIds,
  );
  projectIssueFields(
    'severities',
    [{ name: 'level', role: 'claim' }, { name: 'rationale', role: 'claim' }],
    (issueId) => [...issueBasis.get(issueId)!, ...(principleIds.get(issueId) ?? [])],
    severityIds,
  );
  list(payload.annotatedScreenshots, 'annotatedScreenshots').forEach((raw, index) => {
    const screenshot = record(raw, `annotatedScreenshots/${index}`);
    const issueId = identifier(screenshot.issueId, `annotatedScreenshots/${index}/issueId`);
    if (!issueIndexes.has(issueId)) {
      fail('EDITORIAL_RELATION_INVALID', `annotatedScreenshots references unknown issue ${issueId}`);
    }
    const assetId = identifier(screenshot.assetId, `annotatedScreenshots/${index}/assetId`);
    if (!visualBindings.comparisonAfterAssetIds.has(assetId)) {
      fail('EDITORIAL_RELATION_INVALID', 'annotatedScreenshots Asset is not the annotation side of a frozen ReportDocument comparison');
    }
  });
  projectIssueFields(
    'annotatedScreenshots',
    [{ name: 'annotation', role: 'claim' }],
    (issueId) => issueBasis.get(issueId)!,
  );
  projectIssueFields(
    'remediations',
    [{ name: 'action', role: 'recommendation' }, { name: 'acceptanceCriteria', role: 'validation' }],
    (issueId, name, created) => name === 'acceptanceCriteria'
      ? uniqueStrings([...issueBasis.get(issueId)!, ...created])
      : [...issueBasis.get(issueId)!, ...(principleIds.get(issueId) ?? []), ...(severityIds.get(issueId) ?? [])],
    remediationIds,
  );
  projectIssueFields(
    'retests',
    [{ name: 'method', role: 'validation' }, { name: 'expectedResult', role: 'validation' }],
    (issueId) => [...issueBasis.get(issueId)!, ...(remediationIds.get(issueId) ?? [])],
  );
}

function projectAccessibility(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = record(payloadValue, 'accessibility payload');
  list(payload.platforms, 'platforms').forEach((raw, index) => {
    const item = record(raw, `platforms/${index}`);
    const groupId = `a11y-platform:${index}`;
    const name = builder.addUnit({ pointer: `/payload/platforms/${index}/name`, value: scalar(item.name, 'platform name'), role: 'context', groupId, requiredInBody: true });
    builder.addUnit({ pointer: `/payload/platforms/${index}/assistiveTechnology`, value: scalar(item.assistiveTechnology, 'assistive technology'), role: 'audit', groupId, basisUnitIds: [name.id], requiredInBody: true });
    builder.addUnit({ pointer: `/payload/platforms/${index}/browser`, value: scalar(item.browser, 'browser'), role: 'audit', groupId, basisUnitIds: [name.id], requiredInBody: true });
  });
  const knownIssueIds = new Set<string>();
  for (const field of ['pourPrinciples', 'components', 'conformanceLevels', 'priorities', 'screenReaderBehavior', 'remediations', 'verification'] as const) {
    list(payload[field], field).forEach((raw, index) => knownIssueIds.add(identifier(record(raw, `${field}/${index}`).issueId, `${field} issueId`)));
  }
  const addFields = (
    field: string,
    specs: Array<{ name: string; role: UnitRole; requiredInBody?: boolean }>,
    basisFor: (issueId: string, name: string, created: readonly string[]) => string[],
    collectInto?: Map<string, string[]>,
  ): void => {
    list(payload[field], field).forEach((raw, index) => {
      const item = record(raw, `${field}/${index}`);
      const issueId = identifier(item.issueId, `${field} issueId`);
      if (!knownIssueIds.has(issueId)) fail('EDITORIAL_RELATION_INVALID', `${field} has invalid issue ${issueId}`);
      const created: string[] = [];
      for (const spec of specs) {
        const unitBasis = basisFor(issueId, spec.name, created);
        created.push(builder.addUnit({ pointer: `/payload/${field}/${index}/${spec.name}`, value: scalar(item[spec.name], `${field} ${spec.name}`), role: spec.role, groupId: `a11y-issue:${issueId}`, basisUnitIds: unitBasis, requiredInBody: spec.requiredInBody }).id);
      }
      if (collectInto) collectInto.set(issueId, uniqueStrings([...(collectInto.get(issueId) ?? []), ...created]));
    });
  };
  const principleIds = new Map<string, string[]>();
  const componentIds = new Map<string, string[]>();
  const conformanceIds = new Map<string, string[]>();
  const observedIds = new Map<string, string[]>();
  const expectedIds = new Map<string, string[]>();
  const remediationIds = new Map<string, string[]>();
  addFields('pourPrinciples', [{ name: 'principle', role: 'claim' }, { name: 'rationale', role: 'claim' }], () => [], principleIds);
  list(payload.components, 'components').forEach((raw, index) => {
    const item = record(raw, `components/${index}`);
    const issueId = identifier(item.issueId, 'components issueId');
    if (!knownIssueIds.has(issueId)) fail('EDITORIAL_RELATION_INVALID', `components has invalid issue ${issueId}`);
    const groupId = `a11y-issue:${issueId}`;
    const component = builder.addUnit({
      pointer: `/payload/components/${index}/component`,
      value: scalar(item.component, 'components component'),
      role: 'context',
      groupId,
      requiredInBody: true,
    });
    builder.addUnit({
      pointer: `/payload/components/${index}/selector`,
      value: scalar(item.selector, 'components selector'),
      role: 'audit',
      groupId,
      basisUnitIds: [component.id],
    });
    componentIds.set(issueId, [...(componentIds.get(issueId) ?? []), component.id]);
  });
  addFields('conformanceLevels', [{ name: 'level', role: 'claim' }, { name: 'criterion', role: 'claim' }], (issueId) => componentIds.get(issueId) ?? [], conformanceIds);
  list(payload.screenReaderBehavior, 'screenReaderBehavior').forEach((raw, index) => {
    const item = record(raw, `screenReaderBehavior/${index}`);
    const issueId = identifier(item.issueId, 'screenReaderBehavior issueId');
    if (!knownIssueIds.has(issueId)) fail('EDITORIAL_RELATION_INVALID', `screenReaderBehavior has invalid issue ${issueId}`);
    const groupId = `a11y-issue:${issueId}`;
    const observed = builder.addUnit({
      pointer: `/payload/screenReaderBehavior/${index}/observed`,
      value: scalar(item.observed, 'screenReaderBehavior observed'),
      role: 'claim',
      groupId,
      basisUnitIds: componentIds.get(issueId) ?? [],
    });
    const expected = builder.addUnit({
      pointer: `/payload/screenReaderBehavior/${index}/expected`,
      value: scalar(item.expected, 'screenReaderBehavior expected'),
      role: 'validation',
      groupId,
      basisUnitIds: [observed.id],
    });
    observedIds.set(issueId, [...(observedIds.get(issueId) ?? []), observed.id]);
    expectedIds.set(issueId, [...(expectedIds.get(issueId) ?? []), expected.id]);
  });
  const behaviorBasis = (issueId: string): string[] => [
    ...(principleIds.get(issueId) ?? []),
    ...(conformanceIds.get(issueId) ?? []),
    ...(observedIds.get(issueId) ?? []),
  ];
  addFields('priorities', [{ name: 'level', role: 'claim' }, { name: 'rationale', role: 'claim' }], behaviorBasis);
  addFields('remediations', [{ name: 'action', role: 'recommendation' }], behaviorBasis, remediationIds);
  addFields(
    'verification',
    [{ name: 'method', role: 'validation' }, { name: 'expectedResult', role: 'validation' }],
    (issueId) => [
      ...(remediationIds.get(issueId) ?? []),
      ...(observedIds.get(issueId) ?? []),
      ...(expectedIds.get(issueId) ?? []),
    ],
  );
}

function visualKey(assetId: string, manifestArtifactId: string): string {
  return `${assetId}\u0000${manifestArtifactId}`;
}

function materializeVisualAssets(builder: MaterialBuilder, document: ReportDocument): void {
  if (!builder.reportDocumentArtifact) fail('SOURCE_INTEGRITY', 'multimodal source has no ReportDocument Artifact');
  const verified = new Map(builder.source.verifiedVisualAssets.map((asset) => [
    visualKey(asset.artifact.id, asset.manifestArtifact.id),
    asset,
  ]));
  const accepted = (asset: VerifiedVisualAsset): boolean => {
    if (asset.manifest.exportPolicy === 'mask') {
      builder.warnings.push(createEditorialVisualWarning('VISUAL_MASK_OMITTED'));
      return false;
    }
    if (asset.manifest.exportPolicy === 'block') {
      builder.warnings.push(createEditorialVisualWarning('VISUAL_BLOCKED_OMITTED'));
      return false;
    }
    if (asset.manifest.mediaType === 'image/svg+xml') {
      builder.warnings.push(createEditorialVisualWarning('VISUAL_SVG_OMITTED'));
      return false;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.manifest.mediaType)) {
      fail('VISUAL_POLICY', `unsupported visual media type ${asset.manifest.mediaType}`);
    }
    return true;
  };
  const addAsset = (input: {
    asset: VerifiedVisualAsset;
    sectionIndex: number;
    blockIndex: number;
    caption: string;
    altText: string;
    evidenceIds: string[];
    visualRole: EditorialMaterialAsset['visualRole'];
    comparisonGroupId?: string;
    derivedFromAssetId?: string;
    captionUnitId?: string;
    altTextUnitId?: string;
  }): { captionUnitId: string; altTextUnitId: string } => {
    const blockPointer = `/sections/${input.sectionIndex}/blocks/${input.blockIndex}`;
    const captionUnitId = input.captionUnitId ?? builder.addUnit({ pointer: `${blockPointer}/caption`, value: input.caption, role: 'context', groupId: `visual:${input.comparisonGroupId ?? input.asset.artifact.id}`, evidenceIds: input.evidenceIds, artifact: builder.reportDocumentArtifact! }).id;
    const altTextUnitId = input.altTextUnitId ?? builder.addUnit({ pointer: `${blockPointer}/altText`, value: input.altText, role: 'audit', groupId: `visual:${input.comparisonGroupId ?? input.asset.artifact.id}`, evidenceIds: input.evidenceIds, artifact: builder.reportDocumentArtifact! }).id;
    const digest = canonicalSha256(['editorial-material-asset-v1', input.asset.artifact.id, input.asset.manifestArtifact.id, blockPointer]);
    builder.assets.push({
      id: `ema_${digest.slice('sha256:'.length)}`,
      assetId: input.asset.artifact.id,
      manifestArtifactId: input.asset.manifestArtifact.id,
      visualRole: input.visualRole,
      mediaType: input.asset.manifest.mediaType as 'image/png' | 'image/jpeg' | 'image/webp',
      byteSize: input.asset.bytes.byteLength,
      width: input.asset.manifest.width,
      height: input.asset.manifest.height,
      exportPolicy: 'allow',
      captionUnitId,
      altTextUnitId,
      evidenceIds: uniqueStrings(input.evidenceIds),
      sourceRefs: [{ artifactId: builder.reportDocumentArtifact!.artifactId, jsonPointer: blockPointer }],
      ...(input.comparisonGroupId === undefined ? {} : { comparisonGroupId: input.comparisonGroupId }),
      ...(input.derivedFromAssetId === undefined ? {} : { derivedFromAssetId: input.derivedFromAssetId }),
    });
    return { captionUnitId, altTextUnitId };
  };
  document.sections.forEach((section, sectionIndex) => section.blocks.forEach((block, blockIndex) => {
    if (block.type === 'chart') {
      builder.warnings.push(createEditorialVisualWarning('VISUAL_SVG_OMITTED'));
      return;
    }
    if (block.type === 'image') {
      const asset = verified.get(visualKey(block.assetRef.assetId, block.assetRef.manifestArtifactId));
      if (!asset) fail('SOURCE_INTEGRITY', `ReportDocument image ${block.id} has no frozen verified Asset`);
      if (!accepted(asset)) return;
      addAsset({ asset, sectionIndex, blockIndex, caption: block.caption, altText: block.altText, evidenceIds: block.evidenceIds ?? [], visualRole: 'standalone' });
      return;
    }
    if (block.type !== 'image-comparison') return;
    const before = verified.get(visualKey(block.beforeAssetRef.assetId, block.beforeAssetRef.manifestArtifactId));
    const after = verified.get(visualKey(block.afterAssetRef.assetId, block.afterAssetRef.manifestArtifactId));
    if (!before || !after) fail('SOURCE_INTEGRITY', `ReportDocument comparison ${block.id} has no frozen verified pair`);
    const lineage = after.manifest.derivedFrom;
    if (
      !lineage
      || lineage.assetId !== before.artifact.id
      || lineage.manifestArtifactId !== before.manifestArtifact.id
      || lineage.contentSha256 !== before.artifact.contentSha256
      || lineage.manifestHash !== before.manifest.manifestHash
    ) {
      fail('EDITORIAL_RELATION_INVALID', `ReportDocument comparison ${block.id} lineage is invalid`);
    }
    const beforeAllowed = accepted(before);
    const afterAllowed = accepted(after);
    if (!beforeAllowed || !afterAllowed) return;
    const sharedCopy = addAsset({ asset: before, sectionIndex, blockIndex, caption: block.caption, altText: block.altText, evidenceIds: block.evidenceIds ?? [], visualRole: 'comparison-before', comparisonGroupId: block.id });
    addAsset({ asset: after, sectionIndex, blockIndex, caption: block.caption, altText: block.altText, evidenceIds: block.evidenceIds ?? [], visualRole: 'comparison-after', comparisonGroupId: block.id, derivedFromAssetId: before.artifact.id, ...sharedCopy });
  }));
}

function projectPayload(builder: MaterialBuilder, deliverable: ResearchDeliverableEnvelope<unknown>): void {
  switch (deliverable.deliverableType) {
    case 'research_plan': return projectResearchPlan(builder, deliverable.payload);
    case 'competitive_analysis_report': return projectCompetitive(builder, deliverable.payload);
    case 'voc_diagnosis_report': return projectVoc(builder, deliverable.payload);
    case 'design_audit_report': return projectDesignAudit(builder, deliverable.payload);
    case 'accessibility_audit_report': return projectAccessibility(builder, deliverable.payload);
    default: fail('EDITORIAL_DELIVERABLE_UNSUPPORTED', `unsupported deliverable ${deliverable.deliverableType}`);
  }
}

export function materializeEditorialReport(source: FrozenEditorialSource): EditorialMaterializationResult {
  const deliverableArtifact = findArtifact(source, source.reportPackage.value.deliverableArtifactId, 'Deliverable');
  const evidenceManifestArtifact = findArtifact(source, source.reportPackage.value.evidenceManifestArtifactId, 'Evidence Manifest');
  const reportDocumentArtifact = source.reportPackage.value.reportDocumentArtifactId === undefined
    ? null
    : findArtifact(source, source.reportPackage.value.reportDocumentArtifactId, 'ReportDocument');
  const builder = new MaterialBuilder(source, deliverableArtifact, evidenceManifestArtifact, reportDocumentArtifact);
  const deliverable = source.current.deliverable;
  const methodSummaryUnitId = projectFindingGraph(builder, deliverable);
  projectPayload(builder, deliverable);
  if (source.current.presentationMode === 'multimodal') {
    materializeVisualAssets(builder, source.current.reportDocument);
  }
  const material: EditorialMaterial = {
    version: EDITORIAL_MATERIAL_VERSION,
    taskId: source.binding.taskId,
    planVersionId: source.binding.planVersionId,
    attemptId: source.binding.attemptId,
    deliverableType: deliverable.deliverableType as EditorialMaterial['deliverableType'],
    presentationMode: source.current.presentationMode,
    sourceReportPackage: findArtifact(source, source.binding.reportPackageArtifactId, 'Report Package'),
    sourceArtifacts: source.sourceArtifacts.map((artifact) => ({ ...artifact })),
    materializationWarningCodes: builder.warnings.map(({ code }) => code),
    ...(builder.titleUnitId === undefined ? {} : { titleUnitId: builder.titleUnitId }),
    methodSummaryUnitId,
    units: builder.units,
    assets: builder.assets,
    evidence: builder.evidence(),
  };
  assertValidEditorialMaterial(material);
  const materialBytes = canonicalJsonBytes(material);
  const materialHash = hashBytes(materialBytes);
  const projected = projectEditorialModelContext(material);
  return {
    material,
    materialBytes,
    materialHash,
    modelContext: projected.context,
    modelContextBytes: Buffer.from(projected.bytes),
    modelContextHash: projected.hash,
    modelContextByteSize: projected.byteSize,
    sourcePolicyMetadata: source.sourcePolicyMetadata.map((metadata) => ({ ...metadata })),
    warnings: builder.warnings,
  };
}
