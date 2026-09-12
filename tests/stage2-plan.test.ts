import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildPlanConfirmationPayload,
  parseDatasetColumns,
  reconcileDatasetColumnMetadata,
} from '../apps/web/src/components/stages/stage2-plan-confirmation.ts';

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

test('Stage2Plan exposes CSV field descriptions and units after reading the selected header', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /parseDatasetColumns\(await file\.text\(\)\)/u);
  assert.match(source, /字段说明与单位（选填）/u);
  assert.match(source, /editDatasetColumnMetadata\(datasetInput\.role, 'fieldNotes'/u);
  assert.match(source, /editDatasetColumnMetadata\(datasetInput\.role, 'units'/u);
  assert.match(source, /Boolean\(datasetHeaderErrors\[input\.role\]\)/u);
});

test('Stage2 treats inherited Task Materials as already provided and does not ask for another upload', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /providedByRole\.has\(input\.role\)/u);
  assert.match(source, /已提供：\{provided\.fileNames\.join\('、'\)\}/u);
  assert.match(source, /provided \? \(/u);
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
    datasetUploads: [],
  });
  assert.equal(JSON.stringify(payload).includes('scoring_weights'), false);
});

test('Stage2 parses quoted UTF-8 CSV headers and scopes field metadata to the selected columns', () => {
  const columns = parseDatasetColumns('\uFEFFsample_id,"quote,raw",score\r\nu1,"价格,太复杂",3\r\n');
  assert.deepEqual(columns, ['sample_id', 'quote,raw', 'score']);
  assert.deepEqual(reconcileDatasetColumnMetadata({
    rowMeaning: '一行代表一位匿名受访者',
    timeRange: '2026-Q3',
    fieldNotes: { score: '满意度评分', obsolete: '旧字段' },
    units: { score: '分', obsolete: '次' },
    sampling: '访谈样本',
    piiConfirmedAbsent: true,
  }, columns), {
    rowMeaning: '一行代表一位匿名受访者',
    timeRange: '2026-Q3',
    fieldNotes: { sample_id: '', 'quote,raw': '', score: '满意度评分' },
    units: { sample_id: '', 'quote,raw': '', score: '分' },
    sampling: '访谈样本',
    piiConfirmedAbsent: true,
  });
});

test('Stage2 confirmation keeps an uploaded Dataset as an opaque pre-upload request', () => {
  const file = new File(['sample_id,quote\nu1,hello\n'], 'users.csv', { type: 'text/csv' });
  const dataset = {
    role: 'user_research_dataset',
    file,
    metadata: {
      rowMeaning: '一行代表一位匿名受访者',
      timeRange: '2026-Q3',
      fieldNotes: { sample_id: '匿名样本编号', quote: '用户原话' },
      units: { score: '分' },
      sampling: '访谈样本',
      piiConfirmedAbsent: true,
    },
  };
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: {},
    pending: [{
      kind: 'dataset', role: dataset.role, label: '用户研究 CSV', multiple: false,
      targets: [{ step_no: 4, tool_id: 'industry-market-analysis', field: dataset.role, multiple: false }],
    }],
    values: {}, images: {}, datasets: { [dataset.role]: dataset },
  });

  assert.deepEqual(payload.inputValues, {});
  assert.deepEqual(payload.uploads, []);
  assert.deepEqual(payload.datasetUploads, [dataset]);
});
