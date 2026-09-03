import type {
  EvidenceEntry,
  IndustryMarketAnalysisPayloadV1,
  IndustryMarketSupportV1,
  ResearchDeliverableEnvelope,
  ResearchStrategyReportPayloadV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReadableReportDocument,
  ReportBlockV1V2,
  ReportBlockV3,
  ReportBlockV4,
} from '../../../../packages/api-contract/report-document.ts';
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

function projectResearchStrategy(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = payloadValue as ResearchStrategyReportPayloadV2;
  if (payload?.schemaVersion !== 'research-strategy-content-v2') {
    fail('EDITORIAL_PAYLOAD_INVALID', 'research_strategy_report requires research-strategy-content-v2');
  }
  const support = (binding: {
    questionIds: string[];
    evidenceIds: string[];
    status: 'supported' | 'provisional';
  }) => ({
    questionIds: binding.questionIds,
    evidenceIds: binding.evidenceIds,
    epistemicStatus: binding.status === 'supported' ? 'fact' as const : 'inference' as const,
  });

  const title = builder.addUnit({
    pointer: '/payload/title',
    value: payload.title,
    role: 'context',
    groupId: 'strategy-report',
    requiredInBody: true,
  });
  builder.titleUnitId = title.id;
  const decisionContext = builder.addUnit({
    pointer: '/payload/decisionContext',
    value: payload.decisionContext,
    role: 'context',
    groupId: 'strategy-report',
    requiredInBody: true,
  });
  builder.addUnit({
    pointer: '/payload/executiveAnswer',
    value: payload.executiveAnswer,
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'strategy-report',
    basisUnitIds: [decisionContext.id],
    requiredInBody: true,
  });

  payload.directAnswers.forEach((answer, index) => {
    const groupId = `strategy-answer:${identifier(answer.questionId, `directAnswers/${index}/questionId`)}`;
    const question = builder.addUnit({
      pointer: `/payload/directAnswers/${index}/question`,
      value: answer.question,
      role: 'context',
      groupId,
      questionIds: [answer.questionId],
      requiredInBody: true,
    });
    const answerUnit = builder.addUnit({
      pointer: `/payload/directAnswers/${index}/answer`,
      value: answer.answer,
      role: 'claim',
      epistemicStatus: answer.answerStatus === 'unanswered' ? 'unknown' : 'inference',
      groupId,
      basisUnitIds: [question.id],
      evidenceIds: answer.evidenceIds,
      questionIds: [answer.questionId],
      requiredInBody: true,
    });
    builder.addUnit({
      pointer: `/payload/directAnswers/${index}/businessImplication`,
      value: answer.businessImplication,
      role: 'claim',
      epistemicStatus: answer.answerStatus === 'unanswered' ? 'unknown' : 'inference',
      groupId,
      basisUnitIds: [answerUnit.id],
      evidenceIds: answer.evidenceIds,
      questionIds: [answer.questionId],
      requiredInBody: true,
    });
    builder.addUnit({
      pointer: `/payload/directAnswers/${index}/recommendedAction`,
      value: answer.recommendedAction,
      role: 'recommendation',
      groupId,
      basisUnitIds: [answerUnit.id],
      evidenceIds: answer.evidenceIds,
      questionIds: [answer.questionId],
      requiredInBody: true,
    });
    if (answer.validationNeeded.trim()) {
      builder.addUnit({
        pointer: `/payload/directAnswers/${index}/validationNeeded`,
        value: answer.validationNeeded,
        role: 'validation',
        groupId,
        basisUnitIds: [answerUnit.id],
        questionIds: [answer.questionId],
        requiredInBody: true,
      });
    }
  });

  payload.evidenceFindings.forEach((finding, index) => {
    builder.addUnit({
      pointer: `/payload/evidenceFindings/${index}/statement`,
      value: finding.statement,
      role: 'claim',
      ...support(finding.support),
      groupId: `strategy-finding:${identifier(finding.id, `evidenceFindings/${index}/id`)}`,
      requiredInBody: true,
    });
  });

  payload.contentBlocks.forEach((block, blockIndex) => {
    const groupId = `strategy-content:${block.kind}:${identifier(block.id, `contentBlocks/${blockIndex}/id`)}`;
    const titleUnit = builder.addUnit({
      pointer: `/payload/contentBlocks/${blockIndex}/title`,
      value: block.title,
      role: 'context',
      groupId,
      requiredInBody: true,
    });
    if (block.kind === 'narrative') {
      builder.addUnit({
        pointer: `/payload/contentBlocks/${blockIndex}/content`,
        value: block.content,
        role: 'claim',
        ...support(block.support),
        groupId,
        basisUnitIds: [titleUnit.id],
      });
      return;
    }
    if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      const rowUnits = new Map(block.rows.map((row, rowIndex) => {
        const unit = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/rows/${rowIndex}`,
          value: row,
          role: 'context',
          groupId,
          basisUnitIds: [titleUnit.id],
          requiredInBody: true,
        });
        return [row, unit.id] as const;
      }));
      const columnUnits = new Map(block.columns.map((column, columnIndex) => {
        const unit = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/columns/${columnIndex}`,
          value: column,
          role: 'context',
          groupId,
          basisUnitIds: [titleUnit.id],
          requiredInBody: true,
        });
        return [column, unit.id] as const;
      }));
      block.cells.forEach((cell, cellIndex) => builder.addUnit({
        pointer: `/payload/contentBlocks/${blockIndex}/cells/${cellIndex}/statement`,
        value: cell.statement,
        role: 'claim',
        ...support(cell.support),
        groupId,
        basisUnitIds: [
          titleUnit.id,
          rowUnits.get(cell.row),
          columnUnits.get(cell.column),
        ].filter((id): id is string => id !== undefined),
      }));
      return;
    }
    if (block.kind === 'mind_model') {
      const nodeIds = new Map<string, string>();
      block.nodes.forEach((node, nodeIndex) => {
        const nodeUnit = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/nodes/${nodeIndex}/description`,
          value: `${node.label}：${node.description}`,
          role: 'claim',
          ...support(node.support),
          groupId,
          basisUnitIds: [titleUnit.id],
        });
        nodeIds.set(node.id, nodeUnit.id);
      });
      block.edges.forEach((edge, edgeIndex) => builder.addUnit({
        pointer: `/payload/contentBlocks/${blockIndex}/edges/${edgeIndex}/relationship`,
        value: edge.relationship,
        role: 'context',
        groupId,
        basisUnitIds: [
          nodeIds.get(edge.from),
          nodeIds.get(edge.to),
        ].filter((id): id is string => id !== undefined),
        requiredInBody: true,
      }));
      return;
    }
    if (block.kind === 'design_principles') {
      block.items.forEach((item, itemIndex) => {
        const itemTitle = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/title`,
          value: item.title,
          role: 'context',
          groupId,
          basisUnitIds: [titleUnit.id],
          requiredInBody: true,
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/statement`,
          value: item.statement,
          role: 'claim',
          ...support(item.support),
          groupId,
          basisUnitIds: [itemTitle.id],
        });
      });
      return;
    }
    if (block.kind === 'opportunity_backlog') {
      block.items.forEach((item, itemIndex) => {
        const opportunity = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/statement`,
          value: `${item.title}：${item.statement}`,
          role: 'claim',
          ...support(item.support),
          groupId,
          basisUnitIds: [titleUnit.id],
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/impact`,
          value: item.impact,
          role: 'claim',
          ...support(item.support),
          groupId,
          basisUnitIds: [opportunity.id],
        });
      });
      return;
    }
    if (block.kind === 'prioritized_actions' || block.kind === 'action_plan') {
      block.items.forEach((item, itemIndex) => {
        const action = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/action`,
          value: item.action,
          role: 'recommendation',
          groupId,
          basisUnitIds: [titleUnit.id],
          evidenceIds: item.support.evidenceIds,
          questionIds: item.support.questionIds,
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/priority`,
          value: item.priority,
          role: 'context',
          groupId,
          basisUnitIds: [action.id],
          requiredInBody: true,
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/rationale`,
          value: item.rationale,
          role: 'claim',
          ...support(item.support),
          groupId,
          basisUnitIds: [action.id],
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/validationMethod`,
          value: item.validationMethod,
          role: 'validation',
          groupId,
          basisUnitIds: [action.id],
          questionIds: item.support.questionIds,
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/ownerType`,
          value: item.ownerType,
          role: 'audit',
          groupId,
          basisUnitIds: [action.id],
        });
      });
      return;
    }
    if (block.kind === 'channel_strategies') {
      block.items.forEach((item, itemIndex) => {
        const channel = builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/channel`,
          value: item.channel,
          role: 'context',
          groupId,
          basisUnitIds: [titleUnit.id],
          requiredInBody: true,
        });
        builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/role`,
          value: item.role,
          role: 'claim',
          ...support(item.support),
          groupId,
          basisUnitIds: [channel.id],
        });
        item.strategies.forEach((strategy, strategyIndex) => builder.addUnit({
          pointer: `/payload/contentBlocks/${blockIndex}/items/${itemIndex}/strategies/${strategyIndex}`,
          value: strategy,
          role: 'recommendation',
          groupId,
          basisUnitIds: [channel.id],
          evidenceIds: item.support.evidenceIds,
          questionIds: item.support.questionIds,
        }));
      });
      return;
    }
    fail('EDITORIAL_PAYLOAD_INVALID', `unsupported research strategy block ${String((block as { kind?: unknown }).kind)}`);
  });

  payload.limitations.forEach((value, index) => builder.addUnit({
    pointer: `/payload/limitations/${index}`,
    value,
    role: 'risk',
    groupId: `strategy-limitation:${index}`,
  }));
  payload.openQuestions.forEach((value, index) => builder.addUnit({
    pointer: `/payload/openQuestions/${index}`,
    value,
    role: 'risk',
    groupId: `strategy-open-question:${index}`,
  }));
  payload.riskDisclosures.forEach((risk, index) => builder.addUnit({
    pointer: `/payload/riskDisclosures/${index}/statement`,
    value: risk.statement,
    role: 'risk',
    groupId: `strategy-risk:${identifier(risk.id, `riskDisclosures/${index}/id`)}`,
  }));
  payload.requestedArtifactBindings.forEach((binding, index) => builder.addUnit({
    pointer: `/payload/requestedArtifactBindings/${index}/artifactType`,
    value: binding.artifactType,
    role: 'audit',
    groupId: `strategy-requested-artifact:${index}`,
    evidenceIds: binding.evidenceIds,
    questionIds: binding.questionIds,
  }));
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

type AnyReportBlock = ReportBlockV1V2 | ReportBlockV3 | ReportBlockV4;

function indexedReportBlocks(document: ReadableReportDocument): Array<{
  block: AnyReportBlock;
  sectionIndex: number;
  blockIndex: number;
}> {
  const sections = document.sections as ReadonlyArray<{ blocks: readonly AnyReportBlock[] }>;
  return sections.flatMap((section, sectionIndex) => section.blocks.map((block, blockIndex) => ({
    block,
    sectionIndex,
    blockIndex,
  })));
}

function reportBlockEvidenceIds(
  document: ReadableReportDocument,
  block: AnyReportBlock,
): string[] {
  if ('evidenceIds' in block && Array.isArray(block.evidenceIds)) {
    return uniqueStrings(block.evidenceIds);
  }
  if (!('traceIndex' in document) || !('leafRefs' in block)) return [];
  return uniqueStrings(block.leafRefs.flatMap((leafId) => (
    document.traceIndex[leafId]?.evidenceIds ?? []
  )));
}

function reportVisualBindings(builder: MaterialBuilder): ReportVisualBindings {
  const bindings: ReportVisualBindings = {
    standaloneAssetIds: new Set(),
    comparisonPairs: new Set(),
    comparisonAfterAssetIds: new Set(),
  };
  if (builder.source.current.presentationMode !== 'multimodal') return bindings;
  for (const { block } of indexedReportBlocks(builder.source.current.reportDocument)) {
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

function materializeVisualAssets(builder: MaterialBuilder, document: ReadableReportDocument): void {
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
  for (const { block, sectionIndex, blockIndex } of indexedReportBlocks(document)) {
    if (block.type === 'chart') {
      builder.warnings.push(createEditorialVisualWarning('VISUAL_SVG_OMITTED'));
      continue;
    }
    if (block.type === 'image') {
      const asset = verified.get(visualKey(block.assetRef.assetId, block.assetRef.manifestArtifactId));
      if (!asset) fail('SOURCE_INTEGRITY', `ReportDocument image ${block.id} has no frozen verified Asset`);
      if (!accepted(asset)) continue;
      addAsset({
        asset,
        sectionIndex,
        blockIndex,
        caption: block.caption,
        altText: block.altText,
        evidenceIds: reportBlockEvidenceIds(document, block),
        visualRole: 'standalone',
      });
      continue;
    }
    if (block.type !== 'image-comparison') continue;
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
    if (!beforeAllowed || !afterAllowed) continue;
    const evidenceIds = reportBlockEvidenceIds(document, block);
    const sharedCopy = addAsset({ asset: before, sectionIndex, blockIndex, caption: block.caption, altText: block.altText, evidenceIds, visualRole: 'comparison-before', comparisonGroupId: block.id });
    addAsset({ asset: after, sectionIndex, blockIndex, caption: block.caption, altText: block.altText, evidenceIds, visualRole: 'comparison-after', comparisonGroupId: block.id, derivedFromAssetId: before.artifact.id, ...sharedCopy });
  }
}

function reportDocumentTitle(document: ReadableReportDocument): string | undefined {
  return typeof document.title === 'string'
    ? document.title
    : document.title.text;
}

function projectIndustryMarket(builder: MaterialBuilder, payloadValue: unknown): void {
  const payload = payloadValue as IndustryMarketAnalysisPayloadV1;
  if (payload?.schemaVersion !== 'industry-market-analysis-v1') {
    fail('EDITORIAL_PAYLOAD_INVALID', 'industry_market_analysis_report requires industry-market-analysis-v1');
  }
  const epistemicStatus = (support: IndustryMarketSupportV1): EpistemicStatus => (
    support.status === 'supported' ? 'fact' : support.status === 'provisional' ? 'inference' : 'unknown'
  );
  const addSupported = (input: {
    pointer: string;
    value: string | number | boolean;
    role: 'claim' | 'recommendation' | 'validation';
    groupId: string;
    support: IndustryMarketSupportV1;
    requiredInBody?: boolean;
  }): EditorialMaterialUnit => builder.addUnit({
    ...input,
    ...(input.role === 'claim' ? { epistemicStatus: epistemicStatus(input.support) } : {}),
    evidenceIds: input.support.evidenceIds,
    questionIds: input.support.questionIds,
  });
  const projectClaims = (
    values: readonly { id: string; title: string; statement: string; support: IndustryMarketSupportV1 }[],
    pointer: string,
    groupPrefix: string,
  ): void => values.forEach((item, index) => {
    const groupId = `${groupPrefix}:${item.id}`;
    builder.addUnit({ pointer: `${pointer}/${index}/title`, value: item.title, role: 'context', groupId });
    addSupported({ pointer: `${pointer}/${index}/statement`, value: item.statement, role: 'claim', groupId, support: item.support });
    if (item.support.validationNeeded) {
      builder.addUnit({ pointer: `${pointer}/${index}/support/validationNeeded`, value: item.support.validationNeeded, role: 'validation', groupId, evidenceIds: item.support.evidenceIds, questionIds: item.support.questionIds });
    }
  });

  const title = builder.addUnit({ pointer: '/payload/title', value: payload.title, role: 'context', groupId: 'industry-report', requiredInBody: true });
  builder.titleUnitId = title.id;
  const scope = payload.scope;
  builder.addUnit({ pointer: '/payload/scope/category', value: scope.category, role: 'context', groupId: 'industry-scope', requiredInBody: true });
  scope.subcategories.forEach((value, index) => builder.addUnit({ pointer: `/payload/scope/subcategories/${index}`, value, role: 'context', groupId: 'industry-scope' }));
  scope.exclusions.forEach((value, index) => builder.addUnit({ pointer: `/payload/scope/exclusions/${index}`, value, role: 'audit', groupId: 'industry-scope' }));
  for (const [field, value] of [
    ['analysisDepth', scope.analysisDepth],
    ['primaryFocus', scope.primaryFocus],
    ['decisionGoal', scope.decisionGoal],
    ['timeWindow', scope.timeWindow],
  ] as const) builder.addUnit({ pointer: `/payload/scope/${field}`, value, role: 'context', groupId: 'industry-scope' });
  scope.secondaryFocuses.forEach((value, index) => builder.addUnit({ pointer: `/payload/scope/secondaryFocuses/${index}`, value, role: 'context', groupId: 'industry-scope' }));
  scope.decisionAudience.forEach((value, index) => builder.addUnit({ pointer: `/payload/scope/decisionAudience/${index}`, value, role: 'context', groupId: 'industry-scope' }));

  payload.coverageLedger.forEach((entry, index) => {
    const groupId = `industry-coverage:${entry.dimension}`;
    builder.addUnit({ pointer: `/payload/coverageLedger/${index}/dimension`, value: entry.dimension, role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/coverageLedger/${index}/status`, value: entry.status, role: 'audit', groupId });
    builder.addUnit({ pointer: `/payload/coverageLedger/${index}/summary`, value: entry.summary, role: entry.status === 'unavailable' ? 'validation' : 'claim', epistemicStatus: entry.status === 'supported' ? 'fact' : entry.status === 'partial' ? 'inference' : 'unknown', groupId, evidenceIds: entry.evidenceIds, requiredInBody: true });
  });

  const sections = [
    ['marketLandscape', payload.marketLandscape, 'industry-market'],
    ['supplyLandscape', payload.supplyLandscape, 'industry-supply'],
    ['jdDiagnosis', payload.jdDiagnosis, 'industry-jd-diagnosis'],
    ['designLanguage', payload.designLanguage, 'industry-design-language'],
  ] as const;
  for (const [key, section, groupId] of sections) {
    const sectionEvidenceIds = uniqueStrings(section.items.flatMap(({ support }) => support.evidenceIds));
    const sectionQuestionIds = uniqueStrings(section.items.flatMap(({ support }) => support.questionIds));
    builder.addUnit({ pointer: `/payload/${key}/summary`, value: section.summary, role: section.status === 'unavailable' ? 'validation' : section.status === 'supported' && sectionEvidenceIds.length === 0 ? 'context' : 'claim', epistemicStatus: section.status === 'supported' ? 'fact' : section.status === 'provisional' ? 'inference' : 'unknown', groupId, evidenceIds: sectionEvidenceIds, questionIds: sectionQuestionIds, requiredInBody: true });
    projectClaims(section.items, `/payload/${key}/items`, groupId);
  }

  const audience = payload.audienceSegments;
  const audienceEvidenceIds = uniqueStrings([
    ...audience.items,
    ...audience.segments,
    ...audience.personas,
    ...audience.differences,
    ...audience.designImplications,
  ].flatMap(({ support }) => support.evidenceIds));
  const audienceQuestionIds = uniqueStrings([
    ...audience.items,
    ...audience.segments,
    ...audience.personas,
    ...audience.differences,
    ...audience.designImplications,
  ].flatMap(({ support }) => support.questionIds));
  builder.addUnit({ pointer: '/payload/audienceSegments/summary', value: audience.summary, role: audience.status === 'unavailable' ? 'validation' : audience.status === 'supported' && audienceEvidenceIds.length === 0 ? 'context' : 'claim', epistemicStatus: audience.status === 'supported' ? 'fact' : audience.status === 'provisional' ? 'inference' : 'unknown', groupId: 'industry-audience', evidenceIds: audienceEvidenceIds, questionIds: audienceQuestionIds, requiredInBody: true });
  builder.addUnit({ pointer: '/payload/audienceSegments/basisType', value: audience.basisType, role: 'audit', groupId: 'industry-audience' });
  builder.addUnit({ pointer: '/payload/audienceSegments/sampleCoverage', value: audience.sampleCoverage, role: 'audit', groupId: 'industry-audience' });
  projectClaims(audience.items, '/payload/audienceSegments/items', 'industry-audience-item');
  projectClaims(audience.segments, '/payload/audienceSegments/segments', 'industry-segment');
  projectClaims(audience.personas, '/payload/audienceSegments/personas', 'industry-persona');
  projectClaims(audience.differences, '/payload/audienceSegments/differences', 'industry-audience-difference');
  projectClaims(audience.designImplications, '/payload/audienceSegments/designImplications', 'industry-audience-implication');

  const competitor = payload.competitorAnalysis;
  const competitorEvidenceIds = uniqueStrings([
    ...competitor.items.flatMap(({ support }) => support.evidenceIds),
    ...competitor.competitorSamples.flatMap(({ evidenceIds }) => evidenceIds),
    ...competitor.dimensionMatrix.flatMap(({ values }) => values.flatMap(({ evidenceIds }) => evidenceIds)),
    ...competitor.differences.flatMap(({ support }) => support.evidenceIds),
    ...competitor.impacts.flatMap(({ support }) => support.evidenceIds),
  ]);
  const competitorQuestionIds = uniqueStrings([
    ...competitor.items,
    ...competitor.differences,
    ...competitor.impacts,
  ].flatMap(({ support }) => support.questionIds));
  builder.addUnit({ pointer: '/payload/competitorAnalysis/summary', value: competitor.summary, role: competitor.status === 'unavailable' ? 'validation' : competitor.status === 'supported' && competitorEvidenceIds.length === 0 ? 'context' : 'claim', epistemicStatus: competitor.status === 'supported' ? 'fact' : competitor.status === 'provisional' ? 'inference' : 'unknown', groupId: 'industry-competition', evidenceIds: competitorEvidenceIds, questionIds: competitorQuestionIds, requiredInBody: true });
  projectClaims(competitor.items, '/payload/competitorAnalysis/items', 'industry-competitor-item');
  competitor.competitorSamples.forEach((sample, index) => {
    const groupId = `industry-competitor:${sample.id}`;
    builder.addUnit({ pointer: `/payload/competitorAnalysis/competitorSamples/${index}/name`, value: sample.name, role: 'context', groupId, evidenceIds: sample.evidenceIds });
    builder.addUnit({ pointer: `/payload/competitorAnalysis/competitorSamples/${index}/rationale`, value: sample.rationale, role: 'audit', groupId, evidenceIds: sample.evidenceIds });
  });
  competitor.dimensionMatrix.forEach((row, rowIndex) => {
    const groupId = `industry-competitor-matrix:${rowIndex}`;
    builder.addUnit({ pointer: `/payload/competitorAnalysis/dimensionMatrix/${rowIndex}/dimension`, value: row.dimension, role: 'context', groupId });
    row.values.forEach((value, valueIndex) => {
      builder.addUnit({
        pointer: `/payload/competitorAnalysis/dimensionMatrix/${rowIndex}/values/${valueIndex}/value`,
        value: value.value,
        role: 'claim',
        epistemicStatus: value.evidenceIds.length > 0 ? 'fact' : 'inference',
        groupId,
        evidenceIds: value.evidenceIds,
        requiredInBody: true,
      });
    });
  });
  competitor.differences.forEach((item, index) => addSupported({ pointer: `/payload/competitorAnalysis/differences/${index}/statement`, value: item.statement, role: 'claim', groupId: `industry-difference:${item.id}`, support: item.support }));
  competitor.impacts.forEach((item, index) => addSupported({ pointer: `/payload/competitorAnalysis/impacts/${index}/statement`, value: item.statement, role: 'claim', groupId: `industry-impact:${item.differenceId}:${index}`, support: item.support }));

  payload.validatedFindings.forEach((item, index) => addSupported({ pointer: `/payload/validatedFindings/${index}/statement`, value: item.statement, role: 'claim', groupId: `industry-finding:${item.id}`, support: item.support }));
  payload.gapMatrix.forEach((item, index) => {
    const groupId = `industry-gap-matrix:${item.id}`;
    addSupported({ pointer: `/payload/gapMatrix/${index}/userNeed`, value: item.userNeed, role: 'claim', groupId, support: item.support });
    builder.addUnit({ pointer: `/payload/gapMatrix/${index}/jdState`, value: item.jdState, role: 'audit', groupId, evidenceIds: item.support.evidenceIds, questionIds: item.support.questionIds });
    builder.addUnit({ pointer: `/payload/gapMatrix/${index}/competitorSupply`, value: item.competitorSupply, role: 'audit', groupId, evidenceIds: item.support.evidenceIds, questionIds: item.support.questionIds });
    builder.addUnit({ pointer: `/payload/gapMatrix/${index}/gapLevel`, value: item.gapLevel, role: 'context', groupId });
  });
  addSupported({ pointer: '/payload/positioning/statement', value: payload.positioning.statement, role: 'claim', groupId: 'industry-positioning', support: payload.positioning.support, requiredInBody: true });
  payload.positioning.exclusions.forEach((value, index) => builder.addUnit({ pointer: `/payload/positioning/exclusions/${index}`, value, role: 'audit', groupId: 'industry-positioning' }));

  payload.opportunities.forEach((item, index) => {
    const groupId = `industry-requested-artifact:opportunity:${item.id}`;
    builder.addUnit({ pointer: `/payload/opportunities/${index}/title`, value: item.title, role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/opportunities/${index}/priority`, value: item.priority, role: 'context', groupId });
    addSupported({ pointer: `/payload/opportunities/${index}/statement`, value: item.statement, role: 'recommendation', groupId, support: item.support });
  });
  payload.strategyChains.forEach((item, index) => {
    const groupId = `industry-requested-artifact:strategy-chain:${item.id}`;
    builder.addUnit({ pointer: `/payload/strategyChains/${index}/title`, value: item.title, role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/strategyChains/${index}/priority`, value: item.priority, role: 'context', groupId, requiredInBody: item.priority === 'P0' });
    addSupported({ pointer: `/payload/strategyChains/${index}/goal`, value: item.goal, role: 'recommendation', groupId, support: item.support });
    addSupported({ pointer: `/payload/strategyChains/${index}/currentProblem`, value: item.currentProblem, role: 'claim', groupId, support: item.support });
    addSupported({ pointer: `/payload/strategyChains/${index}/competitorReference`, value: item.competitorReference, role: 'claim', groupId, support: item.support });
    addSupported({ pointer: `/payload/strategyChains/${index}/designAction`, value: item.designAction, role: 'recommendation', groupId, support: item.support, requiredInBody: true });
    addSupported({ pointer: `/payload/strategyChains/${index}/measurement`, value: item.measurement, role: 'validation', groupId, support: item.support });
    addSupported({ pointer: `/payload/strategyChains/${index}/validationMethod`, value: item.validationMethod, role: 'validation', groupId, support: item.support });
  });
  payload.categoryAssets.forEach((item, index) => {
    const groupId = `industry-requested-artifact:category-asset:${item.id}`;
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/family`, value: item.family, role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/name`, value: item.name, role: 'context', groupId });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/fitness`, value: item.fitness, role: 'context', groupId });
    addSupported({ pointer: `/payload/categoryAssets/${index}/rationale`, value: item.rationale, role: 'recommendation', groupId, support: item.support });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/reviewStatus`, value: item.reviewStatus, role: 'audit', groupId });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/collectedAt`, value: item.collectedAt, role: 'audit', groupId });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/platformInheritance`, value: item.platformInheritance, role: 'audit', groupId });
    builder.addUnit({ pointer: `/payload/categoryAssets/${index}/categoryDelta`, value: item.categoryDelta, role: 'audit', groupId });
  });
  payload.measurementPlan.forEach((item, index) => {
    const groupId = `industry-requested-artifact:measurement:${item.id}`;
    builder.addUnit({ pointer: `/payload/measurementPlan/${index}/name`, value: item.name, role: 'context', groupId });
    addSupported({ pointer: `/payload/measurementPlan/${index}/definition`, value: item.definition, role: 'claim', groupId, support: item.support });
    if (item.baseline !== null) builder.addUnit({ pointer: `/payload/measurementPlan/${index}/baseline`, value: item.baseline, role: 'context', groupId, metricEligible: typeof item.baseline === 'number', evidenceIds: item.support.evidenceIds });
    if (item.target !== null) builder.addUnit({ pointer: `/payload/measurementPlan/${index}/target`, value: item.target, role: 'context', groupId, metricEligible: typeof item.target === 'number', evidenceIds: item.support.evidenceIds });
    addSupported({ pointer: `/payload/measurementPlan/${index}/validationMethod`, value: item.validationMethod, role: 'validation', groupId, support: item.support });
  });
  payload.dataGaps.forEach((item, index) => {
    const groupId = `industry-data-gap:${item.id}`;
    builder.addUnit({ pointer: `/payload/dataGaps/${index}/statement`, value: item.statement, role: 'risk', groupId, requiredInBody: true });
    builder.addUnit({ pointer: `/payload/dataGaps/${index}/impact`, value: item.impact, role: 'risk', groupId });
    builder.addUnit({ pointer: `/payload/dataGaps/${index}/resolutionPath`, value: item.resolutionPath, role: 'validation', groupId });
  });
}

function projectPayload(builder: MaterialBuilder, deliverable: ResearchDeliverableEnvelope<unknown>): void {
  switch (deliverable.deliverableType) {
    case 'research_plan': return projectResearchPlan(builder, deliverable.payload);
    case 'research_strategy_report': return projectResearchStrategy(builder, deliverable.payload);
    case 'competitive_analysis_report': return projectCompetitive(builder, deliverable.payload);
    case 'voc_diagnosis_report': return projectVoc(builder, deliverable.payload);
    case 'design_audit_report': return projectDesignAudit(builder, deliverable.payload);
    case 'accessibility_audit_report': return projectAccessibility(builder, deliverable.payload);
    case 'industry_market_analysis_report': return projectIndustryMarket(builder, deliverable.payload);
    default: fail('EDITORIAL_DELIVERABLE_UNSUPPORTED', `unsupported deliverable ${deliverable.deliverableType}`);
  }
}

export function materializeEditorialReport(source: FrozenEditorialSource): EditorialMaterializationResult {
  const reportPackage = source.reportPackage.value;
  const reportDocumentArtifactId = reportPackage.version === 'report-package-v2'
    ? reportPackage.sourceReportDocumentArtifactId
    : reportPackage.reportDocumentArtifactId;
  const deliverableArtifact = findArtifact(source, reportPackage.deliverableArtifactId, 'Deliverable');
  const evidenceManifestArtifact = findArtifact(source, reportPackage.evidenceManifestArtifactId, 'Evidence Manifest');
  const reportDocumentArtifact = reportDocumentArtifactId === undefined
    ? null
    : findArtifact(source, reportDocumentArtifactId, 'ReportDocument');
  const builder = new MaterialBuilder(source, deliverableArtifact, evidenceManifestArtifact, reportDocumentArtifact);
  const deliverable = source.current.deliverable;
  const methodSummaryUnitId = projectFindingGraph(builder, deliverable);
  projectPayload(builder, deliverable);
  if (
    builder.titleUnitId === undefined
    && reportDocumentArtifact !== null
    && source.current.presentationMode === 'multimodal'
  ) {
    const title = reportDocumentTitle(source.current.reportDocument)?.trim();
    if (title) {
      builder.titleUnitId = builder.addUnit({
        pointer: '/title',
        value: title,
        role: 'context',
        groupId: 'report-title',
        requiredInBody: true,
        artifact: reportDocumentArtifact,
      }).id;
    }
  }
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
