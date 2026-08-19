import type { ChartSpec } from '../../../../packages/api-contract/research-deliverable.ts';

export interface CompetitiveScoringWeight {
  dimension: string;
  percentage: number;
}

export interface CompetitiveWeightChartData {
  version: 'competitive-weight-chart-data-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  unit: 'percent';
  weights: CompetitiveScoringWeight[];
}

export interface CompetitiveWeightChartBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

export interface CompetitiveWeightDataArtifactReference {
  artifactId: string;
  contentSha256: string;
}

export interface CompetitiveWeightEvidenceEntry {
  id: string;
  kind: string;
  evidenceClass: string;
  artifactId: string;
  artifactContentSha256: string;
  jsonPointer: string;
}

export type CompetitiveScoringWeightResolution =
  | { status: 'ready'; weights: CompetitiveScoringWeight[] }
  | {
      status: 'unavailable';
      code:
        | 'chart_weights_step_missing'
        | 'chart_weights_step_ambiguous'
        | 'chart_weights_missing'
        | 'chart_weights_invalid';
      message: string;
    };

export const COMPETITIVE_WEIGHT_CHART_DATA_VERSION = 'competitive-weight-chart-data-v1';
export const COMPETITIVE_WEIGHT_TITLE = '对比维度评分权重 / Comparison-dimension Weights (%)';
export const COMPETITIVE_WEIGHT_CHART_ID = 'competitive-scoring-weights';
export const COMPETITIVE_WEIGHT_SERIES_KEY = 'actor:user-defined-scoring-weight';
export const COMPETITIVE_WEIGHT_SERIES_LABEL = '用户确认权重 / Confirmed weight';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedWeights(value: unknown): CompetitiveScoringWeight[] | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length < 2) return null;
  if (entries.some(([dimension, weight]) => !dimension.trim()
    || typeof weight !== 'number'
    || !Number.isFinite(weight)
    || weight <= 0)) return null;
  const numeric = entries as Array<[string, number]>;
  const total = numeric.reduce((sum, [, weight]) => sum + weight, 0);
  const fractions = numeric.every(([, weight]) => weight <= 1) && Math.abs(total - 1) < 0.000_001;
  const percentages = numeric.every(([, weight]) => weight <= 100) && Math.abs(total - 100) < 0.000_001;
  if (!fractions && !percentages) return null;
  const normalized = numeric.map(([dimension, weight]) => ({
    dimension: dimension.trim(),
    percentage: fractions ? weight * 100 : weight,
  }));
  if (new Set(normalized.map(({ dimension }) => dimension)).size !== normalized.length) return null;
  return normalized;
}

function orderedWeights(
  weights: CompetitiveScoringWeight[],
  dimensionsValue: unknown,
): CompetitiveScoringWeight[] | null {
  if (!Array.isArray(dimensionsValue) || dimensionsValue.length < 2) return null;
  if (dimensionsValue.some((dimension) => (
    typeof dimension !== 'string'
    || !dimension.trim()
    || dimension !== dimension.trim()
  ))) return null;
  const dimensions = dimensionsValue as string[];
  if (new Set(dimensions).size !== dimensions.length || dimensions.length !== weights.length) return null;
  const byDimension = new Map(weights.map((weight) => [weight.dimension, weight]));
  if (byDimension.size !== weights.length) return null;
  const ordered = dimensions.map((dimension) => byDimension.get(dimension));
  return ordered.every((weight): weight is CompetitiveScoringWeight => weight !== undefined)
    ? ordered
    : null;
}

export function resolveCompetitiveScoringWeights(plan: unknown): CompetitiveScoringWeightResolution {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) {
    return {
      status: 'unavailable',
      code: 'chart_weights_step_missing',
      message: '评分权重图未生成：冻结计划中缺少 competitive-web-research Skill 步骤。',
    };
  }
  const matchingSteps = plan.steps.filter((step) => isRecord(step)
    && step.actor_type === 'skill'
    && step.actor_id === 'competitive-web-research');
  if (matchingSteps.length === 0) {
    return {
      status: 'unavailable',
      code: 'chart_weights_step_missing',
      message: '评分权重图未生成：冻结计划中缺少 competitive-web-research Skill 步骤。',
    };
  }
  if (matchingSteps.length > 1) {
    return {
      status: 'unavailable',
      code: 'chart_weights_step_ambiguous',
      message: '评分权重图未生成：冻结计划包含多个 competitive-web-research Skill 步骤。',
    };
  }
  const stepInput = matchingSteps[0]!.input;
  if (!isRecord(stepInput) || !Object.hasOwn(stepInput, 'scoring_weights')) {
    return {
      status: 'unavailable',
      code: 'chart_weights_missing',
      message: '评分权重图未生成：冻结计划未提供 scoring_weights。',
    };
  }
  let weights = normalizedWeights(stepInput.scoring_weights);
  if (weights && Object.hasOwn(stepInput, 'dimensions')) {
    weights = orderedWeights(weights, stepInput.dimensions);
  }
  if (!weights) {
    return {
      status: 'unavailable',
      code: 'chart_weights_invalid',
      message: '评分权重图未生成：冻结计划中的 scoring_weights 格式或总和无效。',
    };
  }
  return { status: 'ready', weights };
}

export function extractCompetitiveScoringWeights(plan: unknown): CompetitiveScoringWeight[] {
  const resolution = resolveCompetitiveScoringWeights(plan);
  return resolution.status === 'ready' ? resolution.weights : [];
}

export function parseCompetitiveWeightChartData(
  value: unknown,
  binding: CompetitiveWeightChartBinding,
): CompetitiveWeightChartData {
  if (!isRecord(value)
    || value.version !== COMPETITIVE_WEIGHT_CHART_DATA_VERSION
    || value.taskId !== binding.taskId
    || value.planVersionId !== binding.planVersionId
    || value.attemptId !== binding.attemptId
    || value.unit !== 'percent'
    || !Array.isArray(value.weights)
    || value.weights.length < 2) {
    throw new Error('competitive weight Chart Data version, unit, or Task/Plan/Attempt binding is invalid');
  }
  const weights: CompetitiveScoringWeight[] = [];
  for (const candidate of value.weights) {
    if (!isRecord(candidate)
      || typeof candidate.dimension !== 'string'
      || !candidate.dimension.trim()
      || candidate.dimension !== candidate.dimension.trim()
      || typeof candidate.percentage !== 'number'
      || !Number.isFinite(candidate.percentage)
      || candidate.percentage <= 0) {
      throw new Error('competitive weight Chart Data contains an invalid dimension or percentage');
    }
    weights.push({ dimension: candidate.dimension, percentage: candidate.percentage });
  }
  if (new Set(weights.map(({ dimension }) => dimension)).size !== weights.length) {
    throw new Error('competitive weight Chart Data dimensions must be unique');
  }
  const total = weights.reduce((sum, { percentage }) => sum + percentage, 0);
  if (Math.abs(total - 100) >= 0.000_001) {
    throw new Error('competitive weight Chart Data percentages must total 100');
  }
  return {
    version: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
    taskId: binding.taskId,
    planVersionId: binding.planVersionId,
    attemptId: binding.attemptId,
    unit: 'percent',
    weights,
  };
}

export function assertCompetitiveWeightChartBinding(input: {
  data: CompetitiveWeightChartData;
  spec: ChartSpec;
  dataArtifactRef: CompetitiveWeightDataArtifactReference;
  evidenceEntries: CompetitiveWeightEvidenceEntry[];
}): void {
  const { data, spec, dataArtifactRef } = input;
  const expectedCategories = data.weights.map(({ dimension }) => dimension);
  const expectedValues = data.weights.map(({ percentage }) => percentage);
  const series = spec.series[0];
  if (spec.chartId !== COMPETITIVE_WEIGHT_CHART_ID
    || spec.type !== 'comparison'
    || spec.title !== COMPETITIVE_WEIGHT_TITLE
    || spec.categories.length !== expectedCategories.length
    || spec.categories.some((category, index) => category !== expectedCategories[index])
    || spec.series.length !== 1
    || !series
    || series.key !== COMPETITIVE_WEIGHT_SERIES_KEY
    || series.label !== COMPETITIVE_WEIGHT_SERIES_LABEL
    || series.values.length !== expectedValues.length
    || series.values.some((value, index) => value !== expectedValues[index])
    || series.evidenceIds.length !== expectedValues.length) {
    throw new Error('competitive weight Chart labels or values do not match its Chart Data');
  }
  const evidenceById = new Map(input.evidenceEntries.map((entry) => [entry.id, entry]));
  for (let index = 0; index < series.evidenceIds.length; index += 1) {
    const evidenceIds = series.evidenceIds[index]!;
    const entry = evidenceIds.length === 1 ? evidenceById.get(evidenceIds[0]!) : undefined;
    if (!entry
      || entry.kind !== 'user_constraint'
      || entry.evidenceClass !== 'user_input'
      || entry.artifactId !== dataArtifactRef.artifactId
      || entry.artifactContentSha256 !== dataArtifactRef.contentSha256
      || entry.jsonPointer !== `/weights/${index}/percentage`) {
      throw new Error(`competitive weight Chart Evidence at index ${index} does not match its Chart Data lineage`);
    }
  }
}
