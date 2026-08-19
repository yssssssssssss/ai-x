export interface CompetitiveScoringWeight {
  dimension: string;
  percentage: number;
}

const WEIGHT_KEY = /(?:^|_)(?:scoring_)?weights?$/iu;
const PERCENTAGE = /(?:^|[、，；:：—-])\s*([^、，；:：—-]*?\S)\s*(\d+(?:\.\d+)?)%/gu;

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
  return numeric.map(([dimension, weight]) => ({
    dimension: dimension.trim(),
    percentage: fractions ? weight * 100 : weight,
  }));
}

function weightsFromObject(value: unknown, seen = new Set<unknown>()): CompetitiveScoringWeight[] | null {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = weightsFromObject(child, seen);
      if (match) return match;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (WEIGHT_KEY.test(key)) {
      const match = normalizedWeights(child);
      if (match) return match;
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const match = weightsFromObject(child, seen);
    if (match) return match;
  }
  return null;
}

function weightsFromText(value: unknown): CompetitiveScoringWeight[] | null {
  const strings: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      if (/权重|加权/u.test(candidate)) strings.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (isRecord(candidate)) Object.values(candidate).forEach(visit);
  };
  visit(value);
  for (const text of strings) {
    const matches = [...text.matchAll(PERCENTAGE)].map((match) => ({
      dimension: match[1]!.trim().replace(/^.*(?:为|：|:)\s*/u, ''),
      percentage: Number(match[2]),
    }));
    if (
      matches.length >= 2
      && new Set(matches.map(({ dimension }) => dimension)).size === matches.length
      && matches.every(({ dimension, percentage }) => dimension && percentage > 0)
      && Math.abs(matches.reduce((sum, { percentage }) => sum + percentage, 0) - 100) < 0.000_001
    ) return matches;
  }
  return null;
}

export function extractCompetitiveScoringWeights(input: {
  plan: unknown;
  structuredTask: unknown;
}): CompetitiveScoringWeight[] {
  return weightsFromObject(input.plan)
    ?? weightsFromObject(input.structuredTask)
    ?? weightsFromText(input.structuredTask)
    ?? [];
}
