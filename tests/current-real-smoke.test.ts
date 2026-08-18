import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertGatewayModelReceipts,
  assertSmokeReceiptMinimums,
  CURRENT_REAL_SMOKE_PROFILES,
  designSmokeInputValue,
  resolveSmokeRequirement,
  safeSmokeErrorMessage,
  selectSmokeCandidate,
} from '../scripts/current-real-smoke.ts';
import { parseModelRoutes } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
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
  'CURRENT_DESIGN_SMOKE_IMAGE_PATH',
] as const;
const realProviderConfigured = REQUIRED_REAL_PROVIDER_ENV.every((key) => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() !== '';
});
const realSmokeOptions = { skip: !realProviderConfigured };
const realProfiles = [...CURRENT_REAL_SMOKE_PROFILES];

type SmokeReceipt = {
  profile: string;
  taskType: string;
  deliverableType: string;
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
    artifactId: string;
    automated: true;
    verdict: 'pass';
  };
  machineEvidence?: unknown;
};

test('current real smoke covers all five Current profiles', () => {
  assert.deepEqual(realProfiles, [
    'competitive_research',
    'user_research_planning',
    'voc_diagnosis',
    'design_audit',
    'a11y_audit',
  ]);
});

test('design smoke accepts one explicit absolute local image path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-design-smoke-'));
  try {
    const path = join(dir, 'design.png');
    writeFileSync(path, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const value = designSmokeInputValue(path);
    assert.match(value.dataUrl, /^data:image\/png;base64,/u);
    assert.doesNotMatch(value.dataUrl, new RegExp(path, 'u'));
    assert.throws(() => designSmokeInputValue('relative.png'), /absolute local path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('gateway model receipts support a routing alias with a distinct canonical actual model', () => {
  assert.doesNotThrow(() => assertGatewayModelReceipts({
    modelRoutes: [{ requestedModel: 'gateway-routing-alias', expectedActualModel: 'canonical-model-id' }],
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
    modelRoutes: [{ requestedModel: 'gateway-routing-alias', expectedActualModel: 'canonical-model-id' }],
    modelCalls: [{
      status: 'succeeded',
      provider: 'gateway',
      requestedModel: 'gateway-routing-alias',
      actualModel: 'unexpected-model-id',
    }],
  }), /invalid gateway model receipt/);
});

test('gateway model receipts validate every configured route independently', () => {
  assert.doesNotThrow(() => assertGatewayModelReceipts({
    modelRoutes: [
      { requestedModel: 'route-a', expectedActualModel: 'model-a' },
      { requestedModel: 'route-b', expectedActualModel: 'model-b' },
    ],
    modelCalls: [
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-a', actualModel: 'model-a' },
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-b', actualModel: 'model-b' },
    ],
  }));
  assert.throws(() => assertGatewayModelReceipts({
    modelRoutes: [
      { requestedModel: 'route-a', expectedActualModel: 'model-a' },
      { requestedModel: 'route-b', expectedActualModel: 'model-b' },
    ],
    modelCalls: [
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-b', actualModel: 'model-a' },
    ],
  }), /invalid gateway model receipt/);
});

test('real smoke CLI failures expose only a stable message hash', () => {
  const credential = 'postgres://operator:secret-value@localhost:5432/smoke';
  const message = safeSmokeErrorMessage(new Error(`connection failed: ${credential}`));
  assert.match(message, /^Current real smoke failed message_hash=[a-f0-9]{16}$/u);
  assert.doesNotMatch(message, /operator|secret-value|postgres:/u);
  assert.equal(message, safeSmokeErrorMessage(new Error(`connection failed: ${credential}`)));
});

test('real smoke enforces semantic Gold evidence and visual minimums in the CLI path', () => {
  assert.doesNotThrow(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://two.test', 'https://three.test'],
  }, { minPublicSources: 3, minVisualAssets: 0 }));
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 2,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://two.test'],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://ONE.test/', 'https://one.test/#same-source'],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: [
      'https://example.test/path',
      'https://example.test./%70ath',
      'https://EXAMPLE.test/pa%74h#same-source',
    ],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 1,
    sources: ['https://one.test', 'https://two.test', 'https://three.test'],
  }, { minPublicSources: 3, minVisualAssets: 2 }), /visual.*minimum/i);
});

test('real smoke accepts a profile-specific Skill instead of one global Skill pair', () => {
  const selected = selectSmokeCandidate([
    {
      candidateId: 'depth',
      plan: {
        steps: [
          { actor_type: 'tool', actor_id: 'tavily-web-search' },
          { actor_type: 'skill', actor_id: 'competitive-web-research' },
          { actor_type: 'llm', actor_id: 'current-llm' },
          { actor_type: 'reviewer', actor_id: 'research-lead-reviewer' },
        ],
      },
    },
    {
      candidateId: 'speed',
      plan: {
        steps: [
          { actor_type: 'tool', actor_id: 'tavily-web-search' },
          { actor_type: 'skill', actor_id: 'competitive-web-research' },
          { actor_type: 'llm', actor_id: 'current-llm' },
        ],
      },
    },
  ]);

  assert.equal(selected.candidateId, 'depth');
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

test('current real smoke produces one receipt for each supported full-real profile', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: realProfiles,
  });

  assert.equal(receipts.length, realProfiles.length);
  assert.deepEqual(receipts.map((receipt) => receipt.profile), realProfiles);
});

test('current real smoke receipts preserve task, plan, attempt, and Report Package identity', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: realProfiles,
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
    profiles: realProfiles,
  });
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'), 'utf8')) as {
    scenarios: Array<{
      profile: string;
      expectedDeliverableType: string;
      minPublicSources: number;
      minVisualAssets: number;
    }>;
  };

  for (const receipt of receipts) {
    const expected = fixture.scenarios.find((scenario) => scenario.profile === receipt.profile);
    assert.ok(expected, `missing fixture profile ${receipt.profile}`);
    assert.equal(receipt.deliverableType, expected.expectedDeliverableType);
    assert.ok(receipt.evidenceCount >= expected.minPublicSources, `${receipt.profile} evidence is insufficient`);
    assert.ok(receipt.visualAssetCount >= expected.minVisualAssets, `${receipt.profile} visual count is insufficient`);
  }
});

test('current real smoke is full-real, model-pinned, core-tool-backed, sealed, and automatically reviewed', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: realProfiles,
  });

  for (const receipt of receipts) {
    assert.equal(receipt.provider, 'gateway');
    const expectedByRequested = new Map(
      parseModelRoutes(process.env.LLM_MODEL_ROUTES, process.env.LLM_MODEL_NAME)
        .map(({ requestedModel, expectedActualModel }) => [requestedModel, expectedActualModel]),
    );
    assert.equal(receipt.actualModel, expectedByRequested.get(receipt.requestedModel));
    assert.equal(receipt.coreTool, 'tavily-web-search');
    assert.equal(receipt.packageSealed, true);
    assert.ok(receipt.review.artifactId);
    assert.equal(receipt.review.automated, true);
    assert.equal(receipt.review.verdict, 'pass');
  }
});

test('current real smoke receipts and machine evidence never expose secrets or raw inputs', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: (input: { fixturePath: string; profiles: string[] }) => Promise<SmokeReceipt[]>;
  };
  const receipts = await smoke.runCurrentRealSmoke({
    fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
    profiles: realProfiles,
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
  assert.match(envExample, /^CURRENT_DESIGN_SMOKE_IMAGE_PATH=$/m);
  assert.match(envExample, /^GOLD_BUILD_ID=$/m);
  assert.match(envExample, /^GOLD_REVIEWER_JWT=$/m);
  assert.match(envExample, /gold:run collect <batch_id>/);
  assert.match(envExample, /gold:run review <batch_id> <attempt_id>/);
  assert.match(envExample, /gold:run decide <batch_id>/);
  assert.match(envExample, /trusted_gold_enabled=false/);
  assert.match(ci, /smoke:current:real/);
  assert.match(ci, /if: github\.event_name != 'pull_request'/);
  assert.match(ci, /steps\.secret_gate\.outputs\.enabled == 'true'/);
  assert.match(ci, /pnpm db:migrate/);
  assert.match(ci, /pnpm db:seed/);
  assert.match(ci, /knowledge-base\/assets\/playbooks\/images\/jingxi-img-01\.png/);
  for (const profile of realProfiles) assert.match(ci, new RegExp(profile));
  for (const port of ['8801', '8802', '8805']) assert.match(ci, new RegExp(port));
});
test('real smoke rejects missing or non-passing automated Review Artifact receipts', async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    verifyAutomatedReviewArtifactReceipt: (value: unknown) => SmokeReceipt['review'];
  };
  assert.throws(() => smoke.verifyAutomatedReviewArtifactReceipt(null), /automated Review Artifact/);
  assert.throws(() => smoke.verifyAutomatedReviewArtifactReceipt({
    artifactId: 'review-1',
    automated: true,
    verdict: 'revise',
  }), /automated Review Artifact/);
  assert.deepEqual(smoke.verifyAutomatedReviewArtifactReceipt({
    artifactId: 'review-1',
    automated: true,
    verdict: 'pass',
  }), {
    artifactId: 'review-1',
    automated: true,
    verdict: 'pass',
  });
});
