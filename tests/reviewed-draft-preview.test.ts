import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewedDraftPreviewFromFailure } from '../apps/web/src/reviewed-draft-preview.ts';

test('reviewed Draft preview is exposed only as non-canonical and non-exportable', () => {
  const preview = reviewedDraftPreviewFromFailure({
    kind: 'deliverable_validation',
    draftPreview: {
      version: 'reviewed-strategy-draft-preview-v1',
      canonical: false,
      exportAllowed: false,
      title: 'Reviewed draft',
      executiveAnswer: 'The existing answer remains available for inspection.',
      directAnswers: [{ questionId: 'Q1' }],
      contentBlocks: [{ key: 'map', kind: 'strategy_map', title: 'Strategy map', itemCount: 4 }],
      evidenceFindingCount: 2,
      limitationCount: 1,
      openQuestionCount: 3,
    },
  });

  assert.deepEqual(preview, {
    title: 'Reviewed draft',
    executiveAnswer: 'The existing answer remains available for inspection.',
    directAnswerCount: 1,
    evidenceFindingCount: 2,
    limitationCount: 1,
    openQuestionCount: 3,
    contentBlocks: [{ key: 'map', kind: 'strategy_map', title: 'Strategy map', itemCount: 4 }],
  });
});

test('reviewed Draft preview rejects canonical, exportable, or malformed payloads', () => {
  const base = {
    version: 'reviewed-strategy-draft-preview-v1',
    canonical: false,
    exportAllowed: false,
    title: 'Draft',
    executiveAnswer: 'Answer',
    directAnswers: [],
    contentBlocks: [],
  };
  assert.equal(reviewedDraftPreviewFromFailure(undefined), null);
  assert.equal(reviewedDraftPreviewFromFailure({ draftPreview: { ...base, canonical: true } }), null);
  assert.equal(reviewedDraftPreviewFromFailure({ draftPreview: { ...base, exportAllowed: true } }), null);
  assert.equal(reviewedDraftPreviewFromFailure({ draftPreview: { ...base, contentBlocks: 'invalid' } }), null);
});
