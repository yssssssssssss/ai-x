import { Router } from 'express';
import { createUser, getUserByEmail, getUserById } from '../../../../database/repository.ts';
import { hashPassword, verifyPassword, signToken } from '../auth.ts';
import { requireAuth } from '../middleware.ts';

// 认证路由:注册 / 登录 / 当前用户。独立注册体系,不接 ERP。

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body ?? {};
  if (!email || !password || !displayName) {
    res.status(400).json({ error: 'email / password / displayName 必填' });
    return;
  }
  const existing = await getUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: '邮箱已注册' });
    return;
  }
  const user = await createUser({ email, displayName, passwordHash: await hashPassword(password) });
  const token = signToken({ userId: user.id, email: user.email });
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'email / password 必填' });
    return;
  }
  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }
  const token = signToken({ userId: user.id, email: user.email });
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.userId!);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
});
