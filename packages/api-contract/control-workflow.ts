import type { ResearchTaskData, ResearchTaskV2 } from './plan.ts';
import type { CurrentExecutionPlan, PendingInput } from './research-deliverable.ts';

export type ControlWorkflowState =
  | 'awaiting_clarification'
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing_report'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ControlWorkflowRole = 'owner' | 'legal' | 'security' | 'gold';

export interface ControlRequirementVersion {
  id: string;
  taskId: string;
  version: number;
  rawInputHash: string;
  clarification: unknown;
  structuredTask: ResearchTaskV2;
  modelCallId: string | null;
  createdAt: Date;
}

export interface CreateRequirementVersionRequest {
  taskId: string;
  version: number;
  rawInputHash: string;
  clarification: unknown;
  structuredTask: ResearchTaskV2;
  modelCallId?: string | null;
}

export interface ActivateRequirementVersionRequest {
  taskId: string;
  requirementVersionId: string;
  expectedVersion: number;
  ownerUserId: string;
}
export interface PlanControlTaskRequest {
  originalInput: string;
  conversationId?: string;
}


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

export interface CurrentPlanCandidate {
  planVersionId: string;
  candidateId: 'depth' | 'speed';
  title: string;
  rationale: string;
  tradeoffs: string;
  planHash: string;
  plan: CurrentExecutionPlan;
  pendingInputs: PendingInput[];
}

export interface ControlPlanCandidatesResponse {
  kind: 'current';
  conversationId: string;
  task: ControlTaskResponse;
  structuredTask: ResearchTaskData | ResearchTaskV2;
  activatedNodes: string[];
  candidates: CurrentPlanCandidate[];
}

export interface SelectControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  idempotencyKey: string;
}

export interface SelectControlPlanResponse {
  planVersionId: string;
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface ReviseControlPlanRequest {
  expectedVersion: number;
  revisionInstruction: string;
  idempotencyKey: string;
}

export interface ConfirmControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  confirmationAnswers: Record<string, unknown>;
  inputValues: Record<string, unknown>;
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
  action?: 'retry' | 'skip' | 'abort';
  failedStepNo?: number;
}

export interface ControlCommandResponse {
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface DisabledExecutionResponse extends ControlCommandResponse {
  attemptId: string;
  executionDisabled: true;
}
export interface ControlExecutionResult {
  attemptId: string;
  state: ControlWorkflowState;
  stateVersion: number;
  status: 'completed' | 'completed_with_gaps' | 'paused';
  executionDisabled: false;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  gapCount?: number;
  failedStepNo?: number;
  failure?: Record<string, unknown>;
}


export interface LegacyTaskReadResponse<T> {
  kind: 'legacy';
  task: T;
}

export interface ControlExecutionStepResponse {
  stepNo: number;
  stepName: string;
  actorType: string;
  actorId: string;
  state: string;
  toolProvenance: Record<string, unknown> | null;
  skillProvenance: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  latencyMs: number | null;
}

export interface CurrentTaskReadResponse {
  kind: 'current';
  task: ControlTaskResponse & {
    conversationId: string;
    originalInput: string;
    structuredTask: ResearchTaskData | ResearchTaskV2;
  };
  executionSteps: ControlExecutionStepResponse[];
  activatedNodes: string[];
  candidates: CurrentPlanCandidate[];
}
