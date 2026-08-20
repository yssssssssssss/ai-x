import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  zeroPublicationButtonLabel,
  zeroPublicationProgressLabel,
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

test('multimodal report source dispatches only through the API client', async () => {
  const source = await readFile(
    new URL('../apps/web/src/components/stages/CurrentStage4Report.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /发送到 Zero/u);
  assert.match(source, /api\.zeroStatus/u);
  assert.match(source, /api\.createZeroPublication/u);
  assert.match(source, /api\.zeroPublication/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:27618|use_design_html|use_design_script/u);
});
