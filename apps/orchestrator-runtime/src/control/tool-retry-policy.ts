import { randomUUID } from 'node:crypto';
import type { ToolManifest } from '../runtime/config-loader.ts';
import {
  ToolInvocationError,
  type ToolAbortReason,
  type ToolInvocationContext,
  type ToolKnowledgeAttachment,
  type ToolMediaAttachment,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';

export interface ToolRetryAttemptContext {
  attempt: number;
  attemptId: string;
  invocation: ToolInvocationContext;
}

export interface ToolRetryAttemptResult<T = unknown> {
  output: T;
  receipt: ToolInvocationReceipt;
  latencyMs?: number;
  mediaAttachments?: ToolMediaAttachment[];
  knowledgeAttachments?: ToolKnowledgeAttachment[];
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
  abortReason?: ToolAbortReason;
  details?: Record<string, unknown>;
}

export type ToolRetryResult<T = unknown> =
  | {
      status: 'succeeded';
      output: T;
      receipt: ToolInvocationReceipt;
      latencyMs?: number;
      mediaAttachments?: ToolMediaAttachment[];
      knowledgeAttachments?: ToolKnowledgeAttachment[];
      attemptReceipts: ToolRetryAttemptReceipt[];
    }
  | {
      status: 'failed';
      failure: ToolRetryFailure;
      attemptReceipts: ToolRetryAttemptReceipt[];
    };

export interface ToolRetryInput<T = unknown> {
  manifest: ToolManifest;
  context: ToolInvocationContext;
  isLeaseActive: () => Promise<boolean>;
  onLeaseLost?: () => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  invoke: (context: ToolRetryAttemptContext) => Promise<ToolRetryAttemptResult<T>>;
}

interface RetryErrorInfo {
  kind: string;
  retryable: boolean;
  providerStatus: number | null;
  message: string;
  receipt?: ToolInvocationReceipt;
  details?: Record<string, unknown>;
}

function errorInfo(error: unknown): RetryErrorInfo {
  if (error instanceof ToolInvocationError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
      receipt: error.receipt ?? undefined,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
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
      details?: unknown;
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
      ...(candidate.details
        && typeof candidate.details === 'object'
        && !Array.isArray(candidate.details)
        && Object.keys(candidate.details).length > 0
        ? { details: candidate.details as Record<string, unknown> }
        : {}),
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
  if (!info.retryable) return false;
  if (info.kind === 'capacity') return true;
  if (info.kind === 'network' || info.kind === 'timeout') return true;
  if (info.kind === 'rate_limit') return info.providerStatus === 429;
  if (info.kind === 'server') return info.providerStatus !== null && info.providerStatus >= 500 && info.providerStatus <= 599;
  return false;
}

async function leaseActive(
  check: () => Promise<boolean>,
  context: ToolInvocationContext,
): Promise<'active' | 'inactive' | 'deadline_exceeded'> {
  const remainingMs = context.deadlineAt - Date.now();
  if (context.signal.aborted) return 'inactive';
  if (remainingMs <= 0) return 'deadline_exceeded';

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<'inactive' | 'deadline_exceeded'>((resolve) => {
    onAbort = () => resolve('inactive');
    context.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => resolve('deadline_exceeded'), remainingMs);
    if (context.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      check().then((active) => active ? 'active' as const : 'inactive' as const)
        .catch(() => 'inactive' as const),
      interrupted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) context.signal.removeEventListener('abort', onAbort);
  }
}
function safeReceipt(receipt: ToolInvocationReceipt | undefined): ToolInvocationReceipt | undefined {
  if (!receipt) return undefined;
  return {
    declaredAdapterType: receipt.declaredAdapterType,
    resolvedAdapterType: receipt.resolvedAdapterType,
    implementationId: receipt.implementationId,
    executionMode: receipt.executionMode,
    endpointHost: receipt.endpointHost,
    status: receipt.status,
    latencyMs: receipt.latencyMs,
    ...(receipt.attemptId === undefined ? {} : { attemptId: receipt.attemptId }),
    ...(receipt.retryOf === undefined ? {} : { retryOf: receipt.retryOf }),
    ...(receipt.runtimeVersions === undefined
      ? {}
      : { runtimeVersions: { ...receipt.runtimeVersions } }),
  };
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

function signalLeaseLost(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* the lease result remains authoritative */ }
}

function abortReason(context: ToolInvocationContext): ToolAbortReason | null {
  if (context.signal.aborted) {
    if (context.signal.reason === 'lease_lost') return 'lease_lost';
    if (context.signal.reason === 'deadline_exceeded') return 'deadline_exceeded';
  }
  return Date.now() >= context.deadlineAt ? 'deadline_exceeded' : null;
}

function abortedResult<T>(
  context: ToolInvocationContext,
  attempts: number,
  maxAttempts: number,
  attemptReceipts: ToolRetryAttemptReceipt[],
): ToolRetryResult<T> | null {
  const reason = abortReason(context);
  if (!reason) return null;
  if (reason === 'lease_lost') {
    const result = leaseLost(attempts, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
    if (result.status === 'failed') result.failure.abortReason = reason;
    return result;
  }
  return deadlineExceeded(attempts, maxAttempts, attemptReceipts);
}

function deadlineExceeded<T>(
  attempts: number,
  maxAttempts: number,
  attemptReceipts: ToolRetryAttemptReceipt[],
): ToolRetryResult<T> {
  return {
    status: 'failed',
    failure: {
      kind: 'timeout',
      retryable: true,
      providerStatus: null,
      attempts,
      maxAttempts,
      lastFailure: 'tool execution deadline exceeded',
      abortReason: 'deadline_exceeded',
    },
    attemptReceipts,
  };
}

async function sleepUntilBackoffOrAbort(
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms, signal), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function invokeWithRetry<T = unknown>(input: ToolRetryInput<T>): Promise<ToolRetryResult<T>> {
  const configuredMaxAttempts = input.manifest.retry_policy?.max_attempts ?? 1;
  const maxAttempts = Math.max(1, Math.floor(configuredMaxAttempts));
  const backoffMs = Math.max(0, input.manifest.retry_policy?.backoff_seconds ?? 0) * 1_000;
  const attemptReceipts: ToolRetryAttemptReceipt[] = [];
  const invocation = input.context;

  const abortedBeforeLease = abortedResult<T>(invocation, 0, maxAttempts, attemptReceipts);
  if (abortedBeforeLease) return abortedBeforeLease;
  const initialLeaseState = await leaseActive(input.isLeaseActive, invocation);
  const abortedAfterInitialLease = abortedResult<T>(invocation, 0, maxAttempts, attemptReceipts);
  if (abortedAfterInitialLease) return abortedAfterInitialLease;
  if (initialLeaseState === 'deadline_exceeded') {
    return deadlineExceeded(0, maxAttempts, attemptReceipts);
  }
  if (initialLeaseState === 'inactive') {
    signalLeaseLost(input.onLeaseLost);
    return leaseLost(0, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const abortedBeforeAttempt = abortedResult<T>(invocation, attempt - 1, maxAttempts, attemptReceipts);
    if (abortedBeforeAttempt) return abortedBeforeAttempt;
    const context: ToolRetryAttemptContext = { attempt, attemptId: randomUUID(), invocation };
    try {
      const result = await input.invoke(context);
      attemptReceipts.push({
        attempt,
        attemptId: context.attemptId,
        status: 'succeeded',
        receipt: safeReceipt(result.receipt),
      });
      const abortedAfterSuccess = abortedResult<T>(
        invocation,
        attempt,
        maxAttempts,
        attemptReceipts,
      );
      if (abortedAfterSuccess) return abortedAfterSuccess;
      return {
        status: 'succeeded',
        output: result.output,
        receipt: safeReceipt(result.receipt)!,
        latencyMs: result.latencyMs,
        mediaAttachments: result.mediaAttachments,
        knowledgeAttachments: result.knowledgeAttachments,
        attemptReceipts,
      };
    } catch (error) {
      const info = errorInfo(error);
      attemptReceipts.push({
        attempt,
        attemptId: context.attemptId,
        status: 'failed',
        receipt: safeReceipt(info.receipt),
        failure: { kind: info.kind, providerStatus: info.providerStatus },
      });
      const abortedAfterAttempt = abortedResult<T>(invocation, attempt, maxAttempts, attemptReceipts);
      if (abortedAfterAttempt) return abortedAfterAttempt;
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
            ...(info.details ? { details: info.details } : {}),
          },
          attemptReceipts,
        };
      }
      const leaseStateBeforeBackoff = await leaseActive(input.isLeaseActive, invocation);
      const abortedBeforeBackoff = abortedResult<T>(invocation, attempt, maxAttempts, attemptReceipts);
      if (abortedBeforeBackoff) return abortedBeforeBackoff;
      if (leaseStateBeforeBackoff === 'deadline_exceeded') {
        return deadlineExceeded(attempt, maxAttempts, attemptReceipts);
      }
      if (leaseStateBeforeBackoff === 'inactive') {
        signalLeaseLost(input.onLeaseLost);
        return leaseLost(attempt, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
      }
      await sleepUntilBackoffOrAbort(input.sleep, backoffMs, invocation.signal);
      const abortedAfterBackoff = abortedResult<T>(invocation, attempt, maxAttempts, attemptReceipts);
      if (abortedAfterBackoff) return abortedAfterBackoff;
      const leaseStateAfterBackoff = await leaseActive(input.isLeaseActive, invocation);
      const abortedAfterFinalLease = abortedResult<T>(invocation, attempt, maxAttempts, attemptReceipts);
      if (abortedAfterFinalLease) return abortedAfterFinalLease;
      if (leaseStateAfterBackoff === 'deadline_exceeded') {
        return deadlineExceeded(attempt, maxAttempts, attemptReceipts);
      }
      if (leaseStateAfterBackoff === 'inactive') {
        signalLeaseLost(input.onLeaseLost);
        return leaseLost(attempt, maxAttempts, attemptReceipts) as ToolRetryResult<T>;
      }
    }
  }

  throw new Error('tool retry policy exhausted without a terminal result');
}
