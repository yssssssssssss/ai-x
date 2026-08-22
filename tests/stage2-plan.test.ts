import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildPlanConfirmationPayload } from '../apps/web/src/components/stages/stage2-plan-confirmation.ts';

const component = new URL('../apps/web/src/components/stages/Stage2Plan.tsx', import.meta.url);

test('Stage2Plan renders frozen competitive weights as read-only definition data', async () => {
  const source = await readFile(component, 'utf8');
  const start = source.indexOf('{scoringWeights.length > 0');
  const end = source.indexOf('\n      <div style={{ marginTop: 16 }}>', start);
  assert.ok(start >= 0 && end > start);
  const weightBlock = source.slice(start, end);

  assert.match(source, /extractCompetitiveScoringWeights\(plan\.plan\)/u);
  assert.match(weightBlock, /<dl/u);
  assert.match(weightBlock, /<dt/u);
  assert.match(weightBlock, /<dd/u);
  assert.doesNotMatch(weightBlock, /<input|<textarea|onChange|setScoring/u);
});

test('Stage2Plan renders frozen resource cardinality gaps before confirmation', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /skill_invocations\?\.flatMap/u);
  assert.match(source, /知识资源缺口/u);
  assert.match(source, /gap\.selected_items/u);
  assert.match(source, /gap\.min_items/u);
});

test('Stage2 confirmation payload includes only declared pending inputs and no weight copy', () => {
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: { scope: '中国主流平台' },
    pending: [{
      kind: 'value',
      role: 'competitors',
      label: '竞品',
      multiple: true,
      targets: [{ step_no: 2, tool_id: 'competitive-web-research', field: 'competitors', multiple: true }],
    }, {
      kind: 'visual',
      role: 'screenshots',
      label: '截图',
      multiple: false,
      targets: [{ step_no: 2, tool_id: 'competitive-web-research', field: 'screenshots', multiple: false }],
    }],
    values: {
      competitors: '京东\n淘宝',
      scoring_weights: '{"需求理解": 1}',
    },
    images: {
      screenshots: ['data:image/png;base64,fixture', 'data:image/png;base64,ignored'],
      scoring_weights: ['data:text/plain,fixture'],
    },
  });

  assert.deepEqual(payload, {
    confirmationAnswers: { scope: '中国主流平台' },
    inputValues: { competitors: ['京东', '淘宝'] },
    uploads: [{ role: 'screenshots', dataUrl: 'data:image/png;base64,fixture' }],
  });
  assert.equal(JSON.stringify(payload).includes('scoring_weights'), false);
});
