import { Router } from 'express';
import {
  createConversation,
  listRecentTasks,
  getResearchTask,
  listDecisionStates,
  listExecutionLog,
} from '../../../../database/repository.ts';
import { buildOrchestrator } from '../../../orchestrator-runtime/src/orchestrator.ts';
import { RunWorkspace } from '../../../orchestrator-runtime/src/run-workspace.ts';
import { requireAuth } from '../middleware.ts';
import type { ResearchTaskData } from '../../../../packages/api-contract/plan.ts';
import type {
  PlanCandidatesResponse,
  TaskDetail,
  Report,
} from '../../../../packages/api-contract/http.ts';

// 任务路由:四段流的 HTTP 入口。plan=段1-2,execute=段3-4。
// 薄入口:只做鉴权/会话/转发/读库,判断全在 orchestrator+LLM。

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

// owner 隔离:取任务并校验归属,不属于当前用户 → 404(不泄露存在性)
async function getOwnedTask(taskId: string, userId: string) {
  const task = await getResearchTask(taskId);
  if (!task || task.owner_user_id !== userId) return null;
  return task;
}

// 段1+2:一句话 → 候选计划(2 份,停在候选选择闸门,不执行)
tasksRouter.post('/plan', async (req, res) => {
  const { originalInput, conversationId } = req.body ?? {};
  if (!originalInput) {
    res.status(400).json({ error: 'originalInput 必填' });
    return;
  }
  // 无会话则新建(标题取输入前 40 字)
  const convId =
    conversationId ??
    (await createConversation({ ownerUserId: req.userId!, title: originalInput.slice(0, 40) })).id;

  try {
    const orch = buildOrchestrator();
    const result = await orch.planPhase({
      originalInput,
      conversationId: convId,
      ownerUserId: req.userId!,
    });
    const body: PlanCandidatesResponse = {
      conversationId: convId,
      taskId: result.taskId,
      task: result.task,
      activatedNodes: result.activatedNodes,
      candidates: result.candidates,
    };
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: `规划失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 段1+2 流式:SSE 逐阶段推送 planPhase 进度(理解→激活→召回→判定→候选→归档),末尾推 result。
// 用 POST(带 body + JWT header,EventSource 不支持);前端用 fetch ReadableStream 解析。
tasksRouter.post('/plan/stream', async (req, res) => {
  const { originalInput, conversationId } = req.body ?? {};
  if (!originalInput) {
    res.status(400).json({ error: 'originalInput 必填' });
    return;
  }
  const convId =
    conversationId ??
    (await createConversation({ ownerUserId: req.userId!, title: originalInput.slice(0, 40) })).id;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁反代缓冲,保证逐条到达
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('conversation', { conversationId: convId });

  try {
    const orch = buildOrchestrator();
    const result = await orch.planPhase(
      { originalInput, conversationId: convId, ownerUserId: req.userId! },
      (ev) => send('progress', ev),
    );
    const body: PlanCandidatesResponse = {
      conversationId: convId,
      taskId: result.taskId,
      task: result.task,
      activatedNodes: result.activatedNodes,
      candidates: result.candidates,
    };
    send('result', body);
  } catch (err) {
    send('error', { error: `规划失败: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    res.end();
  }
});

// Legacy mutations are intentionally unavailable; legacy tasks remain read-only.
tasksRouter.post('/:id/select', (_req, res) => {
  res.status(410).json({ error: 'legacy task mutation 已移除；请使用 /api/control-tasks/:id/select' });
});

// Legacy merged execution is intentionally unavailable.
tasksRouter.post('/:id/execute', (_req, res) => {
  res.status(410).json({ error: 'legacy merged execute 已移除；请使用 /api/control-tasks/:id/execute' });
});

// Legacy resume is intentionally unavailable.
tasksRouter.post('/:id/resume', (_req, res) => {
  res.status(410).json({ error: 'legacy task resume 已移除；请使用 /api/control-tasks/:id/resume' });
});

// 历史任务(owner 隔离)
tasksRouter.get('/', async (req, res) => {
  res.json({ kind: 'legacy', tasks: await listRecentTasks(req.userId!) });
});

// 任务详情:task + 决策状态 + 执行日志 + 报告(复盘用)
tasksRouter.get('/:id', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const body: TaskDetail = {
    task: {
      id: task.id,
      original_input: task.original_input,
      task_type: task.task_type,
      structured_task: task.structured_task as ResearchTaskData,
      status: task.status,
    },
    decisionStates: await listDecisionStates(task.id),
    executionLog: await listExecutionLog(task.id),
    report: new RunWorkspace(task.id).readReport<Report>(),
  };
  res.json({ kind: 'legacy', ...body });
});
