import { Router } from 'express';
import {
  listRecentTasks,
  getResearchTask,
  listDecisionStates,
  listExecutionLog,
} from '../../../../database/repository.ts';
import { RunWorkspace } from '../../../orchestrator-runtime/src/run-workspace.ts';
import { requireAuth } from '../middleware.ts';
import type { ResearchTaskData } from '../../../../packages/api-contract/plan.ts';
import type {
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

// Legacy planning mutations are intentionally unavailable; use /api/control-tasks planning.
tasksRouter.post('/plan', (_req, res) => {
  res.status(410).json({ error: 'legacy task plan 已移除；请使用 /api/control-tasks/plan' });
});

// 段1+2 流式:SSE 逐阶段推送 planPhase 进度(理解→激活→召回→判定→候选→归档),末尾推 result。
// 用 POST(带 body + JWT header,EventSource 不支持);前端用 fetch ReadableStream 解析。
tasksRouter.post('/plan/stream', (_req, res) => {
  res.status(410).json({ error: 'legacy task plan/stream 已移除；请使用 /api/control-tasks/plan/stream' });
});

// Legacy feedback mutation is intentionally unavailable.
tasksRouter.post('/:id/feedback', (_req, res) => {
  res.status(410).json({ error: 'legacy task feedback 已移除；请使用 control 反馈通道' });
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
    executionLog: (await listExecutionLog(task.id)).map((row) => ({
      ...row,
      skillProvenance: null,
    })),
    report: new RunWorkspace(task.id).readReport<Report>(),
  };
  res.json({ kind: 'legacy', ...body });
});
