import { isIPv4 } from 'node:net';
import { Router, type Request } from 'express';
import { createUser, getUserByEmail, getUserById } from '../../../../database/users.ts';
import { hashPassword, verifyPassword, signToken } from '../auth.ts';
import { requireAuth } from '../middleware.ts';

// 认证路由:注册 / 登录 / 当前用户。独立注册体系,不接 ERP。

export const authRouter = Router();

function isLoopbackClient(req: Request): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  if (address === '::1') return true;
  if (isIPv4(address)) return address.startsWith('127.');

  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  return ipv4Mapped !== undefined && isIPv4(ipv4Mapped) && ipv4Mapped.startsWith('127.');
}

function devQuickLoginEmail(req: Request): string | null {
  if (process.env.NODE_ENV !== 'development') return null;
  if (process.env.DEV_QUICK_LOGIN_ENABLED !== '1') return null;
  if (!isLoopbackClient(req)) return null;
  return process.env.DEV_QUICK_LOGIN_EMAIL?.trim() || null;
}

function publicUser(user: { id: string; email: string; display_name: string; role: string }) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  };
}

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
  res.json({ token, user: publicUser(user) });
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
  res.json({ token, user: publicUser(user) });
});

authRouter.get('/methods', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ quickLogin: devQuickLoginEmail(req) !== null });
});

authRouter.post('/quick-login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const email = devQuickLoginEmail(req);
  if (!email) {
    res.status(404).json({ error: '快捷登录未启用' });
    return;
  }

  const user = await getUserByEmail(email);
  if (!user || user.status !== 'active') {
    res.status(503).json({ error: '快捷登录账号不可用' });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email });
  res.json({ token, user: publicUser(user) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.userId!);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json({ user: publicUser(user) });
});
