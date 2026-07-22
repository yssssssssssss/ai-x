import { Router, raw, type Response } from 'express';
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
import { buildOrchestrator, type ExecuteResult } from '../../../orchestrator-runtime/src/orchestrator.ts';
import { renderReportHtml } from '../../../orchestrator-runtime/src/report-renderer.ts';
import { RunWorkspace } from '../../../orchestrator-runtime/src/run-workspace.ts';
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

async function buildExecutePayload(taskId: string, result: ExecuteResult) {
  return {
    taskId,
    status: result.status,
    reportArtifactId: result.reportArtifactId ?? null,
    failedStepNo: result.failedStepNo ?? null,
    failedStepName: result.failedStepName ?? null,
    gapCount: result.gapCount ?? 0,
    executionLog: await listExecutionLog(taskId),
    report: readReport(taskId),
  };
}

function openSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// 图片在任务工作区独立落盘。执行请求只传 assetId，避免 Base64 穿过 JSON、日志和运行状态。
tasksRouter.post('/:id/media', raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '10mb' }), async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: '仅支持 JPEG、PNG、WebP 或 GIF 图片' });
    return;
  }
  const role = req.header('x-media-role') ?? '';
  const encodedName = req.header('x-file-name');
  let fileName: string | undefined;
  try { fileName = encodedName ? decodeURIComponent(encodedName) : undefined; }
  catch { fileName = undefined; }
  try {
    const asset = new RunWorkspace(task.id).writeMediaAsset({
      role,
      mimeType: (req.header('content-type') ?? '').split(';', 1)[0].trim().toLowerCase(),
      data: req.body,
      fileName: fileName?.slice(0, 255),
    });
    const { storageUri: _storageUri, ...publicAsset } = asset;
    res.status(201).json(publicAsset);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
    res.json({
      conversationId: convId,
      taskId: result.taskId,
      task: result.task,
      activatedNodes: result.activatedNodes,
      candidates: result.candidates,
    });
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
    send('result', {
      conversationId: convId,
      taskId: result.taskId,
      task: result.task,
      activatedNodes: result.activatedNodes,
      candidates: result.candidates,
    });
  } catch (err) {
    send('error', { error: `规划失败: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    res.end();
  }
});

// 候选选择:用户选一份 → finalize 出 plan + pendingUploads,状态转 awaiting_confirmation。
tasksRouter.post('/:id/select', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const { candidateId } = req.body ?? {};
  if (candidateId !== 'depth' && candidateId !== 'speed') {
    res.status(400).json({ error: 'candidateId 需为 depth 或 speed' });
    return;
  }
  try {
    const orch = buildOrchestrator();
    const result = await orch.selectPlan({ taskId: task.id, candidateId });
    res.json({
      taskId: result.taskId,
      candidateId: result.candidateId,
      plan: result.plan,
      pendingUploads: result.pendingUploads,
    });
  } catch (err) {
    res.status(502).json({ error: `候选选择失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 段3+4:确认后执行 → 报告(容错:遇失败步返回 status=paused,前端给跳过/终止)
tasksRouter.post('/:id/execute', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  try {
    const orch = buildOrchestrator();
    const result = await orch.executePhase({
      taskId: task.id,
      conversationId: task.conversation_id,
      uploads: req.body?.uploads,   // [{ role, assetId }] — 确认闸门上传后的任务级媒体引用
    });
    res.json(await buildExecutePayload(task.id, result));
  } catch (err) {
    res.status(502).json({ error: `执行失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 段3+4 流式:逐步推送 step/synthesis 进度,末尾返回完整执行结果。
tasksRouter.post('/:id/execute/stream', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const send = openSse(res);
  try {
    const orch = buildOrchestrator();
    const result = await orch.executePhase(
      { taskId: task.id, conversationId: task.conversation_id, uploads: req.body?.uploads },
      (ev) => send('progress', ev),
    );
    send('result', await buildExecutePayload(task.id, result));
  } catch (err) {
    send('error', { error: `执行失败: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    res.end();
  }
});

// 失败步恢复:skip=从下一步续跑,abort=终止收尾
tasksRouter.post('/:id/resume', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const { action } = req.body ?? {};
  if (action !== 'skip' && action !== 'abort') {
    res.status(400).json({ error: 'action 需为 skip 或 abort' });
    return;
  }
  try {
    const orch = buildOrchestrator();
    const result = await orch.resumePhase({
      taskId: task.id,
      conversationId: task.conversation_id,
      action,
    });
    res.json(await buildExecutePayload(task.id, result));
  } catch (err) {
    res.status(502).json({ error: `恢复失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// 恢复流式:skip 推送跳过与后续步骤进度;abort 推送 failed 后返回结果。
tasksRouter.post('/:id/resume/stream', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const { action } = req.body ?? {};
  if (action !== 'skip' && action !== 'abort') {
    res.status(400).json({ error: 'action 需为 skip 或 abort' });
    return;
  }
  const send = openSse(res);
  try {
    const orch = buildOrchestrator();
    const result = await orch.resumePhase(
      { taskId: task.id, conversationId: task.conversation_id, action },
      (ev) => send('progress', ev),
    );
    send('result', await buildExecutePayload(task.id, result));
  } catch (err) {
    send('error', { error: `恢复失败: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    res.end();
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

// HTML 报告下载:自包含 HTML 文件,可离线打开
tasksRouter.get('/:id/report.html', async (req, res) => {
  const task = await getOwnedTask(req.params.id, req.userId!);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const basePath = join(process.cwd(), 'run-workspaces', task.id, 'artifacts');
  const htmlPath = join(basePath, 'report.html');
  let html: string;
  if (existsSync(htmlPath)) {
    html = readFileSync(htmlPath, 'utf8');
  } else {
    // 旧任务:只有 report.json,实时渲染
    const jsonPath = join(basePath, 'report.json');
    if (!existsSync(jsonPath)) {
      res.status(404).json({ error: '报告尚未生成' });
      return;
    }
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    html = renderReportHtml({ report });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${task.id.slice(0, 8)}.html"`);
  res.send(html);
});
