import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserExecutionGate } from '../apps/orchestrator-runtime/src/runtime/browser-execution-gate.ts';
import { ToolInvocationError } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';

function context(signal = new AbortController().signal, deadlineAt = Date.now() + 1_000) {
  return { signal, deadlineAt };
}

async function toolError(promise: Promise<unknown>): Promise<ToolInvocationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ToolInvocationError);
    return error;
  }
  assert.fail('expected ToolInvocationError');
}

test('BrowserExecutionGate enforces 2 active and 8 queued calls', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 2, maxQueued: 8, queueTimeoutMs: 1_000 });
  const first = await gate.acquire('playwright-page-capture', context());
  const second = await gate.acquire('playwright-page-capture', context());
  const queued = Array.from({ length: 8 }, () => gate.acquire('playwright-page-capture', context()));

  assert.deepEqual(gate.stats(), { active: 2, queued: 8 });
  const overflow = await toolError(gate.acquire('playwright-page-capture', context()));
  assert.equal(overflow.kind, 'capacity');
  assert.equal(overflow.retryable, true);

  first.release();
  second.release();
  for (const pending of queued) (await pending).release();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('BrowserExecutionGate reports capacity after the queue wait expires', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 10 });
  const active = await gate.acquire('playwright-page-capture', context());
  const error = await toolError(gate.acquire('playwright-page-capture', context()));

  assert.equal(error.kind, 'capacity');
  assert.equal(error.retryable, true);
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
  active.release();
});

test('BrowserExecutionGate preserves lease_lost and removes cancelled waiters', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 1_000 });
  const active = await gate.acquire('playwright-page-capture', context());
  const controller = new AbortController();
  const pending = gate.acquire('playwright-page-capture', context(controller.signal));
  controller.abort('lease_lost');
  const error = await toolError(pending);

  assert.equal(error.kind, 'lease_lost');
  assert.equal(error.details.abortReason, 'lease_lost');
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
  active.release();
  const next = await gate.acquire('playwright-page-capture', context());
  next.release();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('BrowserExecutionGate maps an exhausted shared deadline to timeout, not capacity', async () => {
  const gate = new BrowserExecutionGate({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 1_000 });
  const active = await gate.acquire('playwright-page-capture', context());
  const error = await toolError(gate.acquire(
    'playwright-page-capture',
    context(new AbortController().signal, Date.now() + 10),
  ));

  assert.equal(error.kind, 'timeout');
  assert.equal(error.details.abortReason, 'deadline_exceeded');
  active.release();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});
