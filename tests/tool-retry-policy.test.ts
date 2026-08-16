import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolInvocationError,
  type ToolInvocationReceipt,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { invokeWithRetry } from '../apps/orchestrator-runtime/src/control/tool-retry-policy.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

type AttemptContext = { attempt: number; attemptId: string };
type RetryResult = {
  status: 'succeeded' | 'failed';
  output?: unknown;
  failure?: {
    kind: string;
    retryable?: boolean;
    providerStatus?: number | null;
    attempts: number;
    maxAttempts: number;
    lastFailure?: string;
  };
  attemptReceipts: Array<{
    attempt: number;
    attemptId: string;
    status: 'failed' | 'succeeded';
    failure?: { kind?: string; providerStatus?: number | null };
  }>;
};

const baseManifest: ToolManifest = {
  id: 'retry-fixture',
  name: 'Retry fixture',
  adapter_type: 'rest_json',
  auth_required: false,
  risk_level: 'low',
  input_schema: 'tools/fixture/input.schema.json',
  output_schema: 'tools/fixture/output.schema.json',
  retry_policy: { max_attempts: 3, backoff_seconds: 2 },
};

function receipt(attempt: number, status: 'ok' | 'failed' = 'failed'): ToolInvocationReceipt {
  return {
    declaredAdapterType: 'rest_json',
    resolvedAdapterType: 'rest_json',
    implementationId: `fixture-adapter-${attempt}`,
    executionMode: 'real',
    endpointHost: 'fixture.test',
    status,
    latencyMs: attempt,
  };
}

function failure(
  kind: 'network' | 'timeout' | 'rate_limit' | 'server' | 'schema' | 'authentication' | 'safety',
  attempt: number,
  providerStatus: number | null = null,
): ToolInvocationError {
  return new ToolInvocationError('retry-fixture', {
    kind,
    retryable: ['network', 'timeout', 'rate_limit', 'server'].includes(kind),
    providerStatus,
    sanitizedMessage: `${kind} failure`,
    receipt: receipt(attempt),
  });
}

function integrityFailure(attempt: number): Error & { kind: 'integrity'; retryable: false; receipt: ToolInvocationReceipt } {
  return Object.assign(new Error('integrity verification failed'), {
    kind: 'integrity' as const,
    retryable: false as const,
    receipt: receipt(attempt),
  });
}

function attemptFrom(context: unknown): AttemptContext {
  if (typeof context === 'number') return { attempt: context, attemptId: `attempt-${context}` };
  if (context && typeof context === 'object') {
    const candidate = context as Partial<AttemptContext>;
    return {
      attempt: candidate.attempt ?? 1,
      attemptId: candidate.attemptId ?? `attempt-${candidate.attempt ?? 1}`,
    };
  }
  return { attempt: 1, attemptId: 'attempt-1' };
}

test('retries network, timeout, HTTP 429, and HTTP 5xx failures before success', async (t) => {
  const scenarios: Array<{ kind: 'network' | 'timeout' | 'rate_limit' | 'server'; status: number | null }> = [
    { kind: 'network', status: null },
    { kind: 'timeout', status: null },
    { kind: 'rate_limit', status: 429 },
    { kind: 'server', status: 503 },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.kind, async () => {
      const sleeps: number[] = [];
      const attempts: number[] = [];
      let invocation = 0;
      const result = await invokeWithRetry({
        manifest: baseManifest,
        isLeaseActive: async () => true,
        sleep: async (ms: number) => { sleeps.push(ms); },
        invoke: async (context: unknown) => {
          const current = attemptFrom(context);
          invocation += 1;
          attempts.push(current.attempt);
          if (invocation < 3) throw failure(scenario.kind, current.attempt, scenario.status);
          return { output: 'ok', receipt: receipt(current.attempt, 'ok') };
        },
      }) as RetryResult;

      assert.equal(result.status, 'succeeded');
      assert.equal(result.output, 'ok');
      assert.deepEqual(attempts, [1, 2, 3]);
      assert.deepEqual(sleeps, [2_000, 2_000]);
      assert.equal(result.attemptReceipts.length, 3);
    });
  }
});

test('does not retry schema, authentication, safety, or integrity failures', async (t) => {
  const scenarios: Array<{ name: string; error: Error }> = [
    { name: 'schema', error: failure('schema', 1) },
    { name: 'authentication', error: failure('authentication', 1, 401) },
    { name: 'safety', error: failure('safety', 1) },
    { name: 'integrity', error: integrityFailure(1) },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const sleeps: number[] = [];
      const result = await invokeWithRetry({
        manifest: baseManifest,
        isLeaseActive: async () => true,
        sleep: async (ms: number) => { sleeps.push(ms); },
        invoke: async () => {
          calls += 1;
          throw scenario.error;
        },
      }) as RetryResult;

      assert.equal(result.status, 'failed');
      assert.equal(result.failure?.kind, scenario.name);
      assert.equal(result.failure?.attempts, 1);
      assert.equal(calls, 1);
      assert.deepEqual(sleeps, []);
    });
  }
});

test('honors manifest max_attempts and never exceeds the configured attempt count', async () => {
  const sleeps: number[] = [];
  const manifest = { ...baseManifest, retry_policy: { max_attempts: 2, backoff_seconds: 7 } };
  let calls = 0;
  const result = await invokeWithRetry({
    manifest,
    isLeaseActive: async () => true,
    sleep: async (ms: number) => { sleeps.push(ms); },
    invoke: async (context: unknown) => {
      calls += 1;
      throw failure('server', attemptFrom(context).attempt, 500);
    },
  }) as RetryResult;

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'server');
  assert.equal(result.failure?.attempts, 2);
  assert.equal(result.failure?.maxAttempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7_000]);
});

test('records an independent receipt for every attempt, including failed attempts', async () => {
  let calls = 0;
  const result = await invokeWithRetry({
    manifest: baseManifest,
    isLeaseActive: async () => true,
    sleep: async () => {},
    invoke: async (context: unknown) => {
      const current = attemptFrom(context);
      calls += 1;
      if (calls === 1) throw failure('network', current.attempt);
      return { output: 'ok', receipt: receipt(current.attempt, 'ok') };
    },
  }) as RetryResult;

  assert.equal(result.status, 'succeeded');
  assert.equal(result.attemptReceipts.length, 2);
  assert.equal(new Set(result.attemptReceipts.map((item) => item.attemptId)).size, 2);
  assert.deepEqual(result.attemptReceipts.map((item) => item.attempt), [1, 2]);
  assert.deepEqual(result.attemptReceipts.map((item) => item.status), ['failed', 'succeeded']);
  assert.equal(result.attemptReceipts[0]?.failure?.kind, 'network');
  assert.equal(result.attemptReceipts[1]?.failure, undefined);
});

test('stops before the first provider call when the lease is already lost', async () => {
  let calls = 0;
  const result = await invokeWithRetry({
    manifest: baseManifest,
    isLeaseActive: async () => false,
    sleep: async () => { throw new Error('sleep must not run'); },
    invoke: async () => {
      calls += 1;
      return { output: 'must not execute', receipt: receipt(1, 'ok') };
    },
  }) as RetryResult;

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(result.failure?.attempts, 0);
  assert.equal(calls, 0);
});

test('stops before sleeping when the lease is lost after a retryable failure', async () => {
  let leaseActive = true;
  let calls = 0;
  let sleeps = 0;
  const result = await invokeWithRetry({
    manifest: baseManifest,
    isLeaseActive: async () => leaseActive,
    sleep: async () => { sleeps += 1; },
    invoke: async (context: unknown) => {
      calls += 1;
      leaseActive = false;
      throw failure('timeout', attemptFrom(context).attempt);
    },
  }) as RetryResult;

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(result.failure?.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

test('stops before the next provider call when the lease is lost during backoff sleep', async () => {
  let leaseActive = true;
  let calls = 0;
  const result = await invokeWithRetry({
    manifest: baseManifest,
    isLeaseActive: async () => leaseActive,
    sleep: async () => { leaseActive = false; },
    invoke: async (context: unknown) => {
      calls += 1;
      throw failure('network', attemptFrom(context).attempt);
    },
  }) as RetryResult;

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.kind, 'lease_lost');
  assert.equal(result.failure?.attempts, 1);
  assert.equal(calls, 1);
});

test('returns a structured final failure after retry exhaustion', async () => {
  const manifest = { ...baseManifest, retry_policy: { max_attempts: 3, backoff_seconds: 0 } };
  const result = await invokeWithRetry({
    manifest,
    isLeaseActive: async () => true,
    sleep: async () => {},
    invoke: async (context: unknown) => {
      throw failure('rate_limit', attemptFrom(context).attempt, 429);
    },
  }) as RetryResult;

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failure, {
    kind: 'rate_limit',
    retryable: true,
    providerStatus: 429,
    attempts: 3,
    maxAttempts: 3,
    lastFailure: 'rate_limit failure',
  });
});
