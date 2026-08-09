import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  LLMReceiptContext,
  ModelCallRecorder,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from './llm-client.ts';
import { hashPrompt } from './llm-client.ts';

export class ModelDriftError extends Error {
  constructor(
    public readonly expectedModel: string,
    public readonly actualModel: string,
  ) {
    super(`model drift: expected ${expectedModel}, got ${actualModel}`);
    this.name = 'ModelDriftError';
  }
}

export class MissingModelReceiptError extends Error {
  constructor(cause: unknown) {
    super('model receipt was not persisted', { cause });
    this.name = 'MissingModelReceiptError';
  }
}

export class ReceiptLLMClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    private readonly recorder: ModelCallRecorder,
  ) {}

  get identity(): LLMProviderIdentity {
    return this.inner.identity;
  }

  async generateStructured<T>(opts: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const startedAt = new Date();
    try {
      const result = await this.inner.generateStructured<T>(opts);
      await this.recordOrThrow(opts.receipt, result, startedAt);
      return result;
    } catch (error) {
      if (error instanceof ModelDriftError || error instanceof MissingModelReceiptError) throw error;
      await this.recordFailureOrThrow(
        opts.receipt,
        error,
        startedAt,
        hashPrompt(opts.prompt, opts.context, opts.schemaName),
      );
      throw error;
    }
  }

  async generateText(opts: TextLLMCallOptions): Promise<TextLLMResult> {
    const startedAt = new Date();
    try {
      const result = await this.inner.generateText(opts);
      await this.recordOrThrow(opts.receipt, result, startedAt);
      return result;
    } catch (error) {
      if (error instanceof ModelDriftError || error instanceof MissingModelReceiptError) throw error;
      await this.recordFailureOrThrow(opts.receipt, error, startedAt, hashPrompt(opts.prompt, opts.context));
      throw error;
    }
  }

  private async recordFailureOrThrow(
    receipt: LLMReceiptContext,
    error: unknown,
    startedAt: Date,
    promptHash: string,
  ): Promise<void> {
    const structured = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const failure = {
      kind: typeof structured.kind === 'string' ? structured.kind : 'provider_call',
      retryable: typeof structured.retryable === 'boolean' ? structured.retryable : false,
      providerStatus: typeof structured.providerStatus === 'number' ? structured.providerStatus : null,
      message: typeof structured.sanitizedMessage === 'string'
        ? structured.sanitizedMessage
        : error instanceof Error ? error.message : String(error),
    };
    try {
      await this.recorder.recordModelCall({
        attemptId: receipt.attemptId,
        stage: receipt.stage,
        stepNo: receipt.stepNo,
        provider: this.inner.identity.provider,
        endpointHost: this.inner.identity.endpointHost,
        requestedModel: this.inner.identity.requestedModel,
        actualModel: 'unknown',
        promptHash,
        contextManifestHash: receipt.contextManifestHash,
        status: 'failed',
        failure,
        startedAt,
        finishedAt: new Date(),
      });
    } catch (receiptError) {
      throw new MissingModelReceiptError(receiptError);
    }
  }

  private async recordOrThrow<T extends LLMResult<unknown> | TextLLMResult>(
    receipt: LLMReceiptContext | undefined,
    result: T,
    startedAt: Date,
  ): Promise<void> {
    if (!receipt) {
      throw new MissingModelReceiptError(new Error('missing receipt context'));
    }
    const finishedAt = new Date();
    const expectedModel = receipt.expectedModel;
    const drift = expectedModel !== undefined && expectedModel !== result.modelName;
    try {
      await this.recorder.recordModelCall({
        attemptId: receipt.attemptId,
        stage: receipt.stage,
        stepNo: receipt.stepNo,
        provider: this.inner.identity.provider,
        endpointHost: this.inner.identity.endpointHost,
        requestedModel: this.inner.identity.requestedModel,
        actualModel: result.modelName,
        promptHash: result.promptHash,
        contextManifestHash: receipt.contextManifestHash,
        traceId: result.traceId,
        tokens: result.tokens,
        status: drift ? 'failed' : 'succeeded',
        failure: drift
          ? { kind: 'model_drift', expectedModel, actualModel: result.modelName }
          : null,
        startedAt,
        finishedAt,
      });
    } catch (err) {
      throw new MissingModelReceiptError(err);
    }
    if (drift && expectedModel !== undefined) {
      throw new ModelDriftError(expectedModel, result.modelName);
    }
  }
}
