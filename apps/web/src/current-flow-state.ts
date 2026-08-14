import type { ControlExecutionStepResponse } from '../../../packages/api-contract/control-workflow.ts';
import type { ExecLogRow } from '../../../packages/api-contract/http.ts';

export interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

export type ReportState = 'idle' | 'loading' | 'ready' | 'report-loading-error';

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
}

export function hydrateCurrentTask(input: CurrentTaskHydrationInput): {
  phase: 'clarifying' | 'picking' | 'idle';
  stateVersion: number;
  originalInput: string;
  clarification: unknown | null;
} {
  const { task } = input;
  if (task.state !== 'awaiting_clarification') {
    return {
      phase: task.state === 'awaiting_selection' ? 'picking' : 'idle',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
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
  };
}
