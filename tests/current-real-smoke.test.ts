import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertGatewayModelReceipts, resolveSmokeRequirement } from '../scripts/current-real-smoke.ts';
const REQUIRED_REAL_PROVIDER_ENV = [
  'ALLOW_REAL_PROVIDER',
  'LLM_PROVIDER',
  'TOOL_ADAPTER',
  'DATABASE_URL',
  'JWT_SECRET',
  'LLM_GATEWAY_BASE_URL',
  'LLM_GATEWAY_API_KEY',
  'LLM_MODEL_NAME',
  'LLM_EXPECTED_ACTUAL_MODEL',
  'TAVILY_API_KEY',
] as const;
const realProviderConfigured = REQUIRED_REAL_PROVIDER_ENV.every((key) => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() !== '';
});
const realSmokeOptions = { skip: !realProviderConfigured };

type SmokeReceipt = {
  profile: string;
  taskType: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPackageId: string;
  visualAssetCount: number;
  evidenceCount: number;
  provider: string;
  requestedModel: string;
  actualModel: string;
  coreTool: string;
  packageSealed: boolean;
  review: {
    reviewerId: string;
    authenticated: boolean;
    independent: boolean;
    verdict: 'usable' | 'needs_revision' | 'unusable';
  };
  machineEvidence?: unknown;
};


test('gateway model receipts support a routing alias with a distinct canonical actual model', () => {
  assert.doesNotThrow(() => assertGatewayModelReceipts({
    configuredModel: 'gateway-routing-alias',
    expectedActualModel: 'canonical-model-id',
    modelCalls: [{
      status: 'succeeded',
      provider: 'gateway',
      requestedModel: 'gateway-routing-alias',
      actualModel: 'canonical-model-id',
    }],
  }));
});

test('gateway model receipts still reject actual model drift', () => {
  assert.throws(() => assertGatewayModelReceipts({
    configuredModel: 'gateway-routing-alias',
    expectedActualModel: 'canonical-model-id',
    modelCalls: [{
      status: 'succeeded',
      provider: 'gateway',
      requestedModel: 'gateway-routing-alias',
      actualModel: 'unexpected-model-id',
    }],
  }), /invalid gateway model receipt/);
});

test('real smoke continues clarification until the requirement becomes ready', async () => {
  const answers: Array<Record<string, unknown>> = [];
  const result = await resolveSmokeRequirement({
    status: 'clarification_required',
    requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
  }, async (roundAnswers) => {
    answers.push(roundAnswers);
    if (answers.length === 1) {
      return {
        status: 'clarification_required',
        requirement: { clarification_questions: [{ key: 'audience', question: 'Which audience?' }] },
      };
    }
    return {
      status: 'ready_to_plan',
      requirement: { clarification_questions: [] },
      planningResult: { id: 'plan' },
    };
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.equal(answers.length, 2);
  assert.match(String(answers[0]?.scope), /^Controlled smoke decision:/);
});

test('real smoke bounds clarification to three rounds', async () => {
  let rounds = 0;
  const result = await resolveSmokeRequirement({
    status: 'clarification_required',
    requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
  }, async () => {
    rounds += 1;
    return {
      status: 'clarification_required',
      requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
    };
  });

  assert.equal(result.status, 'clarification_required');
  assert.equal(rounds, 3);
});

test('current real smoke produces one receipt for each semantic Gold profile', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: [
      'competitive_research',
      'user_research_planning',
      'voc_diagnosis',
      'design_audit',
      'a11y_audit',
    ],
  });

  assert.equal(receipts.length, 5);
  assert.deepEqual(
    receipts.map((receipt) => receipt.profile).sort(),
    ['a11y_audit', 'competitive_research', 'design_audit', 'user_research_planning', 'voc_diagnosis'],
  );
});

test('current real smoke receipts preserve task, plan, attempt, and Report Package identity', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: ['competitive_research', 'user_research_planning', 'voc_diagnosis', 'design_audit', 'a11y_audit'],
  });

  for (const key of ['taskId', 'planVersionId', 'attemptId', 'reportPackageId'] as const) {
    const values = receipts.map((receipt) => receipt[key]);
    assert.ok(values.every((value) => value.trim().length > 0), `${key} must be present`);
    assert.equal(new Set(values).size, receipts.length, `${key} must be unique per profile`);
  }
});

test('current real smoke reports visual and evidence counts for every profile', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: ['competitive_research', 'user_research_planning', 'voc_diagnosis', 'design_audit', 'a11y_audit'],
  });
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'), 'utf8')) as {
    scenarios: Array<{ profile: string; minPublicSources: number; minVisualAssets: number }>;
  };

  for (const receipt of receipts) {
    const expected = fixture.scenarios.find((scenario) => scenario.profile === receipt.profile);
    assert.ok(expected, `missing fixture profile ${receipt.profile}`);
    assert.ok(receipt.evidenceCount >= expected.minPublicSources, `${receipt.profile} evidence is insufficient`);
    assert.ok(receipt.visualAssetCount >= expected.minVisualAssets, `${receipt.profile} visual count is insufficient`);
  }
});

test('current real smoke is full-real, model-pinned, core-tool-backed, sealed, and independently auth-reviewed', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: ['competitive_research', 'user_research_planning', 'voc_diagnosis', 'design_audit', 'a11y_audit'],
  });

  for (const receipt of receipts) {
    assert.equal(receipt.provider, 'gateway');
    assert.equal(receipt.requestedModel, process.env.LLM_MODEL_NAME);
    assert.equal(receipt.actualModel, process.env.LLM_EXPECTED_ACTUAL_MODEL);
    assert.equal(receipt.coreTool, 'tavily-web-search');
    assert.equal(receipt.packageSealed, true);
    assert.ok(receipt.review.reviewerId);
    assert.equal(receipt.review.authenticated, true);
    assert.equal(receipt.review.independent, true);
    assert.equal(receipt.review.verdict, 'usable');
  }
});

test('current real smoke receipts and machine evidence never expose secrets or raw inputs', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: ['competitive_research', 'user_research_planning', 'voc_diagnosis', 'design_audit', 'a11y_audit'],
  });

  for (const receipt of receipts) {
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /Bearer\s+[^\s"']+|api[_-]?key\s*[:=]|password\s*[:=]|secret|base64|data:image/i);
    assert.doesNotMatch(serialized, /raw[_-]?input|full[_-]?prompt|authorization/i);
  }
});

test('environment documentation and CI expose an explicit current real smoke gate', () => {
  const envExample = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  assert.match(envExample, /CURRENT_REAL_SMOKE/);
  assert.match(envExample, /LLM_PROVIDER=gateway/);
  assert.match(envExample, /TOOL_ADAPTER=real/);
  assert.match(envExample, /LLM_MODEL_NAME=/);
  assert.match(envExample, /TAVILY_API_KEY=/);
  assert.match(ci, /smoke:current:real/);
});
test('real smoke rejects missing or non-independent persisted review evidence', async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    verifyPersistedIndependentReview: (value: unknown) => SmokeReceipt['review'];
  };
  assert.throws(() => smoke.verifyPersistedIndependentReview(null), /independent review evidence/);
  assert.throws(() => smoke.verifyPersistedIndependentReview({
    reviewerId: 'reviewer-1',
    authenticated: true,
    independent: false,
    verdict: 'usable',
  }), /independent review evidence/);
  assert.deepEqual(smoke.verifyPersistedIndependentReview({
    reviewerId: 'reviewer-1',
    authenticated: true,
    independent: true,
    verdict: 'usable',
  }), {
    reviewerId: 'reviewer-1',
    authenticated: true,
    independent: true,
    verdict: 'usable',
  });
});
