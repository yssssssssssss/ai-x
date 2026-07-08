import { Router } from 'express';
import { writeFeedback, getResearchTask } from '../../../../database/repository.ts';
import { requireAuth } from '../middleware.ts';

// 反馈路由:对任务报告评分/采纳。MVP 仅存储,不自动优化。

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

feedbackRouter.post('/:id/feedback', async (req, res) => {
  const task = await getResearchTask(req.params.id);
  if (!task || task.owner_user_id !== req.userId!) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const { rating, adopted, comment } = req.body ?? {};
  const fb = await writeFeedback({ taskId: task.id, userId: req.userId!, rating, adopted, comment });
  res.json({ id: fb.id });
});
