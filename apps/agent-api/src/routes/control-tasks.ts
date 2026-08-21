import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { PlanProgress } from '../../../../packages/api-contract/plan.ts';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import { ControlPlaneConflictError, type ControlPlaneRepository } from '../../../../database/control-plane.ts';
import { getUserById } from '../../../../database/repository.ts';
import {
  CandidateProfileNoLongerEligibleError,
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  requiredApprovals,
  type TaskWorkflowService,
  type WorkflowActor,
} from '../../../orchestrator-runtime/src/control/task-workflow.ts';
import { assertVisualAssetManifestSchema } from '../../../orchestrator-runtime/src/report/visual-asset-service.ts';
import { LLMInvocationError } from '../../../orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../../../orchestrator-runtime/src/schema/validator.ts';
import type { CurrentPlanningResponse } from './control-planning.ts';
import { requireAuth } from '../middleware.ts';

const currentRequirementValidator = new SchemaValidator();

export interface ControlClarificationPort {
  clarify(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    answers: Record<string, unknown>;
    assumptionEdits: Record<string, string>;
    expectedVersion: number;
    commandReservation: {
      commandType: 'clarification';
      idempotencyKey: string;
      requestHash: string;
      expectedVersion: number;
      reservationToken: string;
      actorUserId: string;
    };
  }, onProgress?: (event: PlanProgress) => void): Promise<CurrentPlanningResponse>;
}

export interface ControlTasksRuntime {
  repository: ControlPlaneRepository;
  workflow: TaskWorkflowService;
  getDeliverable(taskId: string, ownerUserId: string): Promise<unknown | null>;
  readVisualAsset?(input: {
    taskId: string;
    assetId: string;
    ownerUserId: string;
  }): Promise<{
    artifact: { id: string };
    manifestArtifact: { schemaVersion: string };
    bytes: Uint8Array;
    manifest: unknown;
  } | null>;
  clarification?: ControlClarificationPort;
}



function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function version(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

async function actorFor(req: Request): Promise<WorkflowActor | null> {
  if (!req.userId) return null;
  const user = await getUserById(req.userId);
  if (!user || user.status !== 'active') return null;
  const role = user.role === 'legal' ? 'legal' : user.role === 'security' ? 'security' : user.role === 'gold' ? 'gold' : 'owner';
  return { userId: user.id, role, service: role === 'gold' ? 'gold' : undefined };
}

function idempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  return string(header) ?? string(record(req.body)?.idempotencyKey);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function clarificationRequestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

async function readApprovalRequirements(
  repository: ControlPlaneRepository,
  task: Awaited<ReturnType<ControlPlaneRepository['getTaskDetail']>>,
  actorRole: WorkflowActor['role'],
): Promise<Array<{
  gateKey: string;
  requiredAuthority: WorkflowActor['role'];
  decision: 'pending' | 'approved' | 'rejected';
  canApprove: boolean;
}>> {
  if (!task?.activePlanVersionId) return [];
  const plan = await repository.getPlanVersionDetail(task.activePlanVersionId);
  if (!plan) return [];
  const gates = await repository.listGateRecords(task.id, plan.id);
  return requiredApprovals(task, plan).map(({ key, authority }) => {
    const approval = gates.find((gate) => (
      gate.gateType === 'approval' && gate.gateKey === key
    ));
    const decision = approval?.decision === 'approved' || approval?.decision === 'rejected'
      ? approval.decision
      : 'pending';
    return {
      gateKey: key,
      requiredAuthority: authority,
      decision,
      canApprove: decision === 'pending' && actorRole === authority,
    };
  });
}

function responseError(res: Response, error: unknown): void {
  if (error instanceof TaskWorkflowGateError) {
    res.status(422).json({ error: error.message, unresolved: error.unresolved });
    return;
  }
  if (error instanceof TaskWorkflowAuthorizationError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof LLMInvocationError && error.providerStatus === 429) {
    res.status(429).json({
      error: error.sanitizedMessage,
      kind: error.kind,
      retryable: error.retryable,
    });
    return;
  }
  if (error instanceof CandidateProfileNoLongerEligibleError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ControlPlaneConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: 'control workflow failed' });
}

async function authenticatedActor(req: Request, res: Response): Promise<WorkflowActor | null> {
  const actor = await actorFor(req);
  if (!actor) res.status(401).json({ error: '用户不存在或已停用' });
  return actor;
}

async function ensureOwnedTask(
  runtime: ControlTasksRuntime,
  req: Request,
  res: Response,
  actor: WorkflowActor,
  hiddenError = '任务不存在',
): Promise<boolean> {
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
    res.status(404).json({ error: hiddenError });
    return false;
  }
  return true;
}

async function ensureApprovalTaskAccess(
  runtime: ControlTasksRuntime,
  req: Request,
  res: Response,
  actor: WorkflowActor,
  gateKey: string,
): Promise<boolean> {
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return false;
  }
  const isOwner = task.ownerUserId === actor.userId
    && task.conversationOwnerUserId === actor.userId;
  if (isOwner) return true;
  const requirements = await readApprovalRequirements(runtime.repository, task, actor.role);
  const isMatchingApprover = task.state === 'awaiting_approval'
    && requirements.some((requirement) => (
      requirement.gateKey === gateKey
      && requirement.requiredAuthority === actor.role
    ));
  if (!isMatchingApprover) {
    res.status(404).json({ error: '任务不存在' });
    return false;
  }
  return true;
}

export function createControlTasksRouter(runtime: ControlTasksRuntime): Router {
  const router = Router();
  router.use(requireAuth);
  const { repository, workflow } = runtime;
  router.get('/', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    try {
      const tasks = await repository.listTasksForOwner({ ownerUserId: actor.userId });
      res.json({ kind: 'current', tasks });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/:id/clarify', async (req, res) => {
    const body = record(req.body);
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!runtime.clarification) {
      res.status(501).json({ error: '澄清服务不可用' });
      return;
    }
    const forbidden = ['plan', 'planHash', 'structuredTask'];
    if (body && forbidden.some((field) => field in body)) {
      res.status(400).json({ error: 'plan、planHash、structuredTask 由服务端生成，不接受客户端提交' });
      return;
    }
    const expectedVersion = version(body?.expectedVersion);
    const clarificationAnswers = record(body?.clarificationAnswers);
    const assumptionEdits = record(body?.assumptionEdits);
    const key = idempotencyKey(req);
    if (
      expectedVersion == null
      || !clarificationAnswers
      || !assumptionEdits
      || !key
      || Object.values(assumptionEdits).some((value) => typeof value !== 'string')
    ) {
      res.status(400).json({ error: 'expectedVersion、clarificationAnswers、assumptionEdits、Idempotency-Key 必填' });
      return;
    }

    const task = await repository.getTaskDetail(req.params.id);
    if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    const requestHash = clarificationRequestHash({
      expectedVersion,
      clarificationAnswers,
      assumptionEdits,
    });
    if (task.state !== 'awaiting_clarification') {
      const existing = await repository.getCommand(task.id, 'clarification', key);
      if (!existing || existing.requestHash !== requestHash) {
        res.status(409).json({ error: `task ${task.id} is not awaiting_clarification` });
        return;
      }
    }

    const command = {
      taskId: task.id,
      commandType: 'clarification' as const,
      idempotencyKey: key,
      requestHash,
      expectedVersion,
    };
    try {
      let reservationToken: string | null = null;
      while (!reservationToken) {
        const reservation = await repository.reserveCommand({
          ...command,
          actorUserId: actor.userId,
        });
        if (reservation.status === 'conflict') {
          throw new ControlPlaneConflictError(
            `idempotency key ${key} was reused with a different request`,
          );
        }
        if (reservation.status === 'replay') {
          res.json(reservation.response);
          return;
        }
        if (reservation.status === 'pending') {
          const waited = await repository.waitForCommand(command);
          if (waited.status === 'conflict') {
            throw new ControlPlaneConflictError(
              `idempotency key ${key} was reused with a different request`,
            );
          }
          if (waited.status === 'replay') {
            res.json(waited.response);
            return;
          }
          continue;
        }
        reservationToken = reservation.reservationToken;
      }

      try {
        const response = await runtime.clarification.clarify({
          taskId: task.id,
          conversationId: task.conversationId,
          ownerUserId: actor.userId,
          answers: clarificationAnswers,
          assumptionEdits: Object.fromEntries(
            Object.entries(assumptionEdits).map(([field, value]) => [field, value as string]),
          ),
          expectedVersion,
          commandReservation: {
            ...command,
            reservationToken,
            actorUserId: actor.userId,
          },
        });
        if (response.status === 'clarification_required') {
          await repository.completeCommand({
            ...command,
            reservationToken,
            stateAfter: response.task.state,
            response,
          });
        }
        res.json(response);
      } catch (error) {
        await repository.recoverCommandAfterFailure({ ...command, reservationToken });
        throw error;
      }
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/assets/:assetId', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    const hidden = () => res.status(404).json({ error: '资源不存在' });
    if (!await ensureOwnedTask(runtime, req, res, actor, '资源不存在')) return;
    if (!runtime.readVisualAsset) {
      hidden();
      return;
    }
    try {
      const asset = await runtime.readVisualAsset({
        taskId: req.params.id,
        assetId: req.params.assetId,
        ownerUserId: actor.userId,
      });
      if (
        !asset
        || asset.artifact.id !== req.params.assetId
      ) {
        hidden();
        return;
      }
      assertVisualAssetManifestSchema(asset.manifest);
      const manifest: VisualAssetManifest = asset.manifest;
      if (
        manifest.assetId !== req.params.assetId
        || asset.manifestArtifact.schemaVersion !== manifest.version
        || (manifest.exportPolicy !== 'allow' && manifest.exportPolicy !== 'mask')
      ) {
        hidden();
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'Content-Type': manifest.mediaType,
      });
      res.send(Buffer.from(asset.bytes));
    } catch {
      hidden();
    }
  });

  router.get('/approvals', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    try {
      const tasks = await repository.listTasksAwaitingApproval();
      const summaries = [];
      for (const task of tasks) {
        const approvals = await readApprovalRequirements(repository, task, actor.role);
        if (!approvals.some((approval) => approval.canApprove || approval.requiredAuthority === actor.role)) continue;
        const structuredTask = task.structuredTask;
        const taskType = record(structuredTask)?.task_type;
        summaries.push({
          id: task.id,
          originalInput: task.originalInput,
          taskType: typeof taskType === 'string' ? taskType : null,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId,
        });
      }
      res.json({ tasks: summaries });
    } catch (error) {
      responseError(res, error);
    }
  });

router.get('/:id', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  const task = await repository.getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  try {
    const isOwner = task.ownerUserId === actor.userId
      && task.conversationOwnerUserId === actor.userId;
    const approvalRequirements = await readApprovalRequirements(repository, task, actor.role);
    const canReviewAsApprover = task.state === 'awaiting_approval'
      && approvalRequirements.some((approval) => approval.requiredAuthority === actor.role);
    if (!isOwner && !canReviewAsApprover) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    if (task.state === 'awaiting_clarification') {
      const errors = currentRequirementValidator.validate('research-task-v2', task.structuredTask);
      if (errors.length > 0) {
        throw new ControlPlaneConflictError(
          `awaiting_clarification task ${task.id} has invalid research-task-v2`,
        );
      }
    }
    const [recovered, activePlan, executionSteps, pendingInputQuarantined] = await Promise.all([
      task.state === 'awaiting_selection'
        ? isOwner
          ? repository.listCandidatePlanVersionsForOwner({
            taskId: task.id,
            ownerUserId: actor.userId,
          })
          : Promise.resolve({ candidates: [], activatedNodes: [] })
        : Promise.resolve({ candidates: [], activatedNodes: [] }),
      task.activePlanVersionId
        ? isOwner
          ? repository.getActivePlanForOwner({ taskId: task.id, ownerUserId: actor.userId })
          : repository.getActivePlan(task.id)
        : Promise.resolve(null),
      task.currentAttemptId
        ? repository.listExecutionSteps(task.currentAttemptId)
        : Promise.resolve([]),
      task.activePlanVersionId && isOwner
        ? repository.isPlanPendingInputQuarantined(task.activePlanVersionId)
        : Promise.resolve(false),
    ]);
    if (!recovered) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    res.json({
      kind: 'current',
      task,
      activePlan,
      executionSteps: executionSteps.map((step) => ({
        stepNo: step.stepNo,
        stepName: step.stepName,
        actorType: step.actorType,
        actorId: step.actorId,
        state: step.state,
        toolProvenance: step.toolProvenance,
        skillProvenance: step.skillProvenance,
        failure: step.failure,
        latencyMs: step.latencyMs,
      })),
      approvalRequirements,
      ...(pendingInputQuarantined
        ? { planRecovery: { kind: 'plan_revision_required' as const, reason: 'legacy_pending_inputs' as const } }
        : {}),
      ...recovered,
    });
  } catch (error) {
    responseError(res, error);
  }
});

router.get('/:id/deliverable', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  try {
    const deliverable = await runtime.getDeliverable(req.params.id, actor.userId);
    if (deliverable === null) {
      res.status(404).json({ error: '交付物不存在' });
      return;
    }
    res.json(deliverable);
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/select', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId 必填' });
    return;
  }
  try {
    res.json(await workflow.select({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      planVersionId,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/confirm', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const confirmationAnswers = record(body?.confirmationAnswers);
  const inputValues = record(body?.inputValues);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId || !confirmationAnswers || !inputValues) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId、confirmationAnswers、inputValues 必填' });
    return;
  }
  try {
    res.json(await workflow.confirm({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
      confirmationAnswers,
      inputValues,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/approve', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const gateKey = string(body?.gateKey);
  const decision = body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
  if (!actor) return;
  if (!await ensureApprovalTaskAccess(runtime, req, res, actor, gateKey ?? '')) return;
  if (expectedVersion == null || !key || !planVersionId || !gateKey || !decision) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId、gateKey、decision 必填' });
    return;
  }
  try {
    res.json(await workflow.approve({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
      gateKey,
      decision,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/revise', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const revisionInstruction = string(body?.revisionInstruction);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (body && ('plan' in body || 'planHash' in body)) {
    res.status(400).json({ error: 'plan 和 planHash 由服务端生成，不接受客户端提交' });
    return;
  }
  if (expectedVersion == null || !key || !revisionInstruction) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、revisionInstruction 必填' });
    return;
  }
  try {
    res.json(await workflow.revise({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      revisionInstruction,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/resume', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const action = body?.action === 'retry' || body?.action === 'skip' || body?.action === 'abort'
    ? body.action
    : undefined;
  const failedStepNo = version(body?.failedStepNo);
  if (body?.action !== undefined && !action) {
    res.status(400).json({ error: 'action 需为 retry、skip 或 abort' });
    return;
  }
  if (body?.failedStepNo !== undefined && (!failedStepNo || failedStepNo < 1)) {
    res.status(400).json({ error: 'failedStepNo 需为正整数' });
    return;
  }
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key 必填' });
    return;
  }
  try {
    res.json(await workflow.resume({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      action,
      failedStepNo: failedStepNo && failedStepNo > 0 ? failedStepNo : undefined,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/execute', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId 必填' });
    return;
  }
  try {
    res.json(await workflow.execute({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

  return router;
}
