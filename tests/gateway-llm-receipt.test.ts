import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import {
  type ModelCallRecordInput,
  LLMInvocationError,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  ModelDriftError,
  ReceiptLLMClient,
} from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

class MemoryRecorder {
  readonly calls: ModelCallRecordInput[] = [];

  async recordModelCall(input: ModelCallRecordInput): Promise<void> {
    this.calls.push(input);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function client(recorder: MemoryRecorder): ReceiptLLMClient {
  process.env.LLM_GATEWAY_BASE_URL = 'https://llm.test/v1';
  process.env.LLM_GATEWAY_API_KEY = 'secret-key';
  process.env.LLM_MODEL_NAME = 'pinned-model';
  return new ReceiptLLMClient(new GatewayLLMClient({ timeoutMs: 50 }), recorder);
}

test('Gateway 5xx is a structured retryable failed receipt', async () => {
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 });
  const recorder = new MemoryRecorder();
  const llm = client(recorder);

  await assert.rejects(
    llm.generateText({
      prompt: 'test failure',
      receipt: { stage: 'synthesis', expectedModel: 'pinned-model' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof LLMInvocationError);
      assert.equal(error.kind, 'server');
      assert.equal(error.retryable, true);
      assert.equal(error.providerStatus, 503);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    },
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].status, 'failed');
  assert.deepEqual(recorder.calls[0].failure, {
    kind: 'server',
    retryable: true,
    providerStatus: 503,
    message: 'gateway HTTP 503',
  });
});

test('Gateway response without actual model records unknown and fails model pin', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'trace-1',
    choices: [{ message: { content: 'summary' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const recorder = new MemoryRecorder();
  const llm = client(recorder);

  await assert.rejects(
    llm.generateText({
      prompt: 'test missing model',
      receipt: { stage: 'synthesis', expectedModel: 'pinned-model' },
    }),
    ModelDriftError,
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].actualModel, 'unknown');
  assert.equal(recorder.calls[0].status, 'failed');
  assert.equal(recorder.calls[0].failure?.kind, 'model_drift');
});
