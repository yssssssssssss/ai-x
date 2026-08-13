import { Router, type Request, type Response } from 'express';
import { ControlPlaneConflictError, type ControlPlaneRepository } from '../../../../database/control-plane.ts';
import { getUserById } from '../../../../database/repository.ts';
import {
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  type TaskWorkflowService,
  type WorkflowActor,
} from '../../../orchestrator-runtime/src/control/task-workflow.ts';
import { requireAuth } from '../middleware.ts';

export interface ControlTasksRuntime {
  repository: ControlPlaneRepository;
  workflow: TaskWorkflowService;
  getDeliverable(taskId: string, ownerUserId: string): Promise<unknown | null>;
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

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
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

function responseError(res: Response, error: unknown): void {
  if (error instanceof TaskWorkflowGateError) {
    res.status(422).json({ error: error.message, unresolved: error.unresolved });
    return;
  }
  if (error instanceof TaskWorkflowAuthorizationError) {
    res.status(403).json({ error: error.message });
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
): Promise<boolean> {
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
    res.status(404).json({ error: '任务不存在' });
    return false;
  }
  return true;
}

export function createControlTasksRouter(runtime: ControlTasksRuntime): Router {
  const router = Router();
  router.use(requireAuth);
  const { repository, workflow } = runtime;

router.get('/:id', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  const task = await repository.getTaskDetail(req.params.id);
  if (!task || task.ownerUserId !== actor.userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const executionSteps = task.currentAttemptId
    ? await repository.listExecutionSteps(task.currentAttemptId)
    : [];
  res.json({ kind: 'current', task, executionSteps });
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
  const inputRoles = stringList(body?.inputRoles);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId || !confirmationAnswers || !inputRoles) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId、confirmationAnswers、inputRoles 必填' });
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
      inputRoles,
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
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
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
