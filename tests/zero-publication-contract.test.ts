import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ZERO_PUBLICATION_STAGES,
  ZERO_PUBLICATION_STATUSES,
  ZeroPublicationContractError,
  isZeroNodeId,
  parseCreateZeroPublicationRequest,
} from '../packages/api-contract/zero-publication.ts';

test('Zero publication contract freezes status and stage enums', () => {
  assert.deepEqual(ZERO_PUBLICATION_STATUSES, ['queued', 'running', 'completed', 'failed']);
  assert.deepEqual(ZERO_PUBLICATION_STAGES, [
    'checking_zero',
    'reading_report',
    'rendering_html',
    'creating_draft',
    'transcoding_images',
    'writing_images',
    'verifying_metadata',
    'verifying_fills',
    'capturing_screenshots',
    'finalizing_receipt',
  ]);
});

test('Zero publication create request accepts only the frozen client surface', () => {
  assert.deepEqual(parseCreateZeroPublicationRequest({
    expectedTaskState: 'completed',
    target: { mode: 'current_page' },
  }), {
    expectedTaskState: 'completed',
    target: { mode: 'current_page' },
  });

  for (const forbidden of ['reportPackageArtifactId', 'planVersionId', 'attemptId', 'updatePublicationId', 'updateRootNodeId']) {
    assert.throws(
      () => parseCreateZeroPublicationRequest({
        expectedTaskState: 'completed',
        target: { mode: 'current_page' },
        [forbidden]: 'forbidden',
      }),
      ZeroPublicationContractError,
      `${forbidden} must remain server-owned`,
    );
  }
});

test('Zero publication create request rejects malformed states, targets, and updates', () => {
  const invalid: unknown[] = [
    null,
    {},
    { expectedTaskState: 'executing', target: { mode: 'current_page' } },
    { expectedTaskState: 'completed', target: { mode: 'another_page' } },
    { expectedTaskState: 'completed', target: { mode: 'current_page', extra: true } },
    { expectedTaskState: 'completed', target: { mode: 'current_page' }, updatePublicationId: '11111111-1111-4111-8111-111111111111' },
  ];
  for (const value of invalid) {
    assert.throws(() => parseCreateZeroPublicationRequest(value), ZeroPublicationContractError);
  }
});

test('Zero node IDs are strict numeric pairs', () => {
  assert.equal(isZeroNodeId('31:1242'), true);
  assert.equal(isZeroNodeId('0:1'), true);
  assert.equal(isZeroNodeId('31-1242'), false);
  assert.equal(isZeroNodeId('31:1242;31:1'), false);
  assert.equal(isZeroNodeId('../31:1242'), false);
});
