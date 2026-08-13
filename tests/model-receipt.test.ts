import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockLLMClient,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type ModelCallRecordInput,
  type StructuredLLMCallOptions,
  type TextLLMCallOptions,
  type TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  MissingModelReceiptError,
  ModelDriftError,
  ReceiptLLMClient,
} from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';

class MemoryModelRecorder {
  readonly calls: ModelCallRecordInput[] = [];

  async recordModelCall(input: ModelCallRecordInput): Promise<void> {
    this.calls.push(input);
  }
}

class FailingModelRecorder {
  async recordModelCall(_input: ModelCallRecordInput): Promise<void> {
    throw new Error('database unavailable');
  }
}

class FailingRealLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'gateway',
    endpointHost: 'llm.test',
    requestedModel: 'pinned-model',
    mode: 'real',
    eligibleAsReal: true,
  };

  async generateStructured<T>(_options: StructuredLLMCallOptions): Promise<never> {
    throw new Error('provider unavailable');
  }

  async generateText(_options: TextLLMCallOptions): Promise<never> {
    throw new Error('provider unavailable');
  }
}

test('records successful structured call receipt with identity, timestamps, and tokens', async () => {
  const recorder = new MemoryModelRecorder();
  const llm = new ReceiptLLMClient(new MockLLMClient({ answer: { ok: true } }, { name: 'mock-model', version: 'v-test' }), recorder);

  const result = await llm.generateStructured<{ ok: boolean }>({
    prompt: 'return ok',
    schema: {},
    schemaName: 'answer',
    context: { kept: 'only hashed by client' },
    receipt: {
      stage: 'plan',
      attemptId: '11111111-1111-4111-8111-111111111111',
      stepNo: 3,
      contextManifestHash: 'sha256:context',
      expectedModel: 'mock-model',
    },
  });

  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.modelName, 'mock-model');
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].attemptId, '11111111-1111-4111-8111-111111111111');
  assert.equal(recorder.calls[0].stage, 'plan');
  assert.equal(recorder.calls[0].stepNo, 3);
  assert.equal(recorder.calls[0].provider, 'mock');
  assert.equal(recorder.calls[0].endpointHost, 'local-mock');
  assert.equal(recorder.calls[0].requestedModel, 'mock-model');
  assert.equal(recorder.calls[0].actualModel, 'mock-model');
  assert.equal(recorder.calls[0].promptHash, result.promptHash);
  assert.equal(recorder.calls[0].contextManifestHash, 'sha256:context');
  assert.equal(recorder.calls[0].traceId, result.traceId);
  assert.deepEqual(recorder.calls[0].tokens, { prompt: 0, completion: 0, total: 0 });
  assert.equal(recorder.calls[0].status, 'succeeded');
  assert.equal(recorder.calls[0].failure, null);
  assert.ok(recorder.calls[0].startedAt instanceof Date);
  assert.ok(recorder.calls[0].finishedAt instanceof Date);
  assert.ok(recorder.calls[0].finishedAt.getTime() >= recorder.calls[0].startedAt.getTime());
  assert.equal('prompt' in recorder.calls[0], false);
  assert.equal('authorization' in recorder.calls[0], false);
});

test('records model drift receipt before rejecting with typed error', async () => {
  const recorder = new MemoryModelRecorder();
  const llm = new ReceiptLLMClient(new MockLLMClient({ answer: { ok: true } }, { name: 'actual-model', version: 'v-test' }), recorder);

  await assert.rejects(
    llm.generateStructured<{ ok: boolean }>({
      prompt: 'return ok',
      schema: {},
      schemaName: 'answer',
      receipt: { stage: 'execute', expectedModel: 'pinned-model' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof ModelDriftError);
      assert.equal(err.expectedModel, 'pinned-model');
      assert.equal(err.actualModel, 'actual-model');
      return true;
    },
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].requestedModel, 'actual-model');
  assert.equal(recorder.calls[0].actualModel, 'actual-model');
  assert.equal(recorder.calls[0].status, 'failed');
  assert.deepEqual(recorder.calls[0].failure, {
    kind: 'model_drift',
    expectedModel: 'pinned-model',
    actualModel: 'actual-model',
  });
});

test('planning pin compares the returned actual model while preserving the requested model in the failed receipt', async () => {
  const recorder = new MemoryModelRecorder();
  const provider: LLMClient = {
    identity: {
      provider: 'gateway',
      endpointHost: 'llm.test',
      requestedModel: 'gateway-routing-alias',
      mode: 'real',
      eligibleAsReal: true,
    },
    async generateStructured<T>(_options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      return {
        data: { task_type: 'competitive_research' } as T,
        promptHash: 'sha256:planning',
        modelName: 'backend-drifted-model',
        modelVersion: '1',
        traceId: 'trace-planning-drift',
      };
    },
    async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
      return {
        text: 'unused',
        promptHash: 'sha256:unused',
        modelName: 'backend-drifted-model',
        modelVersion: '1',
        traceId: 'trace-unused',
      };
    },
  };
  const llm = new ReceiptLLMClient(provider, recorder);

  await assert.rejects(
    () => llm.generateStructured({
      prompt: 'understand current planning task',
      schema: {},
      schemaName: 'research-task',
      receipt: {
        stage: 'task_understanding',
        expectedModel: 'pinned-production-model',
      },
    }),
    ModelDriftError,
  );

  assert.equal(recorder.calls.length, 1);
  assert.deepEqual({
    stage: recorder.calls[0].stage,
    requestedModel: recorder.calls[0].requestedModel,
    actualModel: recorder.calls[0].actualModel,
    status: recorder.calls[0].status,
    failure: recorder.calls[0].failure,
  }, {
    stage: 'task_understanding',
    requestedModel: 'gateway-routing-alias',
    actualModel: 'backend-drifted-model',
    status: 'failed',
    failure: {
      kind: 'model_drift',
      expectedModel: 'pinned-production-model',
      actualModel: 'backend-drifted-model',
    },
  });
});

test('recorder persistence failure fails closed with typed missing receipt error', async () => {
  const llm = new ReceiptLLMClient(new MockLLMClient({ answer: { ok: true } }), new FailingModelRecorder());

  await assert.rejects(
    llm.generateStructured<{ ok: boolean }>({
      prompt: 'return ok',
      schema: {},
      schemaName: 'answer',
      receipt: { stage: 'execute' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof MissingModelReceiptError);
      assert.match(err.message, /model receipt was not persisted/);
      assert.ok(err.cause instanceof Error);
      return true;
    },
  );
});

test('records a failed provider call before rethrowing it', async () => {
  const recorder = new MemoryModelRecorder();
  const llm = new ReceiptLLMClient(new FailingRealLLM(), recorder);

  await assert.rejects(
    llm.generateText({
      prompt: 'fail safely',
      receipt: { stage: 'synthesis', attemptId: '11111111-1111-4111-8111-111111111111' },
    }),
    /provider unavailable/,
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].status, 'failed');
  assert.equal(recorder.calls[0].actualModel, 'unknown');
  assert.deepEqual(recorder.calls[0].failure, {
    kind: 'provider_call',
    retryable: false,
    providerStatus: null,
    message: 'provider unavailable',
  });
});

test('mock identity is explicit and never eligible as real provider evidence', () => {
  const llm = new MockLLMClient({}, { name: 'mock-llm', version: 'v0' });

  assert.equal(llm.identity.provider, 'mock');
  assert.equal(llm.identity.endpointHost, 'local-mock');
  assert.equal(llm.identity.mode, 'mock');
  assert.equal(llm.identity.eligibleAsReal, false);
  assert.equal(llm.identity.requestedModel, 'mock-llm');
});
