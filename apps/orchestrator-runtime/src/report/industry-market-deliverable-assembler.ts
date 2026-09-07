import type {
  CapabilityProvenance,
  CurrentRecommendation,
  FindingGraph,
  IndustryMarketAnalysisPayloadV1,
  IndustryMarketClaimV1,
  IndustryMarketContentDraftV1,
  IndustryMarketSupportV1,
  ProblemGraph,
  ResearchDeliverableCoverage,
  ResearchDeliverableEnvelope,
  ResearchContributionBundleV1,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import {
  isFactualEvidenceClass,
  type EvidenceManifest,
} from '../evidence/evidence-service.ts';
import { SchemaValidator } from '../schema/validator.ts';
import type { SynthesisMaterial } from './synthesis-materializer.ts';

interface IndustryPayloadValidator {
  validateFileOrThrow(path: string, value: unknown): void;
}

const DRAFT_SCHEMA = 'schemas/skills/industry-market-content-draft-v1.schema.json';
const PAYLOAD_SCHEMA = 'schemas/deliverables/industry-market-analysis-report.schema.json';
const DIMENSIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;

export class IndustryMarketAssemblyError extends Error {
  constructor(message: string) {
    super(`Industry Market assembly failed: ${message}`);
    this.name = 'IndustryMarketAssemblyError';
  }
}

function fail(message: string): never {
  throw new IndustryMarketAssemblyError(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function expectedScope(requirement: ResearchTaskV2): IndustryMarketAnalysisPayloadV1['scope'] {
  const scope = requirement.industry_scope;
  if (!scope) return fail('finalized Industry requirement has no industry_scope');
  return {
    category: scope.category,
    subcategories: [...scope.subcategories],
    exclusions: [...scope.exclusions],
    analysisDepth: scope.analysis_depth,
    primaryFocus: scope.primary_focus,
    secondaryFocuses: [...scope.secondary_focuses],
    decisionAudience: [...scope.decision_audience],
    decisionGoal: scope.decision_goal,
    timeWindow: scope.time_window,
  };
}

function claimSupports(payload: IndustryMarketAnalysisPayloadV1): IndustryMarketSupportV1[] {
  const sectionClaims = (section: { items: IndustryMarketClaimV1[] }): IndustryMarketClaimV1[] => section.items;
  return [
    ...sectionClaims(payload.marketLandscape),
    ...sectionClaims(payload.audienceSegments),
    ...payload.audienceSegments.segments,
    ...payload.audienceSegments.personas,
    ...payload.audienceSegments.differences,
    ...payload.audienceSegments.designImplications,
    ...sectionClaims(payload.supplyLandscape),
    ...sectionClaims(payload.competitorAnalysis),
    ...payload.competitorAnalysis.differences,
    ...payload.competitorAnalysis.impacts,
    ...sectionClaims(payload.jdDiagnosis),
    ...payload.validatedFindings,
    ...payload.gapMatrix,
    payload.positioning,
    ...payload.opportunities,
    ...payload.strategyChains,
    ...sectionClaims(payload.designLanguage),
    ...payload.categoryAssets,
    ...payload.measurementPlan,
  ].map(({ support }) => support);
}

function claimStatements(payload: IndustryMarketAnalysisPayloadV1): Array<{
  statement: string;
  support: IndustryMarketSupportV1;
}> {
  const claims = (section: { items: IndustryMarketClaimV1[] }) => section.items;
  return [
    ...claims(payload.marketLandscape),
    ...claims(payload.audienceSegments),
    ...payload.audienceSegments.segments,
    ...payload.audienceSegments.personas,
    ...payload.audienceSegments.differences,
    ...payload.audienceSegments.designImplications,
    ...claims(payload.supplyLandscape),
    ...claims(payload.competitorAnalysis),
    ...payload.competitorAnalysis.differences,
    ...payload.competitorAnalysis.impacts,
    ...claims(payload.jdDiagnosis),
    ...payload.validatedFindings,
    ...payload.gapMatrix.map((item) => ({ statement: `${item.userNeed}：${item.jdState}；${item.competitorSupply}`, support: item.support })),
    payload.positioning,
    ...payload.opportunities,
    ...payload.strategyChains.map((item) => ({ statement: item.designAction, support: item.support })),
    ...claims(payload.designLanguage),
    ...payload.categoryAssets.map((item) => ({ statement: item.rationale, support: item.support })),
    ...payload.measurementPlan.map((item) => ({ statement: item.definition, support: item.support })),
  ];
}

function applyContributionCertaintyCeiling(
  payload: IndustryMarketAnalysisPayloadV1,
  bundle?: ResearchContributionBundleV1,
): void {
  if (!bundle) return;
  const sourceById = new Map<string, ResearchContributionBundleV1['entries'][number]['contribution']['units'][number]>(
    bundle.entries.flatMap((entry) => entry.contribution.units.map((unit) => (
      [`${entry.artifactId}:${unit.key}`, unit] as const
    ))),
  );
  for (const support of claimSupports(payload)) {
    const sources = (support.sourceContributionUnitIds ?? []).map((sourceUnitId) => sourceById.get(sourceUnitId));
    if (sources.some((source) => source?.support.status === 'provisional') && support.status === 'supported') {
      support.status = 'provisional';
    }
    for (const source of sources) {
      if (source) support.confidence = Math.min(support.confidence, source.support.confidence);
    }
    if (support.status === 'provisional' && !support.validationNeeded.trim()) {
      support.validationNeeded = sources
        .map((source) => source?.support.validationNeeded ?? '')
        .find((value) => value.trim())
        ?? '验证 Contributor 贡献后再提升该判断的确定性。';
    }
  }
}

function validatePayloadBindings(input: {
  payload: IndustryMarketAnalysisPayloadV1;
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
  contributionBundle?: ResearchContributionBundleV1;
}): void {
  const questionIds = new Set(input.problemGraph.questions.map(({ id }) => id));
  const evidenceById = new Map(input.evidenceManifest.entries.map((entry) => [entry.id, entry]));
  const gapIds = new Set(input.payload.dataGaps.map(({ id }) => id));
  const opportunityIds = new Set(input.payload.opportunities.map(({ id }) => id));
  const categoryAssetIds = new Set(input.payload.categoryAssets.map(({ id }) => id));
  const contributionUnitIds = new Set((input.contributionBundle?.entries ?? []).flatMap((entry) => (
    entry.contribution.units.map((unit) => `${entry.artifactId}:${unit.key}`)
  )));

  if (gapIds.size !== input.payload.dataGaps.length) fail('data gap IDs must be unique');
  if (opportunityIds.size !== input.payload.opportunities.length) fail('opportunity IDs must be unique');
  if (categoryAssetIds.size !== input.payload.categoryAssets.length) fail('category asset IDs must be unique');

  const dimensions = input.payload.coverageLedger.map(({ dimension }) => dimension);
  if (
    dimensions.length !== DIMENSIONS.length
    || new Set(dimensions).size !== DIMENSIONS.length
    || DIMENSIONS.some((dimension) => !dimensions.includes(dimension))
  ) fail('coverage ledger must contain dimensions A-J exactly once');

  const validateEvidenceIds = (ids: readonly string[], label: string): void => {
    for (const evidenceId of ids) {
      if (!evidenceById.has(evidenceId)) fail(`${label} references unknown Evidence ${evidenceId}`);
    }
  };
  const validateSupport = (support: IndustryMarketSupportV1, label: string): void => {
    for (const questionId of support.questionIds) {
      if (!questionIds.has(questionId)) fail(`${label} references unknown question ${questionId}`);
    }
    validateEvidenceIds(support.evidenceIds, label);
    for (const sourceUnitId of support.sourceContributionUnitIds ?? []) {
      if (!contributionUnitIds.has(sourceUnitId)) {
        fail(`${label} references unknown Contribution unit ${sourceUnitId}`);
      }
    }
    if (support.status === 'supported') {
      if (support.evidenceIds.length === 0) fail(`${label} is supported without Evidence`);
      for (const evidenceId of support.evidenceIds) {
        const entry = evidenceById.get(evidenceId)!;
        if (!isFactualEvidenceClass(entry.evidenceClass)) {
          fail(`${label} is supported by non-factual Evidence ${evidenceId}`);
        }
      }
    } else if (!support.validationNeeded.trim()) {
      fail(`${label} ${support.status} status has no validation need`);
    }
  };

  claimSupports(input.payload).forEach((support, index) => validateSupport(support, `support ${index + 1}`));
  input.payload.coverageLedger.forEach((entry) => {
    validateEvidenceIds(entry.evidenceIds, `coverage ${entry.dimension}`);
    for (const gapId of entry.gapIds) {
      if (!gapIds.has(gapId)) fail(`coverage ${entry.dimension} references unknown gap ${gapId}`);
    }
  });
  input.payload.competitorAnalysis.competitorSamples.forEach((sample) => (
    validateEvidenceIds(sample.evidenceIds, `competitor sample ${sample.id}`)
  ));
  input.payload.competitorAnalysis.dimensionMatrix.forEach((row) => row.values.forEach((value) => (
    validateEvidenceIds(value.evidenceIds, `competitor matrix ${row.dimension}/${value.sampleId}`)
  )));
  input.payload.competitorAnalysis.visualEvidence.forEach((visual) => (
    validateEvidenceIds(visual.evidenceIds, `visual evidence ${visual.id}`)
  ));
  for (const chain of input.payload.strategyChains) {
    if (!opportunityIds.has(chain.opportunityId)) {
      fail(`strategy chain ${chain.id} references unknown opportunity ${chain.opportunityId}`);
    }
    for (const assetId of chain.categoryAssetRefs) {
      if (!categoryAssetIds.has(assetId)) fail(`strategy chain ${chain.id} references unknown category asset ${assetId}`);
    }
    validateEvidenceIds(chain.currentEvidenceIds, `strategy chain ${chain.id}`);
    validateEvidenceIds(chain.competitorEvidenceIds, `strategy chain ${chain.id}`);
  }
  input.payload.categoryAssets.forEach((asset) => (
    validateEvidenceIds(asset.benchmarkEvidenceIds, `category asset ${asset.id}`)
  ));

  if (input.payload.audienceSegments.basisType === 'dataset_derived') {
    const audienceEvidence = new Set([
      ...input.payload.audienceSegments.items,
      ...input.payload.audienceSegments.segments,
      ...input.payload.audienceSegments.personas,
      ...input.payload.audienceSegments.differences,
      ...input.payload.audienceSegments.designImplications,
    ].flatMap(({ support }) => support.evidenceIds));
    if (![...audienceEvidence].some((id) => evidenceById.get(id)?.evidenceClass === 'dataset')) {
      fail('dataset-derived audience segments require Dataset Evidence');
    }
  }
  if (
    input.payload.audienceSegments.basisType === 'simulation'
    && [...input.payload.audienceSegments.items, ...input.payload.audienceSegments.segments, ...input.payload.audienceSegments.personas]
      .some(({ support }) => support.status === 'supported')
  ) fail('simulation audience content cannot be supported fact');
}

function graphAndCoverage(input: {
  payload: IndustryMarketAnalysisPayloadV1;
  requirement: ResearchTaskV2;
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
}): {
  findingGraph: FindingGraph;
  coverage: ResearchDeliverableCoverage;
  recommendations: CurrentRecommendation[];
} {
  const statements = claimStatements(input.payload);
  const factualFindings = input.payload.validatedFindings.filter(({ support }) => support.status === 'supported');
  const additionalFactualStatements = statements.filter(({ statement, support }) => (
    support.status === 'supported'
    && !factualFindings.some((finding) => finding.statement === statement && finding.support === support)
  ));
  if (factualFindings.length === 0 && additionalFactualStatements.length === 0) {
    fail('at least one supported Industry claim is required');
  }
  const factualRoots = [
    ...factualFindings.map((finding) => ({
      id: finding.id,
      statement: finding.statement,
      support: finding.support,
    })),
    ...additionalFactualStatements.map((claim, index) => ({
      id: `industry-fact-${String(index + 1).padStart(3, '0')}`,
      statement: claim.statement,
      support: claim.support,
    })),
  ];
  const facts = factualRoots.map((finding) => ({
    id: finding.id,
    kind: 'fact' as const,
    evidenceIds: [...finding.support.evidenceIds],
    statement: finding.statement,
  }));
  const inferenceFindings = input.problemGraph.questions.flatMap((question) => {
    const matchingFacts = factualRoots.filter(({ support }) => support.questionIds.includes(question.id));
    if (matchingFacts.length > 0) return [];
    const matching = statements.filter(({ support }) => support.questionIds.includes(question.id));
    return [{
      id: `inference-${question.id}`,
      kind: 'inference' as const,
      findingIds: facts.map(({ id }) => id),
      statement: matching[0]?.statement ?? '当前证据不足，该问题保留为待验证判断。',
    }];
  });
  const summaries = input.problemGraph.questions.map((question) => {
    const matching = statements.filter(({ support }) => support.questionIds.includes(question.id));
    const matchingFacts = factualRoots.filter(({ support }) => support.questionIds.includes(question.id));
    const findingIds = unique(matchingFacts.map(({ id }) => id));
    const rootedFindingIds = findingIds.length > 0 ? findingIds : [`inference-${question.id}`];
    return {
      id: `summary-${question.id}`,
      findingIds: rootedFindingIds,
      analysisIds: [`analysis-${question.id}`],
      summary: matching[0]?.statement ?? '当前证据不足，该问题保留为待验证判断。',
    };
  });
  const analyses = summaries.map((summary) => ({
    id: `analysis-${summary.id.slice('summary-'.length)}`,
    findingIds: [...summary.findingIds],
    statement: summary.summary,
  }));
  const conclusions = summaries.map((summary) => ({
    id: `conclusion-${summary.id.slice('summary-'.length)}`,
    summaryIds: [summary.id],
    statement: summary.summary,
  }));
  const recommendationCandidates = [
    ...input.payload.strategyChains.map(({ designAction, support }) => ({ statement: designAction, support })),
    ...input.payload.opportunities.map(({ statement, support }) => ({ statement, support })),
  ];
  const recommendations = input.problemGraph.questions.map((question) => {
    const candidate = recommendationCandidates.find(({ support }) => support.questionIds.includes(question.id));
    return {
      id: `recommendation-${question.id}`,
      summaryIds: [`summary-${question.id}`],
      statement: candidate?.statement ?? '按 Data Gap 中的路径补充验证后再决策。',
    };
  });
  const conclusionByQuestion = new Map(input.problemGraph.questions.map((question, index) => [question.id, conclusions[index]!.id]));
  const recommendationByQuestion = new Map(input.problemGraph.questions.map((question, index) => [question.id, recommendations[index]!.id]));
  return {
    findingGraph: {
      findings: [...facts, ...inferenceFindings],
      analyses,
      subQuestionSummaries: summaries,
      overallConclusions: conclusions,
    },
    recommendations,
    coverage: {
      questionBindings: input.problemGraph.questions.map(({ id }) => ({
        questionId: id,
        summaryIds: [`summary-${id}`],
      })),
      successCriterionBindings: input.requirement.success_criteria.map(({ id }) => {
        const questions = input.problemGraph.questions.filter(({ success_criterion_ids }) => (
          success_criterion_ids.includes(id)
        ));
        if (questions.length === 0) fail(`success criterion ${id} has no question mapping`);
        return {
          successCriterionId: id,
          conclusionIds: questions.map((question) => conclusionByQuestion.get(question.id)!),
          recommendationIds: questions.map((question) => recommendationByQuestion.get(question.id)!),
        };
      }),
    },
  };
}

export function extractIndustryMarketContentDraft(
  materials: readonly SynthesisMaterial[],
): IndustryMarketContentDraftV1 {
  const matches = materials.filter(({ actorType, actorId }) => (
    actorType === 'skill' && actorId === 'industry-market-analysis'
  ));
  if (matches.length !== 1) fail(`expected exactly one industry-market-analysis material, received ${matches.length}`);
  const skill = matches[0]!;
  const envelope = record(skill.value);
  if (envelope?.version !== 'skill-output-v2') fail('Industry Skill output version is invalid');
  const finalReviews = materials
    .filter(({ actorType, actorId, stepNo }) => (
      actorType === 'reviewer'
      && actorId === 'reviewer.research-lead'
      && stepNo > skill.stepNo
    ))
    .sort((left, right) => right.stepNo - left.stepNo);
  if (finalReviews.length === 0) fail('Industry Skill output has no final Reviewer material');
  const review = record(finalReviews[0]!.value);
  if (review?.version !== 'reviewer-step-output-v1') fail('final Industry Reviewer output is invalid');
  if (
    review.verdict !== 'pass'
    && review.verdict !== 'pass_with_conditions'
    && review.verdict !== 'revise'
  ) {
    fail(`final Industry Reviewer verdict ${String(review.verdict)} does not permit assembly`);
  }
  if (review.verdict === 'revise' && (!Array.isArray(review.conditions) || review.conditions.length === 0)) {
    fail('final Industry Reviewer revise verdict has no explicit conditions');
  }
  if (!record(envelope.payload)) fail('Industry Skill output has no payload');
  return structuredClone(envelope.payload) as unknown as IndustryMarketContentDraftV1;
}

function industryReviewConditions(materials: readonly SynthesisMaterial[]): string[] {
  const skillStepNo = materials.find(({ actorType, actorId }) => (
    actorType === 'skill' && actorId === 'industry-market-analysis'
  ))?.stepNo;
  if (skillStepNo === undefined) return [];
  const review = materials
    .filter(({ actorType, actorId, stepNo }) => (
      actorType === 'reviewer'
      && actorId === 'reviewer.research-lead'
      && stepNo > skillStepNo
    ))
    .sort((left, right) => right.stepNo - left.stepNo)[0];
  const value = record(review?.value);
  return Array.isArray(value?.conditions)
    ? value.conditions.flatMap((condition) => {
        const statement = record(condition)?.statement;
        return typeof statement === 'string' && statement.trim() ? [statement.trim()] : [];
      })
    : [];
}

export function isIndustryMarketPayload(value: unknown): value is IndustryMarketAnalysisPayloadV1 {
  return record(value)?.schemaVersion === 'industry-market-analysis-v1';
}

export function assembleIndustryMarketDeliverable(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  evidenceManifestArtifactId: string;
  requirement: ResearchTaskV2;
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
  materials: readonly SynthesisMaterial[];
  contributionBundle?: ResearchContributionBundleV1;
  draftOverride?: IndustryMarketContentDraftV1;
  gaps: readonly string[];
  capabilityProvenance: CapabilityProvenance[];
  validator?: IndustryPayloadValidator;
}): ResearchDeliverableEnvelope<IndustryMarketAnalysisPayloadV1> {
  if (input.requirement.task_type !== 'industry_market_analysis') {
    return fail(`requirement task type ${input.requirement.task_type} is not Industry`);
  }
  const validator = input.validator ?? new SchemaValidator();
  const draft = structuredClone(input.draftOverride ?? extractIndustryMarketContentDraft(input.materials));
  validator.validateFileOrThrow(DRAFT_SCHEMA, draft);
  const {
    schemaVersion: _draftVersion,
    scope: _draftScope,
    contributionExclusions = [],
    ...content
  } = draft;
  const knownContributionUnitIds = new Set((input.contributionBundle?.entries ?? []).flatMap((entry) => (
    entry.contribution.units.map((unit) => `${entry.artifactId}:${unit.key}`)
  )));
  const exclusionIds = new Set<string>();
  for (const exclusion of contributionExclusions) {
    if (!knownContributionUnitIds.has(exclusion.unitId)) {
      return fail(`contribution exclusion references unknown Unit ${exclusion.unitId}`);
    }
    if (exclusionIds.has(exclusion.unitId)) {
      return fail(`contribution exclusion repeats Unit ${exclusion.unitId}`);
    }
    exclusionIds.add(exclusion.unitId);
  }
  const scope = expectedScope(input.requirement);
  const categoryAssetIds = new Set(content.categoryAssets.map(({ id }) => id));
  const payload: IndustryMarketAnalysisPayloadV1 = {
    ...content,
    scope,
    coverageLedger: content.coverageLedger.map((entry) => ({
      ...entry,
      gapIds: content.dataGaps
        .filter(({ dimensionIds }) => dimensionIds.includes(entry.dimension))
        .map(({ id }) => id),
    })),
    strategyChains: content.strategyChains.map((chain) => ({
      ...chain,
      categoryAssetRefs: chain.categoryAssetRefs.filter((id) => categoryAssetIds.has(id)),
    })),
    schemaVersion: 'industry-market-analysis-v1',
  };
  applyContributionCertaintyCeiling(payload, input.contributionBundle);
  validatePayloadBindings({
    payload,
    problemGraph: input.problemGraph,
    evidenceManifest: input.evidenceManifest,
    ...(input.contributionBundle ? { contributionBundle: input.contributionBundle } : {}),
  });
  validator.validateFileOrThrow(PAYLOAD_SCHEMA, payload);
  const derived = graphAndCoverage({
    payload,
    requirement: input.requirement,
    problemGraph: input.problemGraph,
    evidenceManifest: input.evidenceManifest,
  });
  const risksAndOpenIssues = unique([
    ...payload.dataGaps.map(({ statement }) => statement),
    ...industryReviewConditions(input.materials),
    ...contributionExclusions.map(({ unitId, reason }) => `Contribution Unit ${unitId} excluded: ${reason}`),
    ...input.gaps,
  ]);
  return {
    version: 'research-deliverable-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    deliverableType: 'industry_market_analysis_report',
    evidenceManifestArtifactId: input.evidenceManifestArtifactId,
    methodSummary: `Industry Market Analysis · ${payload.scope.analysisDepth} · A-J ten-dimension review`,
    findingGraph: derived.findingGraph,
    payload,
    recommendations: derived.recommendations,
    coverage: derived.coverage,
    risksAndOpenIssues,
    capabilityProvenance: structuredClone(input.capabilityProvenance),
  };
}
