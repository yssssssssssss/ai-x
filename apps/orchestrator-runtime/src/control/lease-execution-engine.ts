import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ControlPlaneConflictError } from '../../../../database/control-plane.ts';
import type {
  ActiveExecutionLease,
  ControlExecutionLease,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type {
  CurrentPlanStep,
  EvidenceClass,
  EvidenceManifest,
  EvidenceRequirement,
  PendingInput,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { PassedReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  CONFIG_PATHS,
  getConfigRoot,
  hashFile,
  loadToolManifest,
  type ToolManifest,
} from '../runtime/config-loader.ts';
import {
  hashPrompt,
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
  type ToolFailureKind,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';
import { invokeWithRetry, type ToolRetryAttemptReceipt } from './tool-retry-policy.ts';
import {
  containsBlockedSensitiveData,
  redactSensitiveValue,
  redactString,
  redactToolOutput,
} from '../runtime/redaction.ts';
import { ArtifactIntegrityError, ControlArtifactStore } from './artifact-store.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceEntry,
  type ResolvedEvidenceArtifact,
} from '../evidence/evidence-service.ts';
import { CurrentReportValidationError } from '../evidence/report-evidence-validator.ts';
import type { CurrentDeliverableGenerateInput, CurrentDeliverableRevisionInput } from '../report/current-deliverable-service.ts';
import type { DeliverableComposer, ReportReviewInput, ReportReviewResult } from '../report/report-review-service.ts';
import {
  resolveDeliverableContractById,
  resolveExecutionDeliverableContract,
  type DeliverableContractResources,
} from '../report/deliverable-registry.ts';
import { ReportCompositionService, type ReportCompositionPort } from '../report/report-composition-service.ts';
import { VisualAssetService } from '../report/visual-asset-service.ts';
import {
  readVerifiedStepArtifact,
  resolveStepInput,
  StepInputResolutionError,
  validateStepInputBindings,
  type SealedStepOutput as BindingSealedStepOutput,
} from './step-input-resolver.ts';
import { ExecutionScheduler } from './execution-scheduler.ts';

type EngineStep = CurrentPlanStep & { purpose?: string };

interface EnginePlan {
  taskId: string;
  evidence_requirements: EvidenceRequirement[];
  steps: EngineStep[];
}

const SUPPORTED_EVIDENCE_CLASSES: Record<EvidenceClass, true> = {
  public_source: true,
  screenshot: true,
  user_input: true,
  knowledge: true,
  dataset: true,
  simulation: true,
  derived: true,
};

interface ToolSourceRef {
  sourceUrl: string;
  originalIndex: number;
}

const SKILL_PROMPT_PREFIX = 'Execute this Skill workflow using only supplied outputs.';

type StepArtifactKind = 'tool_output' | 'skill_output' | 'llm_output' | 'review_output';

const STEP_ARTIFACT_SCHEMA_VERSIONS: Record<StepArtifactKind, string> = {
  tool_output: 'tool-output-v1',
  skill_output: 'skill-output-v1',
  llm_output: 'llm-output-v1',
  review_output: 'review-output-v1',
};

interface StepResult {
  output: unknown;
  kind: StepArtifactKind;
  artifactValue?: unknown;
  toolReceipt?: ToolInvocationReceipt;
  toolAttemptReceipts?: ToolRetryAttemptReceipt[];
  toolTier?: 'core' | 'optional';
  toolResolution?: ToolAdapterResolution;
  manifestHash?: string;
  inputSchemaHash?: string;
  outputSchemaHash?: string;
  inputHash?: string;
  outputHash?: string;
  redactedOutputHash?: string;
  configHash?: string;
  sourceRefs?: ToolSourceRef[];
  skillProvenance?: Record<string, unknown>;
}

interface EngineSealedStepOutput extends BindingSealedStepOutput {
  actorType: CurrentPlanStep['actor_type'];
  questionIds: string[];
  output?: unknown;
}
interface ReusableExecution {
  output: unknown;
  outputArtifactId: string;
  artifactValue: unknown;
  kind: StepArtifactKind;
  schemaVersion: string;
  provenance: Record<string, unknown>;
}

export interface LeaseExecutionResult {
  status: 'completed' | 'completed_with_gaps' | 'paused';
  attemptId: string;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  reportReviewArtifactId?: string;
  reviewStatus?: ReportReviewResult['status'];
  gapCount?: number;
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

class ExecutionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionSafetyError';
  }
}

class SkillOutputSchemaError extends LLMInvocationError {
  constructor(readonly outputHash: string) {
    super('schema', false, null, 'skill output failed schema validation');
    this.name = 'SkillOutputSchemaError';
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


function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function sanitizeStepResult(result: StepResult): StepResult {
  if (
    containsBlockedSensitiveData(result.output)
    || (result.artifactValue !== undefined && containsBlockedSensitiveData(result.artifactValue))
  ) {
    throw new ExecutionSafetyError('actor output blocked by sensitive business data policy');
  }
  if (result.kind === 'tool_output') return result;
  const output = redactSensitiveValue(result.output);
  return {
    ...result,
    output,
    ...(result.artifactValue === undefined
      ? {}
      : { artifactValue: redactSensitiveValue(result.artifactValue) }),
    ...(result.skillProvenance
      ? { skillProvenance: { ...result.skillProvenance, outputHash: hashJson(output) } }
      : {}),
  };
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

function resolvePlanDeliverableContract(
  structuredTask: unknown,
  plan: unknown,
): DeliverableContractResources {
  if (!isRecord(plan) || typeof plan.deliverable_type !== 'string' || !plan.deliverable_type.trim()) {
    throw new ExecutionAuthenticityError('plan deliverable type is malformed');
  }
  const requirement = isRecord(structuredTask) ? structuredTask : null;
  if (requirement?.version !== 'research-task-v2') {
    const taskType = requirement?.task_type;
    return typeof taskType === 'string' && taskType.trim()
      ? resolveExecutionDeliverableContract(taskType, [plan.deliverable_type], plan.deliverable_type)
      : resolveDeliverableContractById(plan.deliverable_type);
  }
  const taskType = requirement.task_type;
  const expectedDeliverables = requirement.expected_deliverables;
  if (typeof taskType !== 'string' || !taskType.trim()) {
    throw new ExecutionAuthenticityError('finalized task task_type is malformed');
  }
  if (
    !Array.isArray(expectedDeliverables)
    || !expectedDeliverables.every(
      (deliverable) => typeof deliverable === 'string' && deliverable.trim().length > 0,
    )
  ) {
    throw new ExecutionAuthenticityError('finalized task expected_deliverables are malformed');
  }
  return resolveExecutionDeliverableContract(
    taskType,
    expectedDeliverables as string[],
    plan.deliverable_type,
  );
}
function parsePlan(taskId: string, value: unknown, contract: DeliverableContractResources): EnginePlan {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    throw new ExecutionAuthenticityError('active plan is malformed');
  }
  const steps = value.steps.map((item, index): EngineStep => {
    if (!isRecord(item)) throw new ExecutionAuthenticityError(`plan step ${index + 1} is malformed`);
    const stepNo = item.step_no;
    const stepName = item.step_name;
    const actorType = item.actor_type;
    const actorId = item.actor_id;
    const input = item.input;
    const rawBindings = item.input_bindings ?? [];
    if (
      typeof stepNo !== 'number'
      || !Number.isInteger(stepNo)
      || stepNo !== index + 1
      || typeof stepName !== 'string'
      || typeof actorId !== 'string'
      || (actorType !== 'tool' && actorType !== 'skill' && actorType !== 'llm' && actorType !== 'reviewer')
      || (input !== undefined && !isRecord(input))
      || !Array.isArray(rawBindings)
    ) {
      throw new ExecutionAuthenticityError(`plan step ${index + 1} is malformed`);
    }
    const inputBindings = rawBindings.map((binding) => {
      if (
        !isRecord(binding)
        || typeof binding.target_pointer !== 'string'
        || typeof binding.source_step_no !== 'number'
        || !Number.isInteger(binding.source_step_no)
        || typeof binding.source_pointer !== 'string'
      ) {
        throw new ExecutionAuthenticityError(`plan step ${index + 1} input binding is malformed`);
      }
      return {
        target_pointer: binding.target_pointer,
        source_step_no: binding.source_step_no,
        source_pointer: binding.source_pointer,
      };
    });
    const approvalRole = item.approval_role;
    return {
      step_no: stepNo,
      step_name: stepName,
      actor_type: actorType,
      actor_id: actorId,
      question_ids: Array.isArray(item.question_ids)
        ? item.question_ids.filter((questionId): questionId is string => typeof questionId === 'string')
        : [],
      depends_on: Array.isArray(item.depends_on)
        ? item.depends_on.filter((dependency): dependency is number => Number.isInteger(dependency))
        : [],
      input: structuredClone(input ?? {}),
      input_bindings: inputBindings,
      expected_outputs: Array.isArray(item.expected_outputs)
        ? item.expected_outputs.filter((output): output is { pointer: string; description: string } =>
            isRecord(output) && typeof output.pointer === 'string' && typeof output.description === 'string')
        : [],
      acceptance_criteria: Array.isArray(item.acceptance_criteria)
        ? item.acceptance_criteria.filter((criterion): criterion is string => typeof criterion === 'string')
        : [],
      requires_approval: item.requires_approval === true,
      ...(approvalRole === 'owner' || approvalRole === 'legal' || approvalRole === 'security'
        ? { approval_role: approvalRole }
        : {}),
      fallback_actor_ids: Array.isArray(item.fallback_actor_ids)
        ? item.fallback_actor_ids.filter((actor): actor is string => typeof actor === 'string')
        : [],
      ...(typeof item.purpose === 'string' ? { purpose: item.purpose } : {}),
    };
  });
  if (value.deliverable_type !== contract.entry.id) {
    throw new ExecutionAuthenticityError(
      `plan deliverable type ${String(value.deliverable_type)} does not match Registry selection ${contract.entry.id}`,
    );
  }
  const rawRequirements = value.evidence_requirements;
  if (!Array.isArray(rawRequirements) || rawRequirements.length === 0) {
    throw new ExecutionAuthenticityError('plan evidence requirements are malformed');
  }
  const evidenceRequirements = rawRequirements.map((item, index): EvidenceRequirement => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || item.id.trim().length === 0
      || !Array.isArray(item.acceptedClasses)
      || item.acceptedClasses.length === 0
      || !item.acceptedClasses.every(
        (evidenceClass): evidenceClass is EvidenceClass =>
          typeof evidenceClass === 'string'
          && SUPPORTED_EVIDENCE_CLASSES[evidenceClass as EvidenceClass] === true,
      )
      || typeof item.minimumCount !== 'number'
      || !Number.isInteger(item.minimumCount)
      || item.minimumCount < 0
      || typeof item.required !== 'boolean'
    ) {
      throw new ExecutionAuthenticityError(`evidence requirement ${index + 1} is malformed`);
    }
    return {
      id: item.id,
      acceptedClasses: item.acceptedClasses,
      minimumCount: item.minimumCount,
      required: item.required,
    };
  });
  if (!evidenceRequirements.some((requirement) => requirement.required)) {
    throw new ExecutionAuthenticityError('plan must include required evidence');
  }
  return { taskId, evidence_requirements: evidenceRequirements, steps };
}
interface ReviewCoverageIds {
  successCriterionIds: string[];
  questionIds: string[];
}

function parseReviewCoverageIds(structuredTask: unknown, plan: unknown): ReviewCoverageIds {
  if (!isRecord(structuredTask) || structuredTask.version !== 'research-task-v2') {
    throw new ExecutionAuthenticityError('finalized task is not research-task-v2');
  }
  const criteria = structuredTask.success_criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new ExecutionAuthenticityError('finalized task success criteria are malformed');
  }
  const successCriterionIds = criteria.map((criterion, index) => {
    if (!isRecord(criterion) || typeof criterion.id !== 'string' || criterion.id.trim().length === 0) {
      throw new ExecutionAuthenticityError(`success criterion ${index + 1} is malformed`);
    }
    return criterion.id;
  });
  if (new Set(successCriterionIds).size !== successCriterionIds.length) {
    throw new ExecutionAuthenticityError('finalized task success criterion ids must be unique');
  }

  const planRecord = isRecord(plan) ? plan : null;
  const problemGraph = planRecord && isRecord(planRecord.problem_graph) ? planRecord.problem_graph : null;
  const questions = problemGraph?.questions;
  if (problemGraph?.version !== 'problem-graph-v1' || !Array.isArray(questions)) {
    throw new ExecutionAuthenticityError('active plan ProblemGraph is malformed');
  }
  const questionIds = questions.flatMap((question, index) => {
    if (
      !isRecord(question)
      || typeof question.id !== 'string'
      || question.id.trim().length === 0
      || (question.priority !== 'required' && question.priority !== 'optional')
    ) {
      throw new ExecutionAuthenticityError(`ProblemGraph question ${index + 1} is malformed`);
    }
    return question.priority === 'required' ? [question.id] : [];
  });
  if (new Set(questionIds).size !== questionIds.length) {
    throw new ExecutionAuthenticityError('required ProblemGraph question ids must be unique');
  }
  return { successCriterionIds, questionIds };
}


function parsePendingInputs(value: unknown): PendingInput[] {
  if (!Array.isArray(value)) {
    throw new ExecutionAuthenticityError('active plan pending inputs are malformed');
  }
  return value.map((item, index) => {
    if (
      !isRecord(item)
      || typeof item.role !== 'string'
      || item.role.trim().length === 0
      || typeof item.label !== 'string'
      || item.label.trim().length === 0
      || typeof item.multiple !== 'boolean'
      || !Array.isArray(item.targets)
      || item.targets.length === 0
    ) {
      throw new ExecutionAuthenticityError(`pending input ${index + 1} is malformed`);
    }
    const targets = item.targets.map((target) => {
      if (
        !isRecord(target)
        || typeof target.step_no !== 'number'
        || !Number.isInteger(target.step_no)
        || target.step_no < 1
        || typeof target.tool_id !== 'string'
        || target.tool_id.trim().length === 0
        || typeof target.field !== 'string'
        || target.field.trim().length === 0
        || typeof target.multiple !== 'boolean'
      ) {
        throw new ExecutionAuthenticityError(`pending input ${index + 1} target is malformed`);
      }
      return {
        step_no: target.step_no,
        tool_id: target.tool_id,
        field: target.field,
        multiple: target.multiple,
      };
    });
    return {
      role: item.role,
      label: item.label,
      multiple: item.multiple,
      targets,
    };
  });
}

function overlayPendingInputs(
  parsedPlan: EnginePlan,
  pendingInputs: readonly PendingInput[],
  gates: readonly unknown[],
  ownerUserId: string,
): EnginePlan {
  const plan = structuredClone(parsedPlan);
  const inputGates = gates.filter(
    (gate): gate is Record<string, unknown> => isRecord(gate) && gate.gateType === 'input',
  );
  if (inputGates.length !== pendingInputs.length) {
    throw new ExecutionAuthenticityError('input gate records do not match active plan pending inputs');
  }
  const roles = new Set<string>();
  const targetFields = new Set<string>();
  for (const pendingInput of pendingInputs) {
    if (roles.has(pendingInput.role)) {
      throw new ExecutionAuthenticityError(`pending input role ${pendingInput.role} is duplicated`);
    }
    roles.add(pendingInput.role);
    const matchingGates = inputGates.filter((gate) => gate.gateKey === pendingInput.role);
    if (matchingGates.length !== 1) {
      throw new ExecutionAuthenticityError(
        `pending input role ${pendingInput.role} requires exactly one input gate`,
      );
    }
    const gate = matchingGates[0]!;
    if (
      gate.requiredAuthority !== 'owner'
      || gate.decision !== 'provided'
      || gate.actorRole !== 'owner'
      || gate.actorUserId !== ownerUserId
      || !Object.hasOwn(gate, 'value')
    ) {
      throw new ExecutionAuthenticityError(`input gate for pending role ${pendingInput.role} is invalid`);
    }
    for (const target of pendingInput.targets) {
      const targetKey = `${target.step_no}\u0000${target.field}`;
      if (targetFields.has(targetKey)) {
        throw new ExecutionAuthenticityError(
          `pending input target ${target.step_no}/${target.field} is duplicated`,
        );
      }
      targetFields.add(targetKey);
      const step = plan.steps.find((candidate) => candidate.step_no === target.step_no);
      if (
        !step
        || step.actor_id !== target.tool_id
        || !Object.hasOwn(step.input, target.field)
      ) {
        throw new ExecutionAuthenticityError(
          `pending input target ${target.step_no}/${target.field} does not match the active plan`,
        );
      }
      step.input[target.field] = structuredClone(gate.value);
    }
  }
  return plan;
}

function isToolSourceRef(value: unknown): value is ToolSourceRef {
  return isRecord(value)
    && typeof value.sourceUrl === 'string'
    && Number.isInteger(value.originalIndex)
    && (value.originalIndex as number) >= 0;
}

function sourceRefs(value: unknown): ToolSourceRef[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((item, originalIndex) => {
    if (!isRecord(item)) return [];
    const sourceUrl = typeof item.url === 'string' ? item.url : typeof item.oss_url === 'string' ? item.oss_url : null;
    return sourceUrl ? [{ sourceUrl, originalIndex }] : [];
  });
}


function verifiedPriorOutputs(
  outputs: readonly EngineSealedStepOutput[],
  step?: EngineStep,
): Array<{
  stepNo: number;
  actorId: string;
  kind: StepArtifactKind;
  output: unknown;
  artifact: EngineSealedStepOutput['artifact'];
}> {
  const allowed = step
    ? new Set([
        ...step.depends_on,
        ...step.input_bindings.map((binding) => binding.source_step_no),
      ])
    : null;
  return outputs
    .filter(({ stepNo }) => allowed === null || allowed.has(stepNo))
    .map(({ stepNo, actorId, kind, output, artifact }) => ({
      stepNo,
      actorId,
      kind,
      output,
      artifact,
    }));
}

function stepContract(step: EngineStep): Record<string, unknown> {
  return {
    question_ids: [...step.question_ids],
    acceptance_criteria: [...step.acceptance_criteria],
    expected_outputs: step.expected_outputs.map((output) => ({ ...output })),
    actor_type: step.actor_type,
    actor_id: step.actor_id,
  };

}
function detailsFrom(error: unknown): Record<string, unknown> {
  if (error instanceof ToolInvocationError) return error.details;
  return isRecord(error) && isRecord(error.details) ? error.details : {};
}

function attemptReceiptsFrom(error: unknown): ToolRetryAttemptReceipt[] | undefined {
  const details = detailsFrom(error);
  if (Array.isArray(details.toolAttemptReceipts)) {
    return details.toolAttemptReceipts as ToolRetryAttemptReceipt[];
  }
  const retry = isRecord(details.retry) ? details.retry : details;
  return Array.isArray(retry.attemptReceipts)
    ? retry.attemptReceipts as ToolRetryAttemptReceipt[]
    : undefined;
}

function attachToolAttemptReceipts(error: unknown, actorResult: unknown): void {
  if (
    !isRecord(actorResult)
    || !Array.isArray(actorResult.toolAttemptReceipts)
    || !isRecord(error)
  ) return;
  error.details = {
    toolAttemptReceipts: actorResult.toolAttemptReceipts as ToolRetryAttemptReceipt[],
  };
}
function attachAttemptReceipts(
  failure: Record<string, unknown>,
  attemptReceipts: ToolRetryAttemptReceipt[] | undefined,
): void {
  if (!attemptReceipts) return;
  const retry = isRecord(failure.retry) ? failure.retry : {};
  failure.retry = { ...retry, attemptReceipts };
}

function leaseLostWithRetry(
  message: string,
  retry: { attempts: number; maxAttempts: number; attemptReceipts: ToolRetryAttemptReceipt[] },
): ControlPlaneConflictError {
  const error = new ControlPlaneConflictError(message) as ControlPlaneConflictError & {
    details?: Record<string, unknown>;
  };
  error.details = { retry };
  return error;
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
  if (error instanceof ExecutionSafetyError) {
    return { kind: 'safety', retryable: false, message: error.message };
  }
  if (error instanceof ControlPlaneConflictError) {
    return { kind: 'lease_lost', retryable: true, message: error.message, ...detailsFrom(error) };
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
    || error instanceof ArtifactIntegrityError
    || error instanceof ModelDriftError
    || error instanceof MissingModelReceiptError;
}

function deliverableFailureFrom(error: unknown): Record<string, unknown> {
  if (
    error instanceof LLMInvocationError
    || error instanceof ControlPlaneConflictError
    || isIntegrityFailure(error)
  ) {
    return failureFrom(error);
  }
  return {
    kind: 'deliverable_validation',
    retryable: false,
    message: error instanceof CurrentReportValidationError
      ? error.message
      : error instanceof Error ? error.message : String(error),
  };
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
    deliverables: {
      generate(input: CurrentDeliverableGenerateInput): Promise<{
        deliverable: unknown;
        deliverableArtifactId: string;
      }>;
      revise?(input: CurrentDeliverableRevisionInput): Promise<{
        deliverable: unknown;
        deliverableArtifactId: string;
      }>;
    };
    reportReview?: {
      review(input: ReportReviewInput, composer?: DeliverableComposer): Promise<ReportReviewResult>;
    };
    reportComposition?: ReportCompositionPort;
    scheduler?: ExecutionScheduler;
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
    let reviewCoverage: ReviewCoverageIds | null = null;
    let deliverableId: string;
    try {
      const gates = await this.dependencies.repository.listGateRecords(
        input.lease.taskId,
        input.lease.planVersionId,
      );
      const deliverableContract = resolvePlanDeliverableContract(task.structuredTask, planVersion.plan);
      deliverableId = deliverableContract.entry.id;
      const parsedPlan = parsePlan(task.id, planVersion.plan, deliverableContract);
      const pendingInputs = parsePendingInputs(planVersion.pendingInputs);
      plan = overlayPendingInputs(parsedPlan, pendingInputs, gates, task.ownerUserId);
      if (this.dependencies.reportReview) {
        reviewCoverage = parseReviewCoverageIds(task.structuredTask, planVersion.plan);
      }
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
    const preflightError = await this.preflight(plan, researchGoal);
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
    const reusable = await this.loadReusableExecutions(input.lease, plan, planVersion.planHash, researchGoal);
    const outputs: EngineSealedStepOutput[] = [];
    const resolvedArtifacts = new Map<string, ResolvedEvidenceArtifact>();
    const gaps: string[] = [];
    const stepByKey = new Map(plan.steps.map((step) => [String(step.step_no), step]));
    let wavePaused: LeaseExecutionResult | undefined;
    const scheduler = this.dependencies.scheduler ?? new ExecutionScheduler({
      execute: async (scheduledStep) => {
        const step = stepByKey.get(scheduledStep.key);
        if (!step) throw new ExecutionAuthenticityError(`scheduler returned unknown step ${scheduledStep.key}`);
        return step;
      },
    });
    const schedule = await scheduler.schedule({
      steps: plan.steps.map((step) => ({
        key: String(step.step_no),
        dependsOn: step.depends_on.map(String),
        tier: step.actor_type === 'tool' ? this.dependencies.skillLoader.getTool(step.actor_id)?.tier ?? 'core' : 'core',
      })),
    }, {});

    for (const wave of schedule.waves) {
      await Promise.all(wave.map(async (stepKey) => {
        const step = stepByKey.get(stepKey);
        if (!step) throw new ExecutionAuthenticityError(`scheduler returned unknown step ${stepKey}`);
      const checkpoint = reusable.get(step.step_no);
      if (checkpoint) {
        active = await this.refreshLease(input.lease);
        const priorArtifact = await this.dependencies.repository.getArtifact(checkpoint.outputArtifactId);
        if (!priorArtifact || priorArtifact.state !== 'SEALED' || !priorArtifact.contentSha256) {
          throw new ExecutionAuthenticityError(`reusable step Artifact ${checkpoint.outputArtifactId} is unavailable`);
        }
        const resealed = await this.dependencies.artifacts.writeJson({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          kind: checkpoint.kind,
          relativePath: `steps/${step.step_no}-${checkpoint.kind}.json`,
          value: checkpoint.artifactValue,
          schemaVersion: checkpoint.schemaVersion,
          activeLease: input.lease,
        });
        if (resealed.state !== 'SEALED' || !resealed.contentSha256) {
          throw new ExecutionAuthenticityError(`reusable step Artifact ${resealed.id} was not sealed`);
        }
        const sealedOutput: EngineSealedStepOutput = {
          stepNo: step.step_no,
          actorType: step.actor_type,
          questionIds: [...step.question_ids],
          actorId: step.actor_id,
          kind: checkpoint.kind,
          state: 'succeeded',
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          artifact: { id: resealed.id, contentSha256: resealed.contentSha256, state: 'SEALED' },
        };
        const verified = await readVerifiedStepArtifact(sealedOutput, this.dependencies.artifacts);
        outputs.push({ ...sealedOutput, output: verified.output });
        if (step.actor_type === 'tool') {
          resolvedArtifacts.set(resealed.id, {
            artifact: { id: resealed.id, contentSha256: resealed.contentSha256 },
            value: verified.value,
          });
        }
        await this.dependencies.repository.recordExecutionStep({
          attemptId: input.lease.attemptId,
          stepNo: step.step_no,
          stepName: step.step_name,
          actorType: step.actor_type,
          actorId: step.actor_id,
          state: 'succeeded',
          outputArtifactId: resealed.id,
          toolProvenance: { ...checkpoint.provenance, outputArtifactId: resealed.id, sourceArtifactId: priorArtifact.id },
        });
        return;
      }
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
      let resolvedInput = structuredClone(step.input);
      let producedSkillOutputHash: string | undefined;
      let toolAttemptReceipts: ToolRetryAttemptReceipt[] | undefined;
      let actorResult: StepResult | undefined;
      try {
        try {
          resolvedInput = await resolveStepInput(step, outputs, this.dependencies.artifacts);
        } catch (error) {
          if (error instanceof StepInputResolutionError) {
            throw new ExecutionAuthenticityError(error.message, {
              kind: 'input_binding',
              code: error.code,
            });
          }
          throw error;
        }
        actorResult = await this.withLeaseHeartbeat(input.lease, () => this.runStep({
          step,
          lease: input.lease,
          researchGoal,
          resolvedInput,
          outputs,
          expectedModel: input.expectedModel,
        }));
        const actorOutputHash = actorResult.skillProvenance?.outputHash;
        if (typeof actorOutputHash === 'string') producedSkillOutputHash = actorOutputHash;
        toolAttemptReceipts = actorResult.toolAttemptReceipts;
        const result = sanitizeStepResult(actorResult);
        await this.dependencies.repository.requireActiveLease(input.lease);
        const artifactValue = result.artifactValue ?? result.output;
        const artifact = await this.dependencies.artifacts.writeJson({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          kind: result.kind,
          relativePath: `steps/${step.step_no}-${result.kind}.json`,
          value: artifactValue,
          schemaVersion: STEP_ARTIFACT_SCHEMA_VERSIONS[result.kind],
          activeLease: input.lease,
        });
        if (artifact.state !== 'SEALED' || !artifact.contentSha256) {
          throw new ExecutionAuthenticityError(`step Artifact ${artifact.id} was not sealed`);
        }
        const sealedOutput: EngineSealedStepOutput = {
          stepNo: step.step_no,
          actorType: step.actor_type,
          questionIds: [...step.question_ids],
          actorId: step.actor_id,
          kind: result.kind,
          state: 'succeeded',
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          artifact: {
            id: artifact.id,
            contentSha256: artifact.contentSha256,
            state: 'SEALED',
          },
        };
        const verified = await readVerifiedStepArtifact(sealedOutput, this.dependencies.artifacts);
        if (step.actor_type === 'tool') {
          resolvedArtifacts.set(verified.artifact.id, {
            artifact: {
              id: verified.artifact.id,
              contentSha256: verified.artifact.contentSha256!,
            },
            value: verified.value,
          });
        }
        outputs.push({ ...sealedOutput, output: verified.output });
        await this.dependencies.repository.recordExecutionStep({
          attemptId: input.lease.attemptId,
          stepNo: step.step_no,
          stepName: step.step_name,
          actorType: step.actor_type,
          actorId: step.actor_id,
          state: 'succeeded',
          outputArtifactId: artifact.id,
          toolProvenance: result.toolReceipt && result.toolResolution
            ? {
                planHash: planVersion.planHash,
                stepHash: hashJson(step),
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
                attemptReceipts: result.toolAttemptReceipts,
                toolTier: result.toolTier,
                outputArtifactId: artifact.id,
                status: 'succeeded',
              }
            : undefined,
          skillProvenance: result.skillProvenance
            ? { ...result.skillProvenance, outputArtifactId: artifact.id, status: 'succeeded' }
            : undefined,
          latencyMs: result.toolReceipt?.latencyMs,
          startedAt,
          finishedAt: new Date(),
        });
      } catch (error) {
        const attemptReceipts = attemptReceiptsFrom(error) ?? toolAttemptReceipts;
        const failure = failureFrom(error);
        attachAttemptReceipts(failure, attemptReceipts);
        let failedToolProvenance: Record<string, unknown> | undefined;
        let failedSkillProvenance: Record<string, unknown> | undefined;
        let toolTier: 'core' | 'optional' = 'optional';
        if (step.actor_type === 'tool') {
          try {
            toolTier = this.dependencies.skillLoader.getTool(step.actor_id)?.tier ?? 'optional';
          } catch {
            // Registry default is optional; missing config remains non-blocking for enhanced tools.
          }
          failure.toolTier = toolTier;
          const toolProvenance = await this.failedToolProvenance(
            step,
            researchGoal,
            resolvedInput,
            error,
            attemptReceipts,
          );
          toolProvenance.toolTier = toolTier;
          failedToolProvenance = toolProvenance;
          if (toolTier === 'optional' && failure.kind !== 'safety' && failure.kind !== 'lease_lost' && !isIntegrityFailure(error)) {
            failure.allowedActions ??= [];
            await this.dependencies.repository.recordExecutionStep({
              attemptId: input.lease.attemptId,
              stepNo: step.step_no,
              stepName: step.step_name,
              actorType: step.actor_type,
              actorId: step.actor_id,
              state: 'skipped',
              failure,
              toolProvenance: failedToolProvenance,
              startedAt,
              finishedAt: new Date(),
            });
            const message = typeof failure.message === 'string'
              ? failure.message
              : 'optional tool failed';
            gaps.push(redactString(`Step ${step.step_no} (${step.actor_id}): ${message}`));
            return;
          }
          failure.allowedActions = failure.kind === 'safety' ? ['abort'] : ['retry', 'abort'];
        } else {
          failure.allowedActions = failure.retryable === true ? ['retry', 'abort'] : ['abort'];
        }
        if (step.actor_type === 'skill') {
          failedSkillProvenance = await this.failedSkillProvenance({
            step,
            lease: input.lease,
            researchGoal,
            resolvedInput,
            priorOutputs: outputs,
            producedOutputHash: error instanceof SkillOutputSchemaError
              ? error.outputHash
              : producedSkillOutputHash,
          });
        }
        await this.dependencies.repository.recordExecutionStep({
          attemptId: input.lease.attemptId,
          stepNo: step.step_no,
          stepName: step.step_name,
          actorType: step.actor_type,
          actorId: step.actor_id,
          state: 'failed',
          failure,
          toolProvenance: failedToolProvenance,
          skillProvenance: failedSkillProvenance,
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
        wavePaused = { status: 'paused', attemptId: input.lease.attemptId, failedStepNo: step.step_no, failure };
        return;
      }
      }));
      if (wavePaused) return wavePaused;
    }
    let sealedEvidenceManifest!: CurrentDeliverableGenerateInput['evidenceManifest'];
    let evidenceResolver!: EvidenceArtifactResolver;
    try {
      evidenceResolver = {
        resolveArtifact: (artifactId) => resolvedArtifacts.get(artifactId) ?? null,
      };
      const evidenceEntries = (await this.dependencies.repository.listExecutionSteps(input.lease.attemptId))
        .flatMap((step): EvidenceEntry[] => {
          const proof = step.toolProvenance;
          const outputArtifactId = typeof proof?.outputArtifactId === 'string' ? proof.outputArtifactId : null;
          const artifact = outputArtifactId ? resolvedArtifacts.get(outputArtifactId) : undefined;
          const executionMode = proof?.executionMode;
          const implementationId = proof?.implementationId;
          const redactedOutputHash = proof?.redactedOutputHash;
          const toolTier = proof?.toolTier;
          const refs = Array.isArray(proof?.sourceRefs)
            ? proof.sourceRefs.filter(isToolSourceRef).filter((ref) => ref.sourceUrl.startsWith('https://'))
            : [];
          if (
            step.actorType !== 'tool'
            || step.state !== 'succeeded'
            || !artifact
            || executionMode !== 'real'
            || typeof implementationId !== 'string'
            || typeof redactedOutputHash !== 'string'
            || (toolTier !== 'core' && toolTier !== 'optional')
            || refs.length === 0
          ) return [];
          return refs.map(({ sourceUrl, originalIndex }) => ({
            id: `E${step.stepNo}-${originalIndex + 1}`,
            kind: 'tool_output',
            evidenceClass: 'public_source',
            toolId: step.actorId,
            toolTier,
            artifactId: artifact.artifact.id,
            artifactContentSha256: artifact.artifact.contentSha256,
            jsonPointer: `/output/results/${originalIndex}`,
            sourceUrl,
            stepNo: step.stepNo,
            toolProof: { implementationId, executionMode: 'real', redactedOutputHash },
            sensitivity: 'public',
            redaction: 'masked',
          }));
        });
      for (const requirement of plan.evidence_requirements) {
        let actual = 0;
        for (const entry of evidenceEntries) {
          if (requirement.required && entry.toolTier !== 'core') continue;
          if (requirement.acceptedClasses.includes(entry.evidenceClass)) actual += 1;
        }
        if (requirement.required && actual < requirement.minimumCount) {
          throw new ExecutionAuthenticityError(
            `required evidence requirement ${requirement.id} is not satisfied`,
            {
              kind: 'missing_required_evidence',
              requirementId: requirement.id,
              required: requirement.minimumCount,
              actual,
            },
          );
        }
      }
      if (!evidenceEntries.some((entry) => entry.toolTier === 'core')) {
        throw new ExecutionAuthenticityError('execution has no valid core Tool evidence');
      }
      const evidenceManifest = new EvidenceService().createManifest({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        attemptId: input.lease.attemptId,
        collectedAt: new Date().toISOString(),
        entries: evidenceEntries,
      }, evidenceResolver);
      const evidenceManifestArtifact = await this.dependencies.artifacts.writeJson({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        attemptId: input.lease.attemptId,
        kind: 'evidence_manifest',
        relativePath: 'evidence/manifest.json',
        value: evidenceManifest,
        schemaVersion: 'evidence-v1',
        activeLease: input.lease,
      });
      if (evidenceManifestArtifact.state !== 'SEALED' || !evidenceManifestArtifact.contentSha256) {
        throw new ExecutionAuthenticityError('Evidence Manifest Artifact was not sealed');
      }
      sealedEvidenceManifest = {
        artifact: {
          id: evidenceManifestArtifact.id,
          contentSha256: evidenceManifestArtifact.contentSha256,
          state: 'SEALED',
        },
        value: evidenceManifest,
      };
    } catch (error) {
      const failure = failureFrom(error);
      failure.allowedActions = ['abort'];
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: plan.steps.length + 1,
        stepName: 'evidence manifest',
        actorType: 'system',
        actorId: 'evidence',
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
          reason: String(failure.kind ?? 'evidence_failure'),
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

    try {
      active = await this.refreshLease(input.lease);
      const materialDiscovery = this.dependencies.reportComposition?.discoverAttemptMaterials
        ? this.dependencies.reportComposition
        : new ReportCompositionService({
            artifacts: this.dependencies.artifacts,
            visualAssets: new VisualAssetService({ artifacts: this.dependencies.artifacts }),
            repository: this.dependencies.repository,
          });
      const evidenceById = new Map(
        sealedEvidenceManifest.value.entries.map((entry) => [entry.id, entry]),
      );
      const evidenceService = new EvidenceService();
      const reportMaterials = await this.withLeaseHeartbeat(input.lease, () =>
        materialDiscovery.discoverAttemptMaterials!({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          evidenceResolver: (evidenceId) => {
            const entry = evidenceById.get(evidenceId);
            return entry
              ? evidenceService.resolveEvidenceValue(entry, evidenceResolver)
              : undefined;
          },
        }));
      const deliverableInput: CurrentDeliverableGenerateInput = {
        task: { id: task.id },
        plan: {
          id: planVersion.id,
          plan: {
            ...(planVersion.plan as Record<string, unknown>),
            deliverable_type: deliverableId,
            steps: (planVersion.plan as Record<string, unknown>).steps as unknown[],
          },
        },
        attempt: { id: input.lease.attemptId },
        researchGoal,
        finalizedRequirement: task.structuredTask,
        problemGraph: (planVersion.plan as Record<string, unknown>).problem_graph,
        evidenceManifest: sealedEvidenceManifest,
        evidenceResolver,
        outputs,
        gaps,
        expectedModel: input.expectedModel,
        stepNo: plan.steps.length + 1,
        activeLease: input.lease,
        visualAssets: reportMaterials.visualAssets,
      };
      const deliverable = await this.withLeaseHeartbeat(input.lease, () => this.dependencies.deliverables.generate(deliverableInput));
      let deliverableArtifactId = deliverable.deliverableArtifactId;
      let reportReviewArtifactId: string | undefined;
      let reviewStatus: ReportReviewResult['status'] | undefined;
      if (this.dependencies.reportReview) {
        const reviewingTask = await this.dependencies.repository.transitionTask({
          taskId: input.lease.taskId,
          expectedVersion: active.stateVersion,
          from: 'executing',
          to: 'reviewing',
        });
        active = { ...active, stateVersion: reviewingTask.stateVersion };
        const composer: DeliverableComposer | undefined = this.dependencies.deliverables.revise
          ? {
              revise: (revision) => this.dependencies.deliverables.revise!({ ...deliverableInput, review: revision.review }),
            }
          : undefined;
        if (!reviewCoverage) {
          throw new ExecutionAuthenticityError('report review coverage identifiers are unavailable');
        }
        const finalReviewCoverage = reviewCoverage;
        const review = await this.withLeaseHeartbeat(input.lease, () => this.dependencies.reportReview!.review({
          task: { id: task.id },
          plan: { id: planVersion.id },
          attempt: { id: input.lease.attemptId },
          deliverableArtifactId: deliverable.deliverableArtifactId,
          deliverable: deliverable.deliverable,
          successCriterionIds: finalReviewCoverage.successCriterionIds,
          questionIds: finalReviewCoverage.questionIds,
          evidenceIds: sealedEvidenceManifest.value.entries.map((entry) => entry.id),
          expectedModel: input.expectedModel,
          activeLease: input.lease,
        }, composer));
        reportReviewArtifactId = review.artifactId;
        reviewStatus = review.status;
        deliverableArtifactId = review.deliverableArtifactId;
        if (review.status === 'paused') {
          const failure = {
            kind: 'report_review',
            retryable: false,
            allowedActions: ['abort'],
            verdict: review.verdict,
            message: 'report review paused execution',
          };
          const failedStepNo = plan.steps.length + 2;
          await this.dependencies.repository.recordExecutionStep({
            attemptId: input.lease.attemptId,
            stepNo: failedStepNo,
            stepName: 'report review',
            actorType: 'reviewer',
            actorId: 'report-review',
            state: 'failed',
            failure,
            startedAt: new Date(),
            finishedAt: new Date(),
          });
          await this.dependencies.repository.pauseExecution({
            taskId: input.lease.taskId,
            attemptId: input.lease.attemptId,
            expectedVersion: active.stateVersion,
            reason: 'report_review',
          });
          return {
            status: 'paused',
            attemptId: input.lease.attemptId,
            deliverableArtifactId,
            evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
            reportReviewArtifactId,
            reviewStatus,
            failedStepNo,
            failure,
          };
        }
        const composingTask = await this.dependencies.repository.transitionTask({
          taskId: input.lease.taskId,
          expectedVersion: active.stateVersion,
          from: 'reviewing',
          to: 'composing_report',
        });
        active = { ...active, stateVersion: composingTask.stateVersion };
        if (this.dependencies.reportComposition) {
          await this.dependencies.repository.requireActiveLease(input.lease);
          const [verifiedDeliverable, verifiedEvidenceManifest, verifiedReview] = await Promise.all([
            this.dependencies.artifacts.readVerifiedJson<ResearchDeliverableEnvelope<ResearchPlanPayload>>(
              deliverableArtifactId,
            ),
            this.dependencies.artifacts.readVerifiedJson<EvidenceManifest>(
              sealedEvidenceManifest.artifact.id,
            ),
            this.dependencies.artifacts.readVerifiedJson<PassedReportReviewArtifact>(review.artifactId),
          ]);
          if (verifiedReview.value.verdict !== 'pass') {
            throw new ExecutionAuthenticityError('ReportDocument composition requires the final pass Review');
          }
          const materials = reportMaterials;
          const composition = await this.withLeaseHeartbeat(input.lease, () =>
            this.dependencies.reportComposition!.composeAndStore({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              requiredQuestionIds: [...finalReviewCoverage.questionIds],
              deliverable: verifiedDeliverable,
              evidenceManifest: verifiedEvidenceManifest,
              evidenceArtifactResolver: evidenceResolver,
              review: verifiedReview,
              visualAssets: materials.visualAssets,
              charts: materials.charts,
              activeLease: input.lease,
            }));
          if (
            composition.artifact.state !== 'SEALED'
            || composition.artifact.taskId !== input.lease.taskId
            || composition.artifact.planVersionId !== input.lease.planVersionId
            || composition.artifact.attemptId !== input.lease.attemptId
            || composition.artifact.kind !== 'report_document'
            || composition.artifact.schemaVersion !== 'report-document-v1'
          ) {
            throw new ExecutionAuthenticityError('ReportDocument composition did not return a sealed bound Artifact');
          }
        }
      }
      await this.dependencies.repository.requireActiveLease(input.lease);
      const status = gaps.length > 0 ? 'completed_with_gaps' : 'completed';
      await this.dependencies.repository.completeExecution(input.lease, { status });
      return {
        status,
        attemptId: input.lease.attemptId,
        deliverableArtifactId,
        evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
        ...(reportReviewArtifactId === undefined ? {} : { reportReviewArtifactId }),
        ...(reviewStatus === undefined ? {} : { reviewStatus }),
        gapCount: gaps.length,
      };
    } catch (error) {
      if (error instanceof ControlPlaneConflictError) {
        await this.dependencies.repository.invalidateTerminalArtifacts({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          reason: 'terminal artifacts invalidated after execution lease loss',
        });
      }
      const failure = deliverableFailureFrom(error);
      failure.allowedActions = failure.retryable === true ? ['retry', 'abort'] : ['abort'];
      await this.dependencies.repository.recordExecutionStep({
        attemptId: input.lease.attemptId,
        stepNo: plan.steps.length + 1,
        stepName: 'deliverable generation or review',
        actorType: 'llm',
        actorId: 'deliverable',
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
          reason: String(failure.kind ?? 'deliverable_validation'),
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
  }

  private async loadReusableExecutions(
    lease: ControlExecutionLease,
    plan: EnginePlan,
    planHash: string,
    researchGoal: string,
  ): Promise<Map<number, ReusableExecution>> {
    const reusable = new Map<number, ReusableExecution>();
    if (!lease.retryOf) return reusable;
    const previous = await this.dependencies.repository.listExecutionSteps(lease.retryOf);
    let invalid = false;
    for (const step of plan.steps) {
      if (invalid) break;
      const prior = previous.find((candidate) => candidate.stepNo === step.step_no);
      if (!prior || prior.state !== 'succeeded' || !prior.outputArtifactId || !prior.toolProvenance) {
        invalid = true;
        continue;
      }
      if (step.actor_type !== 'tool' || step.input_bindings.length > 0) {
        invalid = true;
        continue;
      }
      const tool = this.dependencies.skillLoader.getTool(step.actor_id);
      if (!tool) {
        invalid = true;
        continue;
      }
      const manifest = loadToolManifest(tool.path);
      const resolution = this.dependencies.tools.resolve(manifest);
      const current = resolution ? {
        planHash,
        stepHash: hashJson(step),
        inputHash: hashJson(Object.keys(step.input).length > 0 ? step.input : { query: researchGoal }),
        manifestHash: hashFile(tool.path),
        inputSchemaHash: hashFile(manifest.input_schema),
        outputSchemaHash: hashFile(manifest.output_schema),
        configHash: toolConfigHash(manifest, resolution),
      } : null;
      const fields: Array<'planHash' | 'stepHash' | 'inputHash' | 'manifestHash' | 'inputSchemaHash' | 'outputSchemaHash' | 'configHash'> = [
        'planHash', 'stepHash', 'inputHash', 'manifestHash', 'inputSchemaHash', 'outputSchemaHash', 'configHash',
      ];
      if (!current || !fields.every((field) => current[field] === prior.toolProvenance?.[field])) {
        invalid = true;
        continue;
      }
      const artifact = await this.dependencies.repository.getArtifact(prior.outputArtifactId);
      if (
        !artifact
        || artifact.state !== 'SEALED'
        || !artifact.contentSha256
        || artifact.taskId !== lease.taskId
        || artifact.planVersionId !== lease.planVersionId
        || artifact.attemptId !== lease.retryOf
      ) {
        invalid = true;
        continue;
      }
      try {
        const stored = await this.dependencies.artifacts.readVerifiedJson<Record<string, unknown>>(artifact.id);
        const output = isRecord(stored.value) && 'output' in stored.value ? stored.value.output : stored.value;
        reusable.set(step.step_no, {
          output,
          outputArtifactId: artifact.id,
          artifactValue: stored.value,
          kind: artifact.kind as StepArtifactKind,
          schemaVersion: artifact.schemaVersion,
          provenance: { ...prior.toolProvenance, outputArtifactId: artifact.id },
        });
      } catch {
        invalid = true;
      }
    }
    return reusable;
  }

  private async preflight(plan: EnginePlan, researchGoal: string): Promise<ExecutionAuthenticityError | null> {
    const requiresPublicSource = plan.evidence_requirements.some((requirement) => (
      requirement.required && requirement.acceptedClasses.includes('public_source')
    ));
    let publicEvidencePolicyFailure = false;
    if (requiresPublicSource) {
      publicEvidencePolicyFailure = !plan.steps.some((step) => {
        if (step.actor_type !== 'tool') return false;
        const registryEntry = this.dependencies.skillLoader.getTool(step.actor_id);
        if (!registryEntry || registryEntry.tier !== 'core') return false;
        try {
          const manifest = loadToolManifest(registryEntry.path);
          const resolution = this.dependencies.tools.resolve(manifest);
          return Boolean(
            resolution
              && resolution.executionMode === 'real'
              && resolution.declaredAdapterType === resolution.resolvedAdapterType
              && resolution.implementationId !== 'unknown',
          );
        } catch {
          return false;
        }
      });
    }
    try {
      const stepNos = plan.steps.map((step) => step.step_no);
      for (const step of plan.steps) validateStepInputBindings(step, stepNos);
      for (const step of plan.steps) {
        if (step.actor_type === 'skill') {
          const skill = this.dependencies.skillLoader.getSkill(step.actor_id);
          if (!skill) return new ExecutionAuthenticityError(`skill ${step.actor_id} is not active`);
          this.dependencies.skillLoader.loadSkillBody(step.actor_id);
          this.dependencies.skillLoader.loadSkillSchemas(step.actor_id);
          if (skill.input_schema && step.input_bindings.length === 0) {
            this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), skill.input_schema), step.input);
          }
          continue;
        }
        if (step.actor_type !== 'tool') continue;
        const tool = this.dependencies.skillLoader.getTool(step.actor_id);
        if (!tool) return new ExecutionAuthenticityError(`tool ${step.actor_id} is not active`);
        const manifest = loadToolManifest(tool.path);
        const resolution = this.dependencies.tools.resolve(manifest);
        const toolInput = Object.keys(step.input).length > 0 ? step.input : { query: researchGoal };
        if (step.input_bindings.length === 0) {
          this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
        }
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
    if (publicEvidencePolicyFailure) {
      return new ExecutionAuthenticityError(
        'execution evidence policy requires a planned eligible real Core Tool for public-source evidence',
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
    let operationSucceeded = false;
    let operationResult: T | undefined;
    try {
      operationResult = await operation();
      operationSucceeded = true;
      if (heartbeatFailure) throw heartbeatFailure;
      await this.dependencies.repository.requireActiveLease(lease);
      return operationResult as T;
    } catch (error) {
      if (operationSucceeded) attachToolAttemptReceipts(error, operationResult);
      throw error;
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
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
  }): Promise<StepResult> {
    await this.dependencies.repository.requireActiveLease(input.lease);
    switch (input.step.actor_type) {
      case 'tool':
        return this.runTool(input.step, input.researchGoal, input.resolvedInput, input.lease);
      case 'skill':
        return this.runSkill(input);
      case 'llm':
        return this.runLlm(input);
      case 'reviewer':
        return this.runReviewer(input);
    }
  }

  private async failedToolProvenance(
    step: EngineStep,
    researchGoal: string,
    resolvedInput: Record<string, unknown>,
    error: unknown,
    fallbackAttemptReceipts?: ToolRetryAttemptReceipt[],
  ): Promise<Record<string, unknown>> {
    const receipt = error instanceof ToolInvocationError ? error.receipt : null;
    const details = detailsFrom(error);
    const attemptReceipts = attemptReceiptsFrom(error) ?? fallbackAttemptReceipts;
    const refs = Array.isArray(details.sourceRefs)
      ? details.sourceRefs.filter(isToolSourceRef)
      : [];
    const fallback = (captureFailure: unknown): Record<string, unknown> => ({
      registryHash: null,
      manifestHash: null,
      inputSchemaHash: null,
      outputSchemaHash: null,
      inputHash: hashJson(Object.keys(resolvedInput).length > 0 ? resolvedInput : { query: researchGoal }),
      outputHash: typeof details.outputHash === 'string' ? details.outputHash : null,
      configHash: null,
      declaredAdapterType: receipt?.declaredAdapterType ?? 'unknown',
      resolvedAdapterType: receipt?.resolvedAdapterType ?? 'unknown',
      implementationId: receipt?.implementationId ?? 'unknown',
      executionMode: receipt?.executionMode ?? 'unknown',
      endpointHost: receipt?.endpointHost ?? null,
      sourceRefs: refs,
      ...(attemptReceipts ? { attemptReceipts } : {}),
      status: 'failed',
      captureFailure: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
    });
    try {
      const tool = this.dependencies.skillLoader.getTool(step.actor_id);
      if (!tool) return fallback(new Error(`tool ${step.actor_id} unavailable during provenance capture`));
      const manifest = loadToolManifest(tool.path);
      const resolution = this.dependencies.tools.resolve(manifest);
      const toolInput = Object.keys(resolvedInput).length > 0 ? resolvedInput : { query: researchGoal };
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
        ...(attemptReceipts ? { attemptReceipts } : {}),
        status: 'failed',
      };
    } catch (captureFailure) {
      return fallback(captureFailure);
    }
  }

  private async failedSkillProvenance(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    priorOutputs: EngineSealedStepOutput[];
    producedOutputHash?: string;
  }): Promise<Record<string, unknown>> {
    let receipt: { id: string; promptHash: string; traceId: string | null } | undefined;
    const fallback = (captureFailure: unknown): Record<string, unknown> => ({
      skillBodyHash: null,
      inputSchemaHash: null,
      outputSchemaHash: null,
      inputHash: hashJson(input.resolvedInput),
      outputHash: input.producedOutputHash ?? null,
      promptHash: receipt?.promptHash ?? null,
      traceId: receipt?.traceId ?? null,
      modelReceiptId: receipt?.id ?? null,
      outputArtifactId: null,
      status: 'failed',
      captureFailure: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
    });
    try {
      const calls = await this.dependencies.repository.listModelCalls(input.lease.attemptId);
      receipt = [...calls].reverse().find(
        (call) => call.stage === 'skill' && call.stepNo === input.step.step_no,
      );
      const skill = this.dependencies.skillLoader.getSkill(input.step.actor_id);
      if (!skill) return fallback(new Error(`skill ${input.step.actor_id} unavailable during provenance capture`));
      const body = this.dependencies.skillLoader.loadSkillBody(input.step.actor_id);
      const context = {
        research_goal: input.researchGoal,
        input: input.resolvedInput,
        prior_outputs: verifiedPriorOutputs(input.priorOutputs, input.step),
        ...stepContract(input.step),
      };
      const prompt = `${SKILL_PROMPT_PREFIX}\n${JSON.stringify(stepContract(input.step))}\n\n${body.body}`;
      return {
        skillBodyHash: body.hash,
        inputSchemaHash: skill.input_schema ? hashFile(skill.input_schema) : null,
        outputSchemaHash: skill.output_schema ? hashFile(skill.output_schema) : null,
        inputHash: hashJson(input.resolvedInput),
        outputHash: input.producedOutputHash ?? null,
        promptHash: receipt?.promptHash ?? hashPrompt(prompt, context, `skill:${input.step.actor_id}`),
        traceId: receipt?.traceId ?? null,
        modelReceiptId: receipt?.id ?? null,
        outputArtifactId: null,
        status: 'failed',
      };
    } catch (captureFailure) {
      return fallback(captureFailure);
    }
  }

  private async runTool(
    step: EngineStep,
    researchGoal: string,
    resolvedInput: Record<string, unknown>,
    lease: ControlExecutionLease,
  ): Promise<StepResult> {
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
    const toolInput = Object.keys(resolvedInput).length > 0 ? resolvedInput : { query: researchGoal };
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
    const retryResult = await invokeWithRetry({
      manifest,
      isLeaseActive: async () => {
        try {
          await this.dependencies.repository.requireActiveLease(lease);
          return true;
        } catch {
          return false;
        }
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      invoke: (context) => this.dependencies.tools.invoke({
        toolId: step.actor_id,
        input: toolInput,
        manifest,
        attemptId: context.attemptId,
        retryOf: lease.retryOf,
      }),
    });
    if (retryResult.status === 'failed') {
      if (retryResult.failure.kind === 'lease_lost') {
        throw leaseLostWithRetry('execution lease lost during tool retry', {
          attempts: retryResult.failure.attempts,
          maxAttempts: retryResult.failure.maxAttempts,
          attemptReceipts: retryResult.attemptReceipts,
        });
      }
      const lastAttempt = retryResult.attemptReceipts[retryResult.attemptReceipts.length - 1];
      throw new ToolInvocationError(step.actor_id, {
        kind: retryResult.failure.kind as ToolFailureKind,
        retryable: retryResult.failure.retryable,
        providerStatus: retryResult.failure.providerStatus,
        sanitizedMessage: retryResult.failure.lastFailure ?? retryResult.failure.kind,
        receipt: lastAttempt?.receipt,
        details: {
          retry: {
            attempts: retryResult.failure.attempts,
            maxAttempts: retryResult.failure.maxAttempts,
            attemptReceipts: retryResult.attemptReceipts,
          },
        },
      });
    }
    try {
      await this.dependencies.repository.requireActiveLease(lease);
    } catch {
      throw leaseLostWithRetry('execution lease lost after tool retry', {
        attempts: retryResult.attemptReceipts.length,
        maxAttempts: manifest.retry_policy?.max_attempts ?? retryResult.attemptReceipts.length,
        attemptReceipts: retryResult.attemptReceipts,
      });
    }
    const result = {
      output: retryResult.output,
      receipt: retryResult.receipt,
      latencyMs: retryResult.latencyMs ?? retryResult.receipt.latencyMs,
    };
    const retryContext = {
      attempts: retryResult.attemptReceipts.length,
      maxAttempts: manifest.retry_policy?.max_attempts ?? retryResult.attemptReceipts.length,
      attemptReceipts: retryResult.attemptReceipts,
    };
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
          retry: retryContext,
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
          retry: retryContext,
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
      toolAttemptReceipts: retryResult.attemptReceipts,
      toolTier: tool.tier ?? 'optional',
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
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('skill LLM provider is not eligible as real');
    }
    const skill = this.dependencies.skillLoader.getSkill(input.step.actor_id);
    if (!skill) throw new ExecutionAuthenticityError(`skill ${input.step.actor_id} is not active`);
    const body = this.dependencies.skillLoader.loadSkillBody(input.step.actor_id);
    const schemas = this.dependencies.skillLoader.loadSkillSchemas(input.step.actor_id);
    if (skill.input_schema) {
      try {
        this.dependencies.validator.validateFileOrThrow(
          join(getConfigRoot(), skill.input_schema),
          input.resolvedInput,
        );
      } catch {
        throw new LLMInvocationError('schema', false, null, 'skill input failed schema validation');
      }
    }
    const skillContext = {
      research_goal: input.researchGoal,
      input: input.resolvedInput,
      prior_outputs: verifiedPriorOutputs(input.outputs, input.step),
      ...stepContract(input.step),
    };
    const prompt = `${SKILL_PROMPT_PREFIX}\n${JSON.stringify(stepContract(input.step))}\n\n${body.body}`;
    const result = await this.llm.generateStructured<object>({
      prompt,
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
      try {
        this.dependencies.validator.validateFileOrThrow(
          join(getConfigRoot(), skill.output_schema),
          result.data,
        );
      } catch {
        throw new SkillOutputSchemaError(hashJson(redactSensitiveValue(result.data)));
      }
    }
    if (!result.receiptId) {
      throw new MissingModelReceiptError(new Error('successful Skill call has no receipt ID'));
    }
    return {
      output: result.data,
      kind: 'skill_output',
      outputHash: hashJson(redactSensitiveValue(result.data)),
      skillProvenance: {
        skillBodyHash: body.hash,
        inputSchemaHash: skill.input_schema ? hashFile(skill.input_schema) : null,
        outputSchemaHash: skill.output_schema ? hashFile(skill.output_schema) : null,
        inputHash: hashJson(input.resolvedInput),
        outputHash: hashJson(redactSensitiveValue(result.data)),
        promptHash: result.promptHash,
        traceId: result.traceId,
        modelReceiptId: result.receiptId,
      },
    };
  }

  private async runLlm(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('LLM provider is not eligible as real');
    }
    const llmContext = {
      research_goal: input.researchGoal,
      input: input.resolvedInput,
      prior_outputs: verifiedPriorOutputs(input.outputs, input.step),
      ...stepContract(input.step),
    };
    const result = await this.llm.generateText({
      prompt: `Execute plan step: ${input.step.step_name}. ${input.step.purpose ?? ''}\nContract: ${JSON.stringify(stepContract(input.step))}`, 
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
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('reviewer LLM provider is not eligible as real');
    }
    const reviewerContext = {
      research_goal: input.researchGoal,
      input: input.resolvedInput,
      prior_outputs: verifiedPriorOutputs(input.outputs, input.step),
      ...stepContract(input.step),
    };
    const result = await this.llm.generateText({
      prompt: `Review completed outputs for source support and gaps: ${input.step.step_name}. Contract: ${JSON.stringify(stepContract(input.step))}`, 
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
