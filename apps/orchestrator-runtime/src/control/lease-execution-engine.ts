import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ControlPlaneConflictError } from '../../../../database/control-plane.ts';
import type {
  ActiveExecutionLease,
  ControlExecutionLease,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type { PlanStep } from '../plan-types.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  CONFIG_PATHS,
  getConfigRoot,
  hashFile,
  loadToolManifest,
  type ToolManifest,
} from '../runtime/config-loader.ts';
import {
  LLMInvocationError,
  type LLMClient,
} from '../runtime/llm-client.ts';
import {
  MissingModelReceiptError,
  ModelDriftError,
  ReceiptLLMClient,
} from '../runtime/receipt-llm-client.ts';
import { SkillLoader } from '../runtime/skill-loader.ts';
import {
  ToolInvocationError,
  ToolRouter,
  type ToolAdapterResolution,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';
import { ControlArtifactStore } from './artifact-store.ts';
import { EvidenceService, type EvidenceEntry } from '../evidence/evidence-service.ts';

interface EnginePlan {
  taskId: string;
  steps: PlanStep[];
}

interface StepResult {
  output: unknown;
  kind: string;
  artifactValue?: unknown;
  toolReceipt?: ToolInvocationReceipt;
  toolResolution?: ToolAdapterResolution;
  manifestHash?: string;
  inputSchemaHash?: string;
  outputSchemaHash?: string;
  inputHash?: string;
  outputHash?: string;
  redactedOutputHash?: string;
  configHash?: string;
  sourceRefs?: string[];
}

export interface LeaseExecutionResult {
  status: 'completed' | 'paused';
  attemptId: string;
  failedStepNo?: number;
  failure?: Record<string, unknown>;
}

export class ExecutionAuthenticityError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExecutionAuthenticityError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function redactString(value: string, maskPii: boolean): string {
  const withoutData = value.startsWith('data:') && value.includes(';base64,')
    ? '[REDACTED_DATA]'
    : value;
  const withoutSecrets = withoutData.replace(
    /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
    (_match, label: string) => `${label}=[REDACTED]`,
  );
  if (!maskPii) return withoutSecrets;
  return withoutSecrets
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/g, '[REDACTED_PHONE]')
    .replace(/\b\d{17}[\dXx]\b/g, '[REDACTED_ID]')
    .replace(/(?:0\d{2,3}-)?\d{7,8}/g, '[REDACTED_LANDLINE]')
    .replace(/[\u4e00-\u9fa5]{2,}(?:省|市|区|县|路|街|号)[\u4e00-\u9fa5\d-]{0,24}/g, '[REDACTED_ADDRESS]');
}

function redactToolOutput(
  value: unknown,
  policy: Record<string, string>,
  key = '',
): unknown {
  const maskPii = policy.pii === 'mask';
  if (/^(authorization|api[_-]?key|token|secret|password|dataurl|base64)$/i.test(key)) return '[REDACTED]';
  if (maskPii && /^(name|full_name|contact_name|email|phone|mobile)$/i.test(key)) return '[REDACTED_PII]';
  if (typeof value === 'string') return redactString(value, maskPii);
  if (Array.isArray(value)) return value.map((item) => redactToolOutput(item, policy));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactToolOutput(child, policy, childKey)]));
}

function containsBlockedSensitiveData(value: unknown): boolean {
  if (typeof value === 'string') return /\b(confidential|internal[-_ ]only|business[-_ ]secret)\b|商业机密|敏感业务/i.test(value);
  if (Array.isArray(value)) return value.some(containsBlockedSensitiveData);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(confidential|internal_only|business_secret|sensitive_business_data)$/i.test(key)
    || containsBlockedSensitiveData(child),
  );
}

function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function toolConfigHash(manifest: ToolManifest, resolution: ToolAdapterResolution | null): string {
  const envKey = manifest.base_url_env;
  const resolvedBaseUrl = envKey
    ? process.env[envKey] ?? null
    : resolution?.resolvedAdapterType === 'internal_api' ? process.env.SPIDER_BASE_URL ?? null
      : resolution?.resolvedAdapterType === 'tavily' ? process.env.TAVILY_BASE_URL ?? null
        : null;
  const timeoutMs = resolution?.resolvedAdapterType === 'internal_api'
    ? process.env.SPIDER_TIMEOUT_MS ?? null
    : resolution?.resolvedAdapterType === 'tavily' ? process.env.TAVILY_TIMEOUT_MS ?? null : null;
  return hashJson({
    adapter: resolution,
    resolvedBaseUrl,
    timeoutMs,
    entrypoint: manifest.entrypoint ?? null,
    timeoutSeconds: manifest.timeout_seconds ?? null,
    retryPolicy: manifest.retry_policy ?? null,
    redactionPolicy: manifest.redaction_policy ?? null,
  });
}

function parsePlan(taskId: string, value: unknown): EnginePlan {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    throw new ExecutionAuthenticityError('active plan is malformed');
  }
  const steps = value.steps.map((item, index): PlanStep => {
    if (!isRecord(item)) throw new ExecutionAuthenticityError(`plan step ${index + 1} is malformed`);
    const stepNo = item.step_no;
    const stepName = item.step_name;
    const actorType = item.actor_type;
    const actorId = item.actor_id;
    if (
      typeof stepNo !== 'number'
      || !Number.isInteger(stepNo)
      || stepNo !== index + 1
      || typeof stepName !== 'string'
      || typeof actorId !== 'string'
      || (actorType !== 'tool' && actorType !== 'skill' && actorType !== 'llm' && actorType !== 'reviewer')
    ) {
      throw new ExecutionAuthenticityError(`plan step ${index + 1} is malformed`);
    }
    return {
      step_no: stepNo,
      step_name: stepName,
      actor_type: actorType,
      actor_id: actorId,
      purpose: typeof item.purpose === 'string' ? item.purpose : undefined,
      input: isRecord(item.input) ? item.input : undefined,
      requires_approval: typeof item.requires_approval === 'boolean' ? item.requires_approval : undefined,
    };
  });
  return { taskId, steps };
}

function sourceRefs(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((item) => {
    if (!isRecord(item)) return [];
    const ref = typeof item.url === 'string' ? item.url : typeof item.oss_url === 'string' ? item.oss_url : null;
    return ref ? [ref] : [];
  });
}

function failureFrom(error: unknown): Record<string, unknown> {
  if (error instanceof ToolInvocationError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
      receipt: error.receipt,
      ...error.details,
    };
  }
  if (error instanceof LLMInvocationError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
    };
  }
  if (error instanceof ControlPlaneConflictError) {
    return { kind: 'lease_lost', retryable: true, message: error.message };
  }
  if (error instanceof ExecutionAuthenticityError) {
    return { kind: 'authenticity', retryable: false, message: error.message, ...error.details };
  }
  if (error instanceof ModelDriftError) {
    return {
      kind: 'model_drift',
      retryable: false,
      expectedModel: error.expectedModel,
      actualModel: error.actualModel,
      message: error.message,
    };
  }
  if (error instanceof MissingModelReceiptError) {
    return { kind: 'missing_receipt', retryable: false, message: error.message };
  }
  return {
    kind: 'capability',
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof ExecutionAuthenticityError
    || error instanceof ModelDriftError
    || error instanceof MissingModelReceiptError;
}

export class LeaseExecutionEngine {
  private readonly llm: ReceiptLLMClient;

  constructor(private readonly dependencies: {
    repository: ControlPlaneRepository;
    artifacts: ControlArtifactStore;
    tools: ToolRouter;
    llm: LLMClient;
    skillLoader: SkillLoader;
    validator: SchemaValidator;
    heartbeatMs: number;
  }) {
    this.llm = new ReceiptLLMClient(dependencies.llm, dependencies.repository);
  }

  async execute(input: {
    lease: ControlExecutionLease;
    expectedModel: string;
  }): Promise<LeaseExecutionResult> {
    let active = await this.dependencies.repository.requireActiveLease(input.lease);
    const planVersion = await this.dependencies.repository.getPlanVersionDetail(input.lease.planVersionId);
    const task = await this.dependencies.repository.getTaskDetail(input.lease.taskId);
    if (!planVersion || planVersion.taskId !== input.lease.taskId || !task) {
      throw new ExecutionAuthenticityError('lease task or plan is unavailable');
    }
    let plan: EnginePlan;
    try {
      plan = parsePlan(task.id, planVersion.plan);
    } catch (error) {
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: 1,
        stepName: 'execution preflight',
        actorType: 'system',
        actorId: 'preflight',
        state: 'failed',
        failure: {
          kind: 'authenticity',
          retryable: false,
          allowedActions: ['abort'],
          message: error instanceof Error ? error.message : String(error),
        },
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      await this.dependencies.repository.pauseExecution({
        taskId: input.lease.taskId,
        attemptId: input.lease.attemptId,
        expectedVersion: active.stateVersion,
        reason: 'authenticity',
      });
      throw error;
    }
    const researchGoal = isRecord(task.structuredTask) && typeof task.structuredTask.research_goal === 'string'
      ? task.structuredTask.research_goal
      : '';
    const preflightError = await this.preflight(plan, input.expectedModel, researchGoal);
    if (preflightError) {
      const failure = failureFrom(preflightError);
      failure.allowedActions = ['abort'];
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: 1,
        stepName: 'execution preflight',
        actorType: 'system',
        actorId: 'preflight',
        state: 'failed',
        failure,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      await this.dependencies.repository.pauseExecution({
        taskId: input.lease.taskId,
        attemptId: input.lease.attemptId,
        expectedVersion: active.stateVersion,
        reason: 'authenticity',
      });
      throw preflightError;
    }
    const outputs: Array<{ actorId: string; output: unknown }> = [];

    for (const step of plan.steps) {
      const startedAt = new Date();
      active = await this.refreshLease(input.lease);
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: step.step_no,
        stepName: step.step_name,
        actorType: step.actor_type,
        actorId: step.actor_id,
        state: 'running',
        startedAt,
      });
      try {
        const result = await this.withLeaseHeartbeat(input.lease, () => this.runStep({
          step,
          lease: input.lease,
          researchGoal,
          outputs,
          expectedModel: input.expectedModel,
        }));
        await this.dependencies.repository.requireActiveLease(input.lease);
        const artifact = await this.dependencies.artifacts.writeJson({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          kind: result.kind,
          relativePath: `steps/${step.step_no}-${result.kind}.json`,
          value: result.artifactValue ?? result.output,
        });
        outputs.push({ actorId: step.actor_id, output: result.output });
        await this.dependencies.repository.recordExecutionStep({
          attemptId: input.lease.attemptId,
          stepNo: step.step_no,
          stepName: step.step_name,
          actorType: step.actor_type,
          actorId: step.actor_id,
          state: 'succeeded',
          toolProvenance: result.toolReceipt && result.toolResolution
            ? {
                registryHash: hashFile(CONFIG_PATHS.toolRegistry),
                manifestHash: result.manifestHash,
                inputSchemaHash: result.inputSchemaHash,
                outputSchemaHash: result.outputSchemaHash,
                inputHash: result.inputHash,
                outputHash: result.outputHash,
                redactedOutputHash: result.redactedOutputHash,
                configHash: result.configHash,
                declaredAdapterType: result.toolReceipt.declaredAdapterType,
                resolvedAdapterType: result.toolReceipt.resolvedAdapterType,
                implementationId: result.toolReceipt.implementationId,
                executionMode: result.toolReceipt.executionMode,
                endpointHost: result.toolReceipt.endpointHost,
                sourceRefs: result.sourceRefs,
                outputArtifactId: artifact.id,
                status: 'succeeded',
              }
            : undefined,
          latencyMs: result.toolReceipt?.latencyMs,
          startedAt,
          finishedAt: new Date(),
        });
      } catch (error) {
        const failure = failureFrom(error);
        if (step.actor_type === 'tool') {
          let tier: 'core' | 'optional' = 'core';
          try {
            tier = this.dependencies.skillLoader.getTool(step.actor_id)?.tier ?? 'core';
          } catch {
            // Config loss is itself unsafe; default core forbids skip.
          }
          failure.toolTier = tier;
          failure.allowedActions = tier === 'core'
            ? ['retry', 'abort']
            : ['retry', 'skip', 'abort'];
        }
        else {
          failure.allowedActions = failure.retryable === true ? ['retry', 'abort'] : ['abort'];
        }
        const failedToolProvenance = step.actor_type === 'tool'
          ? this.failedToolProvenance(step, researchGoal, error)
          : undefined;
        await this.dependencies.repository.recordExecutionStep({
          attemptId: input.lease.attemptId,
          stepNo: step.step_no,
          stepName: step.step_name,
          actorType: step.actor_type,
          actorId: step.actor_id,
          state: 'failed',
          failure,
          toolProvenance: failedToolProvenance,
          startedAt,
          finishedAt: new Date(),
        });
        try {
          await this.dependencies.repository.pauseExecution({
            taskId: input.lease.taskId,
            attemptId: input.lease.attemptId,
            expectedVersion: active.stateVersion,
            reason: String(failure.kind ?? 'execution_failure'),
          });
        } catch (pauseError) {
          if (!(pauseError instanceof ControlPlaneConflictError)) throw pauseError;
        }
        if (isIntegrityFailure(error)) throw error;
        return { status: 'paused', attemptId: input.lease.attemptId, failedStepNo: step.step_no, failure };
      }
    }
    const evidenceEntries = (await this.dependencies.repository.listExecutionSteps(input.lease.attemptId))
      .flatMap((step): EvidenceEntry[] => {
        const provenance = step.toolProvenance;
        const proof = provenance && typeof provenance === 'object' ? provenance : null;
        const outputHash = typeof proof?.outputHash === 'string' ? proof.outputHash : null;
        const executionMode = proof?.executionMode;
        const implementationId = proof?.implementationId;
        const refs = Array.isArray(proof?.sourceRefs)
          ? proof.sourceRefs.filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('https://'))
          : [];
        if (
          step.actorType !== 'tool'
          || step.state !== 'succeeded'
          || !outputHash
          || executionMode !== 'real'
          || typeof implementationId !== 'string'
          || refs.length === 0
        ) return [];
        return refs.map((sourceUrl, index) => ({
          id: `E${step.stepNo}-${index + 1}`,
          kind: 'tool_output',
          evidenceClass: 'public_source',
          artifactHash: outputHash,
          jsonPointer: `/results/${index}`,
          sourceUrl,
          stepNo: step.stepNo,
          toolProof: { implementationId, executionMode: 'real', outputHash },
          sensitivity: 'public',
          redaction: 'masked',
        }));
      });
    if (evidenceEntries.length === 0) {
      await this.dependencies.repository.pauseExecution({
        taskId: input.lease.taskId,
        attemptId: input.lease.attemptId,
        expectedVersion: active.stateVersion,
        reason: 'missing_core_evidence',
      });
      throw new ExecutionAuthenticityError('execution has no valid core Tool evidence');
    }
    const evidenceManifest = new EvidenceService().createManifest({
      taskId: input.lease.taskId,
      planVersionId: input.lease.planVersionId,
      attemptId: input.lease.attemptId,
      collectedAt: new Date().toISOString(),
      entries: evidenceEntries,
    });
    await this.dependencies.artifacts.writeJson({
      taskId: input.lease.taskId,
      planVersionId: input.lease.planVersionId,
      attemptId: input.lease.attemptId,
      kind: 'evidence_manifest',
      relativePath: 'evidence/manifest.json',
      value: evidenceManifest,
    });

    try {
      active = await this.refreshLease(input.lease);
      const synthesisContext = { research_goal: researchGoal, outputs };
      const synthesis = await this.withLeaseHeartbeat(input.lease, () => this.llm.generateText({
        prompt: 'Summarize the completed execution outputs without inventing new evidence.',
        context: synthesisContext,
        receipt: {
          stage: 'synthesis',
          attemptId: input.lease.attemptId,
          stepNo: plan.steps.length + 1,
          contextManifestHash: hashJson(synthesisContext),
          expectedModel: input.expectedModel,
        },
      }));
      await this.dependencies.repository.requireActiveLease(input.lease);
      await this.dependencies.artifacts.writeJson({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        attemptId: input.lease.attemptId,
        kind: 'execution_summary',
        relativePath: 'synthesis/summary.json',
        value: { text: synthesis.text },
      });
    } catch (error) {
      const failure = failureFrom(error);
      failure.allowedActions = failure.retryable === true ? ['retry', 'abort'] : ['abort'];
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: plan.steps.length + 1,
        stepName: 'execution synthesis',
        actorType: 'llm',
        actorId: 'synthesis',
        state: 'failed',
        failure,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      try {
        await this.dependencies.repository.pauseExecution({
          taskId: input.lease.taskId,
          attemptId: input.lease.attemptId,
          expectedVersion: active.stateVersion,
          reason: String(failure.kind ?? 'synthesis_failure'),
        });
      } catch (pauseError) {
        if (!(pauseError instanceof ControlPlaneConflictError)) throw pauseError;
      }
      if (isIntegrityFailure(error)) throw error;
      return {
        status: 'paused',
        attemptId: input.lease.attemptId,
        failedStepNo: plan.steps.length + 1,
        failure,
      };
    }

    await this.dependencies.repository.completeExecution(input.lease);
    return { status: 'completed', attemptId: input.lease.attemptId };
  }

  private async preflight(plan: EnginePlan, expectedModel: string, researchGoal: string): Promise<ExecutionAuthenticityError | null> {
    const tavily = this.dependencies.skillLoader.getTool('tavily-web-search');
    const hasRequiredTavily = tavily?.tier === 'core'
      && plan.steps.some((step) => step.actor_type === 'tool' && step.actor_id === 'tavily-web-search');
    if (!hasRequiredTavily) {
      return new ExecutionAuthenticityError('current P0 execution requires an active core Tavily step');
    }
    try {
      for (const step of plan.steps) {
        if (step.actor_type === 'skill') {
          const skill = this.dependencies.skillLoader.getSkill(step.actor_id);
          if (!skill) return new ExecutionAuthenticityError(`skill ${step.actor_id} is not active`);
          this.dependencies.skillLoader.loadSkillBody(step.actor_id);
          this.dependencies.skillLoader.loadSkillSchemas(step.actor_id);
          continue;
        }
        if (step.actor_type !== 'tool') continue;
        const tool = this.dependencies.skillLoader.getTool(step.actor_id);
        if (!tool) return new ExecutionAuthenticityError(`tool ${step.actor_id} is not active`);
        const manifest = loadToolManifest(tool.path);
        const resolution = this.dependencies.tools.resolve(manifest);
        const toolInput = step.input ?? { query: researchGoal };
        this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
        if (
          !resolution
          || resolution.executionMode !== 'real'
          || resolution.declaredAdapterType !== resolution.resolvedAdapterType
          || resolution.implementationId === 'unknown'
        ) {
          return new ExecutionAuthenticityError(`tool ${step.actor_id} has no qualifying real adapter`, {
            declaredAdapterType: manifest.adapter_type,
            resolvedAdapterType: resolution?.resolvedAdapterType ?? 'unknown',
            implementationId: resolution?.implementationId ?? 'unknown',
            executionMode: resolution?.executionMode ?? 'unknown',
          });
        }
      }
    } catch (error) {
      return new ExecutionAuthenticityError(
        'execution preflight failed before external side effects',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const identity = this.dependencies.llm.identity;
    if (!identity.eligibleAsReal || identity.mode !== 'real') {
      return new ExecutionAuthenticityError('LLM provider is not eligible as real', {
        provider: identity.provider,
        mode: identity.mode,
        requestedModel: identity.requestedModel,
      });
    }
    if (identity.requestedModel !== expectedModel) {
      return new ExecutionAuthenticityError('requested model does not match the execution pin', {
        requestedModel: identity.requestedModel,
        expectedModel,
      });
    }
    return null;
  }

  private async withLeaseHeartbeat<T>(lease: ControlExecutionLease, operation: () => Promise<T>): Promise<T> {
    let heartbeatFailure: unknown = null;
    const timer = setInterval(() => {
      void this.dependencies.repository.heartbeatExecutionLease({
        ...lease,
        extendUntil: new Date(Date.now() + this.dependencies.heartbeatMs),
      }).catch((error: unknown) => {
        heartbeatFailure ??= error;
      });
    }, Math.max(1, Math.floor(this.dependencies.heartbeatMs / 2)));
    try {
      const result = await operation();
      if (heartbeatFailure) throw heartbeatFailure;
      await this.dependencies.repository.requireActiveLease(lease);
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async refreshLease(lease: ControlExecutionLease): Promise<ActiveExecutionLease> {
    await this.dependencies.repository.requireActiveLease(lease);
    return this.dependencies.repository.heartbeatExecutionLease({
      ...lease,
      extendUntil: new Date(Date.now() + this.dependencies.heartbeatMs),
    });
  }

  private async runStep(input: {
    step: PlanStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    outputs: Array<{ actorId: string; output: unknown }>;
    expectedModel: string;
  }): Promise<StepResult> {
    await this.dependencies.repository.requireActiveLease(input.lease);
    switch (input.step.actor_type) {
      case 'tool':
        return this.runTool(input.step, input.researchGoal);
      case 'skill':
        return this.runSkill(input);
      case 'llm':
        return this.runLlm(input);
      case 'reviewer':
        return this.runReviewer(input);
    }
  }

  private failedToolProvenance(
    step: PlanStep,
    researchGoal: string,
    error: unknown,
  ): Record<string, unknown> {
    const receipt = error instanceof ToolInvocationError ? error.receipt : null;
    const details = error instanceof ToolInvocationError ? error.details : {};
    const refs = Array.isArray(details.sourceRefs)
      ? details.sourceRefs.filter((ref): ref is string => typeof ref === 'string')
      : [];
    const fallback = (captureFailure: unknown): Record<string, unknown> => ({
      registryHash: null,
      manifestHash: null,
      inputSchemaHash: null,
      outputSchemaHash: null,
      inputHash: hashJson(step.input ?? { query: researchGoal }),
      outputHash: typeof details.outputHash === 'string' ? details.outputHash : null,
      configHash: null,
      declaredAdapterType: receipt?.declaredAdapterType ?? 'unknown',
      resolvedAdapterType: receipt?.resolvedAdapterType ?? 'unknown',
      implementationId: receipt?.implementationId ?? 'unknown',
      executionMode: receipt?.executionMode ?? 'unknown',
      endpointHost: receipt?.endpointHost ?? null,
      sourceRefs: refs,
      status: 'failed',
      captureFailure: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
    });
    try {
      const tool = this.dependencies.skillLoader.getTool(step.actor_id);
      if (!tool) return fallback(new Error(`tool ${step.actor_id} unavailable during provenance capture`));
      const manifest = loadToolManifest(tool.path);
      const resolution = this.dependencies.tools.resolve(manifest);
      const toolInput = step.input ?? { query: researchGoal };
      return {
        registryHash: hashFile(CONFIG_PATHS.toolRegistry),
        manifestHash: hashFile(tool.path),
        inputSchemaHash: hashFile(manifest.input_schema),
        outputSchemaHash: hashFile(manifest.output_schema),
        inputHash: hashJson(toolInput),
        outputHash: typeof details.outputHash === 'string' ? details.outputHash : null,
        configHash: toolConfigHash(manifest, resolution),
        declaredAdapterType: receipt?.declaredAdapterType ?? manifest.adapter_type,
        resolvedAdapterType: receipt?.resolvedAdapterType ?? resolution?.resolvedAdapterType ?? 'unknown',
        implementationId: receipt?.implementationId ?? resolution?.implementationId ?? 'unknown',
        executionMode: receipt?.executionMode ?? resolution?.executionMode ?? 'unknown',
        endpointHost: receipt?.endpointHost ?? resolution?.endpointHost ?? null,
        sourceRefs: refs,
        status: 'failed',
      };
    } catch (captureFailure) {
      return fallback(captureFailure);
    }
  }

  private async runTool(step: PlanStep, researchGoal: string): Promise<StepResult> {
    const tool = this.dependencies.skillLoader.getTool(step.actor_id);
    if (!tool) throw new ExecutionAuthenticityError(`tool ${step.actor_id} is not active`);
    const manifest = loadToolManifest(tool.path);
    const resolution = this.dependencies.tools.resolve(manifest);
    if (
      !resolution
      || resolution.executionMode !== 'real'
      || resolution.declaredAdapterType !== resolution.resolvedAdapterType
      || resolution.implementationId === 'unknown'
    ) {
      throw new ExecutionAuthenticityError(
        `tool ${step.actor_id} has no qualifying real adapter`,
        {
          declaredAdapterType: manifest.adapter_type,
          resolvedAdapterType: resolution?.resolvedAdapterType ?? 'unknown',
          implementationId: resolution?.implementationId ?? 'unknown',
          executionMode: resolution?.executionMode ?? 'unknown',
          endpointHost: resolution?.endpointHost ?? null,
        },
      );
    }
    const toolInput = step.input ?? { query: researchGoal };
    try {
      this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
    } catch {
      throw new ToolInvocationError(step.actor_id, {
        kind: 'schema',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'tool input failed schema validation',
        receipt: {
          declaredAdapterType: manifest.adapter_type,
          resolvedAdapterType: resolution.resolvedAdapterType,
          implementationId: resolution.implementationId,
          executionMode: resolution.executionMode,
          endpointHost: resolution.endpointHost,
          status: 'failed',
          latencyMs: 0,
        },
        details: { inputHash: hashJson(toolInput) },
      });
    }
    const result = await this.dependencies.tools.invoke({ toolId: step.actor_id, input: toolInput, manifest });
    try {
      this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), manifest.output_schema), result.output);
    } catch {
      throw new ToolInvocationError(step.actor_id, {
        kind: 'schema',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'tool output failed schema validation',
        receipt: result.receipt,
        details: {
          outputHash: hashJson(result.output),
          sourceRefs: sourceRefs(result.output),
        },
      });
    }
    const redactionPolicy = manifest.redaction_policy ?? {};
    if (
      redactionPolicy.sensitive_business_data === 'block'
      && containsBlockedSensitiveData(result.output)
    ) {
      throw new ToolInvocationError(step.actor_id, {
        kind: 'safety',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'tool output blocked by sensitive business data policy',
        receipt: result.receipt,
        details: {
          outputHash: hashJson(result.output),
          sourceRefs: sourceRefs(result.output),
        },
      });
    }
    const originalOutputHash = hashJson(result.output);
    const redactedOutput = redactToolOutput(result.output, redactionPolicy);
    const redactedOutputHash = hashJson(redactedOutput);
    const refs = sourceRefs(redactedOutput);
    return {
      output: redactedOutput,
      artifactValue: {
        output: redactedOutput,
        outputHash: originalOutputHash,
        redactedOutputHash,
        sourceRefs: refs,
        schemaValidated: true,
        redactionPolicy: manifest.redaction_policy ?? {},
      },
      kind: 'tool_output',
      toolReceipt: result.receipt,
      toolResolution: resolution,
      manifestHash: hashFile(tool.path),
      inputSchemaHash: hashFile(manifest.input_schema),
      outputSchemaHash: hashFile(manifest.output_schema),
      inputHash: hashJson(toolInput),
      outputHash: originalOutputHash,
      redactedOutputHash,
      configHash: toolConfigHash(manifest, resolution),
      sourceRefs: refs,
    };
  }

  private async runSkill(input: {
    step: PlanStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    outputs: Array<{ actorId: string; output: unknown }>;
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('skill LLM provider is not eligible as real');
    }
    const skill = this.dependencies.skillLoader.getSkill(input.step.actor_id);
    if (!skill) throw new ExecutionAuthenticityError(`skill ${input.step.actor_id} is not active`);
    const body = this.dependencies.skillLoader.loadSkillBody(input.step.actor_id);
    const schemas = this.dependencies.skillLoader.loadSkillSchemas(input.step.actor_id);
    const skillContext = { research_goal: input.researchGoal, tool_outputs: input.outputs };
    const result = await this.llm.generateStructured<object>({
      prompt: `Execute this Skill workflow using only supplied outputs.\n\n${body.body}`,
      schema: schemas.output ?? {},
      schemaName: `skill:${input.step.actor_id}`,
      context: skillContext,
      receipt: {
        stage: 'skill',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: hashJson(skillContext),
        expectedModel: input.expectedModel,
      },
    });
    if (skill.output_schema) {
      this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), skill.output_schema), result.data);
    }
    return { output: result.data, kind: 'skill_output', outputHash: hashJson(result.data) };
  }

  private async runLlm(input: {
    step: PlanStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    outputs: Array<{ actorId: string; output: unknown }>;
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('LLM provider is not eligible as real');
    }
    const llmContext = { research_goal: input.researchGoal, outputs: input.outputs };
    const result = await this.llm.generateText({
      prompt: `Execute plan step: ${input.step.step_name}. ${input.step.purpose ?? ''}`,
      context: llmContext,
      receipt: {
        stage: 'llm',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: hashJson(llmContext),
        expectedModel: input.expectedModel,
      },
    });
    return { output: { text: result.text }, kind: 'llm_output' };
  }

  private async runReviewer(input: {
    step: PlanStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    outputs: Array<{ actorId: string; output: unknown }>;
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('reviewer LLM provider is not eligible as real');
    }
    const reviewerContext = { research_goal: input.researchGoal, outputs: input.outputs };
    const result = await this.llm.generateText({
      prompt: `Review completed outputs for source support and gaps: ${input.step.step_name}.`,
      context: reviewerContext,
      receipt: {
        stage: 'reviewer',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: hashJson(reviewerContext),
        expectedModel: input.expectedModel,
      },
    });
    return { output: { review: result.text }, kind: 'review_output' };
  }
}
