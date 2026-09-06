import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ARTIFACT_INVALIDATION_PROMOTION_VERSION,
  ControlPlaneConflictError,
} from '../../../../database/control-plane.ts';
import type {
  ActiveExecutionLease,
  ControlArtifact,
  ControlGateRecord,
  ControlExecutionLease,
  ControlModelCall,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import {
  isNativeSkillExecutionPlanV1,
  NATIVE_SKILL_RESULT_VERSION,
  parseNativeFinalReport,
  parseNativeSkillExecutionPlanV1,
  parseNativeSkillResult,
  type NativeSkillRunSpec,
  type NativeReportPolicy,
  type ResolvedPlanInputs,
  type NativeSkillResult,
  type SourceReference,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type {
  ContributionType,
  RequestedArtifact,
  ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import type {
  ChartSpec,
  CurrentExecutionPlan,
  CurrentExecutionPlanV3,
  CurrentPlanStep,
  EvidenceClass,
  EvidenceManifest,
  EvidenceRequirement,
  PendingInput,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  VisualAssetManifest,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  selectAuthoritativeFailedStep,
  type PassedReportReviewArtifact,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ReportDocumentV3,
  ReportDocumentV4,
  ReportNoticeV1,
} from '../../../../packages/api-contract/report-document.ts';
import type { ReportPackageLayoutV2 } from '../../../../packages/api-contract/report-package.ts';
import { SchemaValidationError, SchemaValidator } from '../schema/validator.ts';
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
import { stableJsonHash } from '../runtime/stable-json.ts';
import {
  ToolInvocationError,
  ToolRouter,
  throwIfToolInvocationAborted,
  toolAbortError,
  type ToolAdapterResolution,
  type ToolFailureKind,
  type ToolInvocationContext,
  type ToolKnowledgeAttachment,
  type ToolMediaAttachment,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';
import { invokeWithRetry, type ToolRetryAttemptReceipt } from './tool-retry-policy.ts';
import {
  isMachineReferenceField,
  machineReferencesPreserved,
  redactSensitiveValue,
  redactString,
  redactToolOutput,
} from '../runtime/redaction.ts';
import { compactLlmInput } from '../runtime/llm-input-compactor.ts';
import {
  assertCompiledSkillPlan,
  CompiledSkillPlanDriftError,
} from '../skills/skill-plan-compiler.ts';
import { buildResearchContributionBundle } from '../skills/research-contribution-bundle.ts';
import { assertCompiledPortfolioPlan } from '../skills/portfolio-skill-plan-compiler.ts';
import {
  ContributionAdapterRegistry,
  VIRTUAL_USER_TOOL_ADAPTER_ID,
} from '../skills/contribution-adapter-registry.ts';
import {
  evaluateSkillOutputStatus,
  SkillDegradedPolicyError,
  type SkillOutputOutcome,
} from '../skills/skill-result-status.ts';
import {
  buildSkillExecutionPrompt,
  prepareSkillExecution,
  SkillRuntimeDriftError,
  type FrozenSkillExecutionBinding,
  type PreparedSkillExecution,
} from '../skills/skill-runtime.ts';
import {
  KnowledgeBundleResolver,
  RequiredKnowledgeUnavailableError,
  type FrozenKnowledgeReference,
  type KnowledgeResolutionGap,
} from '../knowledge/knowledge-bundle-resolver.ts';
import { ArtifactIntegrityError, ControlArtifactStore } from './artifact-store.ts';
import {
  ArtifactInvalidationError,
  ArtifactPublicationGroup,
  mergeArtifactInvalidationErrors,
} from './artifact-publication-group.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceEntry,
  type ResolvedEvidenceArtifact,
} from '../evidence/evidence-service.ts';
import { virtualUserSimulationEvidence } from '../evidence/virtual-user-evidence.ts';
import { CurrentReportValidationError } from '../evidence/report-evidence-validator.ts';
import type {
  CurrentDeliverableGenerateInput,
  CurrentDeliverableGenerateResult,
  CurrentDeliverableRevisionInput,
} from '../report/current-deliverable-service.ts';
import type { DeliverableComposer, ReportReviewInput, ReportReviewResult } from '../report/report-review-service.ts';
import {
  resolveDeliverableContractById,
  resolveExecutionDeliverableContract,
  type DeliverableContractResources,
} from '../report/deliverable-registry.ts';
import {
  ReportCompositionService,
  type ReportCompositionPort,
  type ReportCompositionResult,
} from '../report/report-composition-service.ts';
import type { ReportEditorialPlannerDataClassification } from '../report/report-editorial-planner.ts';
import { ReportPackageArtifactService } from '../report/report-package-artifact.ts';
import { ReportPackageV2ArtifactService } from '../report/report-package-v2-artifact.ts';
import { ReportPackageV3ArtifactService } from '../report/report-package-v3-artifact.ts';
import {
  createReportPublicationId,
  renderAndSealStandaloneHtml,
} from '../report/report-v3-publication.ts';
import {
  createNativeSkillResult,
  finalizeMultiNativeReport,
  finalizeSingleNativeReport,
  LlmNativeReportWriter,
  NativeReportArtifactService,
  NativeReportError,
  NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
  assertNativeContentReferences,
  type NativeSkillResultDraft,
} from '../report/native-reporting.ts';
import {
  VisualAssetService,
  type VisualAssetResult,
} from '../report/visual-asset-service.ts';
import {
  ChartRendererUnavailableError,
  renderAndSealChartSvg,
} from '../report/chart-renderer.ts';
import {
  COMPETITIVE_WEIGHT_CHART_ID,
  COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
  COMPETITIVE_WEIGHT_SERIES_KEY,
  COMPETITIVE_WEIGHT_SERIES_LABEL,
  COMPETITIVE_WEIGHT_TITLE,
  resolveCompetitiveScoringWeights,
} from '../report/competitive-weight-chart.ts';
import { ChartSpecValidationError } from '../report/chart-spec-validator.ts';
import type {
  FindingBoundVisualAnnotation,
  MaterializedVisualOriginal,
} from '../report/visual-input-materializer.ts';
import {
  readVerifiedStepArtifact,
  resolveStepInput,
  StepInputResolutionError,
  validateStepInputBindings,
  type SealedStepOutput as BindingSealedStepOutput,
} from './step-input-resolver.ts';
import { ExecutionScheduler } from './execution-scheduler.ts';
import { validateCurrentExecutionPlanV3 } from '../planners/current-execution-plan-v3.ts';
import {
  DatasetInputGateStore,
  type ResolvedDatasetInput,
} from './dataset-input-gate-store.ts';
import {
  VisualInputGateStore,
  valueForPendingInputTarget,
  type ResolvedVisualInput,
} from './visual-input-gate-store.ts';
import {
  parsePendingInputContracts,
  PendingInputContractError,
} from './pending-input-contract.ts';

type EngineStep = CurrentPlanStep & { purpose?: string };

interface InvocationExecutionPolicy {
  invocationId: string;
  skillId: string;
  role: 'contributor' | 'synthesizer';
  contributionTypes: ContributionType[];
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  dependsOnInvocationIds: string[];
  required: boolean;
  failurePolicy: 'block' | 'gap';
  contributionAdapterId?: string;
}

export interface EnginePlan {
  taskId: string;
  evidence_requirements: EvidenceRequirement[];
  steps: EngineStep[];
  optionalToolStepNos: Set<number>;
  capabilityGaps: ExecutionGap[];
  frozenSkillExecutions: Map<number, FrozenSkillExecutionBinding>;
  invocationPoliciesByStep: Map<number, InvocationExecutionPolicy[]>;
  invocationPoliciesById: Map<string, InvocationExecutionPolicy>;
  optionalInvocationStepNos: Set<number>;
  native?: {
    mode: 'single_skill' | 'multi_skill';
    runSpecsByStep: Map<number, {
      invocationId: string;
      runSpec: NativeSkillRunSpec;
    }>;
    finalReportPolicy: NativeReportPolicy;
    resolvedInputs: ResolvedPlanInputs;
  };
}

interface FrozenSkillToolRoles {
  requiredToolIds: Set<string>;
  availableOptionalToolIds: Set<string>;
}

interface ExecutionGap {
  key: string;
  stepNo: number;
  message: string;
}

function nativeSkillOutcome(value: unknown): SkillOutputOutcome | null {
  try {
    const report = parseNativeSkillResult(value);
    if (report.status === 'needs_input') return null;
    return {
      status: report.status === 'completed_with_gaps' ? 'degraded' : 'succeeded',
      limitations: [...report.gaps],
      summary: report.title,
    };
  } catch {
    return null;
  }
}

interface PageFailureGap {
  sourceResultIndex: number;
  code: string;
  message: string;
}

interface ToolGapSummary {
  count: number;
  keys: string[];
  failuresHash: string;
}

const PAGE_FAILURE_CODES = new Set([
  'login_required',
  'captcha_required',
  'paywall',
  'robots_or_terms_blocked',
  'navigation_timeout',
  'no_capture_target',
  'unsupported_content',
]);

const SUPPORTED_EVIDENCE_CLASSES: Record<EvidenceClass, true> = {
  public_source: true,
  screenshot: true,
  user_input: true,
  knowledge: true,
  dataset: true,
  simulation: true,
  derived: true,
};

export function invocationFailureCanBecomeGap(input: {
  optionalInvocationStep: boolean;
  failureKind: string | undefined;
  artifactCleanupFailed: boolean;
  integrityFailure: boolean;
}): boolean {
  return input.optionalInvocationStep
    && !input.artifactCleanupFailed
    && !input.integrityFailure
    && input.failureKind !== 'safety'
    && input.failureKind !== 'lease_lost';
}

interface ToolSourceRef {
  sourceUrl: string;
  originalIndex: number;
}

type StepArtifactKind = 'knowledge_output' | 'tool_output' | 'skill_output' | 'skill_result' | 'research_contribution' | 'llm_output' | 'review_output';

const STEP_ARTIFACT_SCHEMA_VERSIONS: Record<StepArtifactKind, string> = {
  knowledge_output: 'knowledge-bundle-v1',
  tool_output: 'tool-output-v1',
  skill_output: 'skill-output-v2',
  skill_result: NATIVE_SKILL_RESULT_VERSION,
  research_contribution: 'research-contribution-artifact-v1',
  llm_output: 'llm-output-v1',
  review_output: 'review-output-v1',
};

interface ReviewerStepCondition {
  id: string;
  statement: string;
  disposition: 'limitation' | 'open_question';
}

interface ReviewerStepOutput {
  version: 'reviewer-step-output-v1';
  review: string;
  verdict: 'pass' | 'pass_with_conditions' | 'revise' | 'block';
  conditions: ReviewerStepCondition[];
}

export const REVIEWER_STEP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'review', 'verdict', 'conditions'],
  properties: {
    version: { const: 'reviewer-step-output-v1' },
    review: { type: 'string', minLength: 1, pattern: '\\S' },
    verdict: { enum: ['pass', 'pass_with_conditions', 'revise', 'block'] },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement', 'disposition'],
        properties: {
          id: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          statement: { type: 'string', minLength: 1, pattern: '\\S' },
          disposition: { enum: ['limitation', 'open_question'] },
        },
      },
    },
  },
} as const;

interface StepResult {
  output: unknown;
  kind: StepArtifactKind;
  artifactValue?: unknown;
  toolReceipt?: ToolInvocationReceipt;
  toolAttemptReceipts?: ToolRetryAttemptReceipt[];
  mediaAttachments?: ToolMediaAttachment[];
  knowledgeAttachments?: ToolKnowledgeAttachment[];
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
  knowledgeGaps?: KnowledgeResolutionGap[];
}

const TOOL_EXECUTION_DEADLINE_MS = 90_000;
const MAX_BROWSER_CAPTURE_COUNT = 6;
const MAX_BROWSER_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_BROWSER_SIDECAR_BYTES = 40 * 1024 * 1024;

async function runWithinToolScope<T>(
  factory: () => Promise<T>,
  toolId: string,
  context: ToolInvocationContext,
): Promise<T> {
  throwIfToolInvocationAborted(toolId, context);
  const remainingMs = context.deadlineAt - Date.now();
  if (remainingMs <= 0) throw toolAbortError(toolId, context.signal, context.deadlineAt);

  const operation = factory();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toolAbortError(toolId, context.signal, context.deadlineAt));
    context.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => reject(toolAbortError(toolId, context.signal, context.deadlineAt)),
      remainingMs,
    );
    if (context.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) context.signal.removeEventListener('abort', onAbort);
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

class ToolExecutionScope {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  readonly context: ToolInvocationContext;

  constructor(deadlineAt: number) {
    this.context = { signal: this.controller.signal, deadlineAt };
    this.timer = setTimeout(
      () => this.abort('deadline_exceeded'),
      Math.max(0, deadlineAt - Date.now()),
    );
    this.timer.unref?.();
  }

  abort(reason: 'lease_lost' | 'deadline_exceeded'): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  assertActive(toolId: string): void {
    throwIfToolInvocationAborted(toolId, this.context);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

interface LeaseHeartbeatHandle {
  assertHealthy(): void;
  stop(): void;
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

interface CommittedBrowserCapture {
  stepNo: number;
  captureIndex: number;
  toolId: string;
  result: VisualAssetResult;
}

export interface LeaseExecutionResult {
  status: 'completed' | 'completed_with_gaps' | 'paused';
  attemptId: string;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  reportReviewArtifactId?: string;
  reportPackageArtifactId?: string;
  finalReportArtifactId?: string;
  crossSkillReviewArtifactId?: string;
  contributionLedgerArtifactId?: string;
  contributionSummaryArtifactId?: string;
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

class ExecutionStepPersistenceError extends Error {
  constructor(
    readonly leaseLost: boolean,
    options: { cause: unknown },
  ) {
    super('execution step succeeded state could not be confirmed', options);
    this.name = 'ExecutionStepPersistenceError';
  }
}

class SkillOutputSchemaError extends LLMInvocationError {
  constructor(
    readonly outputHash: string,
    readonly schemaHashes: {
      inputSchemaHash: string | null;
      outputSchemaHash: string;
      payloadSchemaHash: string | null;
    },
    readonly schemaErrors: string[],
    readonly repairAttempts: number,
    readonly modelReceipt: { id: string; promptHash: string; traceId: string },
  ) {
    super('schema', true, null, 'skill output failed schema validation after automatic repair');
    this.name = 'SkillOutputSchemaError';
  }
}

const MAX_PERSISTED_SKILL_SCHEMA_ERRORS = 20;
const MAX_PERSISTED_SKILL_SCHEMA_ERROR_LENGTH = 500;

function skillSchemaErrors(error: unknown): string[] {
  if (!(error instanceof SchemaValidationError)) throw error;
  return error.errors
    .slice(0, MAX_PERSISTED_SKILL_SCHEMA_ERRORS)
    .map((issue) => redactString(issue).slice(0, MAX_PERSISTED_SKILL_SCHEMA_ERROR_LENGTH));
}

function skillSchemaRepairPrompt(skillId: string, errors: readonly string[]): string {
  return `Repair the supplied invalid JSON output for Skill ${skillId}. Return one complete replacement object that satisfies the supplied schema. Preserve existing supported content, use only claims and Evidence IDs already present in invalid_output, and do not add new analysis. Correct every listed issue:\n${errors.join('\n')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reportEditorialPlannerDataClassification(
  structuredTask: unknown,
  _evidenceManifest: EvidenceManifest,
): ReportEditorialPlannerDataClassification | undefined {
  if (
    !isRecord(structuredTask)
    || structuredTask.version !== 'research-task-v2'
    || (
      structuredTask.sensitivity !== 'public'
      && structuredTask.sensitivity !== 'internal'
      && structuredTask.sensitivity !== 'confidential'
    )
    || typeof structuredTask.pii_detected !== 'boolean'
  ) {
    return undefined;
  }
  return {
    taskSensitivity: structuredTask.sensitivity,
    piiDetected: structuredTask.pii_detected,
    hasSensitiveOrBlockedEvidence: false,
  };
}

function skillDegradationMessage(step: EngineStep, outcome: SkillOutputOutcome): string {
  const reason = outcome.limitations[0] ?? outcome.summary ?? 'Skill returned a degraded result';
  return redactString(`Step ${step.step_no} (${step.actor_id}) degraded: ${reason}`);
}

function designAnnotationFindings(
  outputs: readonly EngineSealedStepOutput[],
): FindingBoundVisualAnnotation[] {
  const analysis = outputs.find((output) => (
    output.actorType === 'tool'
    && output.actorId === 'attention-analysis-lab'
    && output.kind === 'tool_output'
  ));
  const value = isRecord(analysis?.output) ? analysis.output : null;
  if (!analysis || value?.status !== 'available' || !Array.isArray(value.hotspots)) {
    throw new ExecutionAuthenticityError(
      'design audit requires a successful attention analysis before annotation synthesis',
    );
  }
  const findings = value.hotspots.flatMap((candidate, index): FindingBoundVisualAnnotation[] => {
    if (!isRecord(candidate)) return [];
    const { x, y, width, height, score } = candidate;
    if (
      typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1
      || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1
      || typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || x + width > 1
      || typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || y + height > 1
    ) return [];
    const label = typeof candidate.reason === 'string' && candidate.reason.trim()
      ? candidate.reason.trim()
      : typeof candidate.label === 'string' && candidate.label.trim()
        ? candidate.label.trim()
        : '';
    if (!label) return [];
    const normalizedScore = typeof score === 'number' && Number.isFinite(score) ? score : 0;
    return [{
      findingId: `design-attention-${analysis.stepNo}-${index + 1}`,
      label,
      severity: normalizedScore >= 0.8 ? 'high' : normalizedScore >= 0.5 ? 'medium' : 'low',
      x,
      y,
      width,
      height,
    }];
  });
  if (findings.length === 0) {
    throw new ExecutionAuthenticityError(
      'design audit attention analysis has no valid finding-bound hotspot',
    );
  }
  return findings;
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

function sameOptionalDate(actual: Date | null, expected: Date | undefined): boolean {
  return actual === null
    ? expected === undefined
    : expected !== undefined && actual.getTime() === expected.getTime();
}

function persistedJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function synthesizerPolicyForStep(
  plan: EnginePlan,
  step: EngineStep,
): InvocationExecutionPolicy | undefined {
  return (plan.invocationPoliciesByStep.get(step.step_no) ?? []).find(({ role, skillId }) => (
    role === 'synthesizer' && skillId === step.actor_id
  ));
}

const REDACTION_MARKER = /\[REDACTED_[A-Z0-9_]+\]/u;

function containsRedactedMachineReference(value: unknown, field = ''): boolean {
  if (typeof value === 'string') {
    return isMachineReferenceField(field) && REDACTION_MARKER.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsRedactedMachineReference(item, field));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    containsRedactedMachineReference(child, key)
  ));
}

function contributionBundleArtifactIdentity(
  resolvedInput: Readonly<Record<string, unknown>>,
): { id: string; contentSha256: string } | null {
  const candidate = resolvedInput.contribution_bundle_artifact;
  return isRecord(candidate)
    && typeof candidate.id === 'string'
    && typeof candidate.contentSha256 === 'string'
    ? { id: candidate.id, contentSha256: candidate.contentSha256 }
    : null;
}

function executionInputArtifacts(
  outputs: readonly EngineSealedStepOutput[],
  step: EngineStep,
): Array<{ stepNo: number; artifactId: string; contentSha256: string }> {
  const allowed = new Set([
    ...step.depends_on,
    ...step.input_bindings.map((binding) => binding.source_step_no),
  ]);
  return outputs
    .filter((output) => allowed.has(output.stepNo) && output.artifact.contentSha256 !== null)
    .sort((left, right) => left.stepNo - right.stepNo)
    .map((output) => ({
      stepNo: output.stepNo,
      artifactId: output.artifact.id,
      contentSha256: output.artifact.contentSha256!,
    }));
}

function collectHttpsUrls(value: unknown, urls: Set<string>, depth = 0): void {
  if (depth > 6 || urls.size >= 50) return;
  if (typeof value === 'string') {
    if (value.startsWith('https://')) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol === 'https:') urls.add(parsed.toString());
      } catch {
        // Invalid provider text is not promoted to a source URL.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpsUrls(item, urls, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) collectHttpsUrls(child, urls, depth + 1);
  }
}

function nativeSourceReferences(input: {
  step: EngineStep;
  outputs: readonly EngineSealedStepOutput[];
  resolvedInputs: ResolvedPlanInputs;
  invocationId: string;
  runSpec: NativeSkillRunSpec;
}): SourceReference[] {
  const sources: SourceReference[] = [];
  for (const resolved of input.resolvedInputs.resolved) {
    if (!resolved.targetInvocationIds.includes(input.invocationId)) continue;
    sources.push({
      id: `S-input-${resolved.key}`,
      title: resolved.key,
      type: 'user_input',
    });
  }
  const allowedStepNos = new Set([
    ...input.step.depends_on,
    ...input.step.input_bindings.map(({ source_step_no }) => source_step_no),
  ]);
  for (const output of input.outputs) {
    if (!allowedStepNos.has(output.stepNo)) continue;
    if (output.actorType !== 'tool' && output.actorType !== 'knowledge') continue;
    const urls = new Set<string>();
    collectHttpsUrls(output.output, urls);
    if (urls.size === 0) {
      sources.push({
        id: `S-step-${output.stepNo}`,
        title: output.actorId,
        type: output.actorType === 'tool' ? 'tool_result' : 'knowledge',
      });
      continue;
    }
    let index = 0;
    for (const url of urls) {
      index += 1;
      sources.push({
        id: `S-step-${output.stepNo}-${index}`,
        title: `${output.actorId} ${index}`,
        type: output.actorType === 'tool' ? 'tool_result' : 'knowledge',
        url,
      });
    }
  }
  for (const reference of input.runSpec.selected_references) {
    const identity = hashJson([reference.sourceId, reference.logicalPath]).slice('sha256:'.length, 'sha256:'.length + 24);
    sources.push({
      id: `S-K-${identity}`,
      title: reference.path,
      type: 'knowledge',
      locator: reference.logicalPath,
      contentHash: reference.contentHash,
    });
  }
  return sources;
}

function nativeSkillPrompt(runSpec: NativeSkillRunSpec): string {
  const selected = runSpec.selected_references.map((reference) => (
    `--- ${reference.logicalPath} ---\n${reference.content}`
  ));
  const reportInstructions = runSpec.report_policy.kind === 'skill_defined'
    ? [runSpec.report_policy.instructions]
    : [];
  return [
    runSpec.body,
    ...(selected.length > 0 ? ['', '## 本次冻结 References', ...selected] : []),
    ...(reportInstructions.length > 0
      ? ['', '## 本次报告结构', ...reportInstructions]
      : ['', '## 本次输出', '先形成完整、可供最终报告生成使用的分析结果；不要套用平台固定章节。']),
    '',
    '## 输出要求',
    '- 只返回符合给定 JSON Schema 的对象。',
    `- primary.format 必须为 ${runSpec.report_policy.outputFormat}。`,
    '- 内容只能使用已提供材料，并使用 sourceCatalog 中已有的 [S-*] 引用。',
    '- 不得新增 URL、来源 ID、事实或数字。',
    '- 只有冻结合同中的必需输入缺失时才使用 needs_input；可选输入缺失时继续分析并使用 completed_with_gaps。',
    '- needs_input 的 missingInputKeys 仅可包含下列冻结输入 key：',,
    runSpec.input_requirements.length > 0
      ? runSpec.input_requirements.map(({ key }) => key).join(', ')
      : '(none)',
    '- 不得请求清单外的新 key；其他资料不足时继续分析，使用 completed_with_gaps 并写入 gaps。',
  ].join('\n');
}

function nativeWaivedGaps(
  resolvedInputs: ResolvedPlanInputs,
  invocationId: string,
): string[] {
  return resolvedInputs.waived
    .filter(({ targetInvocationIds }) => targetInvocationIds.includes(invocationId))
    .map(({ key, reason }) => `${key}：${reason}`);
}

interface SkillExecutionFingerprint {
  skillBodyHash: string;
  inputSchemaHash: string | null;
  outputSchemaHash: string;
  payloadSchemaHash: string | null;
  skillReferenceHashes: Array<{ path: string; hash: string }>;
  inputArtifacts: Array<{ stepNo: number; artifactId: string; contentSha256: string }>;
  inputHash: string;
  executionPromptHash: string;
  contributionBundleArtifact?: { id: string; contentSha256: string };
}

function skillExecutionFingerprint(input: {
  prepared: PreparedSkillExecution;
  step: EngineStep;
  resolvedInput: Record<string, unknown>;
  outputs: EngineSealedStepOutput[];
}): { executionPrompt: string; fingerprint: SkillExecutionFingerprint } {
  const executionPrompt = buildSkillExecutionPrompt(
    input.prepared.prompt,
    input.step.expected_outputs.some(({ pointer }) => pointer === '/contribution'),
  );
  const contributionBundleArtifact = contributionBundleArtifactIdentity(input.resolvedInput);
  return {
    executionPrompt,
    fingerprint: {
      skillBodyHash: input.prepared.body.hash,
      inputSchemaHash: input.prepared.schemaHashes.inputSchemaHash,
      outputSchemaHash: input.prepared.schemaHashes.outputSchemaHash,
      payloadSchemaHash: input.prepared.schemaHashes.payloadSchemaHash,
      skillReferenceHashes: input.prepared.referenceHashes,
      inputArtifacts: executionInputArtifacts(input.outputs, input.step),
      inputHash: hashJson(input.resolvedInput),
      executionPromptHash: hashPrompt(
        executionPrompt,
        input.prepared.context,
        `skill:${input.step.actor_id}`,
      ),
      ...(contributionBundleArtifact ? { contributionBundleArtifact } : {}),
    },
  };
}

function pageFailureGaps(value: unknown): PageFailureGap[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ExecutionAuthenticityError('optional tool page failures are malformed');
  }
  const seen = new Set<string>();
  return value.map((candidate, index): PageFailureGap => {
    if (
      !isRecord(candidate)
      || typeof candidate.source_result_index !== 'number'
      || !Number.isInteger(candidate.source_result_index)
      || candidate.source_result_index < 0
      || typeof candidate.code !== 'string'
      || !PAGE_FAILURE_CODES.has(candidate.code)
    ) {
      throw new ExecutionAuthenticityError(`optional tool page failure ${index + 1} is malformed`);
    }
    const key = `${candidate.source_result_index}:${candidate.code}`;
    if (seen.has(key)) {
      throw new ExecutionAuthenticityError(`optional tool page failure ${key} is duplicated`);
    }
    seen.add(key);
    return {
      sourceResultIndex: candidate.source_result_index,
      code: candidate.code,
      message: typeof candidate.sanitized_message === 'string' && candidate.sanitized_message.trim()
        ? redactString(candidate.sanitized_message)
        : candidate.code,
    };
  });
}

function pageGapSummary(
  rawFailures: unknown,
  diagnosticFailures: unknown = rawFailures,
): ToolGapSummary | undefined {
  const failures = pageFailureGaps(rawFailures);
  if (failures.length === 0) return undefined;
  return {
    count: failures.length,
    keys: failures.map(({ sourceResultIndex, code }) => `${sourceResultIndex}:${code}`),
    failuresHash: hashJson(diagnosticFailures),
  };
}

function normalizedPageHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

function userVisiblePageFailures(output: Record<string, unknown>): unknown[] {
  const rawFailures = output.failures;
  pageFailureGaps(rawFailures);
  if (!Array.isArray(rawFailures) || !Array.isArray(output.captures)) return [];
  const capturedHostnames = new Set<string>();
  for (const capture of output.captures) {
    if (!isRecord(capture)) continue;
    for (const value of [capture.requested_url, capture.final_url]) {
      const hostname = normalizedPageHostname(value);
      if (hostname) capturedHostnames.add(hostname);
    }
  }
  return rawFailures.filter((failure) => {
    const hostname = isRecord(failure)
      ? normalizedPageHostname(failure.requested_url)
      : null;
    return hostname === null || !capturedHostnames.has(hostname);
  });
}

function stepGapSummary(failure: Record<string, unknown>, kind: ToolFailureKind): ToolGapSummary {
  return {
    count: 1,
    keys: [`step:${kind}`],
    failuresHash: hashJson(failure),
  };
}

function sanitizeStepResult(result: StepResult): StepResult {
  if (result.kind === 'tool_output') return result;
  const output = redactSensitiveValue(result.output);
  const artifactValue = result.artifactValue === undefined
    ? undefined
    : redactSensitiveValue(result.artifactValue);
  if (
    !machineReferencesPreserved(result.output, output)
    || (
      result.artifactValue !== undefined
      && !machineReferencesPreserved(result.artifactValue, artifactValue)
    )
  ) throw new ExecutionSafetyError('step result redaction altered a machine reference');
  return {
    ...result,
    output,
    ...(artifactValue === undefined ? {} : { artifactValue }),
    ...(result.skillProvenance
      ? { skillProvenance: { ...result.skillProvenance, outputHash: hashJson(output) } }
      : {}),
  };
}

interface JoyspaceKnowledgeSnapshotPublication {
  stepNo: number;
  attachmentIndex: number;
  toolId: string;
  evidenceId: string;
  artifact: ControlArtifact;
  value: {
    version: 'joyspace-knowledge-snapshot-v1';
    title: string;
    body: string;
    author: string | null;
    sourceUrl: string;
    updatedAt: string | null;
    contentSha256: string;
    toolArtifactId: string;
    toolArtifactContentSha256: string;
  };
}

function joyspaceKnowledgeAttachments(
  toolId: string,
  output: unknown,
  attachments: ToolKnowledgeAttachment[] | undefined,
): ToolKnowledgeAttachment[] {
  if (toolId !== 'joyspace-read') {
    if (attachments && attachments.length > 0) {
      throw new ExecutionAuthenticityError(`tool ${toolId} returned unsupported Knowledge attachments`);
    }
    return [];
  }
  const record = isRecord(output) ? output : null;
  if (record?.operation !== 'view' && record?.operation !== 'search') {
    if (attachments && attachments.length > 0) {
      throw new ExecutionAuthenticityError('Joyspace Knowledge attachment has an invalid operation');
    }
    return [];
  }
  const expectedDocument = record.operation === 'view'
    ? (isRecord(record.document) ? record.document : null)
    : (isRecord(record.viewedDocument) ? record.viewedDocument : null);
  if (!expectedDocument) {
    if (attachments && attachments.length > 0) {
      throw new ExecutionAuthenticityError('Joyspace output has an unexpected Knowledge Snapshot attachment');
    }
    return [];
  }
  if (!attachments || attachments.length !== 1) {
    throw new ExecutionAuthenticityError('Joyspace viewed content requires one Knowledge Snapshot attachment');
  }
  const attachment = attachments[0]!;
  const expectedUpdatedAt = record.operation === 'search' && Array.isArray(record.documents)
    ? record.documents.flatMap((candidate) => {
        const document = isRecord(candidate) ? candidate : null;
        return document?.url === attachment.sourceUrl ? [document.updatedAt] : [];
      })[0] ?? null
    : null;
  if (
    attachment.attachmentId !== 'joyspace-document'
    || expectedDocument.title !== attachment.title
    || expectedDocument.body !== attachment.body
    || expectedDocument.url !== attachment.sourceUrl
    || expectedDocument.author !== attachment.author
    || attachment.updatedAt !== expectedUpdatedAt
    || expectedDocument.contentSha256 !== attachment.contentSha256
    || attachment.sensitivity !== 'internal'
    || `sha256:${createHash('sha256').update(attachment.body).digest('hex')}` !== attachment.contentSha256
  ) {
    throw new ExecutionAuthenticityError('Joyspace Knowledge Snapshot binding is invalid');
  }
  return attachments;
}

function browserCaptureAttachments(
  toolId: string,
  output: unknown,
  attachments: ToolMediaAttachment[] | undefined,
): Array<{ captureIndex: number; attachment: ToolMediaAttachment }> {
  if (toolId !== 'playwright-page-capture') {
    if (attachments && attachments.length > 0) {
      throw new ExecutionAuthenticityError(`tool ${toolId} returned unsupported media attachments`);
    }
    return [];
  }
  if (!isRecord(output) || !Array.isArray(output.captures)) {
    throw new ExecutionAuthenticityError('Playwright Tool output has no capture metadata');
  }
  if (!attachments || attachments.length !== output.captures.length || attachments.length === 0) {
    throw new ExecutionAuthenticityError('Playwright Tool capture metadata and media sidecars do not match');
  }
  if (attachments.length > MAX_BROWSER_CAPTURE_COUNT) {
    throw new ExecutionAuthenticityError('Playwright Tool returned too many media sidecars');
  }
  const byId = new Map<string, ToolMediaAttachment>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (
      !(attachment.bytes instanceof Uint8Array)
      || attachment.bytes.byteLength < 1
      || attachment.bytes.byteLength > MAX_BROWSER_CAPTURE_BYTES
    ) {
      throw new ExecutionAuthenticityError('Playwright Tool media attachment size is invalid');
    }
    totalBytes += attachment.bytes.byteLength;
    if (totalBytes > MAX_BROWSER_SIDECAR_BYTES) {
      throw new ExecutionAuthenticityError('Playwright Tool media sidecar exceeds its total byte limit');
    }
    if (!attachment.attachmentId.trim() || byId.has(attachment.attachmentId)) {
      throw new ExecutionAuthenticityError('Playwright Tool media attachment ids must be unique');
    }
    byId.set(attachment.attachmentId, attachment);
  }
  const used = new Set<string>();
  const ordered = output.captures.map((candidate, captureIndex) => {
    const metadata = isRecord(candidate) ? candidate : null;
    const attachmentId = typeof metadata?.attachment_id === 'string' ? metadata.attachment_id : '';
    const attachment = byId.get(attachmentId);
    if (!attachment || used.has(attachmentId)) {
      throw new ExecutionAuthenticityError('Playwright Tool capture metadata has a missing or duplicate sidecar');
    }
    used.add(attachmentId);
    return { captureIndex, attachment };
  });
  if (used.size !== byId.size) {
    throw new ExecutionAuthenticityError('Playwright Tool returned an unreferenced media sidecar');
  }
  return ordered;
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
export function parseExecutionPlan(taskId: string, value: unknown, contract: DeliverableContractResources): EnginePlan {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    throw new ExecutionAuthenticityError('active plan is malformed');
  }
  const nativePlan = isNativeSkillExecutionPlanV1(value)
    ? parseNativeSkillExecutionPlanV1(value)
    : null;
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
      || (actorType !== 'knowledge' && actorType !== 'tool' && actorType !== 'skill' && actorType !== 'llm' && actorType !== 'reviewer')
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
        ...(binding.optional === true ? { optional: true } : {}),
        ...(binding.include_artifact_identity === true ? { include_artifact_identity: true } : {}),
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
      ...(typeof item.skill_invocation_id === 'string' ? { skill_invocation_id: item.skill_invocation_id } : {}),
      ...(typeof item.skill_stage_id === 'string' ? { skill_stage_id: item.skill_stage_id } : {}),
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
  const frozenSkillToolRoles = new Map<string, FrozenSkillToolRoles>();
  const contributionAdapterBySkill = new Map<string, string>();
  const seenOptionalDecisionIds = new Set<string>();
  const unavailableOptionalKeys = new Set<string>();
  const decisions = isRecord(value.capability_decisions)
    ? value.capability_decisions.eligible
    : [];
  if (!Array.isArray(decisions)) {
    throw new ExecutionAuthenticityError('plan capability decisions are malformed');
  }
  for (const [decisionIndex, candidate] of decisions.entries()) {
    if (!isRecord(candidate) || !isRecord(candidate.skill)) {
      throw new ExecutionAuthenticityError(`plan capability decision ${decisionIndex + 1} is malformed`);
    }
    const skillId = candidate.skill.id;
    const requiredTools = candidate.skill.required_tools ?? [];
    const declaredOptionalTools = candidate.skill.optional_tools ?? [];
    const optionalDecisions = candidate.optional_tool_decisions ?? [];
    if (
      typeof skillId !== 'string'
      || !skillId.trim()
      || frozenSkillToolRoles.has(skillId)
      || !Array.isArray(requiredTools)
      || !requiredTools.every((toolId): toolId is string => typeof toolId === 'string' && toolId.length > 0)
      || !Array.isArray(declaredOptionalTools)
      || !declaredOptionalTools.every((toolId): toolId is string => typeof toolId === 'string' && toolId.length > 0)
      || !Array.isArray(optionalDecisions)
    ) {
      throw new ExecutionAuthenticityError(`plan capability decision ${decisionIndex + 1} is malformed`);
    }
    const roles: FrozenSkillToolRoles = {
      requiredToolIds: new Set(requiredTools),
      availableOptionalToolIds: new Set<string>(),
    };
    frozenSkillToolRoles.set(skillId, roles);
    const composition = isRecord(candidate.skill.composition) ? candidate.skill.composition : null;
    if (composition && typeof composition.contribution_adapter === 'string') {
      contributionAdapterBySkill.set(skillId, composition.contribution_adapter);
    }
    for (const optionalDecision of optionalDecisions) {
      if (
        !isRecord(optionalDecision)
        || typeof optionalDecision.tool_id !== 'string'
        || !declaredOptionalTools.includes(optionalDecision.tool_id)
        || (optionalDecision.status !== 'available' && optionalDecision.status !== 'unavailable')
      ) {
        throw new ExecutionAuthenticityError(`plan optional tool decision ${decisionIndex + 1} is malformed`);
      }
      if (seenOptionalDecisionIds.has(optionalDecision.tool_id)) {
        throw new ExecutionAuthenticityError(`plan optional tool ${optionalDecision.tool_id} is duplicated`);
      }
      seenOptionalDecisionIds.add(optionalDecision.tool_id);
      if (optionalDecision.status === 'available') {
        roles.availableOptionalToolIds.add(optionalDecision.tool_id);
        continue;
      }
      if (typeof optionalDecision.reason_code !== 'string') {
        throw new ExecutionAuthenticityError(`plan optional tool ${optionalDecision.tool_id} has no reason`);
      }
      unavailableOptionalKeys.add(`${optionalDecision.tool_id}\u0000${optionalDecision.reason_code}`);
    }
  }
  const optionalToolStepNos = new Set<number>();
  for (const toolStep of steps) {
    if (toolStep.actor_type !== 'tool') continue;
    let requiredByActualSkill = false;
    const optionalOwnerStepNos = new Set<number>();
    for (const skillStep of steps) {
      if (skillStep.actor_type !== 'skill' || skillStep.step_no <= toolStep.step_no) continue;
      const roles = frozenSkillToolRoles.get(skillStep.actor_id);
      if (!roles) continue;
      if (roles.requiredToolIds.has(toolStep.actor_id)) requiredByActualSkill = true;
      if (
        roles.availableOptionalToolIds.has(toolStep.actor_id)
        && skillStep.depends_on.includes(toolStep.step_no)
      ) {
        optionalOwnerStepNos.add(skillStep.step_no);
      }
    }
    if (!requiredByActualSkill && optionalOwnerStepNos.size === 1) {
      optionalToolStepNos.add(toolStep.step_no);
    }
  }
  const nativeNeedsBinding = new Set(nativePlan?.skill_invocations.flatMap(({ run_spec }) => (
    run_spec.tool_bindings
      .filter(({ status }) => status === 'needs_binding')
      .map(({ toolId }) => toolId)
  )) ?? []);
  const rawCapabilityGaps = value.capability_gaps ?? [];
  if (!Array.isArray(rawCapabilityGaps)) {
    throw new ExecutionAuthenticityError('plan capability gaps are malformed');
  }
  const capabilityGaps = rawCapabilityGaps.map((candidate, index): ExecutionGap => {
    if (
      !isRecord(candidate)
      || candidate.capability_type !== 'tool'
      || typeof candidate.capability_id !== 'string'
      || typeof candidate.code !== 'string'
      || typeof candidate.message !== 'string'
      || !candidate.message.trim()
    ) {
      throw new ExecutionAuthenticityError(`plan capability gap ${index + 1} is malformed`);
    }
    const decisionKey = `${candidate.capability_id}\u0000${candidate.code}`;
    if (!unavailableOptionalKeys.delete(decisionKey) && !nativeNeedsBinding.has(candidate.capability_id)) {
      throw new ExecutionAuthenticityError(`plan capability gap ${candidate.capability_id} has no decision`);
    }
    return {
      key: `capability:${candidate.capability_id}:${candidate.code}`,
      stepNo: 0,
      message: redactString(`Optional capability ${candidate.capability_id}: ${candidate.message}`),
    };
  });
  if (unavailableOptionalKeys.size > 0) {
    throw new ExecutionAuthenticityError('plan optional tool decision has no capability gap');
  }
  const resourceGaps: ExecutionGap[] = [];
  const frozenSkillExecutions = new Map<number, FrozenSkillExecutionBinding>();
  const invocationPoliciesByStep = new Map<number, InvocationExecutionPolicy[]>();
  const invocationPoliciesById = new Map<string, InvocationExecutionPolicy>();
  const optionalInvocationStepNos = new Set<number>();
  const nativeRunSpecsByStep = new Map<number, {
    invocationId: string;
    runSpec: NativeSkillRunSpec;
  }>();
  const rawInvocations = value.skill_invocations ?? [];
  if (!Array.isArray(rawInvocations)) {
    throw new ExecutionAuthenticityError('plan Skill invocations are malformed');
  }
  const portfolioPlan = value.execution_contract_version === 'current-execution-plan-v3';
  for (const [invocationIndex, invocation] of rawInvocations.entries()) {
    if (
      !isRecord(invocation)
      || typeof invocation.invocation_id !== 'string'
      || typeof invocation.skill_id !== 'string'
      || !Array.isArray(invocation.step_nos)
      || !invocation.step_nos.every((candidate) => Number.isInteger(candidate))
    ) throw new ExecutionAuthenticityError(`plan Skill invocation ${invocationIndex + 1} is malformed`);

    if (nativePlan) {
      const frozen = nativePlan.skill_invocations[invocationIndex];
      if (!frozen || frozen.invocation_id !== invocation.invocation_id || frozen.skill_id !== invocation.skill_id) {
        throw new ExecutionAuthenticityError(`native Skill invocation ${invocationIndex + 1} drifted`);
      }
      const policy: InvocationExecutionPolicy = {
        invocationId: frozen.invocation_id,
        skillId: frozen.skill_id,
        role: 'contributor',
        contributionTypes: [],
        questionIds: [],
        requestedArtifactTypes: [],
        dependsOnInvocationIds: [...frozen.depends_on_invocation_ids],
        required: frozen.required,
        failurePolicy: frozen.failure_policy,
      };
      if (invocationPoliciesById.has(policy.invocationId)) {
        throw new ExecutionAuthenticityError(`plan Skill invocation ${policy.invocationId} is duplicated`);
      }
      invocationPoliciesById.set(policy.invocationId, policy);
      let outputStepNo: number | undefined;
      for (const candidateStepNo of frozen.step_nos) {
        const invocationStep = steps.find(({ step_no }) => step_no === candidateStepNo);
        if (!invocationStep) {
          throw new ExecutionAuthenticityError(`native Skill invocation ${policy.invocationId} references a missing step`);
        }
        const policies = invocationPoliciesByStep.get(candidateStepNo) ?? [];
        policies.push(policy);
        invocationPoliciesByStep.set(candidateStepNo, policies);
        if (invocationStep.actor_type === 'skill' && invocationStep.actor_id === frozen.skill_id) {
          outputStepNo = candidateStepNo;
        }
      }
      if (outputStepNo === undefined) {
        throw new ExecutionAuthenticityError(`native Skill invocation ${policy.invocationId} has no output step`);
      }
      nativeRunSpecsByStep.set(outputStepNo, {
        invocationId: frozen.invocation_id,
        runSpec: frozen.run_spec,
      });
      continue;
    }

    if (portfolioPlan) {
      if (
        (invocation.role !== 'contributor' && invocation.role !== 'synthesizer')
        || !Array.isArray(invocation.contribution_types)
        || !invocation.contribution_types.every((type) => typeof type === 'string')
        || !Array.isArray(invocation.question_ids)
        || !invocation.question_ids.every((questionId) => typeof questionId === 'string')
        || !Array.isArray(invocation.requested_artifact_types)
        || !invocation.requested_artifact_types.every((artifact) => typeof artifact === 'string')
        || !Array.isArray(invocation.depends_on_invocation_ids)
        || !invocation.depends_on_invocation_ids.every((dependency) => typeof dependency === 'string')
        || typeof invocation.required !== 'boolean'
        || (invocation.failure_policy !== 'block' && invocation.failure_policy !== 'gap')
      ) throw new ExecutionAuthenticityError(`plan Skill invocation ${invocationIndex + 1} policy is malformed`);
      const contributionAdapterId = contributionAdapterBySkill.get(invocation.skill_id);
      if (invocation.role === 'contributor' && !contributionAdapterId) {
        throw new ExecutionAuthenticityError(`Contributor ${invocation.invocation_id} has no frozen adapter`);
      }
      const policy: InvocationExecutionPolicy = {
        invocationId: invocation.invocation_id,
        skillId: invocation.skill_id,
        role: invocation.role,
        contributionTypes: invocation.contribution_types as ContributionType[],
        questionIds: invocation.question_ids as string[],
        requestedArtifactTypes: invocation.requested_artifact_types as RequestedArtifact[],
        dependsOnInvocationIds: invocation.depends_on_invocation_ids as string[],
        required: invocation.required,
        failurePolicy: invocation.failure_policy,
        ...(contributionAdapterId ? { contributionAdapterId } : {}),
      };
      if (invocationPoliciesById.has(policy.invocationId)) {
        throw new ExecutionAuthenticityError(`plan Skill invocation ${policy.invocationId} is duplicated`);
      }
      invocationPoliciesById.set(policy.invocationId, policy);
      for (const candidateStepNo of invocation.step_nos) {
        const policies = invocationPoliciesByStep.get(candidateStepNo as number) ?? [];
        policies.push(policy);
        invocationPoliciesByStep.set(candidateStepNo as number, policies);
      }
    }

    const compiledInvocation = invocation.execution_mode === 'compiled'
      || (!portfolioPlan && invocation.execution_mode === undefined);
    const resourceGapRows = invocation.resource_gaps ?? [];
    if (!Array.isArray(resourceGapRows)) {
      throw new ExecutionAuthenticityError(`plan Skill invocation ${invocationIndex + 1} resource gaps are malformed`);
    }
    if (compiledInvocation) {
      if (
        typeof invocation.contract_hash !== 'string'
        || (invocation.degraded_policy !== 'gap' && invocation.degraded_policy !== 'block')
        || !Array.isArray(invocation.skill_reference_hashes)
        || !invocation.skill_reference_hashes.every((reference) => (
          isRecord(reference) && typeof reference.path === 'string' && typeof reference.hash === 'string'
        ))
      ) throw new ExecutionAuthenticityError(`plan Skill invocation ${invocationIndex + 1} contract is malformed`);
      for (const candidateStepNo of invocation.step_nos) {
        const invocationStep = steps.find(({ step_no }) => step_no === candidateStepNo);
        if (invocationStep?.actor_type !== 'skill') continue;
        frozenSkillExecutions.set(candidateStepNo as number, {
          contractHash: invocation.contract_hash,
          referenceHashes: invocation.skill_reference_hashes.map((reference) => ({
            path: String((reference as Record<string, unknown>).path),
            hash: String((reference as Record<string, unknown>).hash),
          })),
          degradedPolicy: invocation.degraded_policy,
        });
      }
    } else if (invocation.execution_mode !== 'legacy_single_call') {
      throw new ExecutionAuthenticityError(`plan Skill invocation ${invocationIndex + 1} execution mode is malformed`);
    }

    const stepNo = steps.find((step) => (
      step.skill_invocation_id === invocation.invocation_id && step.actor_type === 'knowledge'
    ))?.step_no ?? invocation.step_nos.find((candidate): candidate is number => Number.isInteger(candidate)) ?? 0;
    for (const [gapIndex, gap] of resourceGapRows.entries()) {
      if (
        !isRecord(gap)
        || typeof gap.query_id !== 'string'
        || !Number.isInteger(gap.min_items)
        || !Number.isInteger(gap.selected_items)
        || gap.failure_policy !== 'gap'
        || typeof gap.reason !== 'string'
        || !gap.reason.trim()
      ) throw new ExecutionAuthenticityError(`plan Skill resource gap ${invocationIndex + 1}.${gapIndex + 1} is malformed`);
      resourceGaps.push({
        key: `skill:${invocation.invocation_id}:resource:${gap.query_id}`,
        stepNo,
        message: redactString(`Skill resource gap ${gap.query_id}: ${gap.reason}`),
      });
    }
  }
  for (const [stepNo, policies] of invocationPoliciesByStep) {
    if (policies.length > 0 && policies.every(({ failurePolicy }) => failurePolicy === 'gap')) {
      optionalInvocationStepNos.add(stepNo);
    }
  }
  return {
    taskId,
    evidence_requirements: evidenceRequirements,
    steps,
    optionalToolStepNos,
    capabilityGaps: [...capabilityGaps, ...resourceGaps],
    frozenSkillExecutions,
    invocationPoliciesByStep,
    invocationPoliciesById,
    optionalInvocationStepNos,
    ...(nativePlan
      ? {
          native: {
            mode: nativePlan.mode,
            runSpecsByStep: nativeRunSpecsByStep,
            finalReportPolicy: nativePlan.final_report_policy,
            resolvedInputs: nativePlan.resolved_inputs,
          },
        }
      : {}),
  };
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
  try {
    return parsePendingInputContracts(value);
  } catch (error) {
    throw new ExecutionAuthenticityError(
      error instanceof PendingInputContractError
        ? error.message
        : 'active plan pending inputs are malformed',
    );
  }
}

export function datasetEvidenceEntries(
  datasets: readonly ResolvedDatasetInput[],
): EvidenceEntry[] {
  return datasets.flatMap((dataset) => {
    const contentSha256 = dataset.artifact.contentSha256;
    if (!contentSha256) {
      throw new ExecutionAuthenticityError(`Dataset ${dataset.gateKey} profile hash is missing`);
    }
    return [{
      id: `dataset:${dataset.gateKey}:profile`,
      kind: 'dataset' as const,
      evidenceClass: 'dataset' as const,
      artifactId: dataset.artifact.id,
      artifactContentSha256: contentSha256,
      jsonPointer: '/columnProfiles',
      sensitivity: dataset.artifact.sensitivity === 'public' ? 'public' as const : 'internal' as const,
      redaction: 'none' as const,
    }, ...dataset.profile.rows.map((row) => ({
      id: row.evidenceId,
      kind: 'dataset' as const,
      evidenceClass: 'dataset' as const,
      artifactId: dataset.artifact.id,
      artifactContentSha256: contentSha256,
      jsonPointer: `/rows/${row.index}/values`,
      sensitivity: dataset.artifact.sensitivity === 'public' ? 'public' as const : 'internal' as const,
      redaction: 'none' as const,
    }))];
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
    const pendingState = plan.native?.resolvedInputs.pending
      .find(({ requirement }) => requirement.key === pendingInput.role);
    const pendingRequirement = pendingState?.requirement;
    if (gate.decision === 'waived') {
      if (
        gate.requiredAuthority !== 'owner'
        || gate.actorRole !== 'owner'
        || gate.actorUserId !== ownerUserId
        || !pendingRequirement
        || pendingRequirement.required
        || !isRecord(gate.value)
      ) {
        throw new ExecutionAuthenticityError(`waived input gate for ${pendingInput.role} is invalid`);
      }
      const reason = gate.value.reason;
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new ExecutionAuthenticityError(`waived input gate for ${pendingInput.role} has no reason`);
      }
      plan.native!.resolvedInputs.pending = plan.native!.resolvedInputs.pending
        .filter(({ requirement }) => requirement.key !== pendingInput.role);
      plan.native!.resolvedInputs.waived.push({
        key: pendingInput.role,
        targetInvocationIds: [...pendingState!.targetInvocationIds],
        reason,
      });
      for (const target of pendingInput.targets) {
        const step = plan.steps.find((candidate) => candidate.step_no === target.step_no);
        if (!step || step.actor_id !== target.tool_id || !Object.hasOwn(step.input, target.field)) {
          throw new ExecutionAuthenticityError(
            `pending input target ${target.step_no}/${target.field} does not match the active plan`,
          );
        }
        step.input[target.field] = null;
      }
      continue;
    }
    if (
      gate.requiredAuthority !== 'owner'
      || gate.decision !== 'provided'
      || gate.actorRole !== 'owner'
      || gate.actorUserId !== ownerUserId
      || !Object.hasOwn(gate, 'value')
    ) {
      throw new ExecutionAuthenticityError(`input gate for pending role ${pendingInput.role} is invalid`);
    }
    if (plan.native && pendingState) {
      plan.native.resolvedInputs.pending = plan.native.resolvedInputs.pending
        .filter(({ requirement }) => requirement.key !== pendingInput.role);
      plan.native.resolvedInputs.resolved.push({
        key: pendingInput.role,
        valueRef: typeof gate.evidenceRef === 'string'
          ? gate.evidenceRef
          : `gate:${pendingInput.role}`,
        source: typeof gate.evidenceRef === 'string' ? 'upload' : 'conversation',
        targetInvocationIds: [...pendingState.targetInvocationIds],
      });
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
      step.input[target.field] = valueForPendingInputTarget({
        value: gate.value,
        pendingMultiple: pendingInput.multiple,
        targetMultiple: target.multiple,
      });
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


export function rebindReusableArtifactValue(
  kind: StepArtifactKind,
  value: unknown,
  binding: Pick<ControlExecutionLease, 'taskId' | 'planVersionId' | 'attemptId'>,
): unknown {
  if (kind !== 'research_contribution') return value;
  if (
    !isRecord(value)
    || value.version !== 'research-contribution-artifact-v1'
    || !isRecord(value.contribution)
  ) {
    throw new ExecutionAuthenticityError('reusable Contribution Artifact is malformed');
  }
  return {
    ...structuredClone(value),
    contribution: {
      ...structuredClone(value.contribution),
      taskId: binding.taskId,
      planVersionId: binding.planVersionId,
      attemptId: binding.attemptId,
    },
  };
}

function contributionEvidenceView(input: {
  lease: ControlExecutionLease;
  adapterId: string;
  source?: EngineSealedStepOutput;
}): EvidenceManifest {
  const entries: EvidenceEntry[] = [];
  if (
    input.adapterId === VIRTUAL_USER_TOOL_ADAPTER_ID
    && input.source
    && input.source.actorId === 'virtual-user-lab'
    && isRecord(input.source.output)
    && Array.isArray(input.source.output.reviews)
    && input.source.artifact.contentSha256
  ) {
    entries.push(...virtualUserSimulationEvidence({
      stepNo: input.source.stepNo,
      artifactId: input.source.artifact.id,
      artifactContentSha256: input.source.artifact.contentSha256,
      output: input.source.output,
    }));
  }
  const draft = {
    version: 'evidence-v1' as const,
    taskId: input.lease.taskId,
    planVersionId: input.lease.planVersionId,
    attemptId: input.lease.attemptId,
    collectedAt: '1970-01-01T00:00:00.000Z',
    entries,
  };
  return { ...draft, manifestHash: stableJsonHash(draft) };
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
  evidenceIds?: string[];
}> {
  const allowed = step
    ? new Set([
        ...step.depends_on,
        ...step.input_bindings.map((binding) => binding.source_step_no),
      ])
    : null;
  return [...outputs]
    .filter(({ stepNo }) => allowed === null || allowed.has(stepNo))
    .sort((left, right) => left.stepNo - right.stepNo)
    .map(({ stepNo, actorId, kind, output, artifact }) => {
      const value = isRecord(output) ? output : null;
      const evidenceIds = kind === 'tool_output' && actorId === 'joyspace-read'
        ? (isRecord(value?.document) || isRecord(value?.viewedDocument) ? [`JV${stepNo}-1`] : [])
        : kind === 'tool_output'
        ? sourceRefs(value)
          .filter(({ sourceUrl }) => sourceUrl.startsWith('https://'))
          .map(({ originalIndex }) => `E${stepNo}-${originalIndex + 1}`)
        : kind === 'knowledge_output' && Array.isArray(value?.resources)
          ? value.resources.flatMap((resource, index) => (
              isRecord(resource)
              && typeof resource.id === 'string'
              && typeof resource.contentHash === 'string'
                ? [`K${stepNo}-${index + 1}`]
                : []
            ))
          : [];
      return {
        stepNo,
        actorId,
        kind,
        output,
        artifact,
        ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
      };
    });
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

function modelStepExecution(input: {
  step: EngineStep;
  researchGoal: string;
  resolvedInput: Record<string, unknown>;
  outputs: EngineSealedStepOutput[];
}): {
  prompt: string;
  context: Record<string, unknown>;
  schemaName?: string;
  executionPromptHash: string;
  contextManifestHash: string;
  outputSchemaHash: string | null;
  inputArtifacts: Array<{ stepNo: number; artifactId: string; contentSha256: string }>;
} {
  const context = {
    research_goal: input.researchGoal,
    input: input.resolvedInput,
    prior_outputs: verifiedPriorOutputs(input.outputs, input.step),
    ...stepContract(input.step),
  };
  if (input.step.actor_type === 'llm') {
    const prompt = `Execute plan step: ${input.step.step_name}. ${input.step.purpose ?? ''}\nContract: ${JSON.stringify(stepContract(input.step))}\nEvidence IDs listed in prior_outputs[].evidenceIds are the exact runtime-issued IDs for those outputs. When such a list is present, cite only IDs from it; never infer an ID from an unaddressable result. IDs carried forward in bound upstream analysis remain candidates and will be verified against the final Evidence Manifest.`;
    return {
      prompt,
      context,
      executionPromptHash: hashPrompt(prompt, context),
      contextManifestHash: hashJson(context),
      outputSchemaHash: null,
      inputArtifacts: executionInputArtifacts(input.outputs, input.step),
    };
  }
  if (input.step.actor_type === 'reviewer') {
    const prompt = `Review completed outputs for source support and gaps: ${input.step.step_name}. Return one reviewer-step-output-v1 object. Use verdict=pass with an empty conditions array only when no condition remains. Every limitation, unresolved question, lower-confidence dependency, requested revision, or delivery condition must be a separate conditions item, even when its wording does not contain words such as risk, gap, or missing. Contract: ${JSON.stringify(stepContract(input.step))}`;
    const schemaName = 'reviewer-step-output';
    return {
      prompt,
      context,
      schemaName,
      executionPromptHash: hashPrompt(prompt, context, schemaName),
      contextManifestHash: hashJson(context),
      outputSchemaHash: hashJson(REVIEWER_STEP_OUTPUT_SCHEMA),
      inputArtifacts: executionInputArtifacts(input.outputs, input.step),
    };
  }
  throw new Error(`step ${input.step.step_no} is not a model step`);
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
  const details = isRecord(error.details) ? error.details : {};
  error.details = {
    ...details,
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

export function failureFrom(error: unknown): Record<string, unknown> {
  if (error instanceof ArtifactInvalidationError) {
    return {
      kind: 'artifact_invalidation',
      retryable: false,
      message: error.message,
      failedArtifactIds: [...error.failedArtifactIds],
    };
  }
  if (error instanceof ToolInvocationError) {
    return {
      ...error.details,
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
      receipt: error.receipt,
    };
  }
  if (error instanceof SkillOutputSchemaError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
      schemaErrors: [...error.schemaErrors],
      repairAttempts: error.repairAttempts,
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
  if (error instanceof CompiledSkillPlanDriftError || error instanceof SkillRuntimeDriftError) {
    return {
      kind: 'skill_contract_drift',
      retryable: false,
      requiresReplan: true,
      allowedActions: ['replan', 'abort'],
      message: error.message,
    };
  }
  if (error instanceof SkillDegradedPolicyError) {
    return {
      kind: 'skill_degraded_blocked',
      retryable: false,
      message: error.message,
    };
  }
  if (error instanceof RequiredKnowledgeUnavailableError) {
    const drift = error.code !== 'missing';
    return {
      kind: drift ? 'knowledge_configuration_drift' : 'required_knowledge_unavailable',
      retryable: !drift,
      resourceId: error.resourceId,
      knowledgeFailureCode: error.code,
      requiresReplan: drift,
      allowedActions: drift ? ['replan', 'abort'] : ['retry', 'abort'],
      message: error.message,
    };
  }
  if (error instanceof ExecutionSafetyError) {
    return { kind: 'safety', retryable: false, message: error.message };
  }
  if (error instanceof ExecutionStepPersistenceError && error.leaseLost) {
    return { kind: 'lease_lost', retryable: true, message: error.message };
  }
  if (error instanceof ControlPlaneConflictError) {
    return { kind: 'lease_lost', retryable: true, message: error.message, ...detailsFrom(error) };
  }
  if (error instanceof ExecutionAuthenticityError) {
    return { kind: 'authenticity', retryable: false, message: error.message, ...error.details };
  }
  if (error instanceof ArtifactIntegrityError || error instanceof ChartSpecValidationError) {
    return { kind: 'authenticity', retryable: false, message: error.message };
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
  if (error instanceof NativeReportError) {
    return {
      kind: 'schema',
      retryable: true,
      allowedActions: ['retry', 'abort'],
      message: error.message,
    };
  }
  return {
    kind: 'capability',
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function failedArtifactIdsFrom(
  failure: Record<string, unknown>,
  cleanupFailure: unknown,
  fallbackArtifactIds: string[],
): string[] {
  const current = Array.isArray(failure.failedArtifactIds)
    ? failure.failedArtifactIds.filter((id): id is string => typeof id === 'string')
    : [];
  const cleanup = cleanupFailure instanceof ArtifactInvalidationError
    ? cleanupFailure.failedArtifactIds
    : [];
  const merged = [...new Set([...current, ...cleanup])];
  return merged.length > 0 ? merged : [...new Set(fallbackArtifactIds)];
}

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof ExecutionAuthenticityError
    || error instanceof ArtifactIntegrityError
    || error instanceof ChartSpecValidationError
    || error instanceof ModelDriftError
    || error instanceof MissingModelReceiptError;
}

function deliverableFailureFrom(error: unknown): Record<string, unknown> {
  if (
    error instanceof ArtifactInvalidationError
    || error instanceof LLMInvocationError
    || error instanceof ControlPlaneConflictError
    || isIntegrityFailure(error)
  ) {
    return failureFrom(error);
  }
  const draftPreview = isRecord(error) && isRecord(error.draftPreview)
    ? redactSensitiveValue(error.draftPreview)
    : undefined;
  return {
    kind: 'deliverable_validation',
    retryable: true,
    message: error instanceof CurrentReportValidationError
      ? error.message
      : error instanceof Error ? error.message : String(error),
    ...(draftPreview ? { draftPreview } : {}),
  };
}

export class LeaseExecutionEngine {
  private readonly llm: ReceiptLLMClient;
  private readonly visualInputGates: Pick<VisualInputGateStore, 'resolve'>;
  private readonly datasetInputGates: Pick<DatasetInputGateStore, 'resolve'>;

  constructor(private readonly dependencies: {
    repository: ControlPlaneRepository;
    artifacts: ControlArtifactStore;
    tools: ToolRouter;
    llm: LLMClient;
    skillLoader: SkillLoader;
    contributionAdapters?: ContributionAdapterRegistry;
    validator: SchemaValidator;
    heartbeatMs: number;
    toolExecutionDeadlineMs?: number;
    deliverables: {
      generate(input: CurrentDeliverableGenerateInput): Promise<CurrentDeliverableGenerateResult>;
      revise?(input: CurrentDeliverableRevisionInput): Promise<CurrentDeliverableGenerateResult>;
    };
    reportReview?: {
      review(input: ReportReviewInput, composer?: DeliverableComposer): Promise<ReportReviewResult>;
    };
    reportComposition?: ReportCompositionPort;
    reportEditorialExperienceV1Enabled?: boolean;
    standaloneHtmlBundleV1Enabled?: boolean;
    chartRenderer?: typeof renderAndSealChartSvg;
    scheduler?: ExecutionScheduler;
    visualInputMaterializer?: {
      materialize(input: {
        lease: ControlExecutionLease;
        visuals: ResolvedVisualInput[];
        annotationPurpose?: 'input_provenance';
      }): Promise<MaterializedVisualOriginal[] | void>;
      annotateDesignFindings?(input: {
        lease: ControlExecutionLease;
        original: MaterializedVisualOriginal;
        findings: FindingBoundVisualAnnotation[];
      }): Promise<void>;
    };
    visualInputGates?: Pick<VisualInputGateStore, 'resolve'>;
    datasetInputGates?: Pick<DatasetInputGateStore, 'resolve'>;
  }) {
    this.llm = new ReceiptLLMClient(dependencies.llm, dependencies.repository);
    this.visualInputGates = dependencies.visualInputGates
      ?? new VisualInputGateStore(dependencies.artifacts);
    this.datasetInputGates = dependencies.datasetInputGates
      ?? new DatasetInputGateStore(dependencies.artifacts);
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
    let materializedVisualOriginals: MaterializedVisualOriginal[] = [];
    let resolvedDatasets: ResolvedDatasetInput[] = [];
    try {
      const gates = await this.dependencies.repository.listGateRecords(
        input.lease.taskId,
        input.lease.planVersionId,
      );
      const deliverableContract = resolvePlanDeliverableContract(task.structuredTask, planVersion.plan);
      if (isNativeSkillExecutionPlanV1(planVersion.plan)) {
        const nativePlan = parseNativeSkillExecutionPlanV1(planVersion.plan);
        if (nativePlan.task_id !== task.id || nativePlan.mode !== task.orchestrationMode) {
          throw new ExecutionAuthenticityError('native Plan task or mode binding is invalid');
        }
      } else if (isRecord(planVersion.plan) && planVersion.plan.execution_contract_version === 'current-execution-plan-v2') {
        assertCompiledSkillPlan(
          planVersion.plan as unknown as CurrentExecutionPlan,
          this.dependencies.skillLoader,
          task.structuredTask as ResearchTaskV2,
        );
      } else if (isRecord(planVersion.plan) && planVersion.plan.execution_contract_version === 'current-execution-plan-v3') {
        validateCurrentExecutionPlanV3(
          planVersion.plan as unknown as CurrentExecutionPlanV3,
          this.dependencies.validator,
        );
        assertCompiledPortfolioPlan(
          planVersion.plan as unknown as CurrentExecutionPlanV3,
          this.dependencies.skillLoader,
        );
      }
      deliverableId = deliverableContract.entry.id;
      const parsedPlan = parseExecutionPlan(task.id, planVersion.plan, deliverableContract);
      const pendingInputs = parsePendingInputs(planVersion.pendingInputs);
      const resolvedVisualInputs = await this.visualInputGates.resolve({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        gates,
        pendingInputs,
      });
      const resolvedDatasetInputs = await this.datasetInputGates.resolve({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        ownerUserId: task.ownerUserId,
        gates: resolvedVisualInputs.gates,
        pendingInputs,
      });
      resolvedDatasets = resolvedDatasetInputs.datasets;
      plan = overlayPendingInputs(parsedPlan, pendingInputs, resolvedDatasetInputs.gates, task.ownerUserId);
      if (this.dependencies.visualInputMaterializer) {
        const materializer = this.dependencies.visualInputMaterializer;
        const materialized = await this.withLeaseHeartbeat(input.lease, () => materializer.materialize({
          lease: input.lease,
          visuals: resolvedVisualInputs.visuals,
          ...(deliverableId === 'competitive_analysis_report'
            ? { annotationPurpose: 'input_provenance' as const }
            : {}),
        }));
        materializedVisualOriginals = materialized ?? [];
      }
      if (
        deliverableId === 'design_audit_report'
        && (
          !this.dependencies.visualInputMaterializer?.annotateDesignFindings
          || materializedVisualOriginals.length !== 1
        )
      ) {
        throw new ExecutionAuthenticityError(
          'design audit requires exactly one materialized original and a finding-bound annotation producer',
        );
      }
      if (this.dependencies.reportReview) {
        reviewCoverage = parseReviewCoverageIds(task.structuredTask, planVersion.plan);
      }
    } catch (error) {
      const failure = failureFrom(error);
      failure.allowedActions = failure.requiresReplan === true
        ? ['replan', 'abort']
        : failure.retryable === true ? ['retry', 'abort'] : ['abort'];
      await this.recordFailedExecutionStep({
        ...input.lease,
        stepNo: 1,
        stepName: 'execution preflight',
        actorType: 'system',
        actorId: 'preflight',
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
          reason: String(failure.kind ?? 'authenticity'),
        });
      } catch (pauseError) {
        if (!(pauseError instanceof ControlPlaneConflictError)) throw pauseError;
      }
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
        ...input.lease,
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
    const reusable = await this.loadReusableExecutions(
      input.lease,
      plan,
      planVersion.planHash,
      researchGoal,
      deliverableId,
      input.expectedModel,
    );
    const outputs: EngineSealedStepOutput[] = [];
    const resolvedArtifacts = new Map<string, ResolvedEvidenceArtifact>();
    for (const dataset of resolvedDatasets) {
      if (!dataset.artifact.contentSha256) {
        throw new ExecutionAuthenticityError(`Dataset ${dataset.gateKey} profile hash is missing`);
      }
      resolvedArtifacts.set(dataset.artifact.id, {
        artifact: {
          id: dataset.artifact.id,
          contentSha256: dataset.artifact.contentSha256,
        },
        value: dataset.profile,
      });
    }
    const visualAssetService = new VisualAssetService({ artifacts: this.dependencies.artifacts });
    const committedBrowserCaptures: CommittedBrowserCapture[] = [];
    const committedKnowledgeSnapshots: JoyspaceKnowledgeSnapshotPublication[] = [];
    const gaps = new Map<string, ExecutionGap>(
      plan.capabilityGaps.map((gap) => [gap.key, gap]),
    );
    const addGap = (gap: ExecutionGap): void => {
      if (!gaps.has(gap.key)) gaps.set(gap.key, gap);
    };
    const stepByKey = new Map(plan.steps.map((step) => [String(step.step_no), step]));
    const skippedInvocationIds = new Set<string>();
    let wavePaused: LeaseExecutionResult | undefined;
    let cleanupRecoveryRequired = false;
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
        tier: (step.actor_type === 'tool' && plan.optionalToolStepNos.has(step.step_no))
          || plan.optionalInvocationStepNos.has(step.step_no)
          ? 'optional'
          : 'core',
      })),
    }, {});

    for (const wave of schedule.waves) {
      const waveResults = await Promise.allSettled(wave.map(async (stepKey) => {
        const step = stepByKey.get(stepKey);
        if (!step) throw new ExecutionAuthenticityError(`scheduler returned unknown step ${stepKey}`);
        const invocationPolicies = plan.invocationPoliciesByStep.get(step.step_no) ?? [];
        const skippedInvocation = invocationPolicies.find(({ invocationId }) => (
          skippedInvocationIds.has(invocationId)
        ));
        if (skippedInvocation && invocationPolicies.every(({ failurePolicy }) => failurePolicy === 'gap')) {
          const now = new Date();
          const failure = {
            kind: 'optional_contributor_skipped',
            retryable: true,
            message: `optional Contributor ${skippedInvocation.invocationId} was skipped after an earlier stage failed`,
            invocationId: skippedInvocation.invocationId,
            allowedActions: ['retry', 'abort'],
          };
          await this.dependencies.repository.recordExecutionStep({
            ...input.lease,
            stepNo: step.step_no,
            stepName: step.step_name,
            actorType: step.actor_type,
            actorId: step.actor_id,
            state: 'skipped',
            failure,
            startedAt: now,
            finishedAt: now,
          });
          addGap({
            key: `invocation:${skippedInvocation.invocationId}:step:${step.step_no}:skipped`,
            stepNo: step.step_no,
            message: redactString(failure.message),
          });
          return;
        }
        const startedAt = new Date();
        let resolvedInput = structuredClone(step.input);
        let producedSkillOutputHash: string | undefined;
        let preparedSkillFingerprint: SkillExecutionFingerprint | undefined;
        let toolAttemptReceipts: ToolRetryAttemptReceipt[] | undefined;
        let actorResult: StepResult | undefined;
        let skillOutcome: SkillOutputOutcome | null = null;
        let unpublishedArtifactId: string | undefined;
        let publicationGroup: ArtifactPublicationGroup | undefined;
        const pendingBrowserCaptures: CommittedBrowserCapture[] = [];
        const pendingKnowledgeSnapshots: JoyspaceKnowledgeSnapshotPublication[] = [];
        let toolScope: ToolExecutionScope | undefined;
        let toolHeartbeat: LeaseHeartbeatHandle | undefined;
        let skillDegradedPolicy: 'gap' | 'block' | undefined;
        let frozenSkillExecution: FrozenSkillExecutionBinding | undefined;
        const nativeSkill = plan.native?.runSpecsByStep.get(step.step_no);
        const nativeResolvedInputs = plan.native?.resolvedInputs;
        try {
          frozenSkillExecution = plan.frozenSkillExecutions.get(step.step_no);
          const nativePolicy = nativeSkill
            ? (plan.invocationPoliciesByStep.get(step.step_no) ?? [])
                .find(({ invocationId }) => invocationId === nativeSkill.invocationId)
            : undefined;
          skillDegradedPolicy = nativePolicy?.failurePolicy
            ?? frozenSkillExecution?.degradedPolicy;
          const checkpoint = reusable.get(step.step_no);
          if (checkpoint) {
            active = await this.refreshLease(input.lease);
            const priorArtifact = await this.dependencies.repository.getArtifact(checkpoint.outputArtifactId);
            if (!priorArtifact || priorArtifact.state !== 'SEALED' || !priorArtifact.contentSha256) {
              throw new ExecutionAuthenticityError(`reusable step Artifact ${checkpoint.outputArtifactId} is unavailable`);
            }
            const reusableArtifactValue = rebindReusableArtifactValue(
              checkpoint.kind,
              checkpoint.artifactValue,
              input.lease,
            );
            if (checkpoint.kind === 'research_contribution') {
              this.dependencies.validator.validateOrThrow(
                'research-contribution-artifact-v1',
                reusableArtifactValue,
              );
            }
            const reusableNativeResult = checkpoint.kind === 'skill_result'
              ? await new NativeReportArtifactService(this.dependencies.artifacts).sealSkillResult({
                  activeLease: input.lease,
                  result: parseNativeSkillResult(reusableArtifactValue),
                })
              : undefined;
            const resealed = reusableNativeResult?.jsonArtifact
              ?? await this.dependencies.artifacts.writeJson({
                taskId: input.lease.taskId,
                planVersionId: input.lease.planVersionId,
                attemptId: input.lease.attemptId,
                kind: checkpoint.kind,
                relativePath: `steps/${step.step_no}-${checkpoint.kind}.json`,
                value: reusableArtifactValue,
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
            unpublishedArtifactId = resealed.id;
            const verified = await readVerifiedStepArtifact(sealedOutput, this.dependencies.artifacts);
            let reusedSkillOutcome = step.actor_type === 'skill'
              ? nativeSkill
                ? nativeSkillOutcome(verified.output)
                : evaluateSkillOutputStatus(verified.output, skillDegradedPolicy)
              : null;
            if (
              step.actor_type === 'skill'
              && reusedSkillOutcome === null
              && checkpoint.provenance.status === 'degraded'
            ) {
              reusedSkillOutcome = {
                status: 'degraded',
                limitations: Array.isArray(checkpoint.provenance.limitations)
                  ? checkpoint.provenance.limitations.filter(
                      (value): value is string => typeof value === 'string',
                    )
                  : [],
                summary: 'Reused Skill checkpoint completed with limitations.',
              };
              if (skillDegradedPolicy === 'block') {
                throw new SkillDegradedPolicyError(reusedSkillOutcome);
              }
            }
            await this.recordSucceededExecutionStep({
              ...input.lease,
              stepNo: step.step_no,
              stepName: step.step_name,
              actorType: step.actor_type,
              actorId: step.actor_id,
              state: 'succeeded',
              outputArtifactId: resealed.id,
              ...(step.actor_type === 'tool'
                ? { toolProvenance: { ...checkpoint.provenance, outputArtifactId: resealed.id, sourceArtifactId: priorArtifact.id } }
                : {}),
              ...(step.actor_type !== 'tool'
                ? {
                    skillProvenance: {
                      ...checkpoint.provenance,
                      outputArtifactId: resealed.id,
                      ...(reusableNativeResult
                        ? { primaryArtifactId: reusableNativeResult.primaryArtifact.id }
                        : {}),
                      sourceArtifactId: priorArtifact.id,
                      status: reusedSkillOutcome?.status ?? 'succeeded',
                      ...(reusedSkillOutcome?.status === 'degraded'
                        ? { limitations: reusedSkillOutcome.limitations }
                        : {}),
                    },
                  }
                : {}),
            });
            if (reusedSkillOutcome?.status === 'degraded') {
              addGap({
                key: `step:${step.step_no}:skill:${step.actor_id}:degraded`,
                stepNo: step.step_no,
                message: skillDegradationMessage(step, reusedSkillOutcome),
              });
            }
            unpublishedArtifactId = undefined;
            outputs.push({ ...sealedOutput, output: verified.output });
            if (step.actor_type === 'tool' || step.actor_type === 'knowledge') {
              resolvedArtifacts.set(resealed.id, {
                artifact: { id: resealed.id, contentSha256: resealed.contentSha256 },
                value: verified.value,
              });
            }
            return;
          }
          active = await this.refreshLease(input.lease);
          await this.dependencies.repository.recordExecutionStep({
            ...input.lease,
            stepNo: step.step_no,
            stepName: step.step_name,
            actorType: step.actor_type,
            actorId: step.actor_id,
            state: 'running',
            startedAt,
          });
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
          const synthesizerPolicy = synthesizerPolicyForStep(plan, step);
          if (
            synthesizerPolicy
            && Array.isArray(resolvedInput.contribution_order)
            && isRecord(resolvedInput.contribution_bundle)
          ) {
            const contributionBundle = buildResearchContributionBundle({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              orderedInvocationIds: resolvedInput.contribution_order.filter(
                (invocationId): invocationId is string => typeof invocationId === 'string',
              ),
              valuesByInvocationId: resolvedInput.contribution_bundle,
              policiesByInvocationId: plan.invocationPoliciesById,
              synthesizerInvocationId: synthesizerPolicy.invocationId,
            });
            this.dependencies.validator.validateOrThrow(
              'research-contribution-bundle-v1',
              contributionBundle,
            );
            publicationGroup = new ArtifactPublicationGroup(this.dependencies.artifacts);
            const bundleArtifact = await this.dependencies.artifacts.writeJson({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              kind: 'research_contribution_bundle',
              relativePath: `steps/${step.step_no}-research-contribution-bundle.json`,
              value: contributionBundle,
              schemaVersion: 'research-contribution-bundle-v1',
              activeLease: input.lease,
            });
            publicationGroup.track(bundleArtifact.id);
            if (bundleArtifact.state !== 'SEALED' || !bundleArtifact.contentSha256) {
              throw new ExecutionAuthenticityError(
                `Contribution Bundle Artifact ${bundleArtifact.id} was not sealed`,
              );
            }
            resolvedInput = {
              ...resolvedInput,
              contribution_bundle: contributionBundle,
              contribution_bundle_artifact: {
                id: bundleArtifact.id,
                contentSha256: bundleArtifact.contentSha256,
              },
            };
          }
          if (step.actor_type === 'tool') {
            toolScope = this.createToolExecutionScope();
            toolHeartbeat = this.startLeaseHeartbeat(
              input.lease,
              () => toolScope?.abort('lease_lost'),
            );
            actorResult = await this.runStep({
              step,
              lease: input.lease,
              researchGoal,
              resolvedInput,
              outputs,
              expectedModel: input.expectedModel,
              optionalTool: plan.optionalToolStepNos.has(step.step_no),
              toolContext: toolScope.context,
              onToolLeaseLost: () => toolScope?.abort('lease_lost'),
            });
            toolScope.assertActive(step.actor_id);
            toolHeartbeat.assertHealthy();
          } else {
            actorResult = await this.withLeaseHeartbeat(input.lease, ({ signal }) => this.runStep({
              step,
              lease: input.lease,
              researchGoal,
              resolvedInput,
              outputs,
              expectedModel: input.expectedModel,
              optionalTool: false,
              frozenSkillExecution,
              nativeSkill,
              nativeResolvedInputs,
              onSkillPrepared: (fingerprint) => {
                preparedSkillFingerprint = fingerprint;
              },
              cancellationSignal: signal,
            }));
          }
          const actorOutputHash = actorResult.skillProvenance?.outputHash;
          if (typeof actorOutputHash === 'string') producedSkillOutputHash = actorOutputHash;
          toolAttemptReceipts = actorResult.toolAttemptReceipts;
          let result = sanitizeStepResult(actorResult);
          skillOutcome = step.actor_type === 'skill'
            ? nativeSkill
              ? nativeSkillOutcome(result.output)
              : evaluateSkillOutputStatus(result.output, skillDegradedPolicy)
            : null;
          const successfulPageFailureRows = step.actor_id === 'playwright-page-capture'
            && isRecord(result.output)
            ? userVisiblePageFailures(result.output)
            : [];
          const successfulPageFailures = pageFailureGaps(successfulPageFailureRows);
          const successfulGapSummary = step.actor_id === 'playwright-page-capture'
            ? pageGapSummary(
                successfulPageFailureRows,
                isRecord(result.output) ? result.output.failures : successfulPageFailureRows,
              )
            : undefined;
          const contributionPolicy = !plan.native && step.actor_type === 'skill'
            ? invocationPolicies.find(({ role, skillId }) => (
                role === 'contributor' && skillId === step.actor_id
              ))
            : undefined;
          const captureAttachments = step.actor_type === 'tool'
            ? browserCaptureAttachments(step.actor_id, result.output, result.mediaAttachments)
            : [];
          const knowledgeAttachments = step.actor_type === 'tool'
            ? joyspaceKnowledgeAttachments(step.actor_id, result.output, result.knowledgeAttachments)
            : [];
          if (captureAttachments.length > 0 || knowledgeAttachments.length > 0 || contributionPolicy) {
            publicationGroup ??= new ArtifactPublicationGroup(this.dependencies.artifacts);
          }
          if (toolScope) {
            await this.requireActiveToolLease(
              input.lease,
              step.actor_id,
              toolScope.context,
              () => toolScope?.abort('lease_lost'),
            );
          } else {
            await this.dependencies.repository.requireActiveLease(input.lease);
          }
          toolScope?.assertActive(step.actor_id);
          toolHeartbeat?.assertHealthy();
          const artifactValue = result.artifactValue ?? result.output;
          const nativePublication = result.kind === 'skill_result'
            ? await new NativeReportArtifactService(this.dependencies.artifacts).sealSkillResult({
                activeLease: input.lease,
                result: parseNativeSkillResult(artifactValue),
              })
            : undefined;
          const artifact = nativePublication?.jsonArtifact
            ?? await this.dependencies.artifacts.writeJson({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              kind: result.kind,
              relativePath: `steps/${step.step_no}-${result.kind}.json`,
              value: artifactValue,
              schemaVersion: STEP_ARTIFACT_SCHEMA_VERSIONS[result.kind],
              activeLease: input.lease,
            });
          if (nativePublication) {
            publicationGroup ??= new ArtifactPublicationGroup(this.dependencies.artifacts);
            publicationGroup
              .track(nativePublication.jsonArtifact.id)
              .track(nativePublication.primaryArtifact.id);
            for (const attachment of nativePublication.attachmentArtifacts) {
              publicationGroup.track(attachment.id);
            }
          } else if (publicationGroup) publicationGroup.track(artifact.id);
          else unpublishedArtifactId = artifact.id;
          toolScope?.assertActive(step.actor_id);
          toolHeartbeat?.assertHealthy();
          if (artifact.state !== 'SEALED' || !artifact.contentSha256) {
            throw new ExecutionAuthenticityError(`step Artifact ${artifact.id} was not sealed`);
          }
          for (const [attachmentIndex, attachment] of knowledgeAttachments.entries()) {
            if (!publicationGroup || !toolScope || !toolHeartbeat) {
              throw new ExecutionAuthenticityError('Knowledge Snapshot publication scope is unavailable');
            }
            const snapshot = {
              version: 'joyspace-knowledge-snapshot-v1' as const,
              title: attachment.title,
              body: attachment.body,
              author: attachment.author,
              sourceUrl: attachment.sourceUrl,
              updatedAt: attachment.updatedAt,
              contentSha256: attachment.contentSha256,
              toolArtifactId: artifact.id,
              toolArtifactContentSha256: artifact.contentSha256,
            };
            this.dependencies.validator.validateFileOrThrow(
              join(getConfigRoot(), 'schemas/joyspace-knowledge-snapshot-v1.schema.json'),
              snapshot,
            );
            const snapshotArtifact = await this.dependencies.artifacts.writeJson({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              kind: 'knowledge_snapshot',
              relativePath: `knowledge/joyspace-${step.step_no}-${attachmentIndex + 1}.json`,
              value: snapshot,
              schemaVersion: snapshot.version,
              sensitivity: 'internal',
              redactionPolicyVersion: 'v1',
              activeLease: input.lease,
            });
            publicationGroup.track(snapshotArtifact.id);
            if (snapshotArtifact.state !== 'SEALED' || !snapshotArtifact.contentSha256) {
              throw new ExecutionAuthenticityError('Joyspace Knowledge Snapshot was not sealed');
            }
            toolScope.assertActive(step.actor_id);
            toolHeartbeat.assertHealthy();
            pendingKnowledgeSnapshots.push({
              stepNo: step.step_no,
              attachmentIndex,
              toolId: step.actor_id,
              evidenceId: `JV${step.step_no}-${attachmentIndex + 1}`,
              artifact: snapshotArtifact,
              value: snapshot,
            });
          }
          let sealedOutput: EngineSealedStepOutput = {
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
          let verified = await readVerifiedStepArtifact(sealedOutput, this.dependencies.artifacts);
          let sourceSkillArtifactId: string | undefined;
          if (contributionPolicy) {
            const adapterId = contributionPolicy.contributionAdapterId;
            if (!adapterId) {
              throw new ExecutionAuthenticityError(
                `Contributor ${contributionPolicy.invocationId} has no adapter`,
              );
            }
            const virtualSource = adapterId === VIRTUAL_USER_TOOL_ADAPTER_ID
              ? [...outputs].reverse().find((output) => (
                  output.actorId === 'virtual-user-lab'
                  && output.stepNo < step.step_no
                  && output.kind === 'tool_output'
                ))
              : undefined;
            if (adapterId === VIRTUAL_USER_TOOL_ADAPTER_ID && !virtualSource) {
              throw new ExecutionAuthenticityError(
                `Contributor ${contributionPolicy.invocationId} has no virtual-user-lab source`,
              );
            }
            const source = virtualSource ?? sealedOutput;
            const contributionValue = (this.dependencies.contributionAdapters
              ?? new ContributionAdapterRegistry()).adapt({
              adapterId,
              source: virtualSource?.output ?? verified.output,
              sourceArtifact: {
                id: source.artifact.id,
                contentSha256: source.artifact.contentSha256!,
                schemaVersion: STEP_ARTIFACT_SCHEMA_VERSIONS[source.kind],
              },
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              invocationId: contributionPolicy.invocationId,
              skillId: contributionPolicy.skillId,
              contributionTypes: contributionPolicy.contributionTypes,
              questionIds: contributionPolicy.questionIds,
              requestedArtifactTypes: contributionPolicy.requestedArtifactTypes,
              evidenceManifest: contributionEvidenceView({
                lease: input.lease,
                adapterId,
                source: virtualSource,
              }),
            });
            const contributionArtifact = await this.dependencies.artifacts.writeJson({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              kind: 'research_contribution',
              relativePath: `steps/${step.step_no}-research-contribution.json`,
              value: contributionValue,
              schemaVersion: STEP_ARTIFACT_SCHEMA_VERSIONS.research_contribution,
              activeLease: input.lease,
            });
            publicationGroup?.track(contributionArtifact.id);
            if (contributionArtifact.state !== 'SEALED' || !contributionArtifact.contentSha256) {
              throw new ExecutionAuthenticityError(
                `Contribution Artifact ${contributionArtifact.id} was not sealed`,
              );
            }
            sourceSkillArtifactId = artifact.id;
            sealedOutput = {
              ...sealedOutput,
              kind: 'research_contribution',
              artifact: {
                id: contributionArtifact.id,
                contentSha256: contributionArtifact.contentSha256,
                state: 'SEALED',
              },
            };
            verified = await readVerifiedStepArtifact(sealedOutput, this.dependencies.artifacts);
          }
          toolScope?.assertActive(step.actor_id);
          toolHeartbeat?.assertHealthy();
          for (const { captureIndex, attachment } of captureAttachments) {
            if (!publicationGroup || !toolScope || !toolHeartbeat) {
              throw new ExecutionAuthenticityError('browser capture publication scope is unavailable');
            }
            const visual = await visualAssetService.ingestBrowserCapture({
              taskId: input.lease.taskId,
              planVersionId: input.lease.planVersionId,
              attemptId: input.lease.attemptId,
              activeLease: input.lease,
              toolArtifactId: artifact.id,
              toolArtifactContentSha256: artifact.contentSha256,
              captureIndex,
              attachment,
              exportPolicy: 'allow',
              ensureActive: () => {
                toolScope!.assertActive(step.actor_id);
                toolHeartbeat!.assertHealthy();
              },
            });
            publicationGroup.track(visual.assetArtifact.id).track(visual.manifestArtifact.id);
            if (!visual.manifestArtifact.contentSha256) {
              throw new ExecutionAuthenticityError('browser capture Manifest has no sealed hash');
            }
            toolScope.assertActive(step.actor_id);
            toolHeartbeat.assertHealthy();
            pendingBrowserCaptures.push({
              stepNo: step.step_no,
              captureIndex,
              toolId: step.actor_id,
              result: visual,
            });
          }
          await this.recordSucceededExecutionStep({
            ...input.lease,
            stepNo: step.step_no,
            stepName: step.step_name,
            actorType: step.actor_type,
            actorId: step.actor_id,
            state: 'succeeded',
            outputArtifactId: sealedOutput.artifact.id,
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
                  ...(result.toolReceipt.runtimeVersions === undefined
                    ? {}
                    : { runtimeVersions: { ...result.toolReceipt.runtimeVersions } }),
                  sourceRefs: result.sourceRefs,
                  attemptReceipts: result.toolAttemptReceipts,
                  toolTier: result.toolTier,
                  ...(successfulGapSummary ? { gapSummary: successfulGapSummary } : {}),
                  ...(pendingKnowledgeSnapshots.length === 0 ? {} : {
                    knowledgeSnapshotArtifactIds: pendingKnowledgeSnapshots.map(({ artifact }) => artifact.id),
                  }),
                  outputArtifactId: artifact.id,
                  status: 'succeeded',
                }
              : undefined,
            skillProvenance: result.skillProvenance
              ? {
                  ...result.skillProvenance,
                  planHash: planVersion.planHash,
                  stepHash: hashJson(step),
                  outputArtifactId: sealedOutput.artifact.id,
                  ...(nativePublication
                    ? { primaryArtifactId: nativePublication.primaryArtifact.id }
                    : {}),
                  ...(sourceSkillArtifactId ? { sourceArtifactId: sourceSkillArtifactId } : {}),
                  status: skillOutcome?.status ?? 'succeeded',
                  ...(skillOutcome?.status === 'degraded'
                    ? { limitations: skillOutcome.limitations }
                    : {}),
                }
              : undefined,
            latencyMs: result.toolReceipt?.latencyMs,
            startedAt,
            finishedAt: new Date(),
          });
          publicationGroup?.commit();
          unpublishedArtifactId = undefined;
          committedBrowserCaptures.push(...pendingBrowserCaptures);
          committedKnowledgeSnapshots.push(...pendingKnowledgeSnapshots);
          for (const pageFailure of successfulPageFailures) {
            addGap({
              key: `step:${step.step_no}:${pageFailure.sourceResultIndex}:${pageFailure.code}`,
              stepNo: step.step_no,
              message: redactString(
                `Step ${step.step_no} (${step.actor_id}) page ${pageFailure.sourceResultIndex}: ${pageFailure.message}`,
              ),
            });
          }
          if (skillOutcome?.status === 'degraded') {
            addGap({
              key: `step:${step.step_no}:skill:${step.actor_id}:degraded`,
              stepNo: step.step_no,
              message: skillDegradationMessage(step, skillOutcome),
            });
          }
          for (const knowledgeGap of result.knowledgeGaps ?? []) {
            addGap({
              key: `step:${step.step_no}:${knowledgeGap.key}`,
              stepNo: step.step_no,
              message: redactString(knowledgeGap.message),
            });
          }
          if (step.actor_type === 'tool' || step.actor_type === 'knowledge') {
            resolvedArtifacts.set(verified.artifact.id, {
              artifact: {
                id: verified.artifact.id,
                contentSha256: verified.artifact.contentSha256!,
              },
              value: verified.value,
            });
          }
          for (const capture of pendingBrowserCaptures) {
            const manifestArtifact = capture.result.manifestArtifact;
            resolvedArtifacts.set(manifestArtifact.id, {
              artifact: {
                id: manifestArtifact.id,
                contentSha256: manifestArtifact.contentSha256!,
              },
              value: capture.result.manifest,
            });
          }
          for (const snapshot of pendingKnowledgeSnapshots) {
            resolvedArtifacts.set(snapshot.artifact.id, {
              artifact: {
                id: snapshot.artifact.id,
                contentSha256: snapshot.artifact.contentSha256!,
              },
              value: snapshot.value,
            });
          }
          outputs.push({ ...sealedOutput, output: verified.output });
        } catch (error) {
          attachToolAttemptReceipts(error, actorResult);
          let artifactCleanupFailed = error instanceof ArtifactInvalidationError;
          let cleanupFailure: unknown;
          if (artifactCleanupFailed) cleanupRecoveryRequired = true;
          const artifactCleanupDeferred = Boolean(
            (publicationGroup || unpublishedArtifactId)
            && error instanceof ExecutionStepPersistenceError,
          );
          const compensatePublication = async (reason: string): Promise<void> => {
            if (publicationGroup) {
              await publicationGroup.compensate(reason);
              return;
            }
            if (unpublishedArtifactId) {
              await this.dependencies.artifacts.invalidateArtifactPublication(
                unpublishedArtifactId,
                reason,
              );
            }
          };
          if ((publicationGroup || unpublishedArtifactId) && !artifactCleanupDeferred) {
            try {
              await compensatePublication(
                'unpublished step Artifact invalidated after execution-step persistence failure',
              );
            } catch (cleanupError) {
              artifactCleanupFailed = true;
              cleanupFailure = cleanupError;
              cleanupRecoveryRequired = true;
            }
          }
          const attemptReceipts = attemptReceiptsFrom(error) ?? toolAttemptReceipts;
          let failure = failureFrom(error);
          if (artifactCleanupFailed) {
            failure = {
              ...failure,
              kind: 'artifact_invalidation',
              retryable: false,
              message: 'unpublished step Artifact could not be invalidated',
              failedArtifactIds: failedArtifactIdsFrom(
                failure,
                cleanupFailure,
                publicationGroup?.artifactIds ?? (unpublishedArtifactId ? [unpublishedArtifactId] : []),
              ),
            };
          }
          attachAttemptReceipts(failure, attemptReceipts);
          let failedToolProvenance: Record<string, unknown> | undefined;
          let failedSkillProvenance: Record<string, unknown> | undefined;
          let toolTier: 'core' | 'optional' = 'core';
          let effectiveError = error;
          if (step.actor_type === 'tool') {
            toolTier = plan.optionalToolStepNos.has(step.step_no) ? 'optional' : 'core';
            failure.toolTier = toolTier;
            const toolProvenance = await this.failedToolProvenance(
              step,
              researchGoal,
              resolvedInput,
              error,
              attemptReceipts,
              toolTier === 'optional',
            );
            toolProvenance.toolTier = toolTier;
            let failedPageFailures: PageFailureGap[] = [];
            let failedGapSummary: ToolGapSummary | undefined;
            if (toolTier === 'optional' && !artifactCleanupFailed) {
              try {
                failedPageFailures = pageFailureGaps(failure.page_failures);
                failedGapSummary = pageGapSummary(failure.page_failures);
              } catch (gapError) {
                effectiveError = gapError;
                failure = failureFrom(gapError);
                failure.toolTier = toolTier;
              }
            }
            if (failedGapSummary) toolProvenance.gapSummary = failedGapSummary;
            failedToolProvenance = toolProvenance;
            if (
              toolTier === 'optional'
              && error instanceof ToolInvocationError
              && error.kind !== 'schema'
              && error.kind !== 'safety'
              && error.kind !== 'lease_lost'
              && !artifactCleanupFailed
              && !isIntegrityFailure(effectiveError)
            ) {
              failure.allowedActions ??= [];
              if (!failedGapSummary) {
                failedGapSummary = stepGapSummary(failure, error.kind);
                toolProvenance.gapSummary = failedGapSummary;
              }
              await this.dependencies.repository.recordExecutionStep({
                ...input.lease,
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
              if (failedPageFailures.length > 0) {
                for (const pageFailure of failedPageFailures) {
                  addGap({
                    key: `step:${step.step_no}:${pageFailure.sourceResultIndex}:${pageFailure.code}`,
                    stepNo: step.step_no,
                    message: redactString(
                      `Step ${step.step_no} (${step.actor_id}) page ${pageFailure.sourceResultIndex}: ${pageFailure.message}`,
                    ),
                  });
                }
              } else {
                const message = typeof failure.message === 'string'
                  ? failure.message
                  : 'optional tool failed';
                addGap({
                  key: `step:${step.step_no}:${failedGapSummary.keys[0]}`,
                  stepNo: step.step_no,
                  message: redactString(`Step ${step.step_no} (${step.actor_id}): ${message}`),
                });
              }
              return;
            }
            failure.allowedActions = failure.kind === 'safety' || failure.kind === 'artifact_invalidation'
              ? ['abort']
              : ['retry', 'abort'];
          } else {
            failure.allowedActions = failure.requiresReplan === true
              ? ['replan', 'abort']
              : failure.retryable === true ? ['retry', 'abort'] : ['abort'];
          }
          if (step.actor_type === 'skill') {
            failedSkillProvenance = nativeSkill
              ? {
                  kind: 'native_skill_execution',
                  ...(preparedSkillFingerprint ?? {
                    skillBodyHash: nativeSkill.runSpec.body_hash,
                    inputSchemaHash: nativeSkill.runSpec.input_requirements_hash,
                    outputSchemaHash: hashJson(NATIVE_SKILL_RESULT_VERSION),
                    payloadSchemaHash: null,
                    skillReferenceHashes: [
                      { path: nativeSkill.runSpec.entry_path, hash: nativeSkill.runSpec.body_hash },
                      ...nativeSkill.runSpec.selected_references.map(({ path, contentHash }) => ({
                        path,
                        hash: contentHash,
                      })),
                    ],
                    inputArtifacts: executionInputArtifacts(outputs, step),
                    inputHash: hashJson(resolvedInput),
                    executionPromptHash: null,
                  }),
                  status: 'failed',
                }
              : await this.failedSkillProvenance({
                  step,
                  lease: input.lease,
                  resolvedInput,
                  producedOutputHash: error instanceof SkillOutputSchemaError
                    ? error.outputHash
                    : producedSkillOutputHash,
                  schemaHashes: error instanceof SkillOutputSchemaError
                    ? error.schemaHashes
                    : undefined,
                  preparedFingerprint: preparedSkillFingerprint,
                  ...(error instanceof SkillOutputSchemaError
                    ? { modelReceipt: error.modelReceipt }
                    : {}),
                });
          }
          const optionalInvocationPolicy = plan.optionalInvocationStepNos.has(step.step_no)
            ? invocationPolicies.find(({ failurePolicy }) => failurePolicy === 'gap')
            : undefined;
          if (invocationFailureCanBecomeGap({
            optionalInvocationStep: optionalInvocationPolicy !== undefined,
            failureKind: typeof failure.kind === 'string' ? failure.kind : undefined,
            artifactCleanupFailed,
            integrityFailure: isIntegrityFailure(effectiveError),
          }) && optionalInvocationPolicy) {
            skippedInvocationIds.add(optionalInvocationPolicy.invocationId);
            failure = {
              ...failure,
              kind: 'optional_contributor_failed',
              retryable: true,
              invocationId: optionalInvocationPolicy.invocationId,
              allowedActions: ['retry', 'abort'],
            };
            await this.dependencies.repository.recordExecutionStep({
              ...input.lease,
              stepNo: step.step_no,
              stepName: step.step_name,
              actorType: step.actor_type,
              actorId: step.actor_id,
              state: 'skipped',
              failure,
              toolProvenance: failedToolProvenance,
              skillProvenance: failedSkillProvenance,
              startedAt,
              finishedAt: new Date(),
            });
            addGap({
              key: `invocation:${optionalInvocationPolicy.invocationId}:failed`,
              stepNo: step.step_no,
              message: redactString(
                `Optional Contributor ${optionalInvocationPolicy.invocationId} failed: ${String(failure.message ?? 'unknown error')}`,
              ),
            });
            return;
          }
          if (artifactCleanupDeferred) {
            failure.artifactInvalidationPromotion = {
              version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
              eligibleArtifactIds: [...new Set(
                publicationGroup?.artifactIds ?? (unpublishedArtifactId ? [unpublishedArtifactId] : []),
              )].sort(),
            };
          }
          const failedStep = {
            ...input.lease,
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
          } as const;
          failure = await this.recordFailedExecutionStep(failedStep);
          if (artifactCleanupDeferred) {
            try {
              await compensatePublication(
                'unpublished step Artifact invalidated after failed-step persistence resolved commit ambiguity',
              );
            } catch (cleanupError) {
              artifactCleanupFailed = true;
              cleanupFailure = cleanupError;
              cleanupRecoveryRequired = true;
              const promotedFailure = await this.dependencies.repository.promoteExecutionStepArtifactInvalidation({
                ...input.lease,
                stepNo: step.step_no,
                stepName: step.step_name,
                actorType: step.actor_type,
                actorId: step.actor_id,
                expectedPreviousFailure: failure,
                failedArtifactIds: failedArtifactIdsFrom(
                  failure,
                  cleanupFailure,
                  publicationGroup?.artifactIds ?? (unpublishedArtifactId ? [unpublishedArtifactId] : []),
                ),
              });
              if (!promotedFailure) {
                throw new ControlPlaneConflictError(
                  `execution step ${input.lease.attemptId}/${step.step_no} could not record Artifact invalidation`,
                );
              }
              failure = promotedFailure;
            }
            if (!artifactCleanupFailed) {
              const clearedFailure = await this.dependencies.repository
                .clearExecutionStepArtifactInvalidationPromotion({
                  ...input.lease,
                  stepNo: step.step_no,
                  stepName: step.step_name,
                  actorType: step.actor_type,
                  actorId: step.actor_id,
                  expectedPreviousFailure: failure,
                });
              if (!clearedFailure) {
                throw new ControlPlaneConflictError(
                  `execution step ${input.lease.attemptId}/${step.step_no} could not clear Artifact invalidation marker`,
                );
              }
              failure = clearedFailure;
            }
          }
          const paused = {
            status: 'paused' as const,
            attemptId: input.lease.attemptId,
            failedStepNo: step.step_no,
            failure,
          };
          const authoritativeFailure = selectAuthoritativeFailedStep([
            ...(wavePaused?.failedStepNo === undefined
              ? []
              : [{
                  stepNo: wavePaused.failedStepNo,
                  state: 'failed',
                  failure: wavePaused.failure ?? null,
                }]),
            { stepNo: paused.failedStepNo, state: 'failed', failure: paused.failure },
          ]);
          if (authoritativeFailure?.stepNo === paused.failedStepNo) wavePaused = paused;
          if (isIntegrityFailure(effectiveError)) throw effectiveError;
          return;
        } finally {
          if (actorResult?.knowledgeAttachments) {
          actorResult.knowledgeAttachments.length = 0;
          actorResult.knowledgeAttachments = undefined;
        }
        if (actorResult?.mediaAttachments) {
            actorResult.mediaAttachments.length = 0;
            actorResult.mediaAttachments = undefined;
          }
          toolHeartbeat?.stop();
          toolScope?.dispose();
        }
      }));
      const rejected = waveResults.find((result) => result.status === 'rejected');
      if (wavePaused) {
        try {
          await this.dependencies.repository.pauseExecution({
            taskId: input.lease.taskId,
            attemptId: input.lease.attemptId,
            expectedVersion: active.stateVersion,
            reason: cleanupRecoveryRequired
              ? 'artifact_invalidation'
              : String(wavePaused.failure?.kind ?? 'execution_failure'),
          });
        } catch (pauseError) {
          if (!(pauseError instanceof ControlPlaneConflictError)) throw pauseError;
        }
      }
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (wavePaused) return wavePaused;
    }
    let sealedEvidenceManifest!: CurrentDeliverableGenerateInput['evidenceManifest'];
    let evidenceResolver!: EvidenceArtifactResolver;
    let chartPublication: ArtifactPublicationGroup | undefined;
    let reportPublication: ArtifactPublicationGroup | undefined;
    const compensateChartPublication = async (reason: string): Promise<void> => {
      if (!chartPublication) return;
      const publication = chartPublication;
      await publication.compensate(reason);
      chartPublication = undefined;
    };
    const compensateReportPublication = async (reason: string): Promise<void> => {
      if (!reportPublication) return;
      const publication = reportPublication;
      await publication.compensate(reason);
      reportPublication = undefined;
    };
    try {
      evidenceResolver = {
        resolveArtifact: (artifactId) => resolvedArtifacts.get(artifactId) ?? null,
      };
      const evidenceEntries = (await this.dependencies.repository.listExecutionSteps(input.lease.attemptId))
        .flatMap((step): EvidenceEntry[] => {
          const proof = step.toolProvenance;
          const knowledgeProof = step.skillProvenance;
          const knowledgeOutputArtifactId = typeof knowledgeProof?.outputArtifactId === 'string'
            ? knowledgeProof.outputArtifactId
            : null;
          const knowledgeArtifact = knowledgeOutputArtifactId
            ? resolvedArtifacts.get(knowledgeOutputArtifactId)
            : undefined;
          if (
            step.actorType === 'knowledge'
            && step.state === 'succeeded'
            && knowledgeArtifact
            && Array.isArray(knowledgeProof?.resources)
          ) {
            return knowledgeProof.resources.flatMap((resource, index): EvidenceEntry[] => (
              isRecord(resource)
              && typeof resource.id === 'string'
              && typeof resource.contentHash === 'string'
                ? [{
                    id: `K${step.stepNo}-${index + 1}`,
                    kind: 'knowledge_excerpt',
                    evidenceClass: 'knowledge',
                    artifactId: knowledgeArtifact.artifact.id,
                    artifactContentSha256: knowledgeArtifact.artifact.contentSha256,
                    jsonPointer: `/resources/${index}/content`,
                    stepNo: step.stepNo,
                    sensitivity: 'internal',
                    redaction: 'none',
                  }]
                : []
            ));
          }
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
            step.actorType === 'tool'
            && step.actorId === 'virtual-user-lab'
            && step.state === 'succeeded'
            && artifact
            && executionMode === 'real'
            && typeof implementationId === 'string'
            && typeof redactedOutputHash === 'string'
            && (toolTier === 'core' || toolTier === 'optional')
            && isRecord(artifact.value)
            && isRecord(artifact.value.output)
            && Array.isArray(artifact.value.output.reviews)
          ) {
            return virtualUserSimulationEvidence({
              stepNo: step.stepNo,
              artifactId: artifact.artifact.id,
              artifactContentSha256: artifact.artifact.contentSha256,
              output: artifact.value.output,
              implementationId,
              redactedOutputHash,
            });
          }
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
            redaction: 'none',
          }));
        });
      evidenceEntries.push(...datasetEvidenceEntries(resolvedDatasets));
      const evidenceService = new EvidenceService();
      for (const snapshot of committedKnowledgeSnapshots
        .sort((left, right) => left.stepNo - right.stepNo || left.attachmentIndex - right.attachmentIndex)) {
        if (!snapshot.artifact.contentSha256) {
          throw new ExecutionAuthenticityError('Joyspace Knowledge Snapshot has no sealed hash');
        }
        evidenceEntries.push({
          id: snapshot.evidenceId,
          kind: 'knowledge_excerpt',
          evidenceClass: 'knowledge',
          toolId: snapshot.toolId,
          toolTier: 'optional',
          artifactId: snapshot.artifact.id,
          artifactContentSha256: snapshot.artifact.contentSha256,
          jsonPointer: '/body',
          sourceUrl: snapshot.value.sourceUrl,
          stepNo: snapshot.stepNo,
          sensitivity: 'internal',
          redaction: 'none',
        });
      }
      for (const capture of [...committedBrowserCaptures]
        .sort((left, right) => left.stepNo - right.stepNo || left.captureIndex - right.captureIndex)) {
        const verified = await visualAssetService.readVerified({
          assetId: capture.result.assetArtifact.id,
          manifestArtifactId: capture.result.manifestArtifact.id,
        });
        const source = verified.manifest.source;
        if (
          verified.manifest.version !== 'visual-asset-manifest-v2'
          || source.kind !== 'browser_capture'
          || !verified.manifestArtifact.contentSha256
        ) {
          throw new ExecutionAuthenticityError('committed browser capture Evidence binding is invalid');
        }
        resolvedArtifacts.set(verified.manifestArtifact.id, {
          artifact: {
            id: verified.manifestArtifact.id,
            contentSha256: verified.manifestArtifact.contentSha256,
          },
          value: verified.manifest,
        });
        evidenceEntries.push({
          id: `BC${capture.stepNo}-${capture.captureIndex}`,
          kind: 'screenshot',
          evidenceClass: 'screenshot',
          toolId: capture.toolId,
          toolTier: 'optional',
          artifactId: verified.manifestArtifact.id,
          artifactContentSha256: verified.manifestArtifact.contentSha256,
          jsonPointer: '/assetId',
          sourceUrl: source.sourcePageUrl,
          stepNo: capture.stepNo,
          sensitivity: 'public',
          redaction: 'none',
        });
      }
      for (const [index, visual] of materializedVisualOriginals.entries()) {
        const stored = await this.dependencies.artifacts.readVerifiedJson<VisualAssetManifest>(
          visual.original.manifestArtifactId,
        );
        if (
          stored.artifact.state !== 'SEALED'
          || stored.artifact.taskId !== input.lease.taskId
          || stored.artifact.planVersionId !== input.lease.planVersionId
          || stored.artifact.attemptId !== input.lease.attemptId
          || stored.artifact.kind !== 'visual_asset_manifest'
          || stored.artifact.schemaVersion !== 'visual-asset-manifest-v1'
          || !stored.artifact.contentSha256
          || stored.value.assetId !== visual.original.assetId
        ) {
          throw new ExecutionAuthenticityError('materialized screenshot Evidence binding is invalid');
        }
        resolvedArtifacts.set(stored.artifact.id, {
          artifact: {
            id: stored.artifact.id,
            contentSha256: stored.artifact.contentSha256,
          },
          value: stored.value,
        });
        evidenceEntries.push({
          id: `S1-${index + 1}`,
          kind: 'screenshot',
          evidenceClass: 'screenshot',
          artifactId: stored.artifact.id,
          artifactContentSha256: stored.artifact.contentSha256,
          jsonPointer: '/assetId',
          sensitivity: 'internal',
          redaction: 'none',
        });
      }
      const requestsCompetitiveWeightChart = deliverableId === 'competitive_analysis_report'
        && plan.steps.some((step) => (
          step.actor_type === 'skill'
          && step.actor_id === 'competitive-web-research'
          && Object.hasOwn(step.input, 'scoring_weights')
        ));
      if (requestsCompetitiveWeightChart) {
        const weightResolution = resolveCompetitiveScoringWeights(planVersion.plan);
        const chartGapStepNo = plan.steps.length + 1;
        if (weightResolution.status === 'unavailable') {
          addGap({
            key: `system:chart:${weightResolution.code}`,
            stepNo: chartGapStepNo,
            message: weightResolution.message,
          });
        } else if (!this.dependencies.reportReview || !this.dependencies.reportComposition) {
          addGap({
            key: 'system:chart:composition_unavailable',
            stepNo: chartGapStepNo,
            message: '评分权重图未生成：报告审阅或组合链路不可用。',
          });
        } else {
          const scoringWeights = weightResolution.weights;
          const publication = new ArtifactPublicationGroup(this.dependencies.artifacts);
          chartPublication = publication;
          try {
            const chartEvidence = await this.withLeaseHeartbeat(input.lease, async ({ ensureActive }) => {
              const chartData = {
                version: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
                taskId: input.lease.taskId,
                planVersionId: input.lease.planVersionId,
                attemptId: input.lease.attemptId,
                unit: 'percent',
                weights: scoringWeights,
              } as const;
              const chartDataArtifact = await this.dependencies.artifacts.writeJson({
                taskId: input.lease.taskId,
                planVersionId: input.lease.planVersionId,
                attemptId: input.lease.attemptId,
                kind: 'chart_data',
                relativePath: 'charts/competitive-scoring-weights-data.json',
                value: chartData,
                schemaVersion: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
                sensitivity: 'internal',
                redactionPolicyVersion: 'v1',
                activeLease: input.lease,
              });
              publication.track(chartDataArtifact.id);
              await ensureActive();
              if (
                chartDataArtifact.state !== 'SEALED'
                || !chartDataArtifact.contentSha256
                || chartDataArtifact.kind !== 'chart_data'
                || chartDataArtifact.schemaVersion !== COMPETITIVE_WEIGHT_CHART_DATA_VERSION
              ) {
                throw new ExecutionAuthenticityError('competitive scoring weight data was not sealed');
              }
              const resolvedChartData: ResolvedEvidenceArtifact = {
                artifact: {
                  id: chartDataArtifact.id,
                  contentSha256: chartDataArtifact.contentSha256,
                },
                value: chartData,
              };
              const weightEvidence = scoringWeights.map((_, index): EvidenceEntry => ({
                id: `W-${index + 1}`,
                kind: 'user_constraint',
                evidenceClass: 'user_input',
                artifactId: chartDataArtifact.id,
                artifactContentSha256: chartDataArtifact.contentSha256!,
                jsonPointer: `/weights/${index}/percentage`,
                sensitivity: 'internal',
                redaction: 'none',
              }));
              const weightEvidenceById = new Map(weightEvidence.map((entry) => [entry.id, entry]));
              const chartSpec: ChartSpec = {
                version: 'chart-spec-v1',
                chartId: COMPETITIVE_WEIGHT_CHART_ID,
                type: 'comparison',
                title: COMPETITIVE_WEIGHT_TITLE,
                categories: scoringWeights.map(({ dimension }) => dimension),
                series: [{
                  key: COMPETITIVE_WEIGHT_SERIES_KEY,
                  label: COMPETITIVE_WEIGHT_SERIES_LABEL,
                  values: scoringWeights.map(({ percentage }) => percentage),
                  evidenceIds: weightEvidence.map(({ id }) => [id]),
                }],
                yAxis: { min: 0 },
              };
              const localEvidenceResolver: EvidenceArtifactResolver = {
                resolveArtifact: (artifactId) => artifactId === chartDataArtifact.id
                  ? resolvedChartData
                  : evidenceResolver.resolveArtifact(artifactId),
              };
              const chartEvidenceResolver = (evidenceId: string): unknown | undefined => {
                const entry = weightEvidenceById.get(evidenceId);
                return entry
                  ? evidenceService.resolveEvidenceValue(entry, localEvidenceResolver)
                  : undefined;
              };
              await (this.dependencies.chartRenderer ?? renderAndSealChartSvg)({
                taskId: input.lease.taskId,
                planVersionId: input.lease.planVersionId,
                attemptId: input.lease.attemptId,
                spec: chartSpec,
                evidenceResolver: chartEvidenceResolver,
                chartDataArtifact,
                publication,
                assets: visualAssetService,
                artifacts: this.dependencies.artifacts,
                activeLease: input.lease,
                exportPolicy: 'allow',
                width: 1200,
                height: 640,
                ensureActive,
              });
              return { chartDataArtifact, resolvedChartData, weightEvidence };
            });
            resolvedArtifacts.set(chartEvidence.chartDataArtifact.id, chartEvidence.resolvedChartData);
            evidenceEntries.push(...chartEvidence.weightEvidence);
          } catch (error) {
            if (!(error instanceof ChartRendererUnavailableError)) throw error;
            await compensateChartPublication('Competitive weight Chart renderer was unavailable');
            addGap({
              key: 'system:chart:renderer_unavailable',
              stepNo: chartGapStepNo,
              message: '评分权重图未生成：服务端图表渲染器不可用。',
            });
          }
        }
      }
      for (const requirement of plan.evidence_requirements) {
        let actual = 0;
        for (const entry of evidenceEntries) {
          if (requirement.required && entry.kind === 'tool_output' && entry.toolTier !== 'core') continue;
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
      const requiresCoreToolEvidence = plan.steps.some((step) => (
        step.actor_type === 'tool'
        && this.dependencies.skillLoader.getTool(step.actor_id)?.tier === 'core'
      ));
      if (requiresCoreToolEvidence && !evidenceEntries.some((entry) => entry.toolTier === 'core')) {
        throw new ExecutionAuthenticityError('execution has no valid core Tool evidence');
      }
      const evidenceManifest = evidenceService.createManifest({
        taskId: input.lease.taskId,
        planVersionId: input.lease.planVersionId,
        attemptId: input.lease.attemptId,
        collectedAt: new Date().toISOString(),
        entries: evidenceEntries,
      }, evidenceResolver);
      const evidenceManifestArtifact = await this.withLeaseHeartbeat(
        input.lease,
        async ({ ensureActive }) => {
          const artifact = await this.dependencies.artifacts.writeJson({
            taskId: input.lease.taskId,
            planVersionId: input.lease.planVersionId,
            attemptId: input.lease.attemptId,
            kind: 'evidence_manifest',
            relativePath: 'evidence/manifest.json',
            value: evidenceManifest,
            schemaVersion: 'evidence-v1',
            activeLease: input.lease,
          });
          chartPublication?.track(artifact.id);
          await ensureActive();
          return artifact;
        },
      );
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
      let effectiveError = error;
      try {
        await compensateChartPublication('Competitive weight Chart publication did not pass report material discovery');
      } catch (compensationError) {
        effectiveError = effectiveError instanceof ArtifactInvalidationError
          && compensationError instanceof ArtifactInvalidationError
          ? mergeArtifactInvalidationErrors(effectiveError, compensationError)
          : compensationError;
      }
      const failure = failureFrom(effectiveError);
      failure.allowedActions = ['abort'];
      await this.recordFailedExecutionStep({
        ...input.lease,
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
      if (isIntegrityFailure(effectiveError)) throw effectiveError;
      return {
        status: 'paused',
        attemptId: input.lease.attemptId,
        failedStepNo: plan.steps.length + 1,
        failure,
      };
    }

    try {
      if (plan.native) {
      const results = outputs
        .filter((output) => output.kind === 'skill_result' && output.actorType === 'skill')
        .sort((left, right) => left.stepNo - right.stepNo)
        .map((output) => parseNativeSkillResult(output.output));
      const persistedNativeSteps = await this.dependencies.repository.listExecutionSteps(input.lease.attemptId);
      const skippedNativeStepNos = new Set(persistedNativeSteps
        .filter(({ state, actorType }) => state === 'skipped' && actorType === 'skill')
        .map(({ stepNo }) => stepNo));
      const expectedResultCount = [...plan.native.runSpecsByStep.keys()]
        .filter((stepNo) => !skippedNativeStepNos.has(stepNo))
        .length;
      if (results.length !== expectedResultCount) {
        throw new ExecutionAuthenticityError(
          `native execution produced ${results.length} Skill results, expected ${expectedResultCount}`,
        );
      }
      const needsInput = results.filter(({ status }) => status === 'needs_input');
      if (needsInput.length > 0) {
        const missingInputKeys = [...new Set(needsInput.flatMap(({ missingInputKeys }) => missingInputKeys ?? []))];
        const failure = {
          kind: 'skill_needs_input',
          retryable: false,
          requiresReplan: true,
          allowedActions: ['replan', 'abort'],
          missingInputKeys,
          message: `Skill requires additional input: ${missingInputKeys.join(', ')}`,
        };
        const failedStepNo = plan.steps.length + 1;
        await this.dependencies.repository.recordExecutionStep({
          ...input.lease,
          stepNo: failedStepNo,
          stepName: 'resolve additional Skill input',
          actorType: 'system',
          actorId: 'input-resolution',
          state: 'failed',
          failure,
          startedAt: new Date(),
          finishedAt: new Date(),
        });
        await this.dependencies.repository.pauseExecution({
          taskId: input.lease.taskId,
          attemptId: input.lease.attemptId,
          expectedVersion: active.stateVersion,
          reason: 'skill_needs_input',
        });
        return {
          status: 'paused',
          attemptId: input.lease.attemptId,
          evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
          failedStepNo,
          failure,
        };
      }
      const verifiedSources = results.flatMap(({ sources }) => sources);
      const executionGaps = [...gaps.values()]
        .sort((left, right) => left.stepNo - right.stepNo)
        .map(({ message }) => message);
      const singleRunSpec = [...plan.native.runSpecsByStep.values()][0]?.runSpec;
      const finalReport = plan.native.mode === 'single_skill'
        ? await finalizeSingleNativeReport({
            taskId: input.lease.taskId,
            planVersionId: input.lease.planVersionId,
            attemptId: input.lease.attemptId,
            requirement: task.structuredTask,
            result: results[0]!,
            verifiedSources,
            reportPolicy: singleRunSpec?.report_policy.kind ?? 'default_llm',
            ...(singleRunSpec?.report_policy.kind === 'default_llm'
              ? {
                  defaultWriter: new LlmNativeReportWriter(this.llm, {
                    attemptId: input.lease.attemptId,
                    stepNo: plan.steps.length + 1,
                    stage: 'native_default_report',
                    expectedModel: input.expectedModel,
                  }),
                }
              : {}),
            extraGaps: executionGaps,
          })
        : (await finalizeMultiNativeReport({
            taskId: input.lease.taskId,
            planVersionId: input.lease.planVersionId,
            attemptId: input.lease.attemptId,
            title: researchGoal || '综合报告',
            requirement: task.structuredTask,
            results,
            verifiedSources,
            writer: new LlmNativeReportWriter(this.llm, {
              attemptId: input.lease.attemptId,
              stepNo: plan.steps.length + 1,
              stage: 'native_multi_synthesis',
              expectedModel: input.expectedModel,
              outputFormat: plan.native.finalReportPolicy.outputFormat,
              ...(plan.native.finalReportPolicy.kind === 'skill_defined'
                ? { instructions: plan.native.finalReportPolicy.instructions }
                : {}),
            }),
            reportPolicy: plan.native.finalReportPolicy,
            extraGaps: executionGaps,
          })).report;
      const validatedFinalReport = parseNativeFinalReport(finalReport);
      const sealed = await new NativeReportArtifactService(
        this.dependencies.artifacts,
      ).sealFinalReport({
        activeLease: input.lease,
        report: validatedFinalReport,
      });
      chartPublication?.commit();
      chartPublication = undefined;
      const status = validatedFinalReport.gaps.length > 0 ? 'completed_with_gaps' : 'completed';
      await this.dependencies.repository.completeExecution(input.lease, {
        status,
        finalReportArtifactId: sealed.jsonArtifact.id,
      });
        return {
          status,
          attemptId: input.lease.attemptId,
          evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
          finalReportArtifactId: sealed.jsonArtifact.id,
          gapCount: validatedFinalReport.gaps.length,
        };
      }

      if (deliverableId === 'design_audit_report') {
        const materializer = this.dependencies.visualInputMaterializer!;
        await this.withLeaseHeartbeat(input.lease, () => materializer.annotateDesignFindings!({
          lease: input.lease,
          original: materializedVisualOriginals[0]!,
          findings: designAnnotationFindings(outputs),
        }));
      }
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
          evidenceManifest: sealedEvidenceManifest.value,
          evidenceResolver: (evidenceId) => {
            const entry = evidenceById.get(evidenceId);
            return entry
              ? evidenceService.resolveEvidenceValue(entry, evidenceResolver)
              : undefined;
          },
        }));
      chartPublication?.commit();
      chartPublication = undefined;
      const orderedGaps = [...gaps.values()]
        .sort((left, right) => left.stepNo - right.stepNo);
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
        outputs: [...outputs].sort((left, right) => left.stepNo - right.stepNo),
        gaps: orderedGaps.map(({ message }) => message),
        gapRefs: orderedGaps.map(({ key, stepNo }) => ({ key, stepNo })),
        expectedModel: input.expectedModel,
        stepNo: plan.steps.length + 1,
        activeLease: input.lease,
        visualAssets: reportMaterials.visualAssets,
        visualAnnotationBindings: reportMaterials.visualAnnotationBindings ?? [],
      };
      const deliverable = await this.withLeaseHeartbeat(input.lease, ({ signal }) => (
        this.dependencies.deliverables.generate({ ...deliverableInput, cancellationSignal: signal })
      ));
      let deliverableArtifactId = deliverable.deliverableArtifactId;
      let crossSkillReviewArtifactId = deliverable.crossSkillReviewArtifactId;
      let contributionLedgerArtifactId = deliverable.contributionLedgerArtifactId;
      let contributionSummaryArtifactId = deliverable.contributionSummaryArtifactId;
      let reportReviewArtifactId: string | undefined;
      let reportDocumentArtifactId: string | undefined;
      let reportDocumentArtifact: ControlArtifact | undefined;
      let editorialReportDocument: ReportDocumentV3 | ReportDocumentV4 | undefined;
      let editorialBlueprintArtifactId: string | undefined;
      let editorialLayout: ReportPackageLayoutV2 | undefined;
      let sourceDeliverableContentSha256: string | undefined;
      let sourceReviewContentSha256: string | undefined;
      let editorialShowcase: ReportCompositionResult['editorialShowcase'];
      let reportLayoutBlueprintArtifactId: string | undefined;
      let reportLayoutDiagnosticArtifactId: string | undefined;
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
              revise: (revision) => this.dependencies.deliverables.revise!({
                ...deliverableInput,
                review: revision.review,
                reviewArtifactId: revision.reviewArtifactId,
                currentDeliverable: revision.deliverable as ResearchDeliverableEnvelope<unknown>,
                ...(revision.cancellationSignal
                  ? { cancellationSignal: revision.cancellationSignal }
                  : {}),
              }),
            }
          : undefined;
        if (!reviewCoverage) {
          throw new ExecutionAuthenticityError('report review coverage identifiers are unavailable');
        }
        const finalReviewCoverage = reviewCoverage;
        const review = await this.withLeaseHeartbeat(input.lease, ({ signal }) => this.dependencies.reportReview!.review({
          task: { id: task.id },
          plan: { id: planVersion.id },
          attempt: { id: input.lease.attemptId },
          deliverableArtifactId: deliverable.deliverableArtifactId,
          deliverable: deliverable.deliverable,
          successCriterionIds: finalReviewCoverage.successCriterionIds,
          questionIds: finalReviewCoverage.questionIds,
          evidenceIds: sealedEvidenceManifest.value.entries.map((entry) => entry.id),
          requirement: deliverableInput.finalizedRequirement as ResearchTaskV2,
          expectedModel: input.expectedModel,
          activeLease: input.lease,
          cancellationSignal: signal,
        }, composer));
        reportReviewArtifactId = review.artifactId;
        reviewStatus = review.status;
        deliverableArtifactId = review.deliverableArtifactId;
        crossSkillReviewArtifactId = review.crossSkillReviewArtifactId ?? crossSkillReviewArtifactId;
        contributionLedgerArtifactId = review.contributionLedgerArtifactId ?? contributionLedgerArtifactId;
        contributionSummaryArtifactId = review.contributionSummaryArtifactId ?? contributionSummaryArtifactId;
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
            ...input.lease,
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
            ...(crossSkillReviewArtifactId === undefined ? {} : { crossSkillReviewArtifactId }),
            ...(contributionLedgerArtifactId === undefined ? {} : { contributionLedgerArtifactId }),
            ...(contributionSummaryArtifactId === undefined ? {} : { contributionSummaryArtifactId }),
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
        const shouldComposeReport = this.dependencies.reportComposition
          && (
            deliverableId !== 'research_plan'
            || this.dependencies.reportEditorialExperienceV1Enabled === true
            || reportMaterials.visualAssets.length > 0
            || reportMaterials.charts.length > 0
        );
        if (shouldComposeReport) {
          await this.dependencies.repository.requireActiveLease(input.lease);
          const publication = new ArtifactPublicationGroup(this.dependencies.artifacts);
          reportPublication = publication;
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
          const editorialDataClassification = reportEditorialPlannerDataClassification(
            task.structuredTask,
            verifiedEvidenceManifest.value,
          );
          const composition = await this.withLeaseHeartbeat(input.lease, ({ signal }) =>
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
              expectedModel: input.expectedModel,
              layoutStepNo: plan.steps.length + 3,
              ...(editorialDataClassification
                ? { editorialPlannerDataClassification: editorialDataClassification }
                : {}),
              activeLease: input.lease,
              ...(contributionLedgerArtifactId === undefined
                ? {}
                : { contributionLedgerArtifactId }),
              onArtifactSealed: (artifact) => publication.track(artifact.id),
              cancellationSignal: signal,
            }));
          if (
            composition.artifact.state !== 'SEALED'
            || composition.artifact.taskId !== input.lease.taskId
            || composition.artifact.planVersionId !== input.lease.planVersionId
            || composition.artifact.attemptId !== input.lease.attemptId
            || composition.artifact.kind !== 'report_document'
            || composition.artifact.schemaVersion !== composition.document.version
            || (
              composition.artifact.schemaVersion !== 'report-document-v1'
              && composition.artifact.schemaVersion !== 'report-document-v2'
              && composition.artifact.schemaVersion !== 'report-document-v3'
              && composition.artifact.schemaVersion !== 'report-document-v4'
            )
          ) {
            throw new ExecutionAuthenticityError('ReportDocument composition did not return a sealed bound Artifact');
          }
          reportDocumentArtifactId = composition.artifact.id;
          if (
            composition.document.version === 'report-document-v3'
            || composition.document.version === 'report-document-v4'
          ) {
            if (
              !composition.editorialBlueprintArtifactId
              || !composition.editorialLayout
              || composition.editorialLayout.blueprintArtifactId !== composition.editorialBlueprintArtifactId
            ) {
              throw new ExecutionAuthenticityError(
                'Editorial ReportDocument composition did not return a consistent layout binding',
              );
            }
            if (
              !verifiedDeliverable.artifact.contentSha256
              || !verifiedReview.artifact.contentSha256
              || !composition.artifact.contentSha256
            ) {
              throw new ExecutionAuthenticityError(
                'Editorial ReportDocument publication inputs must have sealed content hashes',
              );
            }
            reportDocumentArtifact = composition.artifact;
            editorialReportDocument = composition.document;
            editorialBlueprintArtifactId = composition.editorialBlueprintArtifactId;
            editorialLayout = composition.editorialLayout;
            sourceDeliverableContentSha256 = verifiedDeliverable.artifact.contentSha256;
            sourceReviewContentSha256 = verifiedReview.artifact.contentSha256;
            editorialShowcase = composition.editorialShowcase;
            if (editorialShowcase?.showcase.status === 'unavailable') {
              addGap({
                key: `editorial-showcase:${editorialShowcase.showcase.reasonCode}`,
                stepNo: plan.steps.length + 3,
                message: `Editorial Showcase unavailable: ${editorialShowcase.showcase.reasonCode}`,
              });
            }
          } else {
            publication.commit();
            reportPublication = undefined;
            reportLayoutBlueprintArtifactId = composition.layoutBlueprintArtifactId;
            reportLayoutDiagnosticArtifactId = composition.layoutDiagnosticArtifactId;
          }
        }
      }
      await this.dependencies.repository.requireActiveLease(input.lease);
      if (reportDocumentArtifactId !== undefined && reportReviewArtifactId === undefined) {
        throw new ExecutionAuthenticityError('Report Package cannot bind a document without its Review Artifact');
      }
      const finalReviewArtifactId = reportReviewArtifactId;
      const canSealTextPackage = finalReviewArtifactId !== undefined
        && reportDocumentArtifactId === undefined
        && this.dependencies.reportComposition !== undefined;
      let reportPackage: ControlArtifact | undefined;
      if (
        finalReviewArtifactId !== undefined
        && (reportDocumentArtifactId !== undefined || canSealTextPackage)
      ) {
        if (editorialReportDocument && this.dependencies.standaloneHtmlBundleV1Enabled === true) {
          if (
            !reportPublication
            || !reportDocumentArtifact
            || !reportDocumentArtifact.contentSha256
            || !editorialBlueprintArtifactId
            || !editorialLayout
            || !sourceDeliverableContentSha256
            || !sourceReviewContentSha256
          ) {
            throw new ExecutionAuthenticityError(
              'Editorial ReportDocument publication inputs are incomplete',
            );
          }
          const publication = reportPublication;
          const reportPublicationId = createReportPublicationId({
            taskId: input.lease.taskId,
            planVersionId: input.lease.planVersionId,
            attemptId: input.lease.attemptId,
            deliverableContentSha256: sourceDeliverableContentSha256,
            reportReviewContentSha256: sourceReviewContentSha256,
            reportDocumentVersion: editorialReportDocument.version,
          });
          const htmlPublication = await renderAndSealStandaloneHtml({
            artifacts: this.dependencies.artifacts,
            activeLease: input.lease,
            reportDocumentArtifact,
            document: editorialReportDocument,
            onArtifactSealed: (artifact) => publication.track(artifact.id),
          });
          const notices: ReportNoticeV1[] = [...editorialReportDocument.notices];
          if (
            htmlPublication.standaloneHtml.status === 'unavailable'
            && !notices.some(({ code }) => code === 'html_unavailable')
          ) {
            notices.push({
              id: 'notice-html-unavailable',
              code: 'html_unavailable',
              severity: 'warning',
              scope: 'export',
              relatedUnitIds: [],
            });
          }
          const canonicalPackageService = new ReportPackageV2ArtifactService(
            this.dependencies.artifacts,
          );
          const canonicalPackage = await canonicalPackageService.seal({
            activeLease: input.lease,
            reportPublicationId,
            deliverableArtifactId,
            evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
            reportReviewArtifactId: finalReviewArtifactId,
            sourceReportDocumentArtifactId: reportDocumentArtifact.id,
            sourceReportDocumentContentSha256: reportDocumentArtifact.contentSha256,
            ...(crossSkillReviewArtifactId === undefined ? {} : { crossSkillReviewArtifactId }),
            ...(contributionLedgerArtifactId === undefined ? {} : { contributionLedgerArtifactId }),
            ...(contributionSummaryArtifactId === undefined ? {} : { contributionSummaryArtifactId }),
            layout: editorialLayout,
            assetSnapshot: { assets: [], charts: [] },
            standaloneHtml: htmlPublication.standaloneHtml,
            notices,
            onArtifactSealed: (artifact) => publication.track(artifact.id),
          });
          reportPackage = canonicalPackage;
          if (editorialShowcase) {
            if (!canonicalPackage.contentSha256) {
              throw new ExecutionAuthenticityError('Canonical Report Package has no sealed hash');
            }
            reportPackage = await new ReportPackageV3ArtifactService({
              artifacts: this.dependencies.artifacts,
              canonicalPackages: canonicalPackageService,
            }).seal({
              activeLease: input.lease,
              canonicalPackageArtifactId: canonicalPackage.id,
              canonicalPackageContentSha256: canonicalPackage.contentSha256,
              reportPublicationId,
              preferredHtml: editorialShowcase.showcase.status === 'ready'
                ? 'showcase'
                : 'canonical',
              showcase: editorialShowcase.showcase,
              onArtifactSealed: (artifact) => publication.track(artifact.id),
            });
          }
        } else {
          const publication = editorialReportDocument ? reportPublication : undefined;
          reportPackage = await new ReportPackageArtifactService(this.dependencies.artifacts).seal({
            activeLease: input.lease,
            presentationMode: reportDocumentArtifactId === undefined ? 'current_text' : 'multimodal',
            deliverableArtifactId,
            evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
            reportReviewArtifactId: finalReviewArtifactId,
            ...(reportDocumentArtifactId === undefined ? {} : { reportDocumentArtifactId }),
            ...(reportLayoutBlueprintArtifactId === undefined ? {} : { reportLayoutBlueprintArtifactId }),
            ...(reportLayoutDiagnosticArtifactId === undefined ? {} : { reportLayoutDiagnosticArtifactId }),
            ...(crossSkillReviewArtifactId === undefined ? {} : { crossSkillReviewArtifactId }),
            ...(contributionLedgerArtifactId === undefined ? {} : { contributionLedgerArtifactId }),
            ...(contributionSummaryArtifactId === undefined ? {} : { contributionSummaryArtifactId }),
            ...(publication === undefined
              ? {}
              : { onArtifactSealed: (artifact) => publication.track(artifact.id) }),
          });
        }
      }
      await this.dependencies.repository.requireActiveLease(input.lease);
      const status = gaps.size > 0 ? 'completed_with_gaps' : 'completed';
      await this.dependencies.repository.completeExecution(input.lease, {
        status,
        ...(reportPackage === undefined ? {} : { reportPackageArtifactId: reportPackage.id }),
      });
      reportPublication?.commit();
      reportPublication = undefined;
      return {
        status,
        attemptId: input.lease.attemptId,
        deliverableArtifactId,
        evidenceManifestArtifactId: sealedEvidenceManifest.artifact.id,
        ...(reportReviewArtifactId === undefined ? {} : { reportReviewArtifactId }),
        ...(reportPackage === undefined ? {} : { reportPackageArtifactId: reportPackage.id }),
        ...(crossSkillReviewArtifactId === undefined ? {} : { crossSkillReviewArtifactId }),
        ...(contributionLedgerArtifactId === undefined ? {} : { contributionLedgerArtifactId }),
        ...(contributionSummaryArtifactId === undefined ? {} : { contributionSummaryArtifactId }),
        ...(reviewStatus === undefined ? {} : { reviewStatus }),
        gapCount: gaps.size,
      };
    } catch (error) {
      if (error instanceof ControlPlaneConflictError && !reportPublication) {
        await this.dependencies.repository.invalidateTerminalArtifacts({
          taskId: input.lease.taskId,
          planVersionId: input.lease.planVersionId,
          attemptId: input.lease.attemptId,
          reason: 'terminal artifacts invalidated after execution lease loss',
        });
      }
      let effectiveError = error;
      try {
        await compensateReportPublication('Report publication did not complete');
      } catch (compensationError) {
        effectiveError = effectiveError instanceof ArtifactInvalidationError
          && compensationError instanceof ArtifactInvalidationError
          ? mergeArtifactInvalidationErrors(effectiveError, compensationError)
          : compensationError;
      }
      try {
        await compensateChartPublication('Competitive weight Chart publication did not pass report material discovery');
      } catch (compensationError) {
        effectiveError = effectiveError instanceof ArtifactInvalidationError
          && compensationError instanceof ArtifactInvalidationError
          ? mergeArtifactInvalidationErrors(effectiveError, compensationError)
          : compensationError;
      }
      let failure = deliverableFailureFrom(effectiveError);
      failure.allowedActions = failure.retryable === true ? ['retry', 'abort'] : ['abort'];
      failure = await this.recordFailedExecutionStep({
        ...input.lease,
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
      if (isIntegrityFailure(effectiveError)) throw effectiveError;
      return {
        status: 'paused',
        attemptId: input.lease.attemptId,
        failedStepNo: plan.steps.length + 1,
        failure,
      };
    }
  }

  private async recordFailedExecutionStep(
    input: Parameters<ControlPlaneRepository['recordExecutionStep']>[0] & {
      state: 'failed';
      failure: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    try {
      await this.dependencies.repository.recordExecutionStep(input);
      return input.failure;
    } catch (error) {
      if (!(error instanceof ControlPlaneConflictError)) throw error;
      if (input.failure.kind === 'lease_lost') {
        const finalized = await this.dependencies.repository.recordLeaseLostExecutionStep(input);
        if (finalized) return input.failure;
      }
      if (input.failure.kind === 'artifact_invalidation') {
        const failedArtifactIds = Array.isArray(input.failure.failedArtifactIds)
          ? input.failure.failedArtifactIds.filter((id): id is string => typeof id === 'string')
          : [];
        const promotedFailure = await this.dependencies.repository.promoteExecutionStepArtifactInvalidation({
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          attemptId: input.attemptId,
          leaseOwner: input.leaseOwner,
          leaseToken: input.leaseToken,
          stepNo: input.stepNo,
          stepName: input.stepName,
          actorType: input.actorType,
          actorId: input.actorId,
          failedArtifactIds,
        });
        if (promotedFailure) return promotedFailure;
      }
      throw error;
    }
  }

  private async recordSucceededExecutionStep(
    input: Parameters<ControlPlaneRepository['recordExecutionStep']>[0] & {
      state: 'succeeded';
      outputArtifactId: string;
    },
  ): Promise<void> {
    let persistenceError: unknown;
    let persistenceConflict: ControlPlaneConflictError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.dependencies.repository.recordExecutionStep(input);
        return;
      } catch (error) {
        if (error instanceof ControlPlaneConflictError) {
          if (persistenceError === undefined) throw error;
          persistenceConflict = error;
          break;
        }
        persistenceError = error;
      }
    }

    try {
      const persisted = (await this.dependencies.repository.listExecutionSteps(input.attemptId))
        .find(({ stepNo }) => stepNo === input.stepNo);
      if (
        persisted?.state === 'succeeded'
        && persisted.stepName === input.stepName
        && persisted.actorType === input.actorType
        && persisted.actorId === input.actorId
        && persisted.outputArtifactId === input.outputArtifactId
        && isDeepStrictEqual(persisted.toolProvenance, persistedJsonValue(input.toolProvenance))
        && isDeepStrictEqual(persisted.skillProvenance, persistedJsonValue(input.skillProvenance))
        && isDeepStrictEqual(persisted.failure, persistedJsonValue(input.failure))
        && persisted.latencyMs === (input.latencyMs ?? null)
        && sameOptionalDate(persisted.startedAt, input.startedAt)
        && sameOptionalDate(persisted.finishedAt, input.finishedAt)
      ) return;
      throw new ExecutionStepPersistenceError(Boolean(persistenceConflict), {
        cause: persistenceConflict ?? persistenceError,
      });
    } catch (error) {
      if (error instanceof ExecutionStepPersistenceError) throw error;
      throw new ExecutionStepPersistenceError(Boolean(persistenceConflict), {
        cause: persistenceConflict ?? persistenceError ?? error,
      });
    }
  }

  private async loadReusableExecutions(
    lease: ControlExecutionLease,
    plan: EnginePlan,
    planHash: string,
    researchGoal: string,
    deliverableId: string,
    expectedModel: string,
  ): Promise<Map<number, ReusableExecution>> {
    const reusable = new Map<number, ReusableExecution>();
    if (!lease.retryOf) return reusable;
    const previous = await this.dependencies.repository.listExecutionSteps(lease.retryOf);
    const finalPlanStepNo = Math.max(...plan.steps.map(({ step_no }) => step_no));
    const authoritativeFailure = selectAuthoritativeFailedStep(previous.map((step) => ({
      stepNo: step.stepNo,
      state: step.state,
      failure: step.failure,
    })));
    const terminalRebuildEligible = deliverableId === 'research_strategy_report'
      && authoritativeFailure?.stepNo === finalPlanStepNo + 1
      && authoritativeFailure.failure?.kind === 'deliverable_validation'
      && plan.steps.every((step) => previous.some((prior) => (
        prior.stepNo === step.step_no
        && prior.actorType === step.actor_type
        && prior.actorId === step.actor_id
        && prior.state === 'succeeded'
        && typeof prior.outputArtifactId === 'string'
      )))
      && !plan.steps.some(({ actor_id }) => actor_id === 'playwright-page-capture');
    if (terminalRebuildEligible) {
      try {
        const modelCalls = await this.dependencies.repository.listModelCalls(lease.retryOf);
        const terminalReusable = new Map<number, ReusableExecution>();
        const terminalReusableOutputs: EngineSealedStepOutput[] = [];
        const expectedKinds: Record<EngineStep['actor_type'], StepArtifactKind> = {
          knowledge: 'knowledge_output',
          tool: 'tool_output',
          skill: plan.native ? 'skill_result' : 'skill_output',
          llm: 'llm_output',
          reviewer: 'review_output',
        };
        for (const step of plan.steps) {
          const prior = previous.find((candidate) => candidate.stepNo === step.step_no)!;
          const artifact = await this.dependencies.repository.getArtifact(prior.outputArtifactId!);
          const contributorOutput = !plan.native
            && step.actor_type === 'skill'
            && (plan.invocationPoliciesByStep.get(step.step_no) ?? []).some(({ role, skillId }) => (
              role === 'contributor' && skillId === step.actor_id
            ));
          const expectedKind = contributorOutput
            ? 'research_contribution'
            : expectedKinds[step.actor_type];
          if (
            !artifact
            || artifact.state !== 'SEALED'
            || !artifact.contentSha256
            || artifact.taskId !== lease.taskId
            || artifact.planVersionId !== lease.planVersionId
            || artifact.attemptId !== lease.retryOf
            || artifact.kind !== expectedKind
          ) throw new Error(`terminal rebuild Artifact for step ${step.step_no} is not reusable`);
          let provenance: Record<string, unknown> | null = null;
          if (step.actor_type === 'tool') {
            provenance = prior.toolProvenance;
            if (
              !provenance
              || provenance.planHash !== planHash
              || provenance.stepHash !== hashJson(step)
            ) throw new Error(`terminal rebuild Tool provenance for step ${step.step_no} drifted`);
          } else if (step.actor_type === 'knowledge' || step.actor_type === 'skill') {
            provenance = await this.matchReusableSkillProvenance({
              step,
              priorProvenance: prior.skillProvenance,
              plan,
              planHash,
              researchGoal,
              outputs: terminalReusableOutputs,
              lease,
            });
            if (!provenance) throw new Error(`terminal rebuild provenance for step ${step.step_no} drifted`);
          } else {
            const call = modelCalls.find((candidate) => (
              candidate.stepNo === step.step_no
              && candidate.stage === step.actor_type
              && candidate.status === 'succeeded'
            ));
            const priorModelProvenance = prior.skillProvenance?.kind === 'model_execution'
              || prior.skillProvenance?.kind === 'model_reuse'
              ? prior.skillProvenance
              : call ? {
                kind: 'model_reuse',
                planHash,
                stepHash: hashJson(step),
                sourceModelCallId: call.id,
                provider: call.provider,
                endpointHost: call.endpointHost,
                requestedModel: call.requestedModel,
                actualModel: call.actualModel,
                modelVersion: call.modelVersion,
                promptHash: call.promptHash,
                contextManifestHash: call.contextManifestHash,
                traceId: call.traceId,
                status: call.status,
              } : null;
            if (!priorModelProvenance) {
              throw new Error(`terminal rebuild Model receipt for step ${step.step_no} is missing`);
            }
            const receiptId = typeof priorModelProvenance.modelReceiptId === 'string'
              ? priorModelProvenance.modelReceiptId
              : typeof priorModelProvenance.sourceModelCallId === 'string'
                ? priorModelProvenance.sourceModelCallId
                : null;
            const receipt = receiptId
              ? await this.dependencies.repository.getModelCall(receiptId)
              : null;
            if (!receipt) {
              throw new Error(`terminal rebuild Model receipt for step ${step.step_no} is missing`);
            }
            provenance = await this.matchReusableModelProvenance({
              step,
              priorProvenance: priorModelProvenance,
              receipt,
              planHash,
              researchGoal,
              outputs: terminalReusableOutputs,
              expectedModel,
            });
            if (!provenance) {
              throw new Error(`terminal rebuild Model provenance for step ${step.step_no} drifted`);
            }
          }
          const stored = await this.dependencies.artifacts.readVerifiedJson<Record<string, unknown>>(artifact.id);
          if (expectedKind === 'research_contribution') {
            await this.assertReusableContributionSource(stored.value, lease);
          }
          const output = isRecord(stored.value) && 'output' in stored.value ? stored.value.output : stored.value;
          if (
            synthesizerPolicyForStep(plan, step)
            && containsRedactedMachineReference(output)
          ) throw new Error(`terminal rebuild Synthesizer checkpoint for step ${step.step_no} is contaminated`);
          terminalReusable.set(step.step_no, {
            output,
            outputArtifactId: artifact.id,
            artifactValue: stored.value,
            kind: artifact.kind as StepArtifactKind,
            schemaVersion: artifact.schemaVersion,
            provenance: { ...provenance, outputArtifactId: artifact.id, terminalRebuild: true },
          });
          terminalReusableOutputs.push({
            stepNo: step.step_no,
            actorType: step.actor_type,
            questionIds: [...step.question_ids],
            actorId: step.actor_id,
            kind: artifact.kind as StepArtifactKind,
            state: 'succeeded',
            taskId: artifact.taskId,
            planVersionId: artifact.planVersionId,
            attemptId: artifact.attemptId,
            artifact: {
              id: artifact.id,
              contentSha256: artifact.contentSha256,
              state: 'SEALED',
            },
            output,
          });
        }
        if (terminalReusable.size === plan.steps.length) return terminalReusable;
      } catch {
        // Any lineage, receipt, or Artifact drift falls back to the ordinary retry path.
      }
    }
    const reusableStepNos = new Set<number>();
    const reusableOutputs: EngineSealedStepOutput[] = [];
    for (const step of plan.steps) {
      const prior = previous.find((candidate) => candidate.stepNo === step.step_no);
      if (
        !prior
        || prior.state !== 'succeeded'
        || !prior.outputArtifactId
        || !step.depends_on.every((dependency) => reusableStepNos.has(dependency))
      ) continue;
      if (step.actor_type === 'tool' && step.actor_id === 'joyspace-read') continue;

      let provenance: Record<string, unknown> | null = null;
      if (step.actor_type === 'tool') {
        if (step.input_bindings.length > 0 || !prior.toolProvenance) continue;
        const tool = this.dependencies.skillLoader.getTool(step.actor_id);
        if (!tool) continue;
        const manifest = loadToolManifest(tool.path);
        const resolution = this.dependencies.tools.resolve(manifest);
        const current = resolution ? {
          planHash,
          stepHash: hashJson(step),
          inputHash: hashJson(step.input),
          manifestHash: hashFile(tool.path),
          inputSchemaHash: hashFile(manifest.input_schema),
          outputSchemaHash: hashFile(manifest.output_schema),
          configHash: toolConfigHash(manifest, resolution),
        } : null;
        const fields: Array<'planHash' | 'stepHash' | 'inputHash' | 'manifestHash' | 'inputSchemaHash' | 'outputSchemaHash' | 'configHash'> = [
          'planHash', 'stepHash', 'inputHash', 'manifestHash', 'inputSchemaHash', 'outputSchemaHash', 'configHash',
        ];
        if (!current || !fields.every((field) => current[field] === prior.toolProvenance?.[field])) continue;
        provenance = prior.toolProvenance;
      } else if (step.actor_type === 'knowledge' || step.actor_type === 'skill') {
        try {
          provenance = await this.matchReusableSkillProvenance({
            step,
            priorProvenance: prior.skillProvenance,
            plan,
            planHash,
            researchGoal,
            outputs: reusableOutputs,
            lease,
          });
          if (!provenance) continue;
        } catch {
          continue;
        }
      } else {
        continue;
      }

      const artifact = await this.dependencies.repository.getArtifact(prior.outputArtifactId);
      const contributorOutput = !plan.native
        && step.actor_type === 'skill'
        && (plan.invocationPoliciesByStep.get(step.step_no) ?? []).some(({ role, skillId }) => (
          role === 'contributor' && skillId === step.actor_id
        ));
      const expectedKind: StepArtifactKind = step.actor_type === 'tool'
        ? 'tool_output'
        : step.actor_type === 'knowledge'
          ? 'knowledge_output'
          : contributorOutput ? 'research_contribution' : plan.native ? 'skill_result' : 'skill_output';
      if (
        !artifact
        || artifact.state !== 'SEALED'
        || !artifact.contentSha256
        || artifact.taskId !== lease.taskId
        || artifact.planVersionId !== lease.planVersionId
        || artifact.attemptId !== lease.retryOf
        || artifact.kind !== expectedKind
      ) continue;
      try {
        const stored = await this.dependencies.artifacts.readVerifiedJson<Record<string, unknown>>(artifact.id);
        if (expectedKind === 'research_contribution') {
          await this.assertReusableContributionSource(stored.value, lease);
        }
        const output = isRecord(stored.value) && 'output' in stored.value ? stored.value.output : stored.value;
        if (
          synthesizerPolicyForStep(plan, step)
          && containsRedactedMachineReference(output)
        ) throw new Error(`reusable Synthesizer checkpoint for step ${step.step_no} is contaminated`);
        reusable.set(step.step_no, {
          output,
          outputArtifactId: artifact.id,
          artifactValue: stored.value,
          kind: artifact.kind as StepArtifactKind,
          schemaVersion: artifact.schemaVersion,
          provenance: { ...provenance, outputArtifactId: artifact.id },
        });
        reusableStepNos.add(step.step_no);
        reusableOutputs.push({
          stepNo: step.step_no,
          actorType: step.actor_type,
          questionIds: [...step.question_ids],
          actorId: step.actor_id,
          kind: artifact.kind as StepArtifactKind,
          state: 'succeeded',
          taskId: artifact.taskId,
          planVersionId: artifact.planVersionId,
          attemptId: artifact.attemptId,
          artifact: {
            id: artifact.id,
            contentSha256: artifact.contentSha256,
            state: 'SEALED',
          },
          output,
        });
      } catch {
        // Invalidity propagates through dependencies because this step is not marked reusable.
      }
    }
    return reusable;
  }

  private async assertReusableContributionSource(
    value: unknown,
    lease: ControlExecutionLease,
  ): Promise<void> {
    this.dependencies.validator.validateOrThrow('research-contribution-artifact-v1', value);
    if (!isRecord(value) || !isRecord(value.source)) {
      throw new Error('reusable Contribution source is malformed');
    }
    const source = value.source;
    if (
      typeof source.artifactId !== 'string'
      || typeof source.artifactContentSha256 !== 'string'
      || typeof source.schemaVersion !== 'string'
    ) throw new Error('reusable Contribution source identity is malformed');
    const verified = await this.dependencies.artifacts.readVerifiedJson<unknown>(source.artifactId);
    if (
      verified.artifact.state !== 'SEALED'
      || verified.artifact.contentSha256 !== source.artifactContentSha256
      || verified.artifact.schemaVersion !== source.schemaVersion
      || verified.artifact.taskId !== lease.taskId
      || verified.artifact.planVersionId !== lease.planVersionId
    ) throw new Error(`reusable Contribution source Artifact ${source.artifactId} drifted`);
  }

  private async matchReusableModelProvenance(input: {
    step: EngineStep;
    priorProvenance: Record<string, unknown>;
    receipt: ControlModelCall;
    planHash: string;
    researchGoal: string;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
  }): Promise<Record<string, unknown> | null> {
    const executionOutputs = await this.outputsForPriorExecution(
      input.step,
      input.outputs,
      input.priorProvenance,
    );
    const resolvedInput = await resolveStepInput(
      input.step,
      executionOutputs,
      this.dependencies.artifacts,
    );
    const execution = modelStepExecution({
      step: input.step,
      researchGoal: input.researchGoal,
      resolvedInput,
      outputs: executionOutputs,
    });
    const identity = this.dependencies.llm.identity;
    const priorExecutionPromptHash = typeof input.priorProvenance.executionPromptHash === 'string'
      ? input.priorProvenance.executionPromptHash
      : input.priorProvenance.promptHash;
    const receiptMatches = input.receipt.stage === input.step.actor_type
      && input.receipt.stepNo === input.step.step_no
      && input.receipt.provider === input.priorProvenance.provider
      && input.receipt.endpointHost === input.priorProvenance.endpointHost
      && input.receipt.requestedModel === input.priorProvenance.requestedModel
      && input.receipt.actualModel === input.priorProvenance.actualModel
      && input.receipt.modelVersion === input.priorProvenance.modelVersion
      && input.receipt.promptHash === input.priorProvenance.promptHash
      && input.receipt.contextManifestHash === input.priorProvenance.contextManifestHash
      && input.receipt.traceId === (input.priorProvenance.traceId ?? null)
      && input.receipt.status === 'succeeded'
      && input.receipt.failure === null;
    const fieldsMatch = input.priorProvenance.planHash === input.planHash
      && input.priorProvenance.stepHash === hashJson(input.step)
      && priorExecutionPromptHash === execution.executionPromptHash
      && input.priorProvenance.contextManifestHash === execution.contextManifestHash
      && input.priorProvenance.provider === identity.provider
      && input.priorProvenance.endpointHost === identity.endpointHost
      && input.priorProvenance.requestedModel === identity.requestedModel
      && input.priorProvenance.actualModel === input.expectedModel
      && input.priorProvenance.status === 'succeeded';
    if (!receiptMatches || !fieldsMatch) return null;
    if (
      input.priorProvenance.outputSchemaHash !== undefined
      && input.priorProvenance.outputSchemaHash !== execution.outputSchemaHash
    ) return null;
    return input.priorProvenance;
  }

  private async outputsForPriorExecution(
    step: EngineStep,
    outputs: EngineSealedStepOutput[],
    provenance: Record<string, unknown>,
  ): Promise<EngineSealedStepOutput[]> {
    if (provenance.inputArtifacts === undefined) return outputs;
    if (!Array.isArray(provenance.inputArtifacts)) {
      throw new Error(`step ${step.step_no} input Artifact provenance is malformed`);
    }
    const identities = provenance.inputArtifacts.map((candidate) => {
      if (
        !isRecord(candidate)
        || !Number.isInteger(candidate.stepNo)
        || typeof candidate.artifactId !== 'string'
        || typeof candidate.contentSha256 !== 'string'
      ) throw new Error(`step ${step.step_no} input Artifact provenance is malformed`);
      return {
        stepNo: candidate.stepNo as number,
        artifactId: candidate.artifactId,
        contentSha256: candidate.contentSha256,
      };
    });
    const relevantStepNos = new Set([
      ...step.depends_on,
      ...step.input_bindings.map((binding) => binding.source_step_no),
    ]);
    const relevantOutputs = outputs.filter(({ stepNo }) => relevantStepNos.has(stepNo));
    if (
      identities.length !== relevantOutputs.length
      || new Set(identities.map(({ stepNo }) => stepNo)).size !== identities.length
    ) throw new Error(`step ${step.step_no} input Artifact provenance does not match its dependencies`);

    const restored: EngineSealedStepOutput[] = [];
    for (const current of relevantOutputs) {
      const identity = identities.find(({ stepNo }) => stepNo === current.stepNo);
      if (!identity) {
        throw new Error(`step ${step.step_no} input Artifact provenance is incomplete`);
      }
      const historical = await this.dependencies.repository.getArtifact(identity.artifactId);
      if (
        !historical
        || historical.state !== 'SEALED'
        || historical.contentSha256 !== identity.contentSha256
        || !historical.planVersionId
        || !historical.attemptId
        || historical.taskId !== current.taskId
        || historical.planVersionId !== current.planVersionId
        || historical.kind !== current.kind
      ) throw new Error(`step ${step.step_no} input Artifact ${identity.artifactId} is not reusable`);
      const currentVerified = await readVerifiedStepArtifact(current, this.dependencies.artifacts);
      const historicalOutput: EngineSealedStepOutput = {
        ...current,
        taskId: historical.taskId,
        planVersionId: historical.planVersionId,
        attemptId: historical.attemptId,
        artifact: {
          id: historical.id,
          contentSha256: historical.contentSha256,
          state: 'SEALED',
        },
      };
      const historicalVerified = await readVerifiedStepArtifact(
        historicalOutput,
        this.dependencies.artifacts,
      );
      const rebound = rebindReusableArtifactValue(
        current.kind,
        historicalVerified.value,
        {
          taskId: current.taskId,
          planVersionId: current.planVersionId,
          attemptId: current.attemptId,
        },
      );
      if (!isDeepStrictEqual(rebound, currentVerified.value)) {
        throw new Error(`step ${step.step_no} input Artifact ${identity.artifactId} changed across retry`);
      }
      restored.push({ ...historicalOutput, output: historicalVerified.output });
    }
    return restored.sort((left, right) => left.stepNo - right.stepNo);
  }

  private async restoreReusableSynthesizerInput(input: {
    step: EngineStep;
    plan: EnginePlan;
    lease: ControlExecutionLease;
    priorProvenance: Record<string, unknown>;
    resolvedInput: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const synthesizerPolicy = synthesizerPolicyForStep(input.plan, input.step);
    if (
      !synthesizerPolicy
      || !Array.isArray(input.resolvedInput.contribution_order)
      || !isRecord(input.resolvedInput.contribution_bundle)
    ) return input.resolvedInput;

    const identity = input.priorProvenance.contributionBundleArtifact;
    if (
      !isRecord(identity)
      || typeof identity.id !== 'string'
      || typeof identity.contentSha256 !== 'string'
    ) throw new Error(`step ${input.step.step_no} Contribution Bundle provenance is missing`);
    const artifact = await this.dependencies.repository.getArtifact(identity.id);
    if (
      !artifact
      || artifact.state !== 'SEALED'
      || artifact.contentSha256 !== identity.contentSha256
      || artifact.taskId !== input.lease.taskId
      || artifact.planVersionId !== input.lease.planVersionId
      || typeof artifact.attemptId !== 'string'
      || artifact.kind !== 'research_contribution_bundle'
      || artifact.schemaVersion !== 'research-contribution-bundle-v1'
    ) throw new Error(`step ${input.step.step_no} Contribution Bundle Artifact is not reusable`);

    const stored = await this.dependencies.artifacts.readVerifiedJson<Record<string, unknown>>(artifact.id);
    this.dependencies.validator.validateOrThrow('research-contribution-bundle-v1', stored.value);
    const expected = buildResearchContributionBundle({
      taskId: input.lease.taskId,
      planVersionId: input.lease.planVersionId,
      attemptId: artifact.attemptId,
      orderedInvocationIds: input.resolvedInput.contribution_order.filter(
        (invocationId): invocationId is string => typeof invocationId === 'string',
      ),
      valuesByInvocationId: input.resolvedInput.contribution_bundle,
      policiesByInvocationId: input.plan.invocationPoliciesById,
      synthesizerInvocationId: synthesizerPolicy.invocationId,
      validator: this.dependencies.validator,
    });
    if (!isDeepStrictEqual(stored.value, expected)) {
      throw new Error(`step ${input.step.step_no} Contribution Bundle content drifted`);
    }
    return {
      ...input.resolvedInput,
      contribution_bundle: stored.value,
      contribution_bundle_artifact: {
        id: artifact.id,
        contentSha256: artifact.contentSha256,
      },
    };
  }

  private async matchReusableSkillProvenance(input: {
    step: EngineStep;
    priorProvenance: Record<string, unknown> | null;
    plan: EnginePlan;
    planHash: string;
    researchGoal: string;
    outputs: EngineSealedStepOutput[];
    lease: ControlExecutionLease;
  }): Promise<Record<string, unknown> | null> {
    const prior = input.priorProvenance;
    if (
      !prior
      || prior.planHash !== input.planHash
      || prior.stepHash !== hashJson(input.step)
    ) return null;
    const executionOutputs = await this.outputsForPriorExecution(
      input.step,
      input.outputs,
      prior,
    );
    let resolvedInput = await resolveStepInput(
      input.step,
      executionOutputs,
      this.dependencies.artifacts,
    );
    if (input.step.actor_type === 'knowledge') {
      const current = (await this.runKnowledge({
        step: input.step,
        lease: input.lease,
        resolvedInput,
      })).skillProvenance;
      return current
        && isDeepStrictEqual(prior.kind, current.kind)
        && isDeepStrictEqual(prior.contractHash, current.contractHash)
        && isDeepStrictEqual(prior.resources, current.resources)
        ? prior
        : null;
    }
    if (input.step.actor_type !== 'skill') return null;
    const nativeSkill = input.plan.native?.runSpecsByStep.get(input.step.step_no);
    if (nativeSkill && input.plan.native) {
      const runSpec = nativeSkill.runSpec;
      const expectedReferenceHashes = [
        { path: runSpec.entry_path, hash: runSpec.body_hash },
        ...runSpec.selected_references.map(({ path, contentHash }) => ({ path, hash: contentHash })),
      ];
      return prior.skillBodyHash === runSpec.body_hash
        && prior.inputSchemaHash === runSpec.input_requirements_hash
        && prior.outputSchemaHash === hashJson(NATIVE_SKILL_RESULT_VERSION)
        && prior.payloadSchemaHash === null
        && isDeepStrictEqual(prior.skillReferenceHashes, expectedReferenceHashes)
        && prior.inputHash === hashJson(resolvedInput)
        ? prior
        : null;
    }
    resolvedInput = await this.restoreReusableSynthesizerInput({
      step: input.step,
      plan: input.plan,
      lease: input.lease,
      priorProvenance: prior,
      resolvedInput,
    });
    const prepared = prepareSkillExecution({
      skillId: input.step.actor_id,
      researchGoal: input.researchGoal,
      resolvedInput: compactLlmInput(resolvedInput) as Record<string, unknown>,
      priorOutputs: verifiedPriorOutputs(executionOutputs, input.step),
      stepContract: stepContract(input.step),
      skillLoader: this.dependencies.skillLoader,
      validator: this.dependencies.validator,
      frozenExecution: input.plan.frozenSkillExecutions.get(input.step.step_no),
    });
    const current = skillExecutionFingerprint({
      prepared,
      step: input.step,
      resolvedInput,
      outputs: executionOutputs,
    }).fingerprint;
    return Object.entries(current).every(([field, value]) => (
      isDeepStrictEqual(prior[field], value)
    )) ? prior : null;
  }

  private async preflight(plan: EnginePlan, researchGoal: string): Promise<ExecutionAuthenticityError | null> {
    const optionalToolStepNos = plan.optionalToolStepNos;
    const requiresPublicSource = plan.evidence_requirements.some((requirement) => (
      requirement.required && requirement.acceptedClasses.includes('public_source')
    ));
    let publicEvidencePolicyFailure = false;
    if (requiresPublicSource) {
      publicEvidencePolicyFailure = !plan.steps.some((step) => {
        if (step.actor_type !== 'tool') return false;
        if (optionalToolStepNos.has(step.step_no)) return false;
        const registryEntry = this.dependencies.skillLoader.getTool(step.actor_id);
        if (!registryEntry) return false;
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
          if (plan.native) {
            if (!plan.native.runSpecsByStep.has(step.step_no)) {
              return new ExecutionAuthenticityError(`native Skill ${step.actor_id} has no frozen snapshot`);
            }
            continue;
          }
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
        const frozenOptional = optionalToolStepNos.has(step.step_no);
        const tool = frozenOptional
          ? this.dependencies.skillLoader.getRegisteredTool(step.actor_id)
          : this.dependencies.skillLoader.getTool(step.actor_id);
        if (!tool) {
          if (frozenOptional) continue;
          return new ExecutionAuthenticityError(`tool ${step.actor_id} is not active`);
        }
        if (
          !frozenOptional
          && tool.tier === 'optional'
          && tool.adapter_type === 'playwright'
        ) {
          return new ExecutionAuthenticityError(
            `optional tool ${step.actor_id} has no frozen optional authorization`,
          );
        }
        if (frozenOptional && tool.status !== 'active') continue;
        let manifest: ToolManifest;
        try {
          manifest = loadToolManifest(tool.path);
        } catch (error) {
          if (frozenOptional) continue;
          throw error;
        }
        const resolution = this.dependencies.tools.resolve(manifest);
        const toolInput = step.input;
        if (step.input_bindings.length === 0) {
          this.dependencies.validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
        }
        if (
          !resolution
          || resolution.executionMode !== 'real'
          || resolution.declaredAdapterType !== resolution.resolvedAdapterType
          || resolution.implementationId === 'unknown'
        ) {
          if (frozenOptional) continue;
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

  private startLeaseHeartbeat(
    lease: ControlExecutionLease,
    onFailure?: (error: unknown) => void,
  ): LeaseHeartbeatHandle {
    let heartbeatFailure: unknown = null;
    const timer = setInterval(() => {
      void this.dependencies.repository.heartbeatExecutionLease({
        ...lease,
        extendUntil: new Date(Date.now() + this.dependencies.heartbeatMs),
      }).catch((error: unknown) => {
        if (heartbeatFailure) return;
        heartbeatFailure = error;
        onFailure?.(error);
      });
    }, Math.max(1, Math.min(1_000, Math.floor(this.dependencies.heartbeatMs / 2))));
    return {
      assertHealthy: () => {
        if (heartbeatFailure) throw heartbeatFailure;
      },
      stop: () => clearInterval(timer),
    };
  }

  private createToolExecutionScope(): ToolExecutionScope {
    return new ToolExecutionScope(
      Date.now() + (this.dependencies.toolExecutionDeadlineMs ?? TOOL_EXECUTION_DEADLINE_MS),
    );
  }

  private async requireActiveToolLease(
    lease: ControlExecutionLease,
    toolId: string,
    context: ToolInvocationContext,
    onLeaseLost?: () => void,
  ): Promise<void> {
    try {
      await runWithinToolScope(
        () => this.dependencies.repository.requireActiveLease(lease),
        toolId,
        context,
      );
    } catch (error) {
      if (!(error instanceof ToolInvocationError)) onLeaseLost?.();
      throw error;
    }
  }

  private async withLeaseHeartbeat<T>(
    lease: ControlExecutionLease,
    operation: (guard: { ensureActive: () => Promise<void>; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const heartbeat = this.startLeaseHeartbeat(lease, (error) => controller.abort(error));
    const ensureActive = async (): Promise<void> => {
      heartbeat.assertHealthy();
      await this.dependencies.repository.requireActiveLease(lease);
      heartbeat.assertHealthy();
    };
    let operationSucceeded = false;
    let operationResult: T | undefined;
    try {
      operationResult = await operation({ ensureActive, signal: controller.signal });
      operationSucceeded = true;
      await ensureActive();
      return operationResult as T;
    } catch (error) {
      heartbeat.assertHealthy();
      if (operationSucceeded) attachToolAttemptReceipts(error, operationResult);
      throw error;
    } finally {
      heartbeat.stop();
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
    optionalTool: boolean;
    frozenSkillExecution?: FrozenSkillExecutionBinding;
    nativeSkill?: {
      invocationId: string;
      runSpec: NativeSkillRunSpec;
    };
    nativeResolvedInputs?: ResolvedPlanInputs;
    onSkillPrepared?: (fingerprint: SkillExecutionFingerprint) => void;
    toolContext?: ToolInvocationContext;
    onToolLeaseLost?: () => void;
    cancellationSignal?: AbortSignal;
  }): Promise<StepResult> {
    if (input.step.actor_type === 'tool') {
      if (!input.toolContext) throw new ExecutionAuthenticityError('tool execution context is missing');
      await this.requireActiveToolLease(
        input.lease,
        input.step.actor_id,
        input.toolContext,
        input.onToolLeaseLost,
      );
      return this.runTool(
        input.step,
        input.researchGoal,
        input.resolvedInput,
        input.lease,
        input.toolContext,
        input.onToolLeaseLost,
        input.optionalTool,
      );
    }
    await this.dependencies.repository.requireActiveLease(input.lease);
    if (input.cancellationSignal?.aborted) {
      throw input.cancellationSignal.reason ?? new Error('execution cancelled');
    }
    switch (input.step.actor_type) {
      case 'knowledge':
        return this.runKnowledge(input);
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
    frozenOptional = false,
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
      inputHash: hashJson(resolvedInput),
      outputHash: typeof details.outputHash === 'string' ? details.outputHash : null,
      configHash: null,
      declaredAdapterType: receipt?.declaredAdapterType ?? 'unknown',
      resolvedAdapterType: receipt?.resolvedAdapterType ?? 'unknown',
      implementationId: receipt?.implementationId ?? 'unknown',
      executionMode: receipt?.executionMode ?? 'unknown',
      endpointHost: receipt?.endpointHost ?? null,
      ...(receipt?.runtimeVersions === undefined
        ? {}
        : { runtimeVersions: { ...receipt.runtimeVersions } }),
      sourceRefs: refs,
      ...(attemptReceipts ? { attemptReceipts } : {}),
      status: 'failed',
      captureFailure: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
    });
    try {
      const tool = frozenOptional
        ? this.dependencies.skillLoader.getRegisteredTool(step.actor_id)
        : this.dependencies.skillLoader.getTool(step.actor_id);
      if (!tool) return fallback(new Error(`tool ${step.actor_id} unavailable during provenance capture`));
      const manifest = loadToolManifest(tool.path);
      const resolution = this.dependencies.tools.resolve(manifest);
      const toolInput = resolvedInput;
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
        ...(receipt?.runtimeVersions === undefined
          ? {}
          : { runtimeVersions: { ...receipt.runtimeVersions } }),
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
    resolvedInput: Record<string, unknown>;
    producedOutputHash?: string;
    schemaHashes?: {
      inputSchemaHash: string | null;
      outputSchemaHash: string;
      payloadSchemaHash: string | null;
    };
    preparedFingerprint?: SkillExecutionFingerprint;
    modelReceipt?: { id: string; promptHash: string; traceId: string | null };
  }): Promise<Record<string, unknown>> {
    let receipt = input.modelReceipt;
    let skillBodyHash: string | null = null;
    let inputSchemaHash = input.schemaHashes?.inputSchemaHash ?? null;
    let outputSchemaHash = input.schemaHashes?.outputSchemaHash ?? null;
    let payloadSchemaHash = input.schemaHashes?.payloadSchemaHash ?? null;
    const fallback = (captureFailure: unknown): Record<string, unknown> => ({
      ...(input.preparedFingerprint ?? {
        skillBodyHash,
        inputSchemaHash,
        outputSchemaHash,
        payloadSchemaHash,
        inputHash: hashJson(input.resolvedInput),
        executionPromptHash: null,
      }),
      outputHash: input.producedOutputHash ?? null,
      promptHash: receipt?.promptHash ?? input.preparedFingerprint?.executionPromptHash ?? null,
      traceId: receipt?.traceId ?? null,
      modelReceiptId: receipt?.id ?? null,
      outputArtifactId: null,
      status: 'failed',
      captureFailure: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
    });
    try {
      if (!receipt) {
        const calls = await this.dependencies.repository.listModelCalls(input.lease.attemptId);
        const matching = [...calls].reverse().filter(
          (call) => call.stepNo === input.step.step_no,
        );
        receipt = matching.find((call) => call.stage === 'skill_repair')
          ?? matching.find((call) => call.stage === 'skill');
      }
      if (input.preparedFingerprint) {
        return {
          ...input.preparedFingerprint,
          outputHash: input.producedOutputHash ?? null,
          promptHash: receipt?.promptHash ?? input.preparedFingerprint.executionPromptHash,
          traceId: receipt?.traceId ?? null,
          modelReceiptId: receipt?.id ?? null,
          outputArtifactId: null,
          status: 'failed',
        };
      }
      const skill = this.dependencies.skillLoader.getSkill(input.step.actor_id);
      if (!skill) return fallback(new Error(`skill ${input.step.actor_id} unavailable during provenance capture`));
      const body = this.dependencies.skillLoader.loadSkillBody(input.step.actor_id);
      skillBodyHash = body.hash;
      inputSchemaHash ??= skill.input_schema ? hashFile(skill.input_schema) : null;
      outputSchemaHash ??= skill.output_schema ? hashFile(skill.output_schema) : null;
      payloadSchemaHash ??= skill.payload_schema ? hashFile(skill.payload_schema) : null;
      return {
        skillBodyHash,
        inputSchemaHash,
        outputSchemaHash,
        payloadSchemaHash,
        inputHash: hashJson(input.resolvedInput),
        outputHash: input.producedOutputHash ?? null,
        promptHash: receipt?.promptHash ?? null,
        executionPromptHash: null,
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
    context: ToolInvocationContext,
    onLeaseLost?: () => void,
    frozenOptional = false,
  ): Promise<StepResult> {
    const tool = frozenOptional
      ? this.dependencies.skillLoader.getRegisteredTool(step.actor_id)
      : this.dependencies.skillLoader.getTool(step.actor_id);
    if (!tool) {
      if (frozenOptional) {
        throw new ToolInvocationError(step.actor_id, {
          kind: 'configuration',
          retryable: false,
          providerStatus: null,
          sanitizedMessage: 'optional tool is no longer registered',
        });
      }
      throw new ExecutionAuthenticityError(`tool ${step.actor_id} is not active`);
    }
    if (frozenOptional && tool.status !== 'active') {
      throw new ToolInvocationError(step.actor_id, {
        kind: 'configuration',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'optional tool is no longer active',
      });
    }
    let manifest: ToolManifest;
    try {
      manifest = loadToolManifest(tool.path);
    } catch (error) {
      if (!frozenOptional) throw error;
      throw new ToolInvocationError(step.actor_id, {
        kind: 'configuration',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'optional tool manifest is unavailable',
      });
    }
    const resolution = this.dependencies.tools.resolve(manifest);
    if (
      !resolution
      || resolution.executionMode !== 'real'
      || resolution.declaredAdapterType !== resolution.resolvedAdapterType
      || resolution.implementationId === 'unknown'
    ) {
      const resolutionDetails = {
          declaredAdapterType: manifest.adapter_type,
          resolvedAdapterType: resolution?.resolvedAdapterType ?? 'unknown',
          implementationId: resolution?.implementationId ?? 'unknown',
          executionMode: resolution?.executionMode ?? 'unknown',
          endpointHost: resolution?.endpointHost ?? null,
      };
      if (frozenOptional) {
        throw new ToolInvocationError(step.actor_id, {
          kind: 'configuration',
          retryable: false,
          providerStatus: null,
          sanitizedMessage: 'optional tool has no qualifying real adapter',
          details: resolutionDetails,
        });
      }
      throw new ExecutionAuthenticityError(
        `tool ${step.actor_id} has no qualifying real adapter`,
        resolutionDetails,
      );
    }
    const toolInput = resolvedInput;
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
      context,
      onLeaseLost,
      isLeaseActive: async () => {
        try {
          await this.dependencies.repository.requireActiveLease(lease);
          return true;
        } catch {
          return false;
        }
      },
      sleep: sleepWithSignal,
      invoke: (context) => this.dependencies.tools.invoke({
        toolId: step.actor_id,
        input: toolInput,
        manifest,
        context: context.invocation,
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
          ...retryResult.failure.details,
          ...(retryResult.failure.abortReason
            ? { abortReason: retryResult.failure.abortReason }
            : {}),
          retry: {
            attempts: retryResult.failure.attempts,
            maxAttempts: retryResult.failure.maxAttempts,
            attemptReceipts: retryResult.attemptReceipts,
          },
        },
      });
    }
    try {
      await this.requireActiveToolLease(lease, step.actor_id, context, onLeaseLost);
    } catch (error) {
      if (error instanceof ToolInvocationError && error.kind === 'timeout') {
        throw new ToolInvocationError(step.actor_id, {
          kind: 'timeout',
          retryable: true,
          providerStatus: error.providerStatus,
          sanitizedMessage: error.sanitizedMessage,
          receipt: retryResult.receipt,
          details: {
            ...error.details,
            retry: {
              attempts: retryResult.attemptReceipts.length,
              maxAttempts: manifest.retry_policy?.max_attempts ?? retryResult.attemptReceipts.length,
              attemptReceipts: retryResult.attemptReceipts,
            },
          },
        });
      }
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
      mediaAttachments: retryResult.mediaAttachments,
      knowledgeAttachments: retryResult.knowledgeAttachments,
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
      mediaAttachments: result.mediaAttachments,
      knowledgeAttachments: result.knowledgeAttachments,
      toolTier: frozenOptional ? 'optional' : 'core',
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

  private async runKnowledge(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    resolvedInput: Record<string, unknown>;
  }): Promise<StepResult> {
    const references = input.resolvedInput.references;
    const contractHash = input.resolvedInput.contractHash;
    if (!Array.isArray(references) || typeof contractHash !== 'string') {
      throw new ExecutionAuthenticityError('knowledge step has no frozen references or contract hash');
    }
    const parsedReferences: FrozenKnowledgeReference[] = references.map((reference) => {
      if (
        !isRecord(reference)
        || typeof reference.resourceId !== 'string'
        || typeof reference.resourceType !== 'string'
        || typeof reference.sourcePath !== 'string'
        || (reference.status !== 'approved' && reference.status !== 'draft')
        || typeof reference.contentHash !== 'string'
        || typeof reference.required !== 'boolean'
        || (reference.failurePolicy !== 'block' && reference.failurePolicy !== 'gap')
        || (reference.queryId !== undefined && typeof reference.queryId !== 'string')
      ) {
        throw new ExecutionAuthenticityError('knowledge step contains a malformed frozen reference');
      }
      return reference as unknown as FrozenKnowledgeReference;
    });
    const resolved = new KnowledgeBundleResolver(this.dependencies.validator).resolve({
      taskId: input.lease.taskId,
      planVersionId: input.lease.planVersionId,
      attemptId: input.lease.attemptId,
      stepNo: input.step.step_no,
      contractHash,
      references: parsedReferences,
    });
    return {
      output: resolved.bundle,
      kind: 'knowledge_output',
      knowledgeGaps: resolved.gaps,
      skillProvenance: {
        kind: 'knowledge',
        contractHash,
        resources: resolved.bundle.resources.map(({ id, status, sourcePath, contentHash }) => ({
          id,
          status,
          sourcePath,
          contentHash,
        })),
      },
    };
  }

  private async runNativeSkill(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
    cancellationSignal?: AbortSignal;
    nativeSkill: {
      invocationId: string;
      runSpec: NativeSkillRunSpec;
    };
    nativeResolvedInputs?: ResolvedPlanInputs;
    onSkillPrepared?: (fingerprint: SkillExecutionFingerprint) => void;
  }): Promise<StepResult> {
    if (!input.nativeResolvedInputs) {
      throw new ExecutionAuthenticityError('native Skill input bindings are unavailable');
    }
    const { invocationId, runSpec } = input.nativeSkill;
    if (runSpec.skill_id !== input.step.actor_id) {
      throw new ExecutionAuthenticityError(`native Skill run spec ${runSpec.skill_id} does not match ${input.step.actor_id}`);
    }
    const sources = nativeSourceReferences({
      step: input.step,
      outputs: input.outputs,
      resolvedInputs: input.nativeResolvedInputs,
      invocationId,
      runSpec,
    });
    const deterministicGaps = nativeWaivedGaps(
      input.nativeResolvedInputs,
      invocationId,
    );
    const context = {
      researchGoal: input.researchGoal,
      resolvedInput: compactLlmInput(input.resolvedInput),
      priorOutputs: verifiedPriorOutputs(input.outputs, input.step),
      sourceCatalog: sources,
      waivedInputs: deterministicGaps,
    };
    const prompt = nativeSkillPrompt(runSpec);
    const fingerprint: SkillExecutionFingerprint = {
      skillBodyHash: runSpec.body_hash,
      inputSchemaHash: runSpec.input_requirements_hash,
      outputSchemaHash: hashJson(NATIVE_SKILL_RESULT_VERSION),
      payloadSchemaHash: null,
      skillReferenceHashes: [
        { path: runSpec.entry_path, hash: runSpec.body_hash },
        ...runSpec.selected_references.map(({ path, contentHash }) => ({ path, hash: contentHash })),
      ],
      inputArtifacts: executionInputArtifacts(input.outputs, input.step),
      inputHash: hashJson(input.resolvedInput),
      executionPromptHash: hashPrompt(prompt, context, `native-skill-result:${input.step.actor_id}`),
    };
    input.onSkillPrepared?.(fingerprint);
    const generated = await this.llm.generateStructured<NativeSkillResultDraft>({
      prompt,
      schema: NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
      schemaName: `skill:${input.step.actor_id}`,
      context,
      ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
      receipt: {
        stage: 'skill',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: hashJson(context),
        expectedModel: input.expectedModel,
      },
    });
    if (!generated.receiptId) {
      throw new MissingModelReceiptError(new Error('successful native Skill call has no receipt ID'));
    }
    this.dependencies.validator.validateSchemaOrThrow(
      NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
      generated.data,
      `skill:${input.step.actor_id}`,
    );
    const allowedInputKeys = new Map(runSpec.input_requirements.map((requirement) => [requirement.key, requirement]));
    const requestedInputKeys = generated.data.missingInputKeys ?? [];
    const unknownInputKeys = requestedInputKeys.filter((key) => !allowedInputKeys.has(key));
    if (unknownInputKeys.length > 0) {
      throw new LLMInvocationError(
        'schema',
        false,
        null,
        `Skill requested unknown input keys: ${unknownInputKeys.join(', ')}`,
      );
    }
    const optionalRequestedInputKeys = requestedInputKeys.filter((key) => allowedInputKeys.get(key)?.required === false);
    const blockingInputKeys = requestedInputKeys.filter((key) => allowedInputKeys.get(key)?.required === true);
    const draft = generated.data.status === 'needs_input' && blockingInputKeys.length === 0
      ? {
          ...generated.data,
          status: 'completed_with_gaps' as const,
          missingInputKeys: [],
          gaps: [
            ...generated.data.gaps,
            ...optionalRequestedInputKeys.map((key) => `可选输入 ${key} 未提供，已按可用证据继续。`),
          ],
        }
      : generated.data;
    const result = createNativeSkillResult({
      skillId: input.step.actor_id,
      invocationId,
      draft,
      sources,
      deterministicGaps,
    });
    assertNativeContentReferences(result.primary.content, sources);
    return {
      output: result,
      kind: 'skill_result',
      outputHash: hashJson(result),
      skillProvenance: {
        ...fingerprint,
        outputHash: hashJson(result),
        promptHash: generated.promptHash,
        traceId: generated.traceId,
        modelReceiptId: generated.receiptId,
      },
    };
  }

  private async runSkill(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
    cancellationSignal?: AbortSignal;
    frozenSkillExecution?: FrozenSkillExecutionBinding;
    nativeSkill?: {
      invocationId: string;
      runSpec: NativeSkillRunSpec;
    };
    nativeResolvedInputs?: ResolvedPlanInputs;
    onSkillPrepared?: (fingerprint: SkillExecutionFingerprint) => void;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('skill LLM provider is not eligible as real');
    }
    if (input.nativeSkill) {
      return this.runNativeSkill({ ...input, nativeSkill: input.nativeSkill });
    }
    const skill = this.dependencies.skillLoader.getSkill(input.step.actor_id);
    if (!skill) throw new ExecutionAuthenticityError(`skill ${input.step.actor_id} is not active`);
    let prepared;
    try {
      prepared = prepareSkillExecution({
        skillId: input.step.actor_id,
        researchGoal: input.researchGoal,
        resolvedInput: compactLlmInput(input.resolvedInput) as Record<string, unknown>,
        priorOutputs: verifiedPriorOutputs(input.outputs, input.step),
        stepContract: stepContract(input.step),
        skillLoader: this.dependencies.skillLoader,
        validator: this.dependencies.validator,
        frozenExecution: input.frozenSkillExecution,
      });
    } catch (error) {
      if (error instanceof SkillRuntimeDriftError) throw error;
      throw new LLMInvocationError('schema', false, null, 'skill input failed schema validation');
    }
    const { schemas, schemaHashes, context: skillContext } = prepared;
    const execution = skillExecutionFingerprint({
      prepared,
      step: input.step,
      resolvedInput: input.resolvedInput,
      outputs: input.outputs,
    });
    input.onSkillPrepared?.(execution.fingerprint);
    const generate = (validationFeedback: string[] = [], invalidOutput?: unknown) => {
      const repair = validationFeedback.length > 0;
      const prompt = repair
        ? skillSchemaRepairPrompt(input.step.actor_id, validationFeedback)
        : execution.executionPrompt;
      const context = repair
        ? {
            invalid_output: redactSensitiveValue(invalidOutput),
            validation_feedback: validationFeedback,
          }
        : skillContext;
      return this.llm.generateStructured<object>({
        prompt,
        schema: schemas.output ?? {},
        schemaName: `skill:${input.step.actor_id}`,
        context,
        ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
        receipt: {
          stage: repair ? 'skill_repair' : 'skill',
          attemptId: input.lease.attemptId,
          stepNo: input.step.step_no,
          contextManifestHash: hashJson(context),
          expectedModel: input.expectedModel,
        },
      });
    };
    let result = await generate();
    if (!result.receiptId) {
      throw new MissingModelReceiptError(new Error('successful Skill call has no receipt ID'));
    }
    try {
      this.dependencies.validator.validateSchemaOrThrow(
        schemas.output,
        result.data,
        `skill:${input.step.actor_id}`,
      );
    } catch (error) {
      const validationFeedback = skillSchemaErrors(error);
      if (input.cancellationSignal?.aborted) {
        throw input.cancellationSignal.reason
          ?? new LLMInvocationError('cancelled', false, null, 'skill schema repair cancelled');
      }
      result = await generate(validationFeedback, result.data);
      if (!result.receiptId) {
        throw new MissingModelReceiptError(new Error('successful Skill repair call has no receipt ID'));
      }
      try {
        this.dependencies.validator.validateSchemaOrThrow(
          schemas.output,
          result.data,
          `skill:${input.step.actor_id}`,
        );
      } catch (repairError) {
        throw new SkillOutputSchemaError(
          hashJson(redactSensitiveValue(result.data)),
          schemaHashes,
          skillSchemaErrors(repairError),
          1,
          {
            id: result.receiptId,
            promptHash: result.promptHash,
            traceId: result.traceId,
          },
        );
      }
    }
    return {
      output: result.data,
      kind: 'skill_output',
      outputHash: hashJson(redactSensitiveValue(result.data)),
      skillProvenance: {
        ...execution.fingerprint,
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
    cancellationSignal?: AbortSignal;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('LLM provider is not eligible as real');
    }
    const execution = modelStepExecution(input);
    const result = await this.llm.generateText({
      prompt: execution.prompt,
      context: execution.context,
      ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
      receipt: {
        stage: 'llm',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: execution.contextManifestHash,
        expectedModel: input.expectedModel,
      },
    });
    return {
      output: { text: result.text },
      kind: 'llm_output',
      skillProvenance: {
        kind: 'model_execution',
        executionPromptHash: execution.executionPromptHash,
        contextManifestHash: execution.contextManifestHash,
        outputSchemaHash: execution.outputSchemaHash,
        inputArtifacts: execution.inputArtifacts,
        provider: this.dependencies.llm.identity.provider,
        endpointHost: this.dependencies.llm.identity.endpointHost,
        requestedModel: this.dependencies.llm.identity.requestedModel,
        actualModel: result.modelName,
        modelVersion: result.modelVersion,
        promptHash: result.promptHash,
        traceId: result.traceId,
        modelReceiptId: result.receiptId,
      },
    };
  }

  private async runReviewer(input: {
    step: EngineStep;
    lease: ControlExecutionLease;
    researchGoal: string;
    resolvedInput: Record<string, unknown>;
    outputs: EngineSealedStepOutput[];
    expectedModel: string;
    cancellationSignal?: AbortSignal;
  }): Promise<StepResult> {
    if (!this.dependencies.llm.identity.eligibleAsReal) {
      throw new ExecutionAuthenticityError('reviewer LLM provider is not eligible as real');
    }
    const execution = modelStepExecution(input);
    const result = await this.llm.generateStructured<ReviewerStepOutput>({
      prompt: execution.prompt,
      schema: REVIEWER_STEP_OUTPUT_SCHEMA,
      schemaName: execution.schemaName!,
      context: execution.context,
      ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
      receipt: {
        stage: 'reviewer',
        attemptId: input.lease.attemptId,
        stepNo: input.step.step_no,
        contextManifestHash: execution.contextManifestHash,
        expectedModel: input.expectedModel,
      },
    });
    this.dependencies.validator.validateSchemaOrThrow(
      REVIEWER_STEP_OUTPUT_SCHEMA,
      result.data,
      'reviewer-step-output',
    );
    const hasConditions = result.data.conditions.length > 0;
    if ((result.data.verdict === 'pass') === hasConditions) {
      throw new LLMInvocationError(
        'schema',
        false,
        null,
        'reviewer output verdict and conditions are inconsistent',
      );
    }
    if (new Set(result.data.conditions.map(({ id }) => id)).size !== result.data.conditions.length) {
      throw new LLMInvocationError('schema', false, null, 'reviewer output condition ids are duplicated');
    }
    return {
      output: result.data,
      kind: 'review_output',
      skillProvenance: {
        kind: 'model_execution',
        executionPromptHash: execution.executionPromptHash,
        contextManifestHash: execution.contextManifestHash,
        outputSchemaHash: execution.outputSchemaHash,
        inputArtifacts: execution.inputArtifacts,
        provider: this.dependencies.llm.identity.provider,
        endpointHost: this.dependencies.llm.identity.endpointHost,
        requestedModel: this.dependencies.llm.identity.requestedModel,
        actualModel: result.modelName,
        modelVersion: result.modelVersion,
        promptHash: result.promptHash,
        traceId: result.traceId,
        modelReceiptId: result.receiptId,
      },
    };
  }
}
