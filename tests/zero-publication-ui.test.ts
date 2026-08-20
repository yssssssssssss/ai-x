import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  transitionZeroPublicationConfirmation,
  zeroPublicationButtonLabel,
  zeroPublicationProgressLabel,
  zeroPublicationRequestForSubmit,
  type ZeroPublicationConfirmationState,
} from '../apps/web/src/zero-publication-ui.ts';

test('multimodal report exposes deterministic Zero publication labels', () => {
  assert.equal(zeroPublicationButtonLabel('idle'), '发送到 Zero');
  assert.equal(zeroPublicationButtonLabel('creating'), '正在创建…');
  assert.equal(zeroPublicationButtonLabel('running'), '正在发送…');
  assert.equal(zeroPublicationButtonLabel('completed'), '更新 Zero 稿件');
  assert.equal(zeroPublicationButtonLabel('failed'), '重试发送到 Zero');
  assert.equal(zeroPublicationProgressLabel('writing_images', 63), '正在写入图片 · 63%');
  assert.equal(zeroPublicationProgressLabel('verifying_fills', 80), '正在验证图片 · 80%');
});

test('Zero publication requires a request click and explicit confirmation before submit', () => {
  let state: ZeroPublicationConfirmationState = 'closed';
  let createCalls = 0;
  const interact = (action: 'request' | 'cancel' | 'confirm') => {
    const transition = transitionZeroPublicationConfirmation(state, action);
    state = transition.state;
    if (transition.submit) createCalls += 1;
  };

  interact('request');
  assert.equal(state, 'open');
  assert.equal(createCalls, 0, 'opening confirmation must not create a publication');
  interact('cancel');
  assert.equal(state, 'closed');
  assert.equal(createCalls, 0, 'cancelling confirmation must not create a publication');
  interact('confirm');
  assert.equal(createCalls, 0, 'confirmation cannot submit unless the panel is open');
  interact('request');
  interact('confirm');
  assert.equal(state, 'closed');
  assert.equal(createCalls, 1, 'only explicit confirmation submits once');
});

test('Zero publication retry reuses the exact original request and idempotency identity', () => {
  const original = zeroPublicationRequestForSubmit({
    uiState: 'idle',
    previousRequest: null,
    expectedTaskState: 'completed_with_gaps',
    idempotencyKey: 'publication-attempt-1',
  });
  assert.deepEqual(original, {
    body: {
      expectedTaskState: 'completed_with_gaps',
      target: { mode: 'current_page' },
    },
    idempotencyKey: 'publication-attempt-1',
  });

  const retry = zeroPublicationRequestForSubmit({
    uiState: 'failed',
    previousRequest: original,
    expectedTaskState: 'completed',
    idempotencyKey: 'must-not-replace-the-original-key',
    updatePublicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(retry, original, 'retry must preserve the original body object and idempotency key');

  const update = zeroPublicationRequestForSubmit({
    uiState: 'completed',
    previousRequest: original,
    expectedTaskState: 'completed',
    idempotencyKey: 'publication-attempt-2',
    updatePublicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  assert.deepEqual(update, {
    body: {
      expectedTaskState: 'completed',
      target: { mode: 'current_page' },
      updatePublicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    idempotencyKey: 'publication-attempt-2',
  });
});

test('multimodal report source dispatches only through the API client', async () => {
  const source = await readFile(
    new URL('../apps/web/src/components/stages/CurrentStage4Report.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /发送到 Zero/u);
  assert.match(source, /role="dialog"/u);
  assert.match(source, /aria-haspopup="dialog"/u);
  assert.match(source, /aria-describedby="zero-publication-confirmation-description"/u);
  assert.match(source, /event\.key === 'Escape'/u);
  assert.match(source, /autoFocus/u);
  assert.match(source, /确认发送/u);
  assert.match(source, /api\.zeroStatus/u);
  assert.match(source, /api\.createZeroPublication/u);
  assert.match(source, /api\.zeroPublication/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:27618|use_design_html|use_design_script/u);

  const printCss = await readFile(
    new URL('../apps/web/src/reporting/report-print.css', import.meta.url),
    'utf8',
  );
  assert.match(
    printCss,
    /@media\s+print[\s\S]*\.zero-publication-confirmation,[\s\S]*display:\s*none/iu,
    'the confirmation dialog must never appear in printed reports',
  );
});
