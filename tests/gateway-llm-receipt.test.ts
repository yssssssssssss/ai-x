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

  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    this.calls.push(input);
    return '11111111-1111-4111-8111-111111111121';
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

test('Gateway forwards the caller output-token budget for long-form text generation', async () => {
  let maxTokens: unknown;
  let messages: unknown;
  globalThis.fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    maxTokens = requestBody.max_tokens;
    messages = requestBody.messages;
    return new Response(JSON.stringify({
      id: 'trace-long-form',
      model: 'pinned-model',
      choices: [{ message: { content: '<!doctype html>' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const recorder = new MemoryRecorder();
  const llm = client(recorder);

  await llm.generateText({
    prompt: 'generate a complete report',
    systemPrompt: 'trusted summary contract',
    maxOutputTokens: 24_000,
    receipt: { stage: 'editorial_summary_html', expectedModel: 'pinned-model' },
  });

  assert.equal(maxTokens, 24_000);
  assert.deepEqual(messages, [
    { role: 'system', content: 'trusted summary contract' },
    { role: 'user', content: 'generate a complete report' },
  ]);
});

test('Gateway sends uploaded images as multimodal message parts without embedding them in text context', async () => {
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'trace-vision',
      model: 'pinned-model',
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const recorder = new MemoryRecorder();
  const llm = client(recorder);
  const dataUrl = `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`;

  await llm.generateStructured({
    prompt: '分析上传的页面截图',
    schemaName: 'skill:vision-fixture',
    schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    context: { resolvedInput: { screenshot: { kind: 'uploaded_image' } } },
    images: [{ dataUrl, label: '京东页面截图 1' }],
    receipt: { stage: 'skill', expectedModel: 'pinned-model' },
  });

  const messages = requestBody.messages as Array<{ role: string; content: unknown }>;
  const content = messages[1]?.content as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content.at(-1), {
    type: 'image_url',
    image_url: { url: dataUrl, detail: 'high' },
  });
  assert.doesNotMatch(String((content[0] as { text?: string }).text), /aW1hZ2UtYnl0ZXM/u);
  assert.match(String((content[1] as { text?: string }).text), /京东页面截图 1/u);
});

test('Gateway cancellation aborts an in-flight provider request', async () => {
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) throw new Error('missing abort signal');
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const recorder = new MemoryRecorder();
  const llm = client(recorder);
  const controller = new AbortController();
  const pending = llm.generateText({
    prompt: 'cancel me',
    signal: controller.signal,
    receipt: { stage: 'synthesis', expectedModel: 'pinned-model' },
  });
  controller.abort(new Error('execution cancelled'));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof LLMInvocationError
      && error.kind === 'cancelled'
      && error.retryable === false,
  );
  assert.equal(recorder.calls[0]?.failure?.kind, 'cancelled');
});

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

test('Gateway model pool switches immediately after 429 and receipts the successful fallback pin', async () => {
  process.env.LLM_GATEWAY_BASE_URL = 'https://llm.test/v1';
  process.env.LLM_GATEWAY_API_KEY = 'secret-key';
  process.env.LLM_MODEL_NAME = 'primary-route';
  process.env.LLM_EXPECTED_ACTUAL_MODEL = 'primary-actual';
  process.env.LLM_MODEL_ROUTES = 'primary-route=primary-actual,fallback-route=fallback-actual';
  const attemptedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    attemptedModels.push(request.model);
    if (request.model === 'primary-route') {
      return new Response(JSON.stringify({ error: { message: 'throughput exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0.001' },
      });
    }
    return new Response(JSON.stringify({
      id: 'trace-fallback',
      model: 'fallback-actual',
      choices: [{ message: { content: 'fallback answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const recorder = new MemoryRecorder();
  const llm = new ReceiptLLMClient(new GatewayLLMClient({ timeoutMs: 50 }), recorder);

  const result = await llm.generateText({
    prompt: 'use fallback',
    receipt: { stage: 'planning', expectedModel: 'primary-actual' },
  });

  assert.equal(result.text, 'fallback answer');
  assert.deepEqual(attemptedModels, ['primary-route', 'fallback-route']);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].requestedModel, 'fallback-route');
  assert.equal(recorder.calls[0].actualModel, 'fallback-actual');
  assert.equal(recorder.calls[0].status, 'succeeded');
});

test('Gateway model pool switches after a retryable 503 provider failure', async () => {
  process.env.LLM_GATEWAY_BASE_URL = 'https://llm.test/v1';
  process.env.LLM_GATEWAY_API_KEY = 'secret-key';
  process.env.LLM_MODEL_NAME = 'primary-route';
  process.env.LLM_EXPECTED_ACTUAL_MODEL = 'primary-actual';
  process.env.LLM_MODEL_ROUTES = 'primary-route=primary-actual,fallback-route=fallback-actual';
  const attemptedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    attemptedModels.push(request.model);
    if (request.model === 'primary-route') return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({
      id: 'trace-fallback-503',
      model: 'fallback-actual',
      choices: [{ message: { content: 'recovered' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const recorder = new MemoryRecorder();
  const llm = new ReceiptLLMClient(new GatewayLLMClient({ timeoutMs: 50 }), recorder);

  const result = await llm.generateText({
    prompt: 'recover from 503',
    receipt: { stage: 'skill', expectedModel: 'primary-actual' },
  });

  assert.equal(result.text, 'recovered');
  assert.deepEqual(attemptedModels, ['primary-route', 'fallback-route']);
  assert.equal(recorder.calls[0]?.requestedModel, 'fallback-route');
});

test('Gateway model pool round-robins the starting route across successful logical calls', async () => {
  process.env.LLM_GATEWAY_BASE_URL = 'https://llm.test/v1';
  process.env.LLM_GATEWAY_API_KEY = 'secret-key';
  process.env.LLM_MODEL_NAME = 'route-a';
  process.env.LLM_EXPECTED_ACTUAL_MODEL = 'actual-a';
  process.env.LLM_MODEL_ROUTES = 'route-a=actual-a,route-b=actual-b,route-c=actual-c';
  const attemptedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    attemptedModels.push(request.model);
    const actualModel = request.model.replace('route-', 'actual-');
    return new Response(JSON.stringify({
      id: `trace-${request.model}`,
      model: actualModel,
      choices: [{ message: { content: request.model } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const recorder = new MemoryRecorder();
  const llm = new ReceiptLLMClient(new GatewayLLMClient({ timeoutMs: 50 }), recorder);

  await llm.generateText({ prompt: 'first', receipt: { stage: 'first', expectedModel: 'actual-a' } });
  await llm.generateText({ prompt: 'second', receipt: { stage: 'second', expectedModel: 'actual-a' } });
  await llm.generateText({ prompt: 'third', receipt: { stage: 'third', expectedModel: 'actual-a' } });

  assert.deepEqual(attemptedModels, ['route-a', 'route-b', 'route-c']);
  assert.deepEqual(recorder.calls.map((call) => [call.requestedModel, call.actualModel]), [
    ['route-a', 'actual-a'],
    ['route-b', 'actual-b'],
    ['route-c', 'actual-c'],
  ]);
});
