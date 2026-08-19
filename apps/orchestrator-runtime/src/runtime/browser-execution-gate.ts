import {
  ToolInvocationError,
  throwIfToolInvocationAborted,
  toolAbortError,
  type ToolInvocationContext,
} from './tool-adapter.ts';
import { performance } from 'node:perf_hooks';

export interface BrowserExecutionLease {
  release(): void;
}

interface BrowserExecutionGateOptions {
  maxActive?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
}

interface Waiter {
  toolId: string;
  context: ToolInvocationContext;
  resolve: (lease: BrowserExecutionLease) => void;
  reject: (error: ToolInvocationError) => void;
  queueTimer: NodeJS.Timeout;
  deadlineTimer: NodeJS.Timeout;
  onAbort: () => void;
  settled: boolean;
}

export class BrowserExecutionGate {
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: BrowserExecutionGateOptions = {}) {
    this.maxActive = options.maxActive ?? 2;
    this.maxQueued = options.maxQueued ?? 8;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 10_000;
    for (const [name, value] of [
      ['maxActive', this.maxActive],
      ['maxQueued', this.maxQueued],
      ['queueTimeoutMs', this.queueTimeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value < (name === 'maxActive' ? 1 : 0)) {
        throw new Error(`${name} must be a non-negative integer${name === 'maxActive' ? ' greater than zero' : ''}`);
      }
    }
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  async acquire(toolId: string, context: ToolInvocationContext): Promise<BrowserExecutionLease> {
    throwIfToolInvocationAborted(toolId, context);
    if (this.active < this.maxActive) {
      this.active += 1;
      return this.lease();
    }
    if (this.queue.length >= this.maxQueued) throw this.capacityError(toolId);

    return new Promise<BrowserExecutionLease>((resolve, reject) => {
      const queueExpiresAt = performance.now() + this.queueTimeoutMs;
      const waiter = {} as Waiter;
      const settleError = (error: ToolInvocationError) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.queueTimer);
        clearTimeout(waiter.deadlineTimer);
        context.signal.removeEventListener('abort', waiter.onAbort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(error);
      };
      waiter.toolId = toolId;
      waiter.context = context;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.settled = false;
      waiter.onAbort = () => settleError(toolAbortError(toolId, context.signal, context.deadlineAt));
      const settleAtDeadline = () => {
        if (waiter.settled) return;
        const remaining = context.deadlineAt - Date.now();
        if (remaining > 0) {
          waiter.deadlineTimer = setTimeout(settleAtDeadline, remaining);
          return;
        }
        settleError(toolAbortError(toolId, context.signal, context.deadlineAt));
      };
      const settleAtQueueExpiry = () => {
        if (waiter.settled) return;
        const remaining = queueExpiresAt - performance.now();
        if (remaining > 0) {
          waiter.queueTimer = setTimeout(settleAtQueueExpiry, remaining);
          return;
        }
        settleError(Date.now() >= context.deadlineAt
          ? toolAbortError(toolId, context.signal, context.deadlineAt)
          : this.capacityError(toolId));
      };
      waiter.deadlineTimer = setTimeout(
        settleAtDeadline,
        Math.max(0, context.deadlineAt - Date.now()),
      );
      waiter.queueTimer = setTimeout(settleAtQueueExpiry, this.queueTimeoutMs);
      context.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      if (context.signal.aborted) waiter.onAbort();
    });
  }

  private capacityError(toolId: string): ToolInvocationError {
    return new ToolInvocationError(toolId, {
      kind: 'capacity',
      retryable: true,
      sanitizedMessage: 'browser execution capacity is unavailable',
      details: {
        active: this.active,
        queued: this.queue.length,
        maxActive: this.maxActive,
        maxQueued: this.maxQueued,
      },
    });
  }

  private lease(): BrowserExecutionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.maxActive) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.queueTimer);
      clearTimeout(waiter.deadlineTimer);
      waiter.context.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.context.signal.aborted || Date.now() >= waiter.context.deadlineAt) {
        waiter.reject(toolAbortError(waiter.toolId, waiter.context.signal, waiter.context.deadlineAt));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.lease());
    }
  }
}
