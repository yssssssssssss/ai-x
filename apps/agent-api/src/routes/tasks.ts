import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConversation,
  listRecentTasks,
  getResearchTask,
  listDecisionStates,
  listExecutionLog,
  listArtifacts,
} from '../../../../database/repository.ts';
import { buildOrchestrator } from '../../../orchestrator-runtime/src/orchestrator.ts';
import { requireAuth } from '../middleware.ts';

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

function readReport(taskId: string): unknown | null {
  const p = join(process.cwd(), 'run-workspaces', taskId, 'artifacts', 'report.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// 段1+2:一句话 → 计划(停在 HITL 闸门,不执行)
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
    res.json({
      conversationId: convId,
      taskId: result.taskId,
      task: result.task,
      activatedNodes: result.activatedNodes,
      plan: result.plan,
    });
  } catch (err) {
    res.status(502).json({ error: `规划失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 段3+4:确认后执行 → 报告
tasksRouter.post('/:id/execute', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  try {
    const orch = buildOrchestrator();
    const { reportArtifactId } = await orch.executePhase({
      taskId: task.id,
      conversationId: task.conversation_id,
    });
    res.json({
      taskId: task.id,
      reportArtifactId,
      executionLog: await listExecutionLog(task.id),
      report: readReport(task.id),
    });
  } catch (err) {
    res.status(502).json({ error: `执行失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 历史任务(owner 隔离)
tasksRouter.get('/', async (req, res) => {
  const tasks = await listRecentTasks(req.userId!);
  res.json({ tasks });
});

// 任务详情:task + 决策状态 + 执行日志 + 报告(复盘用)
tasksRouter.get('/:id', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json({
    task,
    decisionStates: await listDecisionStates(task.id),
    executionLog: await listExecutionLog(task.id),
    artifacts: await listArtifacts(task.id),
    report: readReport(task.id),
  });
});
