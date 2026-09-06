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
      const receiptId = await this.recordOrThrow(opts.receipt, result, startedAt);
      return { ...result, receiptId };
    } catch (error) {
      if (error instanceof ModelDriftError || error instanceof MissingModelReceiptError) throw error;
      await this.recordFailureOrThrow(
        opts.receipt,
        error,
        startedAt,
        hashPrompt(opts.prompt, opts.context, opts.schemaName, opts.images),
      );
      throw error;
    }
  }

  async generateText(opts: TextLLMCallOptions): Promise<TextLLMResult> {
    const startedAt = new Date();
    try {
      const result = await this.inner.generateText(opts);
      const receiptId = await this.recordOrThrow(opts.receipt, result, startedAt);
      return { ...result, receiptId };
    } catch (error) {
      if (error instanceof ModelDriftError || error instanceof MissingModelReceiptError) throw error;
      await this.recordFailureOrThrow(
        opts.receipt,
        error,
        startedAt,
        hashPrompt(
          opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt,
          opts.context,
          undefined,
          opts.images,
        ),
      );
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
  ): Promise<string> {
    if (!receipt) {
      throw new MissingModelReceiptError(new Error('missing receipt context'));
    }
    const finishedAt = new Date();
    const identity = result.providerIdentity ?? this.inner.identity;
    const expectedModel = result.expectedModel ?? receipt.expectedModel;
    const drift = expectedModel !== undefined && expectedModel !== result.modelName;
    let receiptId: string;
    try {
      receiptId = await this.recorder.recordModelCall({
        attemptId: receipt.attemptId,
        stage: receipt.stage,
        stepNo: receipt.stepNo,
        provider: identity.provider,
        endpointHost: identity.endpointHost,
        requestedModel: identity.requestedModel,
        actualModel: result.modelName,
        modelVersion: result.modelVersion,
        promptHash: result.promptHash,
        contextManifestHash: receipt.contextManifestHash ?? undefined,
        traceId: result.traceId,
        tokens: result.tokens,
        status: drift ? 'failed' : 'succeeded',
        failure: drift
          ? { kind: 'model_drift', expectedModel, actualModel: result.modelName }
          : null,
        startedAt,
        finishedAt,
      });
    } catch (error) {
      throw new MissingModelReceiptError(error);
    }
    if (drift && expectedModel !== undefined) {
      throw new ModelDriftError(expectedModel, result.modelName);
    }
    return receiptId;
  }
}
