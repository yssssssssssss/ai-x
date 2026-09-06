import { createHash } from 'node:crypto';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LLMProviderIdentity {
  provider: string;
  endpointHost: string;
  requestedModel: string;
  mode: 'mock' | 'real' | 'draft';
  eligibleAsReal: boolean;
}

export interface LLMResult<T> {
  data: T;
  promptHash: string;
  modelName: string;
  modelVersion: string;
  traceId: string;
  receiptId?: string;
  tokens?: TokenUsage;
  providerIdentity?: LLMProviderIdentity;
  expectedModel?: string;
}

export type TextLLMResult = Omit<LLMResult<string>, 'data'> & { text: string };

export type LLMFailureKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'quota'
  | 'authentication'
  | 'configuration'
  | 'schema'
  | 'capability'
  | 'cancelled'
  | 'unknown';

export class LLMInvocationError extends Error {
  constructor(
    readonly kind: LLMFailureKind,
    readonly retryable: boolean,
    readonly providerStatus: number | null,
    readonly sanitizedMessage: string,
  ) {
    super(sanitizedMessage);
    this.name = 'LLMInvocationError';
  }
}

export interface LLMReceiptContext {
  stage: string;
  attemptId?: string;
  stepNo?: number;
  contextManifestHash?: string;
  expectedModel?: string;
}

export interface StructuredLLMCallOptions {
  prompt: string;
  schema: object;
  schemaName: string;
  context?: object;
  signal?: AbortSignal;
  receipt: LLMReceiptContext;
}

export interface TextLLMCallOptions {
  prompt: string;
  systemPrompt?: string;
  context?: object;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  receipt: LLMReceiptContext;
}

export interface ModelCallRecordInput {
  attemptId?: string;
  stage: string;
  stepNo?: number;
  provider: string;
  endpointHost: string;
  requestedModel: string;
  actualModel: string;
  modelVersion?: string;
  promptHash: string;
  contextManifestHash?: string;
  traceId?: string;
  tokens?: TokenUsage;
  status: 'succeeded' | 'failed';
  failure: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface ModelCallRecorder {
  recordModelCall(input: ModelCallRecordInput): Promise<string>;
}

export interface LLMClient {
  readonly identity: LLMProviderIdentity;
  generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>>;
  generateText(options: TextLLMCallOptions): Promise<TextLLMResult>;
}

export type LegacyStructuredLLMCallOptions = Omit<StructuredLLMCallOptions, 'receipt'> & {
  receipt?: LLMReceiptContext;
};
export type LegacyTextLLMCallOptions = Omit<TextLLMCallOptions, 'receipt'> & {
  receipt?: LLMReceiptContext;
};

export function hashPrompt(prompt: string, context?: object, schemaName?: string): string {
  const hash = createHash('sha256');
  hash.update(prompt);
  if (context) hash.update(JSON.stringify(context));
  if (schemaName) hash.update(schemaName);
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

interface FixtureSchema {
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  required?: string[];
  properties?: Record<string, FixtureSchema>;
  items?: FixtureSchema;
  minItems?: number;
  minimum?: number;
  uniqueItems?: boolean;
  oneOf?: FixtureSchema[];
  anyOf?: FixtureSchema[];
}

function fixtureValue(schema: FixtureSchema, itemIndex = 0): unknown {
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum?.length) return structuredClone(schema.enum[itemIndex % schema.enum.length]);
  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative) return fixtureValue(alternative);
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties) {
    return Object.fromEntries((schema.required ?? []).map((key) => [
      key,
      fixtureValue(schema.properties?.[key] ?? {}, itemIndex),
    ]));
  }
  if (type === 'array') {
    return Array.from({ length: schema.minItems ?? 0 }, (_, index) => fixtureValue(schema.items ?? {}, index));
  }
  if (type === 'integer') return Math.ceil(schema.minimum ?? 0);
  if (type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'string') return 'mock';
  return {};
}

export type FixtureMap = Record<string, unknown>;

export class MockLLMClient implements LLMClient {
  constructor(
    private readonly fixtures: FixtureMap = {},
    private readonly model = {
      name: process.env.LLM_MODEL_NAME ?? 'mock-llm',
      version: process.env.LLM_MODEL_VERSION ?? 'v0',
    },
  ) {}

  get identity(): LLMProviderIdentity {
    return {
      provider: 'mock',
      endpointHost: 'local-mock',
      requestedModel: this.model.name,
      mode: 'mock',
      eligibleAsReal: false,
    };
  }

  async generateStructured<T>(options: LegacyStructuredLLMCallOptions): Promise<LLMResult<T>> {
    const fixture = this.fixtures[options.schemaName] ?? fixtureValue(options.schema as FixtureSchema);
    return {
      data: structuredClone(fixture) as T,
      promptHash: hashPrompt(options.prompt, options.context, options.schemaName),
      modelName: this.model.name,
      modelVersion: this.model.version,
      traceId: this.trace(options.prompt, options.schemaName),
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async generateText(options: LegacyTextLLMCallOptions): Promise<TextLLMResult> {
    return {
      text: typeof this.fixtures.__text__ === 'string' ? this.fixtures.__text__ : '（mock 文本输出）',
      promptHash: hashPrompt(
        options.systemPrompt ? `${options.systemPrompt}\n\n${options.prompt}` : options.prompt,
        options.context,
      ),
      modelName: this.model.name,
      modelVersion: this.model.version,
      traceId: this.trace(options.prompt, 'text'),
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }

  private trace(prompt: string, schemaName: string): string {
    return `trace_${createHash('sha256').update(schemaName + prompt).digest('hex').slice(0, 12)}`;
  }
}
