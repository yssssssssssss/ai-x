import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectIndustryMarketReport } from '../apps/orchestrator-runtime/src/report/industry-market-report-projector.ts';
import { requiredPayloadPointers } from '../apps/orchestrator-runtime/src/report/report-projection.ts';
import { validIndustryMarketPayload } from './fixtures/industry-market.ts';

const schema = JSON.parse(readFileSync(
  join(process.cwd(), 'schemas/deliverables/industry-market-analysis-report.schema.json'),
  'utf8',
)) as object;

test('Industry Detail projects every required Canonical field without omissions', () => {
  const payload = validIndustryMarketPayload();
  const result = projectIndustryMarketReport({
    payload,
    deliverableArtifactId: 'deliverable-industry',
    requiredQuestionIds: ['question-1'],
    requiredPointers: requiredPayloadPointers(schema),
  });

  assert.equal(result.document.version, 'report-document-v2');
  assert.deepEqual(result.document.sections.map(({ id }) => id), [
    'cover', 'executive-summary', 'background', 'scope-method', 'key-metrics',
    'findings', 'question-analysis', 'visual-evidence', 'comparison', 'conclusion',
    'recommendations', 'risks', 'appendix',
  ]);
  assert.equal(result.document.projectionMode, 'full');
  assert.deepEqual(result.document.omittedPointers, []);
  assert.deepEqual(
    new Set(result.document.coveredPointers),
    new Set(requiredPayloadPointers(schema)),
  );
  assert.match(JSON.stringify(result.document), /宠物食品/u);
  assert.match(JSON.stringify(result.document), /配方证据链/u);
  assert.match(JSON.stringify(result.document), /缺少真实用户数据/u);
});
