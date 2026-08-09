import { Router, type Request, type Response } from 'express';
import { ControlPlaneConflictError, ControlPlaneRepository } from '../../../../database/control-plane.ts';
import { pool } from '../../../../database/db.ts';
import { createConversation, getUserById } from '../../../../database/repository.ts';
import {
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  TaskWorkflowService,
  type WorkflowActor,
} from '../../../orchestrator-runtime/src/control/task-workflow.ts';
import { requireAuth } from '../middleware.ts';

export const controlTasksRouter = Router();
controlTasksRouter.use(requireAuth);

const repository = new ControlPlaneRepository(pool);
const workflow = new TaskWorkflowService(repository);

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

controlTasksRouter.post('/', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  const originalInput = string(body?.originalInput);
  if (!originalInput) {
    res.status(400).json({ error: 'originalInput 必填' });
    return;
  }
  const structuredTask = record(body?.structuredTask) ?? {};
  const conversation = await createConversation({ ownerUserId: actor.userId, title: originalInput.slice(0, 40) });
  const task = await repository.createTask({
    conversationId: conversation.id,
    ownerUserId: actor.userId,
    originalInput,
    taskType: string(body?.taskType),
    structuredTask,
    state: 'awaiting_selection',
    sensitivity: string(body?.sensitivity) ?? undefined,
  });
  res.status(201).json({ task });
});

controlTasksRouter.get('/:id', async (req, res) => {
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

controlTasksRouter.post('/:id/select', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const candidateId = string(body?.candidateId);
  const planHash = string(body?.planHash);
  const pendingInputs = Array.isArray(body?.pendingInputs) ? body?.pendingInputs : null;
  if (!actor) return;
  if (expectedVersion == null || !key || !candidateId || !planHash || !pendingInputs || !('plan' in (body ?? {}))) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、candidateId、plan、planHash、pendingInputs 必填' });
    return;
  }
  try {
    res.json(await workflow.select({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      candidateId,
      plan: body?.plan,
      planHash,
      pendingInputs,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

controlTasksRouter.post('/:id/confirm', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const confirmationAnswers = record(body?.confirmationAnswers);
  const inputRoles = stringList(body?.inputRoles);
  if (!actor) return;
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

controlTasksRouter.post('/:id/approve', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const gateKey = string(body?.gateKey);
  const decision = body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
  if (!actor) return;
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

controlTasksRouter.post('/:id/revise', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const candidateId = string(body?.candidateId);
  const planHash = string(body?.planHash);
  const pendingInputs = Array.isArray(body?.pendingInputs) ? body?.pendingInputs : null;
  if (!actor) return;
  if (expectedVersion == null || !key || !candidateId || !planHash || !pendingInputs || !('plan' in (body ?? {}))) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、candidateId、plan、planHash、pendingInputs 必填' });
    return;
  }
  try {
    res.json(await workflow.revise({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      candidateId,
      plan: body?.plan,
      planHash,
      pendingInputs,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

controlTasksRouter.post('/:id/resume', async (req, res) => {
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

controlTasksRouter.post('/:id/execute', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  if (!actor) return;
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
