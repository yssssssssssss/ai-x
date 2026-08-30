import { execFile } from 'node:child_process';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTrustedGoldEnabled,
  isP0EligibleBatch,
  loadGoldPolicy,
  type GoldPolicy,
} from '../apps/orchestrator-runtime/src/audit/gold-policy.ts';
import { buildBatchSummary, countP0EligibleRuns, type BatchInput } from '../apps/orchestrator-runtime/src/audit/batch-summary.ts';

const legacyBatchIds = {
  noReport: '20260805-live-digital-human',
  fakeEvidence: '20260730-live-digital-human-b2',
} as const;

const capabilityRuns: BatchInput = {
  batch_id: '20260808-live-digital-human',
  scenario: '直播场域数字人竞品研究',
  scenario_input: '固定输入',
  runs: [
    { run_id: 'run-1', outcome: 'capability_run', status: 'completed', schema_valid: true, infra_retries: 0 },
    { run_id: 'run-2', outcome: 'capability_run', status: 'completed', schema_valid: true, infra_retries: 0 },
    { run_id: 'run-3', outcome: 'capability_run', status: 'completed', schema_valid: true, infra_retries: 0 },
  ],
};

test('gold policy disables the legacy trusted entry', () => {
  const policy = loadGoldPolicy();
  assert.equal(policy.trusted_gold_enabled, false);
  assert.throws(() => assertTrustedGoldEnabled(policy), /GOLD_TRUST_DISABLED/);
});

test('gold policy records both historical batches as invalidated with reasons', () => {
  const policy = loadGoldPolicy();
  assert.deepEqual(policy.legacy_batches[legacyBatchIds.noReport], {
    status: 'INVALIDATED',
    reasons: ['NO_REVIEWABLE_REPORTS'],
  });
  assert.deepEqual(policy.legacy_batches[legacyBatchIds.fakeEvidence], {
    status: 'INVALIDATED',
    reasons: ['FAKE_CORE_TOOL', 'FABRICATED_SOURCE_REFERENCE', 'INCOMPLETE_AUDIT_PACKAGE'],
  });
});

test('P0 eligibility excludes disabled and invalidated batches', () => {
  const policy = loadGoldPolicy();
  assert.equal(isP0EligibleBatch(capabilityRuns.batch_id, policy), false);
  assert.equal(isP0EligibleBatch(legacyBatchIds.noReport, { ...policy, trusted_gold_enabled: true }), false);
  assert.equal(isP0EligibleBatch('20260808-live-digital-human', { ...policy, trusted_gold_enabled: true }), true);
});

test('P0 counter excludes legacy batches while preserving capability counts for enabled batches', () => {
  const policy: GoldPolicy = {
    ...loadGoldPolicy(),
    trusted_gold_enabled: true,
  };
  assert.equal(countP0EligibleRuns(capabilityRuns, policy), 3);
  assert.equal(countP0EligibleRuns({ ...capabilityRuns, batch_id: legacyBatchIds.fakeEvidence }, policy), 0);
});

test('batch summary reports zero trusted P0 runs while trusted Gold is disabled', () => {
  assert.match(buildBatchSummary(capabilityRuns), /可信 P0 资格计数: 0 \/ 3/);
});

test('gold CLI refuses to start a trusted batch while policy is disabled', async () => {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = execFile(
      'pnpm',
      ['exec', 'tsx', 'apps/orchestrator-runtime/src/gold-run.ts', 'gold-policy-test'],
      { cwd: process.cwd(), timeout: 15_000, env: { ...process.env, DATABASE_URL: 'postgres://127.0.0.1:1/unused' } },
      (error, stdout, stderr) => {
        if (!error && !stderr) {
          resolve({ code: 0, output: stdout });
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 1, output: `${stdout}${stderr}` });
      },
    );
    child.on('error', reject);
  });

  assert.notEqual(result.code, 0);
  assert.match(result.output, /GOLD_TRUST_DISABLED/);
  assert.doesNotMatch(result.output, /===== gold:run 金标批次 =====/);
});
