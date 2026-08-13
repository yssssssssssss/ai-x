import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

interface RealSmokeConfig {
  ALLOW_REAL_PROVIDER?: string;
  LLM_PROVIDER?: string;
  TOOL_ADAPTER?: string;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  LLM_GATEWAY_BASE_URL?: string;
  LLM_GATEWAY_API_KEY?: string;
  LLM_MODEL_NAME?: string;
  LLM_EXPECTED_ACTUAL_MODEL?: string;
  TAVILY_API_KEY?: string;
}

interface SmokeResult {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  evidenceArtifactIds: string[];
  toolReceipt: Record<string, unknown>;
  counts: {
    evidence: number;
    findings: number;
    recommendations: number;
  };
  sources: string[];
  secret?: string;
  apiKey?: string;
  rawPrompt?: string;
}

interface SmokePlanStep {
  actor_type: string;
  actor_id: string;
}

interface SmokeExecutionStep {
  actorType: string;
  actorId: string;
  state: string;
}

interface CurrentRealSmokeModule {
  assertRealSmokeConfig(env: RealSmokeConfig): void;
  selectSmokeCandidate<T extends { candidateId: string; plan: { steps: SmokePlanStep[] } }>(
    candidates: T[],
  ): T;
  requireActorCoverage(steps: SmokeExecutionStep[], plannedSteps: SmokePlanStep[]): void;
  formatSmokeReceipt(result: SmokeResult): unknown;
}

const currentRealSmokeModulePath: string = '../scripts/current-real-smoke.ts';
const currentRealSmokeModuleFile = new URL(currentRealSmokeModulePath, import.meta.url);

async function loadCurrentRealSmokeModule(): Promise<CurrentRealSmokeModule> {
  assert.equal(
    existsSync(currentRealSmokeModuleFile),
    true,
    'Current real smoke module must exist',
  );
  // Keep the planned module path non-literal so the existence assertion is the intentional RED.
  const moduleExports = await import(currentRealSmokeModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.assertRealSmokeConfig, 'function');
  assert.equal(typeof moduleExports.formatSmokeReceipt, 'function');
  assert.equal(typeof moduleExports.selectSmokeCandidate, 'function');
  assert.equal(typeof moduleExports.requireActorCoverage, 'function');
  return moduleExports as unknown as CurrentRealSmokeModule;
}

const validConfig = {
  ALLOW_REAL_PROVIDER: '1',
  LLM_PROVIDER: 'gateway',
  TOOL_ADAPTER: 'real',
  DATABASE_URL: 'postgres://smoke.test/research',
  JWT_SECRET: 'jwt-secret-for-smoke',
  LLM_GATEWAY_BASE_URL: 'https://gateway.example.test/v1',
  LLM_GATEWAY_API_KEY: 'gateway-api-key-for-smoke',
  LLM_MODEL_NAME: 'pinned-real-model',
  LLM_EXPECTED_ACTUAL_MODEL: 'gpt-real-2026-01-01',
  TAVILY_API_KEY: 'tavily-api-key-for-smoke',
} satisfies Required<RealSmokeConfig>;

const requiredSmokeSteps: SmokePlanStep[] = [
  { actor_type: 'tool', actor_id: 'tavily-web-search' },
  { actor_type: 'skill', actor_id: 'competitive-web-research' },
  { actor_type: 'skill', actor_id: 'generate-research-plan' },
  { actor_type: 'llm', actor_id: 'pinned-research-model' },
  { actor_type: 'reviewer', actor_id: 'research-plan-reviewer' },
];

test('assertRealSmokeConfig accepts only a fully explicit real-provider configuration', async () => {
  const { assertRealSmokeConfig } = await loadCurrentRealSmokeModule();

  assert.doesNotThrow(() => assertRealSmokeConfig({ ...validConfig }));
});

test('assertRealSmokeConfig names every missing required field', async (t) => {
  const { assertRealSmokeConfig } = await loadCurrentRealSmokeModule();

  for (const field of Object.keys(validConfig) as Array<keyof RealSmokeConfig>) {
    await t.test(field, () => {
      const config: RealSmokeConfig = { ...validConfig };
      delete config[field];

      assert.throws(() => assertRealSmokeConfig(config), new RegExp(field));
    });
  }
});

test('assertRealSmokeConfig names every field whose value is not explicitly real or non-empty', async (t) => {
  const { assertRealSmokeConfig } = await loadCurrentRealSmokeModule();
  const invalidValues: Array<readonly [keyof RealSmokeConfig, string]> = [
    ['ALLOW_REAL_PROVIDER', 'true'],
    ['LLM_PROVIDER', 'mock'],
    ['TOOL_ADAPTER', 'fake'],
    ['DATABASE_URL', '   '],
    ['JWT_SECRET', '\t'],
    ['LLM_GATEWAY_BASE_URL', ''],
    ['LLM_GATEWAY_API_KEY', '   '],
    ['LLM_MODEL_NAME', '\n'],
    ['LLM_EXPECTED_ACTUAL_MODEL', '   '],
    ['TAVILY_API_KEY', '   '],
  ];

  for (const [field, invalidValue] of invalidValues) {
    await t.test(field, () => {
      const config: RealSmokeConfig = { ...validConfig, [field]: invalidValue };

      assert.throws(() => assertRealSmokeConfig(config), new RegExp(field));
    });
  }
});

test('selectSmokeCandidate prefers speed only when it contains every exact smoke capability', async () => {
  const { selectSmokeCandidate } = await loadCurrentRealSmokeModule();
  const speed = { candidateId: 'speed', plan: { steps: requiredSmokeSteps } };
  const depth = { candidateId: 'depth', plan: { steps: requiredSmokeSteps } };

  assert.equal(selectSmokeCandidate([depth, speed]), speed);
});

test('selectSmokeCandidate falls back to depth and rejects every missing exact capability', async (t) => {
  const { selectSmokeCandidate } = await loadCurrentRealSmokeModule();
  const speedWithoutReviewer = {
    candidateId: 'speed',
    plan: { steps: requiredSmokeSteps.filter((step) => step.actor_type !== 'reviewer') },
  };
  const depth = { candidateId: 'depth', plan: { steps: requiredSmokeSteps } };

  assert.equal(selectSmokeCandidate([speedWithoutReviewer, depth]), depth);

  for (const actorId of [
    'tavily-web-search',
    'competitive-web-research',
    'generate-research-plan',
  ]) {
    await t.test(actorId, () => {
      const candidate = {
        candidateId: 'speed',
        plan: {
          steps: requiredSmokeSteps.map((step) => step.actor_id === actorId
            ? { ...step, actor_id: `substitute-${step.actor_type}` }
            : step),
        },
      };
      assert.throws(() => selectSmokeCandidate([candidate]), new RegExp(actorId));
    });
  }

  for (const actorType of ['llm', 'reviewer']) {
    await t.test(actorType, () => {
      const candidate = {
        candidateId: 'speed',
        plan: { steps: requiredSmokeSteps.filter((step) => step.actor_type !== actorType) },
      };
      assert.throws(() => selectSmokeCandidate([candidate]), new RegExp(actorType, 'i'));
    });
  }
});

test('requireActorCoverage requires each planned smoke actorId to have a succeeded execution step', async (t) => {
  const { requireActorCoverage } = await loadCurrentRealSmokeModule();
  const succeededSteps = requiredSmokeSteps.map((step) => ({
    actorType: step.actor_type,
    actorId: step.actor_id,
    state: 'succeeded',
  }));

  assert.doesNotThrow(() => requireActorCoverage(succeededSteps, requiredSmokeSteps));

  for (const requiredStep of requiredSmokeSteps) {
    await t.test(requiredStep.actor_id, () => {
      const executions = succeededSteps
        .map((step) => step.actorId === requiredStep.actor_id ? { ...step, state: 'failed' } : step)
        .concat({
          actorType: requiredStep.actor_type,
          actorId: `substitute-${requiredStep.actor_type}`,
          state: 'succeeded',
        });

      assert.throws(
        () => requireActorCoverage(executions, requiredSmokeSteps),
        new RegExp(requiredStep.actor_id),
      );
    });
  }
});

test('formatSmokeReceipt returns a JSON-safe, secret-free receipt with IDs, counts, real Tool provenance, and HTTPS sources', async () => {
  const { formatSmokeReceipt } = await loadCurrentRealSmokeModule();
  const gatewayApiKey = 'gateway-key-must-not-leak';
  const tavilyApiKey = 'tavily-key-must-not-leak';
  const jwtSecret = 'jwt-secret-must-not-leak';
  const rawPrompt = 'raw prompt must not leak';

  const receiptInput: SmokeResult = {
    taskId: 'task-1',
    planVersionId: 'plan-version-2',
    attemptId: 'attempt-3',
    deliverableArtifactId: 'deliverable-artifact-4',
    evidenceManifestArtifactId: 'evidence-manifest-artifact-5',
    evidenceArtifactIds: ['evidence-artifact-6', 'evidence-artifact-7'],
    toolReceipt: {
      actorId: 'tavily-web-search',
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'tavily-rest-v1',
      executionMode: 'real',
      endpointHost: 'api.tavily.com',
      status: 'ok',
      latencyMs: 42,
      apiKey: tavilyApiKey,
      rawPrompt,
      nested: { secret: jwtSecret },
    },
    counts: { evidence: 2, findings: 3, recommendations: 1 },
    sources: [
      'https://research.example.test/source-a',
      'http://research.example.test/insecure',
      'artifact://internal/evidence-artifact-6',
      'https://research.example.test/source-b',
      'not-a-url',
    ],
    secret: jwtSecret,
    apiKey: gatewayApiKey,
    rawPrompt,
  };
  const receipt = formatSmokeReceipt(receiptInput);

  const serialized = JSON.stringify(receipt);
  assert.equal(typeof serialized, 'string');
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.deepEqual(receipt, {
    taskId: 'task-1',
    planVersionId: 'plan-version-2',
    attemptId: 'attempt-3',
    deliverableArtifactId: 'deliverable-artifact-4',
    evidenceManifestArtifactId: 'evidence-manifest-artifact-5',
    evidenceArtifactIds: ['evidence-artifact-6', 'evidence-artifact-7'],
    toolReceipt: {
      actorId: 'tavily-web-search',
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'tavily-rest-v1',
      executionMode: 'real',
      endpointHost: 'api.tavily.com',
      status: 'ok',
      latencyMs: 42,
    },
    counts: { evidence: 2, findings: 3, recommendations: 1 },
    sources: [
      'https://research.example.test/source-a',
      'https://research.example.test/source-b',
    ],
  });
  for (const forbidden of [
    'secret',
    'apiKey',
    'rawPrompt',
    gatewayApiKey,
    tavilyApiKey,
    jwtSecret,
    rawPrompt,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `receipt must not contain ${forbidden}`);
  }

  for (const [label, override] of [
    ['a different real tool', { actorId: 'other-web-search' }],
    ['a simulated Tavily adapter', { executionMode: 'simulated' }],
  ] as const) {
    assert.throws(
      () => formatSmokeReceipt({
        ...receiptInput,
        toolReceipt: { ...receiptInput.toolReceipt, ...override },
      }),
      /tavily.*real|real.*tavily/i,
      `receipt must reject ${label}`,
    );
  }
});
