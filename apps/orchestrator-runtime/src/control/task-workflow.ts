import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  ControlPlaneAuthorizationError as TaskWorkflowAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlPlanVersionDetail,
  type ControlTaskDetail,
  type ControlTaskState,
  type ControlExecutionLease,
  type ControlArtifact,
} from '../../../../database/control-plane.ts';
import type {
  ControlExecutionResult,
  DisabledExecutionResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
import { assertValidReportReviewArtifact } from '../report/report-review-service.ts';
export { TaskWorkflowAuthorizationError };

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
  clarification_questions?: ConfirmationRequirement[];
  blocking_issues?: BlockingIssue[];
}

interface WorkflowPlanShape {
  steps?: Array<{ requires_approval?: boolean; approval_role?: WorkflowRole; step_no?: number }>;
}

interface CommandResult {
  state: ControlTaskState;
  stateVersion: number;
}

export interface WorkflowExecutionDriver {
  execute(input: { lease: ControlExecutionLease }): Promise<{
    status: 'completed' | 'completed_with_gaps' | 'paused';
    attemptId: string;
    deliverableArtifactId?: string;
    evidenceManifestArtifactId?: string;
    reportReviewArtifactId?: string;
    reviewStatus?: 'completed' | 'paused';
    gapCount?: number;
    failedStepNo?: number;
    failure?: Record<string, unknown>;
  }>;
}

export interface WorkflowArtifactReader {
  readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
}

export interface WorkflowPlanRevisionDriver {
  revise(input: {
    taskId: string;
    activePlanVersionId: string;
    instruction: string;
  }): Promise<{ plan: unknown; pendingInputs: unknown[] }>;
}

export type WorkflowExecutionResponse = DisabledExecutionResponse | ControlExecutionResult;

export class TaskWorkflowGateError extends Error {
  constructor(readonly unresolved: string[]) {
    super(`workflow gates remain unresolved: ${unresolved.join(', ')}`);
    this.name = 'TaskWorkflowGateError';
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

function leaseTokenHash(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function taskShape(task: ControlTaskDetail): WorkflowTaskShape {
  if (!isRecord(task.structuredTask)) throw new TaskWorkflowGateError(['structured_task']);
  const clarificationQuestions = task.structuredTask.clarification_questions;
  const blockingIssues = task.structuredTask.blocking_issues;
  if (clarificationQuestions !== undefined && !Array.isArray(clarificationQuestions)) throw new TaskWorkflowGateError(['structured_task.clarification_questions']);
  if (blockingIssues !== undefined && !Array.isArray(blockingIssues)) throw new TaskWorkflowGateError(['structured_task.blocking_issues']);
  return {
    clarification_questions: clarificationQuestions?.map((item) => {
      if (!isRecord(item) || typeof item.key !== 'string' || !item.key) throw new TaskWorkflowGateError(['structured_task.clarification_questions']);
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

function revisedPlanWithoutStep(plan: unknown, failedStepNo: number): {
  plan: Record<string, unknown>;
  remappedStepNo: ReadonlyMap<number, number>;
} {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) throw new TaskWorkflowGateError(['plan.steps']);
  const steps = plan.steps.map((step, index) => {
    if (
      !isRecord(step)
      || typeof step.step_no !== 'number'
      || !Number.isInteger(step.step_no)
      || step.step_no !== index + 1
    ) {
      throw new TaskWorkflowGateError(['plan.steps']);
    }
    if (!Array.isArray(step.depends_on)) throw new TaskWorkflowGateError([`step:${step.step_no}:depends_on`]);
    const dependsOn = step.depends_on.map((dependency) => {
      if (typeof dependency !== 'number' || !Number.isInteger(dependency)) {
        throw new TaskWorkflowGateError([`step:${step.step_no}:depends_on`]);
      }
      return dependency;
    });
    if (!Array.isArray(step.input_bindings)) throw new TaskWorkflowGateError([`step:${step.step_no}:input_bindings`]);
    const inputBindings = step.input_bindings.map((binding) => {
      if (
        !isRecord(binding)
        || typeof binding.source_step_no !== 'number'
        || !Number.isInteger(binding.source_step_no)
      ) {
        throw new TaskWorkflowGateError([`step:${step.step_no}:input_bindings`]);
      }
      return { binding, sourceStepNo: binding.source_step_no };
    });
    return { step, stepNo: step.step_no, dependsOn, inputBindings };
  });
  const remaining = steps.filter(({ stepNo }) => stepNo !== failedStepNo);
  if (remaining.length === steps.length) throw new TaskWorkflowGateError([`step:${failedStepNo}`]);
  for (const entry of remaining) {
    if (
      entry.dependsOn.includes(failedStepNo)
      || entry.inputBindings.some(({ sourceStepNo }) => sourceStepNo === failedStepNo)
    ) {
      throw new TaskWorkflowGateError([`step:${failedStepNo}:referenced`]);
    }
  }

  const remappedStepNo = new Map(remaining.map(({ stepNo }, index) => [stepNo, index + 1]));
  const remapReference = (sourceStepNo: number, issue: string): number => {
    const remapped = remappedStepNo.get(sourceStepNo);
    if (remapped === undefined) throw new TaskWorkflowGateError([issue]);
    return remapped;
  };
  return {
    plan: {
      ...plan,
      steps: remaining.map((entry, index) => ({
        ...entry.step,
        step_no: index + 1,
        depends_on: entry.dependsOn.map((dependency) => (
          remapReference(dependency, `step:${entry.stepNo}:depends_on`)
        )),
        input_bindings: entry.inputBindings.map(({ binding, sourceStepNo }) => ({
          ...binding,
          source_step_no: remapReference(sourceStepNo, `step:${entry.stepNo}:input_bindings`),
        })),
      })),
    },
    remappedStepNo,
  };
}

function remapPendingInputs(pendingInputs: unknown, remappedStepNo: ReadonlyMap<number, number>): unknown[] {
  if (!Array.isArray(pendingInputs)) throw new TaskWorkflowGateError(['pending_inputs']);
  return pendingInputs.map((pendingInput, pendingIndex) => {
    if (!isRecord(pendingInput) || !Array.isArray(pendingInput.targets)) {
      throw new TaskWorkflowGateError([`pending_inputs:${pendingIndex}`]);
    }
    return {
      ...pendingInput,
      targets: pendingInput.targets.map((target, targetIndex) => {
        if (
          !isRecord(target)
          || typeof target.step_no !== 'number'
          || !Number.isInteger(target.step_no)
          || typeof target.tool_id !== 'string'
          || !target.tool_id
          || typeof target.field !== 'string'
          || !target.field
          || typeof target.multiple !== 'boolean'
        ) {
          throw new TaskWorkflowGateError([`pending_inputs:${pendingIndex}:targets:${targetIndex}`]);
        }
        const stepNo = remappedStepNo.get(target.step_no);
        if (stepNo === undefined) {
          throw new TaskWorkflowGateError([`pending_inputs:${pendingIndex}:targets:${targetIndex}:step_no`]);
        }
        return { ...target, step_no: stepNo };
      }),
    };
  });
}

function allowedActions(failure: Record<string, unknown> | null): string[] {
  return Array.isArray(failure?.allowedActions)
    ? failure.allowedActions.filter((action): action is string => typeof action === 'string')
    : [];
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
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly executionDriver?: WorkflowExecutionDriver,
    private readonly planRevisionDriver?: WorkflowPlanRevisionDriver,
    private readonly terminalArtifacts?: WorkflowArtifactReader,
  ) {}

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

  private async recoverTerminalArtifacts(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    status: 'completed' | 'completed_with_gaps' | 'paused';
  }): Promise<Partial<ControlExecutionResult>> {
    const selectedReview = await this.repository.findSealedArtifact({
      taskId: input.taskId,
      attemptId: input.attemptId,
      kind: 'report_review',
    });
    if (!selectedReview) return {};
    if (!this.terminalArtifacts) {
      throw new ControlPlaneConflictError('terminal Artifact reader is required to recover reviewed execution');
    }

    const verifiedReview = await this.terminalArtifacts.readVerifiedJson<unknown>(selectedReview.id);
    if (
      verifiedReview.artifact.id !== selectedReview.id
      || verifiedReview.artifact.state !== 'SEALED'
      || !verifiedReview.artifact.contentSha256
      || verifiedReview.artifact.kind !== 'report_review'
      || verifiedReview.artifact.schemaVersion !== 'report-review-v1'
      || verifiedReview.artifact.taskId !== input.taskId
      || verifiedReview.artifact.planVersionId !== input.planVersionId
      || verifiedReview.artifact.attemptId !== input.attemptId
    ) {
      throw new ControlPlaneConflictError('terminal Review Artifact cannot reconstruct execution result');
    }
    try {
      assertValidReportReviewArtifact(verifiedReview.value);
    } catch {
      throw new ControlPlaneConflictError('terminal Review Artifact cannot reconstruct execution result');
    }
    const reviewValue = verifiedReview.value;
    if (
      reviewValue.taskId !== input.taskId
      || reviewValue.planVersionId !== input.planVersionId
      || reviewValue.attemptId !== input.attemptId
      || basename(verifiedReview.artifact.storageUri) !== `review-r${reviewValue.revisionRound}.json`
      || (input.status !== 'paused' && reviewValue.verdict !== 'pass')
    ) {
      throw new ControlPlaneConflictError('terminal Review Artifact cannot reconstruct execution result');
    }

    const verifiedDeliverable = await this.terminalArtifacts.readVerifiedJson<unknown>(
      reviewValue.deliverableArtifactId,
    );
    const deliverableValue = isRecord(verifiedDeliverable.value) ? verifiedDeliverable.value : null;
    if (
      verifiedDeliverable.artifact.id !== reviewValue.deliverableArtifactId
      || verifiedDeliverable.artifact.state !== 'SEALED'
      || !verifiedDeliverable.artifact.contentSha256
      || verifiedDeliverable.artifact.kind !== 'deliverable'
      || verifiedDeliverable.artifact.schemaVersion !== 'research-deliverable-v1-review-gated'
      || verifiedDeliverable.artifact.taskId !== input.taskId
      || verifiedDeliverable.artifact.planVersionId !== input.planVersionId
      || verifiedDeliverable.artifact.attemptId !== input.attemptId
      || !deliverableValue
      || deliverableValue.version !== 'research-deliverable-v1'
      || deliverableValue.taskId !== input.taskId
      || deliverableValue.planVersionId !== input.planVersionId
      || deliverableValue.attemptId !== input.attemptId
      || typeof deliverableValue.evidenceManifestArtifactId !== 'string'
    ) {
      throw new ControlPlaneConflictError('terminal Deliverable Artifact cannot reconstruct execution result');
    }

    const manifestArtifactId = deliverableValue.evidenceManifestArtifactId;
    const verifiedManifest = await this.terminalArtifacts.readVerifiedJson<unknown>(manifestArtifactId);
    const manifestValue = isRecord(verifiedManifest.value) ? verifiedManifest.value : null;
    if (
      verifiedManifest.artifact.id !== manifestArtifactId
      || verifiedManifest.artifact.state !== 'SEALED'
      || !verifiedManifest.artifact.contentSha256
      || verifiedManifest.artifact.kind !== 'evidence_manifest'
      || verifiedManifest.artifact.schemaVersion !== 'evidence-v1'
      || verifiedManifest.artifact.taskId !== input.taskId
      || verifiedManifest.artifact.planVersionId !== input.planVersionId
      || verifiedManifest.artifact.attemptId !== input.attemptId
      || !manifestValue
      || manifestValue.version !== 'evidence-v1'
      || manifestValue.taskId !== input.taskId
      || manifestValue.planVersionId !== input.planVersionId
      || manifestValue.attemptId !== input.attemptId
    ) {
      throw new ControlPlaneConflictError('terminal Evidence Manifest cannot reconstruct execution result');
    }

    return {
      deliverableArtifactId: verifiedDeliverable.artifact.id,
      evidenceManifestArtifactId: verifiedManifest.artifact.id,
      reportReviewArtifactId: verifiedReview.artifact.id,
      reviewStatus: reviewValue.verdict === 'pass' ? 'completed' : 'paused',
    };
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
    planVersionId: string;
  }): Promise<{ planVersionId: string; state: ControlTaskState; stateVersion: number }> {
    const hash = requestHash({
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      planVersionId: input.planVersionId,
    });
    return this.repository.selectCandidate({ ...input, requestHash: hash });
  }

  async confirm(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    actor: WorkflowActor;
    confirmationAnswers: Record<string, unknown>;
    inputValues: Record<string, unknown>;
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
    const missingAnswers = (taskShape(task).clarification_questions ?? [])
      .map((requirement) => requirement.key)
      .filter((key) => !(key in input.confirmationAnswers));
    const requiredInputRoles = new Set(pendingInputKeys(plan));
    const extraInputs = Object.keys(input.inputValues).filter((key) => !requiredInputRoles.has(key));
    const missingInputs = [...requiredInputRoles].filter((key) => (
      !Object.prototype.hasOwnProperty.call(input.inputValues, key)
      || input.inputValues[key] === undefined
    ));
    if (missingAnswers.length || missingInputs.length || extraInputs.length) {
      throw new TaskWorkflowGateError([...missingAnswers, ...missingInputs, ...extraInputs]);
    }

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
        actorService: input.actor.service,
        actorRole: input.actor.role,
        idempotencyKey: `${input.idempotencyKey}:confirmation:${key}`,
      });
    }
    for (const [role, value] of Object.entries(input.inputValues)) {
      await this.repository.recordGate({
        taskId: task.id,
        planVersionId: plan.id,
        planHash: plan.planHash,
        gateType: 'input',
        gateKey: role,
        requiredAuthority: 'owner',
        decision: 'provided',
        value,
        actorUserId: input.actor.userId,
        actorService: input.actor.service,
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
    revisionInstruction: string;
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
    if (!input.revisionInstruction.trim()) {
      throw new ControlPlaneConflictError('revision instruction is required');
    }
    if (!task.activePlanVersionId) {
      throw new ControlPlaneConflictError(`task ${task.id} has no active plan to revise`);
    }
    const activePlan = await this.requirePlan(task, task.activePlanVersionId);
    if (activePlan.candidateId !== 'depth' && activePlan.candidateId !== 'speed') {
      throw new ControlPlaneConflictError(`active plan ${activePlan.id} has no valid candidate choice`);
    }
    if (!this.planRevisionDriver) {
      throw new ControlPlaneConflictError('plan revision driver is unavailable');
    }
    const generated = await this.planRevisionDriver.revise({
      taskId: task.id,
      activePlanVersionId: activePlan.id,
      instruction: input.revisionInstruction,
    });
    if (!isRecord(generated) || !isRecord(generated.plan) || !Array.isArray(generated.pendingInputs)) {
      throw new ControlPlaneConflictError('plan revision driver returned a malformed result');
    }
    const revision = await this.repository.createPlanRevision({
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      from: revisableStates,
      to: 'awaiting_confirmation',
      candidateId: activePlan.candidateId,
      plan: generated.plan,
      pendingInputs: generated.pendingInputs,
    });
    const plan = revision.plan;
    const transitioned = revision.task;
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
    action?: 'retry' | 'skip' | 'abort';
    failedStepNo?: number;
  }): Promise<CommandResult> {
    const hash = requestHash(input);
    const replay = await this.replay<CommandResult>(input.taskId, 'resume', input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    const action = input.action ?? 'retry';
    const currentAttempt = task.currentAttemptId
      ? (await this.repository.listAttempts(task.id)).find((attempt) => attempt.id === task.currentAttemptId)
      : undefined;
    let failedStep = null;
    if (task.currentAttemptId) {
      const steps = await this.repository.listExecutionSteps(task.currentAttemptId);
      failedStep = input.failedStepNo == null
        ? [...steps].reverse().find((step) => step.state === 'failed') ?? null
        : steps.find((step) => step.stepNo === input.failedStepNo && step.state === 'failed') ?? null;
    }
    if (input.failedStepNo != null && !failedStep) {
      throw new TaskWorkflowGateError([`step:${input.failedStepNo}`]);
    }
    if (failedStep) {
      if (!allowedActions(failedStep.failure).includes(action)) {
        throw new TaskWorkflowGateError([`action:${action}`]);
      }
    } else if (action !== 'retry') {
      throw new TaskWorkflowGateError([`action:${action}`]);
    }

    const recoveredState = action === 'skip' ? 'awaiting_confirmation' : action === 'abort' ? 'cancelled' : 'ready';
    if (task.state !== 'paused' || task.stateVersion !== input.expectedVersion) {
      const recoveryAttemptState = action === 'abort' ? 'cancelled' : 'paused';
      if (task.state === recoveredState && currentAttempt?.state === recoveryAttemptState) {
        const recovered = { state: task.state, stateVersion: task.stateVersion };
        try {
          await this.repository.recordCommand({
            taskId: task.id,
            commandType: 'resume',
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            expectedVersion: input.expectedVersion,
            stateBefore: 'paused',
            stateAfter: task.state,
            response: recovered,
            actorUserId: input.actor.userId,
          });
        } catch (error) {
          const replayed = await this.replay<CommandResult>(input.taskId, 'resume', input.idempotencyKey, hash);
          if (replayed) return replayed;
          throw error;
        }
        return recovered;
      }
      throw new ControlPlaneConflictError(`task ${task.id} is not paused at version ${input.expectedVersion}`);
    }

    let transitioned;
    if (action === 'skip') {
      if (!failedStep || !task.activePlanVersionId) throw new TaskWorkflowGateError(['resume.failure']);
      const activePlan = await this.requirePlan(task, task.activePlanVersionId);
      const { plan: revisedPlan, remappedStepNo } = revisedPlanWithoutStep(activePlan.plan, failedStep.stepNo);
      const pendingInputs = remapPendingInputs(activePlan.pendingInputs, remappedStepNo);
      const revision = await this.repository.createPlanRevision({
        taskId: task.id,
        expectedVersion: input.expectedVersion,
        from: 'paused',
        to: 'awaiting_confirmation',
        candidateId: activePlan.candidateId ?? undefined,
        plan: revisedPlan,
        pendingInputs,
      });
      transitioned = revision.task;
    } else if (action === 'abort') {
      if (!task.currentAttemptId) throw new TaskWorkflowGateError(['resume.attempt']);
      transitioned = await this.repository.cancelPausedExecution({
        taskId: task.id,
        attemptId: task.currentAttemptId,
        expectedVersion: input.expectedVersion,
      });
    } else {
      transitioned = await this.repository.transitionTask({
        taskId: task.id,
        expectedVersion: input.expectedVersion,
        from: 'paused',
        to: 'ready',
      });
    }
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
  }): Promise<WorkflowExecutionResponse> {
    const hash = requestHash(input);
    const commandType = this.executionDriver ? 'execution' : 'disabled_execution';
    const replay = await this.replay<WorkflowExecutionResponse>(input.taskId, commandType, input.idempotencyKey, hash);
    if (replay) return replay;
    const task = await this.requireTask(input.taskId);
    this.requireOwner(task, input.actor);
    await this.requirePlan(task, input.planVersionId);
    const leaseToken = randomUUID();
    const leaseOwner = this.executionDriver ? 'workflow-execution-engine' : 'workflow-gate-disabled-executor';
    const claim = await this.repository.claimExecution({
      taskId: task.id,
      planVersionId: input.planVersionId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      leaseOwner,
      leaseTokenHash: leaseTokenHash(leaseToken),
      retryOf: task.currentAttemptId,
    });


    if (this.executionDriver) {
      if (claim.replayed) {
        const finalTask = await this.requireTask(task.id);
        if (
          finalTask.currentAttemptId === claim.attemptId
          && (finalTask.state === 'completed' || finalTask.state === 'completed_with_gaps' || finalTask.state === 'paused')
        ) {
          const failedSteps = finalTask.state === 'paused'
            ? await this.repository.listExecutionSteps(claim.attemptId)
            : [];
          const latestFailure = [...failedSteps].reverse().find((step) => step.state === 'failed');
          const terminalArtifacts = await this.recoverTerminalArtifacts({
            taskId: task.id,
            planVersionId: input.planVersionId,
            attemptId: claim.attemptId,
            status: finalTask.state,
          });
          const recovered: WorkflowExecutionResponse = {
            attemptId: claim.attemptId,
            state: finalTask.state,
            stateVersion: finalTask.stateVersion,
            status: finalTask.state,
            executionDisabled: false,
            failedStepNo: latestFailure?.stepNo,
            failure: latestFailure?.failure ?? undefined,
            ...terminalArtifacts,
          };
          try {
            await this.repository.recordCommand({
              taskId: task.id,
              commandType,
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              expectedVersion: input.expectedVersion,
              stateBefore: 'ready',
              stateAfter: finalTask.state,
              response: recovered,
              actorUserId: input.actor.userId,
            });
          } catch (error) {
            const completed = await this.replay<WorkflowExecutionResponse>(input.taskId, commandType, input.idempotencyKey, hash);
            if (completed) return completed;
            throw error;
          }
          return recovered;
        }
        throw new ControlPlaneConflictError(`execution command ${input.idempotencyKey} is still in progress`);
      }
      const driven = await this.executionDriver.execute({
        lease: {
          taskId: task.id,
          planVersionId: input.planVersionId,
          attemptId: claim.attemptId,
          leaseOwner,
          leaseToken,
          retryOf: task.currentAttemptId,
        },
      });
      const finalTask = await this.requireTask(task.id);
      const result: WorkflowExecutionResponse = {
        attemptId: claim.attemptId,
        state: finalTask.state,
        stateVersion: finalTask.stateVersion,
        status: driven.status,
        executionDisabled: false,
        ...(driven.deliverableArtifactId === undefined ? {} : { deliverableArtifactId: driven.deliverableArtifactId }),
        ...(driven.evidenceManifestArtifactId === undefined ? {} : { evidenceManifestArtifactId: driven.evidenceManifestArtifactId }),
        ...(driven.reportReviewArtifactId === undefined ? {} : { reportReviewArtifactId: driven.reportReviewArtifactId }),
        ...(driven.reviewStatus === undefined ? {} : { reviewStatus: driven.reviewStatus }),
        ...(driven.gapCount === undefined ? {} : { gapCount: driven.gapCount }),
        ...(driven.failedStepNo === undefined ? {} : { failedStepNo: driven.failedStepNo }),
        ...(driven.failure === undefined ? {} : { failure: driven.failure }),
      };
      await this.repository.recordCommand({
        taskId: task.id,
        commandType,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        expectedVersion: input.expectedVersion,
        stateBefore: task.state,
        stateAfter: finalTask.state,
        response: result,
        actorUserId: input.actor.userId,
      });
      return result;
    }

    const paused = await this.repository.pauseExecution({
      taskId: task.id,
      attemptId: claim.attemptId,
      expectedVersion: claim.stateVersion,
      reason: 'execution_disabled_by_workflow_gate',
    });
    const result: WorkflowExecutionResponse = {
      attemptId: claim.attemptId,
      state: paused.state,
      stateVersion: paused.stateVersion,
      executionDisabled: true,
    };
    await this.repository.recordCommand({
      taskId: task.id,
      commandType,
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
