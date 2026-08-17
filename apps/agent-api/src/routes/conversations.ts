import { Router } from 'express';
import {
  createConversation,
  getOwnedConversation,
  listRecentConversations,
  listMessages,
} from '../../../../database/repository.ts';
import { requireAuth } from '../middleware.ts';

// 会话路由:列表 / 新建 / 消息回放。全部 requireAuth + owner 隔离。

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get('/', async (req, res) => {
  const rows = await listRecentConversations(req.userId!);
  res.json({ conversations: rows });
});

conversationsRouter.post('/', async (req, res) => {
  const { title } = req.body ?? {};
  const conv = await createConversation({ ownerUserId: req.userId!, title: title || '新任务' });
  res.json({ conversation: conv });
});

conversationsRouter.get('/:id/messages', async (req, res) => {
  const conversation = await getOwnedConversation(req.params.id, req.userId!);
  if (!conversation) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const msgs = await listMessages(conversation.id, req.userId!);
  res.json({ messages: msgs });
});
