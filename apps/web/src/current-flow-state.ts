import type {
  ControlExecutionStepResponse,
  ControlPlanCandidatesResponse,
  ControlWorkflowState,
  CurrentPlanCandidate,
} from '../../../packages/api-contract/control-workflow.ts';
import type { ExecLogRow, TaskSummary } from '../../../packages/api-contract/http.ts';

export interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

export type ReportState = 'idle' | 'loading' | 'ready' | 'report-loading-error';
export interface CurrentHistoryTaskSummary {
  id: string;
  originalInput: string;
  taskType: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryTaskSummary extends TaskSummary {
  kind: 'legacy' | 'current';
}

export type TaskHistoryGroup = 'action' | 'running' | 'finished';
export type TaskStateTone = 'action' | 'running' | 'success' | 'warning' | 'danger' | 'muted';

export interface TaskStatePresentation {
  label: string;
  group: TaskHistoryGroup;
  tone: TaskStateTone;
}

const TASK_STATE_PRESENTATIONS: Record<ControlWorkflowState, TaskStatePresentation> = {
  awaiting_clarification: { label: '待补充', group: 'action', tone: 'action' },
  awaiting_selection: { label: '待选方案', group: 'action', tone: 'action' },
  awaiting_confirmation: { label: '待确认', group: 'action', tone: 'action' },
  awaiting_approval: { label: '审批中', group: 'running', tone: 'running' },
  ready: { label: '待执行', group: 'action', tone: 'action' },
  executing: { label: '执行中', group: 'running', tone: 'running' },
  paused: { label: '已暂停', group: 'action', tone: 'warning' },
  reviewing: { label: '质量复核中', group: 'running', tone: 'running' },
  composing_report: { label: '报告生成中', group: 'running', tone: 'running' },
  completed: { label: '已完成', group: 'finished', tone: 'success' },
  completed_with_gaps: { label: '已完成·有缺口', group: 'finished', tone: 'warning' },
  failed: { label: '失败', group: 'finished', tone: 'danger' },
  cancelled: { label: '已取消', group: 'finished', tone: 'muted' },
  rejected: { label: '已驳回', group: 'finished', tone: 'danger' },
};

function isControlWorkflowState(state: string): state is ControlWorkflowState {
  return Object.prototype.hasOwnProperty.call(TASK_STATE_PRESENTATIONS, state);
}

export function taskStatePresentation(state: string): TaskStatePresentation {
  if (!isControlWorkflowState(state)) throw new Error(`unsupported Current task state: ${state}`);
  return TASK_STATE_PRESENTATIONS[state];
}

export function mergeTaskHistory(
  legacyTasks: TaskSummary[],
  currentTasks: CurrentHistoryTaskSummary[],
): HistoryTaskSummary[] {
  const history: HistoryTaskSummary[] = [
    ...legacyTasks.map((task) => ({ ...task, kind: 'legacy' as const })),
    ...currentTasks.map((task) => ({
      kind: 'current' as const,
      id: task.id,
      original_input: task.originalInput,
      task_type: task.taskType,
      status: task.state,
      created_at: task.createdAt,
      ...(task.updatedAt ? { updated_at: task.updatedAt } : {}),
    })),
  ];
  return history.sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? '');
    const rightTime = Date.parse(right.created_at ?? '');
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}
export interface RequestIdCrypto {
  randomUUID?: () => string;
  getRandomValues(values: Uint8Array): Uint8Array;
}

export function createRequestId(source: RequestIdCrypto = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}



export interface CompletedExecution {
  attemptId: string;
  state: 'completed' | 'completed_with_gaps';
  status: 'completed' | 'completed_with_gaps';
  stateVersion: number;
  executionDisabled?: false;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  gapCount?: number;
}

export interface DeliverableReadState<TDeliverable = unknown> {
  phase: 'executing' | 'done' | 'error';
  reportState: ReportState;
  execution: CompletedExecution | null;
  deliverable: TDeliverable | null;
  executionError: string | null;
  reportError: string | null;
}

export interface FlowTransition<TDeliverable = unknown> {
  state: DeliverableReadState<TDeliverable>;
  effect: 'load-deliverable' | null;
}


export function buildConfirmationAnswers(
  requirements: ConfirmationRequirement[],
  userAnswers: Record<string, unknown>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const requirement of requirements) {
    const value = userAnswers[requirement.key];
    const answered = Object.prototype.hasOwnProperty.call(userAnswers, requirement.key)
      && value !== undefined
      && value !== null
      && (typeof value !== 'string' || value.trim() !== '');
    if (!answered) {
      missing.push(requirement.key);
      continue;
    }
    answers[requirement.key] = value;
  }

  if (missing.length > 0) {
    throw new Error(`Unresolved confirmation answers: ${missing.join(', ')}`);
  }
  return answers;
}

export interface ExecutionPlanStepView {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  depends_on?: readonly number[];
}

export function executionPlanStepsForTask(input: {
  activePlan?: {
    plan: {
      steps: readonly ExecutionPlanStepView[];
    };
  } | null;
  executionSteps: readonly ControlExecutionStepResponse[];
}): ExecutionPlanStepView[] {
  const activeSteps = input.activePlan?.plan.steps;
  if (activeSteps && activeSteps.length > 0) {
    return activeSteps.map((step) => ({
      step_no: step.step_no,
      step_name: step.step_name,
      actor_type: step.actor_type,
      actor_id: step.actor_id,
      ...(Array.isArray(step.depends_on) ? { depends_on: [...step.depends_on] } : {}),
    }));
  }
  return input.executionSteps.map((step) => ({
    step_no: step.stepNo,
    step_name: step.stepName,
    actor_type: step.actorType,
    actor_id: step.actorId,
  }));
}

export function executionStepsToExecLog(steps: ControlExecutionStepResponse[]): ExecLogRow[] {
  return steps.map((step) => ({
    step_no: step.stepNo,
    step_name: step.stepName,
    actor_type: step.actorType,
    actor_id: step.actorId,
    status: step.state,
    skillProvenance: step.skillProvenance,
    ...(step.failure ? { failure: step.failure } : {}),
  }));
}

export function finishExecution<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
  execution: CompletedExecution,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'loading',
      execution,
      executionError: null,
      reportError: null,
    },
    effect: 'load-deliverable',
  };
}

export function failDeliverableRead<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
  error: string,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'report-loading-error',
      reportError: error,
    },
    effect: null,
  };
}

export function retryDeliverable<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'loading',
      reportError: null,
    },
    effect: 'load-deliverable',
  };
}

export interface ClarificationQuestionState {
  key: string;
  question: string;
  rationale: string;
}

export interface ClarificationRequirementState {
  clarification_questions: ClarificationQuestionState[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
}

function hasExplicitAnswer(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0);
}

export function missingBlockingAnswers(
  requirement: ClarificationRequirementState,
  answers: Record<string, unknown>,
): string[] {
  return requirement.clarification_questions
    .filter((question) => !hasExplicitAnswer(answers[question.key]))
    .map((question) => question.key);
}

export function buildClarificationSubmission(
  requirement: ClarificationRequirementState,
  answers: Record<string, unknown>,
  assumptionEdits: Record<string, string>,
): { clarificationAnswers: Record<string, unknown>; assumptionEdits: Record<string, string> } {
  const questionKeys = new Set(requirement.clarification_questions.map((question) => question.key));
  const editableKeys = new Set(
    requirement.assumptions.filter((assumption) => assumption.editable).map((assumption) => assumption.key),
  );
  return {
    clarificationAnswers: Object.fromEntries(
      Object.entries(answers).filter(([key, value]) => questionKeys.has(key) && hasExplicitAnswer(value)),
    ),
    assumptionEdits: Object.fromEntries(
      Object.entries(assumptionEdits).filter(([key, value]) => editableKeys.has(key) && value.trim().length > 0),
    ),
  };
}

export interface ClarificationSubmissionState {
  pending: { fingerprint: string; idempotencyKey: string } | null;
  activeRequestId: string | null;
}

export interface ClarificationSubmissionRequest {
  requestId: string;
  idempotencyKey: string;
}

function stableClarificationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClarificationValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableClarificationValue(child)]),
  );
}

export function createClarificationSubmissionState(): ClarificationSubmissionState {
  return { pending: null, activeRequestId: null };
}

export function beginClarificationSubmission(
  state: ClarificationSubmissionState,
  payload: unknown,
  createIdentity: () => ClarificationSubmissionRequest,
): { state: ClarificationSubmissionState; request: ClarificationSubmissionRequest | null } {
  const fingerprint = JSON.stringify(stableClarificationValue(payload));
  if (state.activeRequestId && state.pending?.fingerprint === fingerprint) {
    return { state, request: null };
  }
  const identity = createIdentity();
  const pending = state.pending?.fingerprint === fingerprint
    ? state.pending
    : { fingerprint, idempotencyKey: identity.idempotencyKey };
  return {
    state: { pending, activeRequestId: identity.requestId },
    request: { requestId: identity.requestId, idempotencyKey: pending.idempotencyKey },
  };
}

export function settleClarificationSubmission(
  state: ClarificationSubmissionState,
  requestId: string,
  outcome: 'success' | 'failure',
): { state: ClarificationSubmissionState; accepted: boolean } {
  if (state.activeRequestId !== requestId) return { state, accepted: false };
  return {
    state: {
      pending: outcome === 'success' ? null : state.pending,
      activeRequestId: null,
    },
    accepted: true,
  };
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRestorableClarificationRequirement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.version === 'research-task-v2'
    && isNonEmptyString(value.task_type)
    && isNonEmptyString(value.business_domain)
    && isNonEmptyString(value.research_goal)
    && Array.isArray(value.assumptions)
    && value.assumptions.every((assumption) => isRecord(assumption)
      && isNonEmptyString(assumption.key)
      && typeof assumption.value === 'string'
      && typeof assumption.editable === 'boolean')
    && Array.isArray(value.ambiguities)
    && value.ambiguities.every((ambiguity) => isRecord(ambiguity)
      && isNonEmptyString(ambiguity.id)
      && isNonEmptyString(ambiguity.statement)
      && typeof ambiguity.blocking === 'boolean')
    && Array.isArray(value.clarification_questions)
    && value.clarification_questions.every((question) => isRecord(question)
      && isNonEmptyString(question.key)
      && isNonEmptyString(question.question)
      && isNonEmptyString(question.rationale));
}

function isRestorableCandidate(value: unknown): value is CurrentPlanCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CurrentPlanCandidate>;
  return (candidate.candidateId === 'depth' || candidate.candidateId === 'speed')
    && isNonEmptyString(candidate.planVersionId)
    && isNonEmptyString(candidate.title)
    && isNonEmptyString(candidate.rationale)
    && isNonEmptyString(candidate.tradeoffs)
    && isNonEmptyString(candidate.planHash)
    && Boolean(candidate.plan && typeof candidate.plan === 'object')
    && Array.isArray(candidate.pendingInputs);
}

export interface CurrentTaskHydrationInput {
  task: {
    id: string;
    state: string;
    stateVersion: number;
    originalInput: string;
    conversationId: string;
    structuredTask: unknown;
    activePlanVersionId?: string | null;
    currentAttemptId?: string | null;
  };
  candidates?: CurrentPlanCandidate[];
  activatedNodes?: string[];
  activePlan?: CurrentPlanCandidate | null;
}

export type RestoredCurrentTaskPhase =
  | 'clarifying'
  | 'picking'
  | 'planned'
  | 'awaiting-approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing-report'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export function hydrateCurrentTask(input: CurrentTaskHydrationInput): {
  phase: RestoredCurrentTaskPhase;
  stateVersion: number;
  originalInput: string;
  clarification: unknown | null;
  candidatesResp: ControlPlanCandidatesResponse | null;
  selectedCandidate: CurrentPlanCandidate | null;
} {
  const { task } = input;
  if (!isControlWorkflowState(task.state)) {
    throw new Error(`unsupported Current task state: ${task.state}`);
  }
  if (task.state === 'awaiting_selection') {
    const candidates = input.candidates;
    const activatedNodes = input.activatedNodes;
    if (
      !Array.isArray(candidates)
      || candidates.length !== 2
      || !candidates.every(isRestorableCandidate)
      || candidates[0]?.candidateId !== 'depth'
      || candidates[1]?.candidateId !== 'speed'
      || !Array.isArray(activatedNodes)
      || activatedNodes.some((node) => typeof node !== 'string')
    ) {
      throw new Error('awaiting_selection task has no valid server candidate recovery payload');
    }
    return {
      phase: 'picking',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
      selectedCandidate: null,
      candidatesResp: {
        kind: 'current',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: 'awaiting_selection',
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask as ControlPlanCandidatesResponse['structuredTask'],
        activatedNodes,
        candidates,
      },
    };
  }
  if (task.state === 'awaiting_clarification') {
    if (!isRestorableClarificationRequirement(task.structuredTask)) {
      throw new Error('awaiting_clarification task has no valid requirement recovery payload');
    }
    return {
      phase: 'clarifying',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: {
        kind: 'current',
        status: 'clarification_required',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask,
        activatedNodes: [],
        candidates: [],
      },
      candidatesResp: null,
      selectedCandidate: null,
    };
  }

  const activePlanPhases: Partial<Record<ControlWorkflowState, RestoredCurrentTaskPhase>> = {
    awaiting_confirmation: 'planned',
    awaiting_approval: 'awaiting-approval',
    ready: 'ready',
    executing: 'executing',
    paused: 'paused',
    reviewing: 'reviewing',
    composing_report: 'composing-report',
  };
  const activePhase = activePlanPhases[task.state];
  if (activePhase) {
    const activePlan = input.activePlan;
    const plan = activePlan && isRecord(activePlan.plan) ? activePlan.plan : null;
    if (
      !activePlan
      || !isRestorableCandidate(activePlan)
      || activePlan.planVersionId !== task.activePlanVersionId
      || plan?.task_id !== task.id
      || !Array.isArray(plan.activated_nodes)
      || plan.activated_nodes.some((node) => typeof node !== 'string')
    ) {
      throw new Error(`${task.state} task has no valid active plan recovery payload`);
    }
    if (
      (task.state === 'executing'
        || task.state === 'paused'
        || task.state === 'reviewing'
        || task.state === 'composing_report')
      && !isNonEmptyString(task.currentAttemptId)
    ) {
      throw new Error(`${task.state} task has no current execution attempt`);
    }
    return {
      phase: activePhase,
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
      selectedCandidate: activePlan,
      candidatesResp: {
        kind: 'current',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask as ControlPlanCandidatesResponse['structuredTask'],
        activatedNodes: plan.activated_nodes as string[],
        candidates: [activePlan],
      },
    };
  }

  if (
    (task.state === 'completed' || task.state === 'completed_with_gaps')
    && !isNonEmptyString(task.currentAttemptId)
  ) {
    throw new Error(`${task.state} task has no current execution attempt`);
  }
  const terminalPhases: Partial<Record<ControlWorkflowState, RestoredCurrentTaskPhase>> = {
    completed: 'done',
    completed_with_gaps: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
    rejected: 'rejected',
  };
  const terminalPhase = terminalPhases[task.state];
  if (!terminalPhase) throw new Error(`unsupported Current task state: ${task.state}`);
  return {
    phase: terminalPhase,
    stateVersion: task.stateVersion,
    originalInput: task.originalInput,
    clarification: null,
    candidatesResp: null,
    selectedCandidate: null,
  };
}
