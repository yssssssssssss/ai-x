import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveDeliverable,
  resolveDeliverableCompositionPolicy,
  resolveDeliverableContract,
} from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const schemaPath = join(
  process.cwd(),
  'schemas/deliverables/industry-market-analysis-report.schema.json',
);

import { validIndustryMarketPayload } from './fixtures/industry-market.ts';

test('Industry Market payload validates as the seventh deliverable contract', () => {
  const validator = new SchemaValidator();
  assert.doesNotThrow(() => validator.validateFileOrThrow(schemaPath, validIndustryMarketPayload()));

  const selected = resolveDeliverable('industry_market_analysis', ['industry_market_analysis_report']);
  assert.equal(selected.id, 'industry_market_analysis_report');
  assert.deepEqual(resolveDeliverableCompositionPolicy(selected.id), {
    mode: 'portfolio',
    synthesizer_skill_id: 'industry-market-analysis',
    accepted_contribution_types: [
      'market_landscape',
      'competitive_analysis',
      'persona',
      'jobs_to_be_done',
      'journey',
      'metrics',
      'design_audit',
      'prioritization',
      'strategy',
      'action_plan',
      'virtual_user_hypothesis',
    ],
    contribution_schema: 'schemas/research-contribution-v1.schema.json',
  });

  const contract = resolveDeliverableContract('industry_market_analysis', ['industry_market_analysis_report']);
  assert.equal(contract.entry.payload_schema, 'schemas/deliverables/industry-market-analysis-report.schema.json');
  assert.equal(contract.evidencePolicy.deliverable_type, 'industry_market_analysis_report');
});

test('Industry Market payload rejects a missing ten-dimension coverage ledger', () => {
  const validator = new SchemaValidator();
  const payload = validIndustryMarketPayload();
  payload.coverageLedger = payload.coverageLedger.slice(0, 9);
  assert.throws(
    () => validator.validateFileOrThrow(schemaPath, payload),
    SchemaValidationError,
  );
});
