import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalSha256,
  type EditorialModelPort,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  EditorialShowcasePlanner,
} from '../apps/orchestrator-runtime/src/report/editorial-showcase-planner.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { hashPrompt, type LLMResult } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

const LIMITS = {
  overallTimeoutMs: 90_000, maxHttpAttempts: 3, maxRetryAfterMs: 5_000,
  maxResponseBytes: 1_048_576, maxOutputTokens: 8_000,
} as const;

function configuration() {
  const body = {
    provider: 'gateway', endpointHost: 'llm-gw.jd.local', endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real' as const, eligibleAsReal: true, redirectMode: 'error' as const,
    routes: [{ requestedModel: 'showcase-model', expectedActualModel: 'showcase-model-v1', expectedActualModelExplicit: true as const }],
    limits: LIMITS,
  };
  return { ...body, gatewayConfigurationHash: canonicalSha256(body) };
}

class IntentClient {
  readonly configurationIdentity = {
    provider: 'gateway', endpointHost: 'llm-gw.jd.local', endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real' as const, eligibleAsReal: true,
    routes: [{ requestedModel: 'showcase-model', expectedActualModel: 'showcase-model-v1', expectedActualModelExplicit: true }],
  };
  calls = 0;
  constructor(private readonly value: unknown, private readonly actualModel = 'showcase-model-v1') {}
  async generateStructured<T>(options: {
    prompt: string; systemPrompt: string; schema: object; schemaName: 'editorial-report-copy-edits' | 'editorial-report-fidelity' | 'universal-editorial-showcase-intent-v1'; context: object;
  }): Promise<Omit<LLMResult<T>, 'receiptId'>> {
    this.calls += 1;
    return {
      data: this.value as T,
      promptHash: hashPrompt(options.prompt, options.context, options.schemaName),
      modelName: this.actualModel,
      modelVersion: this.actualModel,
      traceId: 'trace-showcase-intent',
      providerIdentity: {
        provider: 'gateway', endpointHost: 'llm-gw.jd.local', requestedModel: 'showcase-model',
        mode: 'real', eligibleAsReal: true,
      },
      expectedModel: 'showcase-model-v1',
    };
  }
}

function validIntent() {
  const fixture = showcaseFixture();
  return {
    version: 'universal-editorial-showcase-intent-v1',
    profileId: 'universal-editorial-showcase-v1',
    sections: [{
      id: 'decision', role: 'decision',
      title: '核心判断',
      componentIds: ['showcase-hero'],
    }],
  };
}

test('planner performs one structured Intent call with pinned model identity', async () => {
  const fixture = showcaseFixture();
  const client = new IntentClient(validIntent());
  const planner = new EditorialShowcasePlanner({
    modelPort: { client, configuration: configuration() } as unknown as EditorialModelPort,
  });

  const deterministicSpec = compileEditorialShowcase({
    material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null,
  }).spec;
  const result = await planner.plan({ sourcePacket: fixture.sourcePacket, deterministicSpec });

  assert.equal(result.mode, 'model_intent');
  assert.equal(result.reasonCode, 'SHOWCASE_INTENT_ACCEPTED');
  assert.equal(result.intent?.version, 'universal-editorial-showcase-intent-v1');
  assert.equal(client.calls, 1);
  assert.equal(result.modelCall?.actualModel, 'showcase-model-v1');
  assert.match(result.intentHash ?? '', /^sha256:[a-f0-9]{64}$/u);
});

test('planner fails closed to deterministic intent without retry', async () => {
  const fixture = showcaseFixture();
  const unavailable = new EditorialShowcasePlanner({ modelPort: { client: null, configuration: null } });
  const deterministicSpec = compileEditorialShowcase({
    material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null,
  }).spec;
  const unavailableResult = await unavailable.plan({ sourcePacket: fixture.sourcePacket, deterministicSpec });
  assert.equal(unavailableResult.mode, 'deterministic_showcase');
  assert.equal(unavailableResult.intent, null);
  assert.equal(unavailableResult.reasonCode, 'SHOWCASE_MODEL_UNAVAILABLE');

  const driftClient = new IntentClient(validIntent(), 'unexpected-model');
  const drift = new EditorialShowcasePlanner({
    modelPort: { client: driftClient, configuration: configuration() } as unknown as EditorialModelPort,
  });
  const driftResult = await drift.plan({ sourcePacket: fixture.sourcePacket, deterministicSpec });
  assert.equal(driftResult.mode, 'deterministic_showcase');
  assert.equal(driftResult.reasonCode, 'SHOWCASE_MODEL_IDENTITY_INVALID');
  assert.equal(driftClient.calls, 1);

  const invalidClient = new IntentClient({ version: 'bad', html: '<main>forbidden</main>' });
  const invalid = new EditorialShowcasePlanner({
    modelPort: { client: invalidClient, configuration: configuration() } as unknown as EditorialModelPort,
  });
  const invalidResult = await invalid.plan({ sourcePacket: fixture.sourcePacket, deterministicSpec });
  assert.equal(invalidResult.mode, 'deterministic_showcase');
  assert.equal(invalidResult.reasonCode, 'SHOWCASE_INVALID_INTENT');
  assert.equal(invalidClient.calls, 1);
});
