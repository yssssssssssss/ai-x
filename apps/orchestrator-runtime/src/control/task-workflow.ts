import { createHash, randomUUID } from 'node:crypto';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlPlanVersionDetail,
  type ControlTaskDetail,
  type ControlTaskState,
} from '../../../../database/control-plane.ts';

export type WorkflowRole = 'owner' | 'legal' | 'security' | 'gold';

export interface WorkflowActor {
  userId: string;
  role: WorkflowRole;
  service?: 'gold';
}

interface ConfirmationRequirement {
  key: string;
  question?: string;
}

interface BlockingIssue {
  key: string;
  kind?: string;
  required_authority?: WorkflowRole;
}

interface WorkflowTaskShape {
  confirmations?: ConfirmationRequirement[];
  blocking_issues?: BlockingIssue[];
}

interface WorkflowPlanShape {
  steps?: Array<{ requires_approval?: boolean; approval_role?: WorkflowRole; step_no?: number }>;
}

interface CommandResult {
  state: ControlTaskState;
  stateVersion: number;
}

export class TaskWorkflowGateError extends Error {
  constructor(readonly unresolved: string[]) {
    super(`workflow gates remain unresolved: ${unresolved.join(', ')}`);
    this.name = 'TaskWorkflowGateError';
  }
}

export class TaskWorkflowAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskWorkflowAuthorizationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workflowRole(value: unknown): WorkflowRole | undefined {
  return value === 'owner' || value === 'legal' || value === 'security' || value === 'gold' ? value : undefined;
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

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function taskShape(task: ControlTaskDetail): WorkflowTaskShape {
  if (!isRecord(task.structuredTask)) throw new TaskWorkflowGateError(['structured_task']);
  const confirmations = task.structuredTask.confirmations;
  const blockingIssues = task.structuredTask.blocking_issues;
  if (confirmations !== undefined && !Array.isArray(confirmations)) throw new TaskWorkflowGateError(['structured_task.confirmations']);
  if (blockingIssues !== undefined && !Array.isArray(blockingIssues)) throw new TaskWorkflowGateError(['structured_task.blocking_issues']);
  return {
    confirmations: confirmations?.map((item) => {
      if (!isRecord(item) || typeof item.key !== 'string' || !item.key) throw new TaskWorkflowGateError(['structured_task.confirmations']);
      return { key: item.key, question: typeof item.question === 'string' ? item.question : undefined };
    }),
    blocking_issues: blockingIssues?.map((item) => {
      if (!isRecord(item) || typeof item.key !== 'string' || !item.key) throw new TaskWorkflowGateError(['structured_task.blocking_issues']);
      const authority = item.required_authority === undefined ? undefined : workflowRole(item.required_authority);
      if (item.required_authority !== undefined && !authority) throw new TaskWorkflowGateError(['structured_task.blocking_issues']);
      return {
        key: item.key,
        kind: typeof item.kind === 'string' ? item.kind : undefined,
        required_authority: authority,
      };
    }),
  };
}

function planShape(plan: ControlPlanVersionDetail): WorkflowPlanShape {
  if (!isRecord(plan.plan)) throw new TaskWorkflowGateError(['plan']);
  const steps = plan.plan.steps;
  if (steps === undefined) return {};
  if (!Array.isArray(steps)) throw new TaskWorkflowGateError(['plan.steps']);
  return {
    steps: steps.map((item) => {
      if (!isRecord(item)) throw new TaskWorkflowGateError(['plan.steps']);
      const authority = item.approval_role === undefined ? undefined : workflowRole(item.approval_role);
      if (item.approval_role !== undefined && !authority) throw new TaskWorkflowGateError(['plan.steps']);
      const requiresApproval = item.requires_approval;
      if (requiresApproval !== undefined && typeof requiresApproval !== 'boolean') throw new TaskWorkflowGateError(['plan.steps']);
      const stepNo = item.step_no;
      let normalizedStepNo: number | undefined;
      if (stepNo !== undefined) {
        if (typeof stepNo !== 'number' || !Number.isInteger(stepNo) || stepNo < 1) throw new TaskWorkflowGateError(['plan.steps']);
        normalizedStepNo = stepNo;
      }
      return {
        requires_approval: requiresApproval,
        approval_role: authority,
        step_no: normalizedStepNo,
      };
    }),
  };
}

function pendingInputKeys(plan: ControlPlanVersionDetail): string[] {
  if (!Array.isArray(plan.pendingInputs)) throw new TaskWorkflowGateError(['pending_inputs']);
  return plan.pendingInputs.map((input) => {
    if (typeof input === 'string' && input) return input;
    if (isRecord(input)) {
      if (typeof input.role === 'string' && input.role) return input.role;
      if (typeof input.key === 'string' && input.key) return input.key;
    }
    throw new TaskWorkflowGateError(['pending_inputs']);
  });
}

function requiredApprovals(task: ControlTaskDetail, plan: ControlPlanVersionDetail): Array<{ key: string; authority: WorkflowRole }> {
  const requirements = new Map<string, WorkflowRole>();
  for (const issue of taskShape(task).blocking_issues ?? []) {
    const authority = issue.required_authority
      ?? (issue.kind === 'privacy_compliance' ? 'legal' : issue.kind === 'security' ? 'security' : 'owner');
    requirements.set(issue.key, authority);
  }
  for (const [index, step] of (planShape(plan).steps ?? []).entries()) {
    if (step.requires_approval) requirements.set(`step:${step.step_no ?? index + 1}`, step.approval_role ?? 'security');
  }
  return [...requirements.entries()].map(([key, authority]) => ({ key, authority }));
}

export class TaskWorkflowService {
  constructor(private readonly repository: ControlPlaneRepository) {}

  private async requireTask(taskId: string): Promise<ControlTaskDetail> {
    const task = await this.repository.getTaskDetail(taskId);
    if (!task) throw new ControlPlaneConflictError(`task ${taskId} does not exist`);
    return task;
  }

  private requireOwner(task: ControlTaskDetail, actor: WorkflowActor): void {
    if (
      task.ownerUserId !== actor.userId
      || task.conversationOwnerUserId !== actor.userId
      || actor.role !== 'owner'
    ) {
      throw new TaskWorkflowAuthorizationError(`actor cannot control task ${task.id}`);
    }
  }

  private async requirePlan(task: ControlTaskDetail, planVersionId: string): Promise<ControlPlanVersionDetail> {
    const plan = await this.repository.getPlanVersionDetail(planVersionId);
    if (!plan || plan.taskId !== task.id || task.activePlanVersionId !== planVersionId) {
      throw new ControlPlaneConflictError(`plan version ${planVersionId} is not active for task ${task.id}`);
    }
    return plan;
  }

  private async replay<T>(taskId: string, commandType: string, idempotencyKey: string, hash: string): Promise<T | null> {
    const existing = await this.repository.getCommand(taskId, commandType, idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash !== hash) {
      throw new ControlPlaneConflictError(`idempotency key ${idempotencyKey} was reused with a different request`);
    }
    return existing.response as T;
  }

  async select(input: {
    taskId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
    candidateId: string;
    plan: unknown;
    planHash: string;
    pendingInputs: unknown[];
  }): Promise<{ planVersionId: string; state: ControlTaskState; stateVersion: number }> {
    const hash = requestHash(input);
    const replay = await this.replay<{ planVersionId: string; state: ControlTaskState; stateVersion: number }>(input.taskId, 'selection', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    if (task.state !== 'awaiting_selection' || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting selection at version ${input.expectedVersion}`);
    }
    const plan = await this.repository.createPlanVersion({
      taskId: task.id,
      version: await this.repository.nextPlanVersion(task.id),
      candidateId: input.candidateId,
      plan: input.plan,
      planHash: input.planHash,
      pendingInputs: input.pendingInputs,
    });
    const transitioned = await this.repository.transitionTask({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: 'awaiting_selection',
      to: 'awaiting_confirmation',
      activePlanVersionId: plan.id,
    });
    const result = { planVersionId: plan.id, state: transitioned.state, stateVersion: transitioned.stateVersion };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'selection',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: transitioned.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }

  async confirm(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
    confirmationAnswers: Record<string, unknown>;
    inputRoles: string[];
  }): Promise<CommandResult> {
    const hash = requestHash(input);
    const replay = await this.replay<CommandResult>(input.taskId, 'confirmation', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    const plan = await this.requirePlan(task, input.planVersionId);
    if (task.state !== 'awaiting_confirmation' || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${task.id} is not awaiting confirmation at version ${input.expectedVersion}`);
    }
    const missingAnswers = (taskShape(task).confirmations ?? [])
      .map((requirement) => requirement.key)
      .filter((key) => !(key in input.confirmationAnswers));
    const missingInputs = pendingInputKeys(plan).filter((key) => !input.inputRoles.includes(key));
    if (missingAnswers.length || missingInputs.length) throw new TaskWorkflowGateError([...missingAnswers, ...missingInputs]);

    for (const [key, value] of Object.entries(input.confirmationAnswers)) {
      await this.repository.recordGate({
        taskId: task.id,
        planVersionId: plan.id,
        planHash: plan.planHash,
        gateType: 'confirmation',
        gateKey: key,
        requiredAuthority: 'owner',
        decision: 'confirmed',
        value,
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        idempotencyKey: `${input.idempotencyKey}:confirmation:${key}`,
      });
    }
    for (const role of input.inputRoles) {
      await this.repository.recordGate({
        taskId: task.id,
        planVersionId: plan.id,
        planHash: plan.planHash,
        gateType: 'input',
        gateKey: role,
        requiredAuthority: 'owner',
        decision: 'provided',
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        idempotencyKey: `${input.idempotencyKey}:input:${role}`,
      });
    }
    const nextState: ControlTaskState = requiredApprovals(task, plan).length ? 'awaiting_approval' : 'ready';
    const transitioned = await this.repository.transitionTask({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: 'awaiting_confirmation',
      to: nextState,
    });
    const result = { state: transitioned.state, stateVersion: transitioned.stateVersion };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'confirmation',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: transitioned.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }

  async approve(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
    gateKey: string;
    decision: 'approved' | 'rejected';
  }): Promise<CommandResult> {
    const hash = requestHash(input);
    const replay = await this.replay<CommandResult>(input.taskId, 'approval', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    const plan = await this.requirePlan(task, input.planVersionId);
    if (task.state !== 'awaiting_approval' || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${task.id} is not awaiting approval at version ${input.expectedVersion}`);
    }
    const requirement = requiredApprovals(task, plan).find((candidate) => candidate.key === input.gateKey);
    if (!requirement) throw new TaskWorkflowGateError([input.gateKey]);
    if (input.actor.role !== requirement.authority || (input.actor.role === 'gold' && input.actor.service !== 'gold')) {
      throw new TaskWorkflowAuthorizationError(`${requirement.authority} authority is required for ${input.gateKey}`);
    }
    await this.repository.recordGate({
      taskId: task.id,
      planVersionId: plan.id,
      planHash: plan.planHash,
      gateType: 'approval',
      gateKey: input.gateKey,
      requiredAuthority: requirement.authority,
      decision: input.decision,
      actorUserId: input.actor.userId,
      actorService: input.actor.service,
      actorRole: input.actor.role,
      idempotencyKey: `${input.idempotencyKey}:approval:${input.gateKey}`,
    });
    const gates = await this.repository.listGateRecords(task.id, plan.id);
    const allApproved = requiredApprovals(task, plan).every((needed) => gates.some(
      (gate) => gate.gateType === 'approval'
        && gate.gateKey === needed.key
        && gate.requiredAuthority === needed.authority
        && gate.decision === 'approved',
    ));
    const nextState: ControlTaskState = input.decision === 'rejected' ? 'rejected' : allApproved ? 'ready' : 'awaiting_approval';
    const transitioned = await this.repository.transitionTask({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: 'awaiting_approval',
      to: nextState,
    });
    const result = { state: transitioned.state, stateVersion: transitioned.stateVersion };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'approval',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: transitioned.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }

  async revise(input: {
    taskId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
    candidateId: string;
    plan: unknown;
    planHash: string;
    pendingInputs: unknown[];
  }): Promise<{ planVersionId: string; state: ControlTaskState; stateVersion: number }> {
    const hash = requestHash(input);
    const replay = await this.replay<{ planVersionId: string; state: ControlTaskState; stateVersion: number }>(input.taskId, 'revision', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    const revisableStates: ControlTaskState[] = ['awaiting_confirmation', 'awaiting_approval', 'ready'];
    if (!revisableStates.includes(task.state) || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${task.id} cannot be revised at version ${input.expectedVersion}`);
    }
    const plan = await this.repository.createPlanVersion({
      taskId: task.id,
      version: await this.repository.nextPlanVersion(task.id),
      candidateId: input.candidateId,
      plan: input.plan,
      planHash: input.planHash,
      pendingInputs: input.pendingInputs,
    });
    const transitioned = await this.repository.transitionTask({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: revisableStates,
      to: 'awaiting_confirmation',
      activePlanVersionId: plan.id,
    });
    const result = { planVersionId: plan.id, state: transitioned.state, stateVersion: transitioned.stateVersion };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'revision',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: transitioned.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }

  async resume(input: {
    taskId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
  }): Promise<CommandResult> {
    const hash = requestHash(input);
    const replay = await this.replay<CommandResult>(input.taskId, 'resume', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    if (task.state !== 'paused' || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${task.id} is not paused at version ${input.expectedVersion}`);
    }
    const transitioned = await this.repository.transitionTask({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: 'paused',
      to: 'ready',
    });
    const result = { state: transitioned.state, stateVersion: transitioned.stateVersion };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'resume',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: transitioned.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }

  async execute(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
  }): Promise<CommandResult & { attemptId: string; executionDisabled: true }> {
    const hash = requestHash(input);
    const replay = await this.replay<CommandResult & { attemptId: string; executionDisabled: true }>(input.taskId, 'disabled_execution', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    await this.requirePlan(task, input.planVersionId);
    if (task.state !== 'ready' || task.stateVersion !== input.expectedVersion) {
      throw new ControlPlaneConflictError(`task ${task.id} is not ready at version ${input.expectedVersion}`);
    }
    const claim = await this.repository.claimExecution({
      taskId: task.id,
      planVersionId: input.planVersionId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      leaseOwner: 'workflow-gate-disabled-executor',
      leaseTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
    const paused = await this.repository.pauseExecution({
      taskId: task.id,
      attemptId: claim.attemptId,
      expectedVersion: claim.stateVersion,
      reason: 'execution_disabled_by_workflow_gate',
    });
    const result = { attemptId: claim.attemptId, state: paused.state, stateVersion: paused.stateVersion, executionDisabled: true as const };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType: 'disabled_execution',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      expectedVersion: input.expectedVersion,
      stateBefore: task.state,
      stateAfter: paused.state,
      response: result,
      actorUserId: input.actor.userId,
    });
    return result;
  }
}
