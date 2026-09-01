import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditorialPresentationBriefError,
  loadEditorialPresentationBrief,
} from '../apps/orchestrator-runtime/src/report/editorial-presentation-brief.ts';

test('loads the trusted rich editorial presentation brief with a stable hash', () => {
  const first = loadEditorialPresentationBrief('rich-editorial-v1');
  const second = loadEditorialPresentationBrief('rich-editorial-v1');

  assert.equal(first.brief.version, 'editorial-presentation-brief-v1');
  assert.equal(first.brief.id, 'rich-editorial-v1');
  assert.deepEqual(first.brief.objective, [
    'structure_clear',
    'content_detailed',
    'hierarchy_explicit',
    'presentation_varied',
    'reading_efficient',
  ]);
  assert.ok(first.brief.preferredPresentations.includes('journey-flow'));
  assert.ok(first.brief.preferredPresentations.includes('strategy-matrix'));
  assert.equal(first.brief.constraints.maxConsecutiveNarrativeBlocks, 2);
  assert.equal(first.brief.constraints.interactiveForms, false);
  assert.match(first.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.brief, second.brief);

  assert.throws(
    () => loadEditorialPresentationBrief('user-provided-profile'),
    (error: unknown) => error instanceof EditorialPresentationBriefError
      && error.code === 'EDITORIAL_PRESENTATION_PROFILE_UNSUPPORTED',
  );
});
