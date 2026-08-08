export type ControlWorkflowState =
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ControlWorkflowRole = 'owner' | 'legal' | 'security' | 'gold';

export interface ControlTaskResponse {
  id: string;
  state: ControlWorkflowState;
  stateVersion: number;
  activePlanVersionId: string | null;
  currentAttemptId: string | null;
}

export interface CreateControlTaskRequest {
  originalInput: string;
  taskType?: string;
  structuredTask?: Record<string, unknown>;
  sensitivity?: string;
}

export interface PlanMutationRequest {
  expectedVersion: number;
  candidateId: string;
  plan: unknown;
  planHash: string;
  pendingInputs: unknown[];
  idempotencyKey: string;
}

export interface SelectControlPlanResponse {
  planVersionId: string;
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface ConfirmControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  confirmationAnswers: Record<string, unknown>;
  inputRoles: string[];
  idempotencyKey: string;
}

export interface ApprovalControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  gateKey: string;
  decision: 'approved' | 'rejected';
  idempotencyKey: string;
}

export interface ExecutionControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  idempotencyKey: string;
}

export interface ResumeControlPlanRequest {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ControlCommandResponse {
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface DisabledExecutionResponse extends ControlCommandResponse {
  attemptId: string;
  executionDisabled: true;
}

export interface LegacyTaskReadResponse<T> {
  kind: 'legacy';
  task: T;
}

export interface CurrentTaskReadResponse {
  kind: 'current';
  task: ControlTaskResponse;
}
