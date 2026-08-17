import type {
  ControlExecutionStepResponse,
  ControlPlanCandidatesResponse,
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
}

export interface HistoryTaskSummary extends TaskSummary {
  kind: 'legacy' | 'current';
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

export function executionStepsToExecLog(steps: ControlExecutionStepResponse[]): ExecLogRow[] {
  return steps.map((step) => ({
    step_no: step.stepNo,
    step_name: step.stepName,
    actor_type: step.actorType,
    actor_id: step.actorId,
    status: step.state,
    skillProvenance: step.skillProvenance,
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
}

export function hydrateCurrentTask(input: CurrentTaskHydrationInput): {
  phase: 'clarifying' | 'picking' | 'idle';
  stateVersion: number;
  originalInput: string;
  clarification: unknown | null;
  candidatesResp: ControlPlanCandidatesResponse | null;
} {
  const { task } = input;
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
  if (task.state !== 'awaiting_clarification') {
    return {
      phase: 'idle',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
      candidatesResp: null,
    };
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
  };
}
