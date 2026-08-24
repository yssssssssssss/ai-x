function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function questionOrdinal(value: string): string | null {
  const match = /^q0*(\d+)(?:[_-]|$)/iu.exec(normalizeText(value));
  return match?.[1]?.replace(/^0+(?=\d)/u, '') ?? null;
}

function questionSkeleton(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

export function canonicalResearchQuestionId(
  value: string,
  knownQuestionIds: readonly string[],
): string | null {
  if (knownQuestionIds.includes(value)) return value;
  const ordinal = questionOrdinal(value);
  if (!ordinal) return null;
  const candidates = knownQuestionIds.filter((questionId) => questionOrdinal(questionId) === ordinal);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const aliasSkeleton = questionSkeleton(value);
  const candidateSkeleton = questionSkeleton(candidate);
  const ordinalSkeleton = `q${ordinal}`;
  const safelyEquivalent = aliasSkeleton === ordinalSkeleton
    || aliasSkeleton === candidateSkeleton
    || aliasSkeleton.startsWith(`${candidateSkeleton}_`)
    || candidateSkeleton.startsWith(`${aliasSkeleton}_`);
  return safelyEquivalent ? candidate : null;
}
