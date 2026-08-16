import { randomUUID } from 'node:crypto';
import type { ToolManifest } from '../runtime/config-loader.ts';
import {
  ToolInvocationError,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';

export interface ToolRetryAttemptContext {
  attempt: number;
  attemptId: string;
}

export interface ToolRetryAttemptResult<T = unknown> {
  output: T;
  receipt: ToolInvocationReceipt;
  latencyMs?: number;
}

export interface ToolRetryAttemptReceipt {
  attempt: number;
  attemptId: string;
  status: 'failed' | 'succeeded';
  receipt?: ToolInvocationReceipt;
  failure?: {
    kind?: string;
    providerStatus?: number | null;
  };
}

export interface ToolRetryFailure {
  kind: string;
  retryable: boolean;
  providerStatus: number | null;
  attempts: number;
  maxAttempts: number;
  lastFailure?: string;
}

export type ToolRetryResult<T = unknown> =
  | {
      status: 'succeeded';
      output: T;
      receipt: ToolInvocationReceipt;
      latencyMs?: number;
      attemptReceipts: ToolRetryAttemptReceipt[];
    }
  | {
      status: 'failed';
      failure: ToolRetryFailure;
      attemptReceipts: ToolRetryAttemptReceipt[];
    };

export interface ToolRetryInput<T = unknown> {
  manifest: ToolManifest;
  isLeaseActive: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  invoke: (context: ToolRetryAttemptContext) => Promise<ToolRetryAttemptResult<T>>;
}

interface RetryErrorInfo {
  kind: string;
  retryable: boolean;
  providerStatus: number | null;
  message: string;
  receipt?: ToolInvocationReceipt;
}

function errorInfo(error: unknown): RetryErrorInfo {
  if (error instanceof ToolInvocationError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
      receipt: error.receipt ?? undefined,
    };
  }
  if (error && typeof error === 'object') {
    const candidate = error as {
      kind?: unknown;
      retryable?: unknown;
      providerStatus?: unknown;
      sanitizedMessage?: unknown;
      receipt?: unknown;
      message?: unknown;
    };
    return {
      kind: typeof candidate.kind === 'string' ? candidate.kind : 'unknown',
      retryable: candidate.retryable === true,
      providerStatus: typeof candidate.providerStatus === 'number' ? candidate.providerStatus : null,
      message: typeof candidate.sanitizedMessage === 'string'
        ? candidate.sanitizedMessage
        : typeof candidate.message === 'string' ? candidate.message : String(error),
      receipt: candidate.receipt && typeof candidate.receipt === 'object'
        ? candidate.receipt as ToolInvocationReceipt
        : undefined,
    };
  }
  return {
    kind: 'unknown',
    retryable: false,
    providerStatus: null,
    message: String(error),
  };
}

function retryableFailure(info: RetryErrorInfo): boolean {
  if (info.kind === 'network' || info.kind === 'timeout') return true;
  if (info.kind === 'rate_limit') return info.providerStatus === 429;
  if (info.kind === 'server') return info.providerStatus !== null && info.providerStatus >= 500 && info.providerStatus <= 599;
  return false;
}

async function leaseActive(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

function leaseLost(
  attempts: number,
  maxAttempts: number,
  attemptReceipts: ToolRetryAttemptReceipt[],
): ToolRetryResult {
  return {
    status: 'failed',
    failure: {
      kind: 'lease_lost',
      retryable: true,
      providerStatus: null,
      attempts,
      maxAttempts,
    },
    attemptReceipts,
  };
}

export async function invokeWithRetry<T = unknown>(input: ToolRetryInput<T>): Promise<ToolRetryResult<T>> {
  const configuredMaxAttempts = input.manifest.retry_policy?.max_attempts ?? 1;
  const maxAttempts = Math.max(1, Math.floor(configuredMaxAttempts));
  const backoffMs = Math.max(0, input.manifest.retry_policy?.backoff_seconds ?? 0) * 1_000;
  const attemptReceipts: ToolRetryAttemptReceipt[] = [];

  if (!(await leaseActive(input.isLeaseActive))) return leaseLost(0, maxAttempts, attemptReceipts) as ToolRetryResult<T>;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const context: ToolRetryAttemptContext = { attempt, attemptId: randomUUID() };
    try {
      const result = await input.invoke(context);
      attemptReceipts.push({
        attempt,
        attemptId: context.attemptId,
        status: 'succeeded',
        receipt: result.receipt,
      });
      return {
        status: 'succeeded',
        output: result.output,
        receipt: result.receipt,
        latencyMs: result.latencyMs,
        attemptReceipts,
      };
    } catch (error) {
      const info = errorInfo(error);
      attemptReceipts.push({
        attempt,
        attemptId: context.attemptId,
        status: 'failed',
        receipt: info.receipt,
        failure: { kind: info.kind, providerStatus: info.providerStatus },
      });
      const canRetry = retryableFailure(info) && attempt < maxAttempts;
      if (!canRetry) {
        return {
          status: 'failed',
          failure: {
            kind: info.kind,
            retryable: retryableFailure(info),
            providerStatus: info.providerStatus,
            attempts: attempt,
            maxAttempts,
            lastFailure: info.message,
          },
          attemptReceipts,
        };
      }
      if (!(await leaseActive(input.isLeaseActive))) return leaseLost(attempt, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
      await input.sleep(backoffMs);
      if (!(await leaseActive(input.isLeaseActive))) return leaseLost(attempt, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
    }
  }

  throw new Error('tool retry policy exhausted without a terminal result');
}
