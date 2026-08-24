export interface ReviewedDraftPreviewView {
  title: string;
  executiveAnswer: string;
  directAnswerCount: number;
  evidenceFindingCount: number;
  limitationCount: number;
  openQuestionCount: number;
  contentBlocks: Array<{ key: string; kind: string; title: string; itemCount: number }>;
}

export function reviewedDraftPreviewFromFailure(
  failure: Record<string, unknown> | undefined,
): ReviewedDraftPreviewView | null {
  const value = failure?.draftPreview;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const preview = value as Record<string, unknown>;
  if (
    preview.version !== 'reviewed-strategy-draft-preview-v1'
    || preview.canonical !== false
    || preview.exportAllowed !== false
    || typeof preview.title !== 'string'
    || typeof preview.executiveAnswer !== 'string'
    || !Array.isArray(preview.directAnswers)
    || !Array.isArray(preview.contentBlocks)
  ) return null;
  const contentBlocks = preview.contentBlocks.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const block = candidate as Record<string, unknown>;
    return typeof block.key === 'string'
      && typeof block.kind === 'string'
      && typeof block.title === 'string'
      && typeof block.itemCount === 'number'
      ? [{ key: block.key, kind: block.kind, title: block.title, itemCount: block.itemCount }]
      : [];
  });
  return {
    title: preview.title,
    executiveAnswer: preview.executiveAnswer,
    directAnswerCount: preview.directAnswers.length,
    evidenceFindingCount: typeof preview.evidenceFindingCount === 'number' ? preview.evidenceFindingCount : 0,
    limitationCount: typeof preview.limitationCount === 'number' ? preview.limitationCount : 0,
    openQuestionCount: typeof preview.openQuestionCount === 'number' ? preview.openQuestionCount : 0,
    contentBlocks,
  };
}
